// Package services holds the middleware service clients used by the
// orchestrator's Temporal activities.
//
// REMOVED during mockware remediation (see MOCKWARE_TRIAGE.md):
//
//   - TigerBeetleService: the previous stub exposed Transfer / CreditAccount /
//     GetAccountBalance methods, but the user->ledger-account mapping, ledger
//     codes and treasury/fee accounts would have had to be invented. Shipping
//     an untested, invented account mapping in money-movement paths is
//     dangerous, so the service was removed entirely. Every activity that
//     needs the ledger now fails loudly with an explicit "not configured"
//     error until a reviewed TigerBeetle integration (the tigerbeetle-go
//     client is already declared in go.mod) is implemented.
//   - FluvioService: no Fluvio Go client dependency exists in go.mod and
//     dependencies may not be added casually, so the stub was removed.
//     PublishFluvioTelemetryActivity now fails loudly instead of pretending
//     to stream telemetry.
//   - The mangled NewServices struct literal (cloak:/fig: artifacts) and the
//     KafkaService.PublishEvent signature mismatch were repaired; PublishEvent
//     now matches its call sites (ctx, topic, event) and JSON-encodes the
//     payload.
package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	dapr "github.com/dapr/go-sdk/client"
	"github.com/go-redis/redis/v8"
	_ "github.com/go-sql-driver/mysql"

	"github.com/vpp-platform/orchestrator/config"
)

// Services holds all middleware service clients.
type Services struct {
	Kafka     *KafkaService
	Dapr      *DaprService
	Redis     *RedisService
	Keycloak  *KeycloakService
	Permify   *PermifyService
	Lakehouse *LakehouseService
	DB        *DBService
	Config    *config.Config
}

// NewServices initializes all middleware services.
func NewServices(cfg *config.Config) (*Services, error) {
	kafkaProducer, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": strings.Join(cfg.Kafka.Brokers, ","),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create Kafka producer: %w", err)
	}

	daprClient, err := dapr.NewClient()
	if err != nil {
		kafkaProducer.Close()
		return nil, fmt.Errorf("failed to create Dapr client: %w", err)
	}

	redisClient := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", cfg.Redis.Host, cfg.Redis.Port),
		Password: cfg.Redis.Password,
		DB:       cfg.Redis.DB,
	})

	return &Services{
		Kafka:     &KafkaService{producer: kafkaProducer},
		Dapr:      &DaprService{client: daprClient},
		Redis:     &RedisService{client: redisClient},
		Keycloak:  NewKeycloakService(cfg.Keycloak),
		Permify:   NewPermifyService(cfg.Permify),
		Lakehouse: NewLakehouseService(cfg.Lakehouse),
		DB:        NewDBService(cfg.Database),
		Config:    cfg,
	}, nil
}

// Close releases all service clients.
func (s *Services) Close() error {
	if s.Kafka != nil && s.Kafka.producer != nil {
		s.Kafka.producer.Flush(5000)
		s.Kafka.producer.Close()
	}
	if s.Dapr != nil && s.Dapr.client != nil {
		s.Dapr.client.Close()
	}
	if s.Redis != nil && s.Redis.client != nil {
		s.Redis.client.Close()
	}
	if s.DB != nil {
		s.DB.Close()
	}
	return nil
}

// KafkaService publishes events to Kafka topics.
type KafkaService struct {
	producer *kafka.Producer
}

// PublishEvent JSON-encodes event and produces it to topic.
func (k *KafkaService) PublishEvent(ctx context.Context, topic string, event interface{}) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("failed to encode event for topic %q: %w", topic, err)
	}
	if err := k.producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Value:          payload,
	}, nil); err != nil {
		return fmt.Errorf("failed to produce event to topic %q: %w", topic, err)
	}
	return nil
}

// RedisService wraps the Redis client with the operations the activities use.
type RedisService struct {
	client *redis.Client
}

func (r *RedisService) Get(ctx context.Context, key string) (string, error) {
	return r.client.Get(ctx, key).Result()
}

