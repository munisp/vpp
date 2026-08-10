ALTER TABLE `users` ADD `onboardingCompleted` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `onboardingStep` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `onboardingSkipped` boolean DEFAULT false NOT NULL;