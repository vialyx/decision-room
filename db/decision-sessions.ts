import type { ActionPlan, DecisionApiResult, DecisionInput } from "@/lib/decision-types";

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type D1Binding = {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
};

type SessionRow = {
  id: string;
  status: string;
  mode: string;
  workflow_version: string;
  input_json: string;
  result_json: string | null;
  evaluation_json: string | null;
  run_state: string | null;
  approval_json: string | null;
  action_plan_json: string | null;
  created_at: number;
  updated_at: number;
};

export type StoredDecisionSession = {
  id: string;
  status: string;
  mode: "demo" | "live";
  workflowVersion: string;
  input: DecisionInput;
  result: DecisionApiResult | null;
  runState: string | null;
  approval: Record<string, unknown> | null;
  actionPlan: ActionPlan | null;
  createdAt: number;
  updatedAt: number;
};

let schemaReady = false;

async function binding(): Promise<D1Binding | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return ((env as unknown as { DB?: D1Binding }).DB) ?? null;
  } catch {
    // The generated Worker is also imported directly by the Node test runner,
    // where the Cloudflare-only module scheme is intentionally unavailable.
    return null;
  }
}

async function ensureSchema(db: D1Binding) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS decision_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      evaluation_json TEXT,
      run_state TEXT,
      approval_json TEXT,
      action_plan_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_decision_sessions_status ON decision_sessions(status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_decision_sessions_created_at ON decision_sessions(created_at)"),
  ]);
  schemaReady = true;
}

export async function saveDecisionSession(args: {
  id: string;
  mode: "demo" | "live";
  input: DecisionInput;
  result: DecisionApiResult;
}): Promise<boolean> {
  const db = await binding();
  if (!db) return false;
  await ensureSchema(db);
  const now = Date.now();
  await db.prepare(`INSERT INTO decision_sessions (
      id, status, mode, workflow_version, input_json, result_json,
      evaluation_json, run_state, approval_json, action_plan_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      result_json = excluded.result_json,
      evaluation_json = excluded.evaluation_json,
      approval_json = excluded.approval_json,
      updated_at = excluded.updated_at`)
    .bind(
      args.id,
      args.result.route === "decision_council" ? "recommended" : "clarification",
      args.mode,
      "decision-room-v3",
      JSON.stringify(args.input),
      JSON.stringify(args.result),
      args.result.route === "decision_council" ? JSON.stringify(args.result.evaluation) : null,
      args.result.route === "decision_council" ? JSON.stringify(args.result.approval) : null,
      now,
      now,
    ).run();
  return true;
}

export async function getDecisionSession(id: string): Promise<StoredDecisionSession | null> {
  const db = await binding();
  if (!db) return null;
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM decision_sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    mode: row.mode as "demo" | "live",
    workflowVersion: row.workflow_version,
    input: JSON.parse(row.input_json) as DecisionInput,
    result: row.result_json ? JSON.parse(row.result_json) as DecisionApiResult : null,
    runState: row.run_state,
    approval: row.approval_json ? JSON.parse(row.approval_json) as Record<string, unknown> : null,
    actionPlan: row.action_plan_json ? JSON.parse(row.action_plan_json) as ActionPlan : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function savePendingApproval(id: string, runState: string | null, approval: Record<string, unknown>): Promise<boolean> {
  const db = await binding();
  if (!db) return false;
  await ensureSchema(db);
  await db.prepare(`UPDATE decision_sessions
    SET status = 'pending_approval', run_state = ?, approval_json = ?, updated_at = ?
    WHERE id = ?`)
    .bind(runState, JSON.stringify(approval), Date.now(), id).run();
  return true;
}

export async function resolveDecisionApproval(id: string, status: "approved" | "rejected", actionPlan: ActionPlan): Promise<boolean> {
  const db = await binding();
  if (!db) return false;
  await ensureSchema(db);
  await db.prepare(`UPDATE decision_sessions
    SET status = ?, run_state = NULL, approval_json = ?, action_plan_json = ?, updated_at = ?
    WHERE id = ?`)
    .bind(status, JSON.stringify({ status }), JSON.stringify(actionPlan), Date.now(), id).run();
  return true;
}