func (r *RedisService) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *RedisService) Delete(ctx context.Context, keys ...string) error {
	return r.client.Del(ctx, keys...).Err()
}

// IncrementScore increments a member's score in a sorted set (ZINCRBY).
func (r *RedisService) IncrementScore(ctx context.Context, key string, member string, delta float64) error {
	return r.client.ZIncrBy(ctx, key, delta, member).Err()
}

// SetScore sets a member's score in a sorted set (ZADD).
func (r *RedisService) SetScore(ctx context.Context, key string, member string, score float64) error {
	return r.client.ZAdd(ctx, key, &redis.Z{Score: score, Member: member}).Err()
}

// DaprService wraps the Dapr client with JSON state-store helpers.
type DaprService struct {
	client dapr.Client
}

// SaveState JSON-encodes value and saves it under key in the named state store.
func (d *DaprService) SaveState(ctx context.Context, storeName string, key string, value interface{}) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to encode state %s/%s: %w", storeName, key, err)
	}
	return d.client.SaveState(ctx, storeName, key, payload, nil)
}

// GetState loads and JSON-decodes the state stored under key.
// A missing key is an error: callers must not silently invent defaults.
func (d *DaprService) GetState(ctx context.Context, storeName string, key string, out interface{}) error {
	item, err := d.client.GetState(ctx, storeName, key, nil)
	if err != nil {
		return fmt.Errorf("failed to load state %s/%s: %w", storeName, key, err)
	}
	if item == nil || len(item.Value) == 0 {
		return fmt.Errorf("state %s/%s not found", storeName, key)
	}
	return json.Unmarshal(item.Value, out)
}

// DBService provides lazily-initialized access to the platform MySQL
// database. Schema ground truth is drizzle/schema.ts: camelCase columns,
// energy in watt-hours, prices in cents per kWh.
type DBService struct {
	dsn string

	mu sync.Mutex
	db *sql.DB
}

// NewDBService creates a DBService. The connection is established lazily on
// first use so that NewServices does not fail when the database is down;
// every query then fails loudly instead.
func NewDBService(cfg config.DatabaseConfig) *DBService {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&timeout=5s",
		cfg.User, cfg.Password, cfg.Host, cfg.Port, cfg.Database)
	return &DBService{dsn: dsn}
}

func (d *DBService) conn(ctx context.Context) (*sql.DB, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.db != nil {
		return d.db, nil
	}
	db, err := sql.Open("mysql", d.dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database connection: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("database unavailable: %w", err)
	}
	d.db = db
	return d.db, nil
}

func (d *DBService) QueryRowContext(ctx context.Context, query string, args ...interface{}) (*sql.Row, error) {
	db, err := d.conn(ctx)
	if err != nil {
		return nil, err
	}
	return db.QueryRowContext(ctx, query, args...), nil
}

func (d *DBService) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	db, err := d.conn(ctx)
	if err != nil {
		return nil, err
	}
	return db.QueryContext(ctx, query, args...)
}

func (d *DBService) ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	db, err := d.conn(ctx)
	if err != nil {
		return nil, err
	}
	return db.ExecContext(ctx, query, args...)
}

func (d *DBService) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.db == nil {
		return nil
	}
	err := d.db.Close()
	d.db = nil
	return err
}

// KeycloakService holds Keycloak configuration (no client calls yet).
type KeycloakService struct {
	config config.KeycloakConfig
}

func NewKeycloakService(cfg config.KeycloakConfig) *KeycloakService {
	return &KeycloakService{config: cfg}
}

// PermifyService holds Permify configuration (no client calls yet).
type PermifyService struct {
	config config.PermifyConfig
}

func NewPermifyService(cfg config.PermifyConfig) *PermifyService {
	return &PermifyService{config: cfg}
}

// LakehouseService holds lakehouse configuration (no client calls yet).
type LakehouseService struct {
	config config.LakehouseConfig
}

func NewLakehouseService(cfg config.LakehouseConfig) *LakehouseService {
	return &LakehouseService{config: cfg}
}
