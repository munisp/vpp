ALTER TYPE "public"."control_assignments_delivery" ADD VALUE 'broker_queued' BEFORE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."control_assignments_protocol" ADD VALUE 'mqtt';