ALTER TABLE `participant_scores` MODIFY COLUMN `responseTimeScore` int;--> statement-breakpoint
ALTER TABLE `tokens` MODIFY COLUMN `status` enum('active','used','expired','pending_issuance') NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `assets` ADD `approvalStatus` enum('pending','approved','rejected') DEFAULT 'pending' NOT NULL;