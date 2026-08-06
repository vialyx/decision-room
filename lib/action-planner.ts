import { Agent, tool } from "@openai/agents";
import { z } from "zod";

export const ActionTaskSchema = z.object({
  title: z.string().min(4).max(160),
  ownerRole: z.string().min(2).max(80),
  dueInDays: z.number().int().min(1).max(180),
  successMeasure: z.string().min(4).max(240),
});

export const ActionPlanSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  recommendedOption: z.string(),
  objective: z.string(),
  tasks: z.array(ActionTaskSchema).max(6),
  approvedAt: z.string().nullable(),
});

const ActionToolInputSchema = z.object({
  recommendedOption: z.string().min(1).max(80),
  objective: z.string().min(8).max(800),
  tasks: z.array(ActionTaskSchema).min(2).max(6),
});

const SENSITIVE_ARGUMENT = /(?:sk-[a-z0-9_-]{12,}|api[_ -]?key|password\s*[:=]|bearer\s+[a-z0-9._-]{12,}|ignore previous|system prompt)/i;

export const acceptDecisionAndCreateActionPlan = tool({
  name: "accept_decision_and_create_action_plan",
  description: "Accept the council recommendation and create a bounded implementation plan. This consequential action always requires explicit human approval.",
  parameters: ActionToolInputSchema,
  outputSchema: ActionPlanSchema,
  needsApproval: true,
  timeoutMs: 5_000,
  timeoutBehavior: "raise_exception",
  inputGuardrails: [{
    name: "action_plan_scope",
    run: async ({ toolCall }) => {
      try {
        const parsed = ActionToolInputSchema.parse(JSON.parse(toolCall.arguments));
        const unsafe = SENSITIVE_ARGUMENT.test(JSON.stringify(parsed));
        return unsafe
          ? { behavior: { type: "rejectContent", message: "The action plan contains unsafe instructions or secrets." }, outputInfo: { safe: false } } as const
          : { behavior: { type: "allow" }, outputInfo: { safe: true, taskCount: parsed.tasks.length } } as const;
      } catch {
        return { behavior: { type: "throwException" }, outputInfo: { safe: false, reason: "Malformed action plan" } } as const;
      }
    },
  }],
  outputGuardrails: [{
    name: "action_plan_result",
    run: async ({ output }) => ActionPlanSchema.safeParse(output).success
      ? { behavior: { type: "allow" }, outputInfo: { valid: true } } as const
      : { behavior: { type: "throwException" }, outputInfo: { valid: false } } as const,
  }],
  execute: async ({ recommendedOption, objective, tasks }) => ({
    status: "approved" as const,
    recommendedOption,
    objective,
    tasks,
    approvedAt: new Date().toISOString(),
  }),
});

export function createActionPlannerAgent(model: string) {
  return new Agent({
    name: "Implementation Planner",
    model,
    modelSettings: { reasoning: { effort: "medium" }, text: { verbosity: "low" } },
    instructions: [
      "Turn an accepted council recommendation into a small, accountable implementation plan.",
      "You must call accept_decision_and_create_action_plan exactly once before returning an approved plan.",
      "Create two to six measurable tasks with realistic owner roles and deadlines.",
      "Do not create external tasks, send messages, or claim organizational approval yourself.",
      "If the human rejects the tool call, return status rejected, preserve the recommended option and objective, use an empty tasks array, and set approvedAt to null.",
    ].join(" "),
    tools: [acceptDecisionAndCreateActionPlan],
    outputType: ActionPlanSchema,
  });
}
