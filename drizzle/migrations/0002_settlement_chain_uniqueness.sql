ALTER TABLE `settlement_events` ADD CONSTRAINT `settlement_events_sequence_number_unique` UNIQUE(`sequence_number`);--> statement-breakpoint
ALTER TABLE `settlement_events` ADD CONSTRAINT `settlement_events_previous_hash_unique` UNIQUE(`previous_hash`);--> statement-breakpoint
ALTER TABLE `wallet_balance_snapshots` ADD `top_ups_completed_cents` int DEFAULT 0 NOT NULL;
