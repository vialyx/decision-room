CREATE TABLE `decision_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`workflow_version` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`evaluation_json` text,
	`run_state` text,
	`approval_json` text,
	`action_plan_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_decision_sessions_status` ON `decision_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_decision_sessions_created_at` ON `decision_sessions` (`created_at`);