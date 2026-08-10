package config

import (
	"fmt"
	"os"
)

type Config struct {
	Temporal     TemporalConfig
	Kafka        KafkaConfig
	Dapr         DaprConfig
	Fluvio       FluvioConfig
	Keycloak     KeycloakConfig
	Permify      PermifyConfig
	Redis        RedisConfig
	APISix       APISixConfig
	TigerBeetle  TigerBeetleConfig
	Lakehouse    LakehouseConfig
	Database     DatabaseConfig
}

type TemporalConfig struct {
	HostPort  string
	Namespace string
	TaskQueue string
}

type KafkaConfig struct {
	Brokers []string
	GroupID string
}

type DaprConfig struct {
	HTTPPort string
	GRPCPort string
}

type FluvioConfig struct {
	Endpoint string
}

type KeycloakConfig struct {
	URL          string
	Realm        string
	ClientID     string
	ClientSecret string
}

type PermifyConfig struct {
	Endpoint string
	APIKey   string
}

type RedisConfig struct {
	Host     string
	Port     string
	Password string
	DB       int
}

type APISixConfig struct {
	AdminURL string
	APIKey   string
}

type TigerBeetleConfig struct {
	ClusterID uint128
	Replicas  []string
}

type LakehouseConfig struct {
	Endpoint string
	Bucket   string
}

type DatabaseConfig struct {
	Host     string
	Port     string
	User     string
	Password string
	Database string
}

type uint128 struct {
	High uint64
	Low  uint64
}

func LoadConfig() (*Config, error) {
	cfg := &Config{
		Temporal: TemporalConfig{
			HostPort:  getEnv("TEMPORAL_HOST_PORT", "localhost:7233"),
			Namespace: getEnv("TEMPORAL_NAMESPACE", "default"),
			TaskQueue: getEnv("TEMPORAL_TASK_QUEUE", "vpp-orchestrator"),
		},
		Kafka: KafkaConfig{
			Brokers: []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
			GroupID: getEnv("KAFKA_GROUP_ID", "vpp-orchestrator"),
		},
		Dapr: DaprConfig{
			HTTPPort: getEnv("DAPR_HTTP_PORT", "3500"),
			GRPCPort: getEnv("DAPR_GRPC_PORT", "50001"),
		},
		Fluvio: FluvioConfig{
			Endpoint: getEnv("FLUVIO_ENDPOINT", "localhost:9003"),
		},
		Keycloak: KeycloakConfig{
			URL:          getEnv("KEYCLOAK_URL", "http://localhost:8080"),
			Realm:        getEnv("KEYCLOAK_REALM", "vpp-platform"),
			ClientID:     getEnv("KEYCLOAK_CLIENT_ID", "vpp-orchestrator"),
			ClientSecret: getEnv("KEYCLOAK_CLIENT_SECRET", ""),
		},
		Permify: PermifyConfig{
			Endpoint: getEnv("PERMIFY_ENDPOINT", "localhost:3476"),
			APIKey:   getEnv("PERMIFY_API_KEY", ""),
		},
		Redis: RedisConfig{
			Host:     getEnv("REDIS_HOST", "localhost"),
			Port:     getEnv("REDIS_PORT", "6379"),
			Password: getEnv("REDIS_PASSWORD", ""),
			DB:       0,
		},
		APISix: APISixConfig{
			AdminURL: getEnv("APISIX_ADMIN_URL", "http://localhost:9180"),
			APIKey:   getEnv("APISIX_API_KEY", ""),
		},
		TigerBeetle: TigerBeetleConfig{
			ClusterID: uint128{High: 0, Low: 0},
			Replicas:  []string{getEnv("TIGERBEETLE_REPLICAS", "localhost:3000")},
		},
		Lakehouse: LakehouseConfig{
			Endpoint: getEnv("LAKEHOUSE_ENDPOINT", "http://localhost:9000"),
			Bucket:   getEnv("LAKEHOUSE_BUCKET", "vpp-data"),
		},
		Database: DatabaseConfig{
			Host:     getEnv("DB_HOST", "localhost"),
			Port:     getEnv("DB_PORT", "3306"),
			User:     getEnv("DB_USER", "root"),
			Password: getEnv("DB_PASSWORD", ""),
			Database: getEnv("DB_NAME", "vpp_platform"),
		},
	}

	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
