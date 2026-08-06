import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const decisionSessions = sqliteTable("decision_sessions", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  mode: text("mode").notNull(),
  workflowVersion: text("workflow_version").notNull(),
  inputJson: text("input_json").notNull(),
  resultJson: text("result_json"),
  evaluationJson: text("evaluation_json"),
  runState: text("run_state"),
  approvalJson: text("approval_json"),
  actionPlanJson: text("action_plan_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  index("idx_decision_sessions_status").on(table.status),
  index("idx_decision_sessions_created_at").on(table.createdAt),
]);
