package services

import (
"context"
"fmt"

"github.com/confluentinc/confluent-kafka-go/v2/kafka"
dapr "github.com/dapr/go-sdk/client"
"github.com/go-redis/redis/v8"
"github.com/vpp-platform/orchestrator/config"
)

// Services holds all middleware service clients
type Services struct {
Kafka       *KafkaService
Dapr        dapr.Client
Redis       *redis.Client
Keycloak    *KeycloakService
Permify     *PermifyService
TigerBeetle *TigerBeetleService
Lakehouse   *LakehouseService
Config      *config.Config
}

// NewServices initializes all middleware services
func NewServices(cfg *config.Config) (*Services, error) {
kafkaProducer, err := kafka.NewProducer(&kafka.ConfigMap{
cfg.Kafka.Brokers[0],
})
if err != nil {
 nil, fmt.Errorf("failed to create Kafka producer: %w", err)
}

kafkaService := &KafkaService{Producer: kafkaProducer}
daprClient, err := dapr.NewClient()
if err != nil {
 nil, fmt.Errorf("failed to create Dapr client: %w", err)
}

redisClient := redis.NewClient(&redis.Options{
    fmt.Sprintf("%s:%s", cfg.Redis.Host, cfg.Redis.Port),
cfg.Redis.Password,
      cfg.Redis.DB,
})

return &Services{
      kafkaService,
       daprClient,
      redisClient,
cloak:    NewKeycloakService(cfg.Keycloak),
:     NewPermifyService(cfg.Permify),
NewTigerBeetleService(cfg.TigerBeetle),
  NewLakehouseService(cfg.Lakehouse),
fig:      cfg,
}, nil
}

func (s *Services) Close() error {
s.Kafka.Producer.Close()
s.Dapr.Close()
s.Redis.Close()
return nil
}

type KafkaService struct {
Producer *kafka.Producer
}

func (k *KafkaService) PublishEvent(topic string, key string, value []byte) error {
return k.Producer.Produce(&kafka.Message{
: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
:            []byte(key),
         value,
}, nil)
}

type KeycloakService struct {
config config.KeycloakConfig
}

func NewKeycloakService(cfg config.KeycloakConfig) *KeycloakService {
return &KeycloakService{config: cfg}
}

type PermifyService struct {
config config.PermifyConfig
}

func NewPermifyService(cfg config.PermifyConfig) *PermifyService {
return &PermifyService{config: cfg}
}

type TigerBeetleService struct {
config config.TigerBeetleConfig
}

func NewTigerBeetleService(cfg config.TigerBeetleConfig) *TigerBeetleService {
return &TigerBeetleService{config: cfg}
}

type LakehouseService struct {
config config.LakehouseConfig
}

func NewLakehouseService(cfg config.LakehouseConfig) *LakehouseService {
return &LakehouseService{config: cfg}
}
