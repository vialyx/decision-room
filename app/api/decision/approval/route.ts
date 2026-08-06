import { RunState, run, withTrace } from "@openai/agents";
import { z } from "zod";
import { createActionPlannerAgent, ActionPlanSchema } from "@/lib/action-planner";
import { getDecisionSession, resolveDecisionApproval, savePendingApproval } from "@/db/decision-sessions";
import type { ActionPlan, DecisionResult } from "@/lib/decision-types";

export const runtime = "nodejs";

const ApprovalRequestSchema = z.object({
  decisionId: z.string().regex(/^dec_[a-z0-9]{12}$/),
  decision: z.enum(["request", "approve", "reject"]),
});

function plannerPrompt(result: DecisionResult) {
  return [
    `RECOMMENDED OPTION: ${result.memo.recommendedOption}`,
    `OBJECTIVE: ${result.memo.summary}`,
    `NEXT STEPS: ${result.memo.nextSteps.join(" | ")}`,
    `STOP CONDITIONS: ${result.memo.conditions.join(" | ")}`,
    "Prepare the approval-required action plan. Do not execute any external action.",
  ].join("\n");
}

function demoActionPlan(result: DecisionResult, approved: boolean): ActionPlan {
  if (!approved) {
    return {
      status: "rejected",
      recommendedOption: result.memo.recommendedOption,
      objective: result.memo.summary,
      tasks: [],
      approvedAt: null,
    };
  }
  return {
    status: "approved",
    recommendedOption: result.memo.recommendedOption,
    objective: result.memo.summary,
    tasks: result.memo.nextSteps.slice(0, 4).map((step, index) => ({
      title: step,
      ownerRole: index === 0 ? "Decision owner" : "Implementation lead",
      dueInDays: 7 + index * 7,
      successMeasure: result.memo.conditions[index] ?? "Complete with evidence recorded against the decision objective.",
    })),
    approvedAt: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  try {
    const parsed = ApprovalRequestSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "A valid decision ID and approval decision are required." }, { status: 400 });

    const session = await getDecisionSession(parsed.data.decisionId);
    if (!session) return Response.json({ error: "The persisted decision session was not found." }, { status: 404 });
    if (!session.result || session.result.route !== "decision_council") {
      return Response.json({ error: "Only a completed council recommendation can enter approval." }, { status: 409 });
    }

    const result = session.result;
    if (parsed.data.decision === "request") {
      if (session.status === "approved" || session.status === "rejected") {
        return Response.json({ status: session.status, actionPlan: session.actionPlan });
      }

      if (session.mode === "demo") {
        const approval = {
          status: "pending",
          toolName: "accept_decision_and_create_action_plan",
          summary: `Accept ${result.memo.recommendedOption} and create an implementation plan.`,
          arguments: { recommendedOption: result.memo.recommendedOption },
        };
        await savePendingApproval(session.id, null, approval);
        return Response.json({ status: "pending", approval, mode: "demo" });
      }

      const model = process.env.OPENAI_PLANNER_MODEL ?? process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5.6-terra";
      const agent = createActionPlannerAgent(model);
      const runResult = await withTrace(
        "Decision Room action approval",
        () => run(agent, plannerPrompt(result), {
          maxTurns: 4,
          toolExecution: { preApprovalInputGuardrails: true },
        }),
        { groupId: session.id, metadata: { decisionId: session.id, workflowVersion: "decision-room-v3" } },
      );
      const interruption = runResult.interruptions[0];
      if (!interruption) throw new Error("The protected action did not create an approval interruption.");

      const approval = {
        status: "pending",
        toolName: interruption.name ?? "accept_decision_and_create_action_plan",
        summary: `Accept ${result.memo.recommendedOption} and create an implementation plan.`,
        arguments: interruption.arguments ? JSON.parse(interruption.arguments) : null,
      };
      await savePendingApproval(session.id, runResult.state.toString(), approval);
      return Response.json({ status: "pending", approval, mode: "live" });
    }

    if (session.status !== "pending_approval") {
      return Response.json({ error: "Request approval before resolving this action." }, { status: 409 });
    }

    if (session.mode === "demo") {
      const actionPlan = demoActionPlan(result, parsed.data.decision === "approve");
      await resolveDecisionApproval(session.id, actionPlan.status, actionPlan);
      return Response.json({ status: actionPlan.status, actionPlan, mode: "demo" });
    }

    if (!session.runState) throw new Error("The persisted approval state is missing.");
    const model = process.env.OPENAI_PLANNER_MODEL ?? process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5.6-terra";
    const agent = createActionPlannerAgent(model);
    const state = await RunState.fromString(agent, session.runState);
    const interruptions = state.getInterruptions();
    if (!interruptions.length) throw new Error("The persisted run has no pending approval.");

    for (const interruption of interruptions) {
      if (parsed.data.decision === "approve") state.approve(interruption);
      else state.reject(interruption, { message: "The decision owner rejected this action. No implementation plan was accepted." });
    }

    const resumed = await withTrace(
      "Decision Room action approval resume",
      () => run(agent, state, {
        maxTurns: 4,
        toolExecution: { preApprovalInputGuardrails: true },
      }),
      { groupId: session.id, metadata: { decisionId: session.id, workflowVersion: "decision-room-v3" } },
    );
    if (!resumed.finalOutput) throw new Error("The resumed planner returned no final output.");
    const actionPlan = ActionPlanSchema.parse(resumed.finalOutput);
    await resolveDecisionApproval(session.id, actionPlan.status, actionPlan);
    return Response.json({ status: actionPlan.status, actionPlan, mode: "live" });
  } catch (error) {
    console.error("Decision approval failed", error);
    return Response.json({ error: "The approval workflow could not be completed." }, { status: 502 });
  }
}
