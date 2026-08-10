package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/vpp-platform/orchestrator/config"
	"github.com/vpp-platform/orchestrator/services"
	"github.com/vpp-platform/orchestrator/workflows"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

func main() {
	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize Temporal client
	temporalClient, err := client.Dial(client.Options{
		HostPort:  cfg.Temporal.HostPort,
		Namespace: cfg.Temporal.Namespace,
	})
	if err != nil {
		log.Fatalf("Failed to create Temporal client: %v", err)
	}
	defer temporalClient.Close()

	// Initialize middleware services
	svc, err := services.NewServices(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize services: %v", err)
	}
	defer svc.Close()

	// Create Temporal worker
	w := worker.New(temporalClient, cfg.Temporal.TaskQueue, worker.Options{})

	// Register workflows
	workflows.RegisterWorkflows(w)

	// Register activities with services
	workflows.RegisterActivities(w, svc)

	// Start worker
	err = w.Start()
	if err != nil {
		log.Fatalf("Failed to start worker: %v", err)
	}
	defer w.Stop()

	log.Printf("Temporal worker started on task queue: %s", cfg.Temporal.TaskQueue)

	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down orchestrator...")
}
