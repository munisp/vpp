CREATE TABLE `payment_reconciliations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paymentId` int NOT NULL,
	`reconciliationDate` timestamp NOT NULL,
	`status` enum('matched','unmatched','discrepancy','manual_review') NOT NULL,
	`gatewayTransactionId` varchar(255),
	`gatewayAmount` int,
	`gatewayStatus` varchar(50),
	`gatewayTimestamp` timestamp,
	`dbAmount` int,
	`dbStatus` varchar(50),
	`dbTimestamp` timestamp,
	`amountDifference` int,
	`statusMismatch` boolean DEFAULT false,
	`timeDifference` int,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_reconciliations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reconciliation_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reconciliationId` int NOT NULL,
	`action` enum('created','matched','flagged_discrepancy','manual_review','resolved','rejected') NOT NULL,
	`performedBy` int,
	`notes` text,
	`previousStatus` varchar(50),
	`newStatus` varchar(50),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reconciliation_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reportDate` timestamp NOT NULL,
	`reportType` enum('daily','weekly','monthly') NOT NULL,
	`totalPayments` int NOT NULL,
	`matchedPayments` int NOT NULL,
	`unmatchedPayments` int NOT NULL,
	`discrepancies` int NOT NULL,
	`totalAmount` int NOT NULL,
	`matchedAmount` int NOT NULL,
	`discrepancyAmount` int NOT NULL,
	`gatewayBreakdown` text,
	`generatedBy` int,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`reportFileUrl` varchar(500),
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reconciliation_reports_id` PRIMARY KEY(`id`)
);
