import {
  Agent,
  InputGuardrailTripwireTriggered,
  generateTraceId,
  handoff,
  run,
  withCustomSpan,
  withTrace,
} from "@openai/agents";
import type {
  ClarificationResult,
  DecisionInput,
  DecisionResult,
  GovernanceSummary,
  SpecialistAnalysis,
} from "@/lib/decision-types";
import {
  ClarificationHandoffSchema,
  ClarificationSchema,
  CouncilHandoffSchema,
  CouncilReadySchema,
  DecisionRequestSchema,
  EvaluationSchema,
  MemoSchema,
  SpecialistSchema,
  classifyDecision,
  createInputGuardrail,
  createMemoGuardrail,
  findDeterministicClarifications,
  inspectEvidence,
  inspectEvidenceItem,
} from "@/lib/decision-governance";
import { saveDecisionSession } from "@/db/decision-sessions";

export const runtime = "nodejs";

const SPECIALISTS = [
  {
    role: "Researcher",
    mandate: "Interrogate the supplied evidence and separate facts from assumptions.",
    lens: "evidence quality, missing data, base rates, measurable signals, and the fastest way to reduce uncertainty",
  },
  {
    role: "Domain expert",
    mandate: "Judge strategic fit, feasibility, and second-order operating effects.",
    lens: "strategy, sequencing, execution constraints, customer value, and practical tradeoffs",
  },
  {
    role: "Skeptic",
    mandate: "Build the strongest credible case against the apparent consensus.",
    lens: "hidden assumptions, opportunity cost, failure modes, incentives, and reasons the obvious answer could be wrong",
  },
  {
    role: "Risk analyst",
    mandate: "Map downside exposure and design reversible safeguards.",
    lens: "likelihood, impact, reversibility, leading indicators, stop conditions, and mitigation",
  },
] as const;

type IntakeHandoffRecord = {
  destination: "Clarification Agent" | "Decision Council Coordinator";
  reason: string;
  priority: "required" | "recommended";
};

type WorkflowTelemetry = {
  inputTokens: number;
  outputTokens: number;
  retries: number;
  partialFailures: string[];
};

function recordUsage(telemetry: WorkflowTelemetry, result: { runContext: { usage: { inputTokens: number; outputTokens: number } } }) {
  telemetry.inputTokens += result.runContext.usage.inputTokens;
  telemetry.outputTokens += result.runContext.usage.outputTokens;
}

async function withReliability<T>(operation: (signal: AbortSignal) => Promise<T>, telemetry: WorkflowTelemetry, timeoutMs = 45_000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Agent run timed out.")), timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      lastError = error;
      if (error instanceof InputGuardrailTripwireTriggered || attempt === 1) throw error;
      telemetry.retries += 1;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function buildBrief(input: DecisionInput) {
  const evidence = input.evidenceItems.length
    ? input.evidenceItems.map((item, index) => `${index + 1}. [${item.sourceType}] ${item.claim}`).join("\n")
    : "No explicit evidence items were attached.";

  return [
    `DECISION: ${input.decision}`,
    `CONTEXT: ${input.context}`,
    `OPTIONS: ${input.options.join(" | ")}`,
    `SUCCESS CRITERIA: ${input.objectives}`,
    `RISK POSTURE: ${input.riskTolerance}`,
    `EVIDENCE ITEMS:\n${evidence}`,
  ].join("\n");
}

function traceOptions(decisionId: string, input: DecisionInput) {
  return {
    groupId: decisionId,
    traceIncludeSensitiveData: false as const,
    traceMetadata: {
      decisionId,
      riskTolerance: input.riskTolerance,
      optionCount: String(input.options.length),
      evidenceCount: String(input.evidenceItems.length),
      workflowVersion: "decision-room-v3",
    },
  };
}

async function runLiveIntake(input: DecisionInput, decisionId: string, telemetry: WorkflowTelemetry) {
  const intakeModel = process.env.OPENAI_INTAKE_MODEL ?? process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5.6-terra";
  const safety = classifyDecision(input);
  const deterministicGaps = findDeterministicClarifications(input, safety);
  let handoffRecord: IntakeHandoffRecord | null = null;

  const clarificationAgent = new Agent({
    name: "Clarification Agent",
    model: intakeModel,
    modelSettings: { reasoning: { effort: "low" }, text: { verbosity: "low" } },
    instructions: [
      "You own incomplete decision briefs after intake hands them off.",
      "Return the exact missing information needed to make the options comparable and the objective decision-grade.",
      "Do not make a recommendation and do not invent context.",
    ].join(" "),
    outputType: ClarificationSchema,
  });

  const councilCoordinator = new Agent({
    name: "Decision Council Coordinator",
    model: intakeModel,
    modelSettings: { reasoning: { effort: "low" }, text: { verbosity: "low" } },
    instructions: [
      "You receive decision briefs that intake has judged ready for the full council.",
      "Confirm readiness concisely. Do not analyze the options or make the decision.",
    ].join(" "),
    outputType: CouncilReadySchema,
  });

  const clarificationHandoff = handoff(clarificationAgent, {
    inputType: ClarificationHandoffSchema,
    toolDescriptionOverride: "Transfer control when the brief needs clarification before specialist analysis.",
    onHandoff: (_context, payload) => {
      handoffRecord = {
        destination: "Clarification Agent",
        reason: payload?.reason ?? "The brief needs clarification.",
        priority: payload?.priority ?? "required",
      };
    },
  });

  const councilHandoff = handoff(councilCoordinator, {
    inputType: CouncilHandoffSchema,
    toolDescriptionOverride: "Transfer control when the brief is complete enough for the deterministic specialist council.",
    onHandoff: (_context, payload) => {
      handoffRecord = {
        destination: "Decision Council Coordinator",
        reason: payload?.reason ?? "The brief is ready for specialist analysis.",
        priority: "recommended",
      };
    },
  });

  const intakeAgent = Agent.create({
    name: "Intake Agent",
    model: intakeModel,
    modelSettings: { reasoning: { effort: "medium" }, text: { verbosity: "low" } },
    instructions: [
      "You route decision briefs; you never answer them yourself.",
      "You must invoke exactly one handoff.",
      "Hand off to Clarification Agent if options overlap, objectives are not measurable, material constraints are absent, or multiple decisions are combined.",
      "Hand off to Decision Council Coordinator when the brief is sufficiently specified for independent analysis.",
      safety.requiresHumanReview
        ? "This is a high-stakes category. Require a named qualified human reviewer before routing to the council."
        : "This brief is not in a high-stakes category.",
      deterministicGaps.length ? `Known gaps: ${deterministicGaps.join(" ")}` : "No deterministic completeness gaps were found.",
    ].join(" "),
    handoffs: [clarificationHandoff, councilHandoff],
    inputGuardrails: [createInputGuardrail(safety)],
  });

  const result = await withReliability(
    (signal) => run(intakeAgent, buildBrief(input), {
      maxTurns: 3,
      signal,
      ...traceOptions(decisionId, input),
    }),
    telemetry,
  );
  recordUsage(telemetry, result);

  const completedHandoff = handoffRecord as IntakeHandoffRecord | null;
  if (!result.finalOutput || !completedHandoff) throw new Error("Intake did not complete a handoff.");

  if (result.lastAgent?.name === "Clarification Agent") {
    return {
      route: "clarification" as const,
      output: ClarificationSchema.parse(result.finalOutput),
      handoff: completedHandoff,
      inputGuardrailsPassed: result.inputGuardrailResults.length,
    };
  }

  CouncilReadySchema.parse(result.finalOutput);
  return {
    route: "decision_council" as const,
    handoff: completedHandoff,
    inputGuardrailsPassed: result.inputGuardrailResults.length,
  };
}

async function runLiveWorkflow(input: DecisionInput, decisionId: string, startedAt: number): Promise<DecisionResult | ClarificationResult> {
  const traceId = generateTraceId();
  const specialistModel = process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5.6-terra";
  const chairModel = process.env.OPENAI_CHAIR_MODEL ?? "gpt-5.6-sol";
  const safety = classifyDecision(input);
  const brief = buildBrief(input);
  const telemetry: WorkflowTelemetry = { inputTokens: 0, outputTokens: 0, retries: 0, partialFailures: [] };

  return withTrace("Decision Room governed workflow", async () => {
    const intake = await withCustomSpan(
      () => runLiveIntake(input, decisionId, telemetry),
      { data: { name: "intake-routing" } },
    );

    if (intake.route === "clarification") {
      return {
        route: "clarification",
        mode: "live",
        generatedAt: new Date().toISOString(),
        ...intake.output,
        governance: {
          decisionId,
          intakeRoute: "clarification",
          handoffDestination: intake.handoff.destination,
          handoffReason: intake.handoff.reason,
          decisionCategory: safety.decisionCategory,
          requiresHumanReview: safety.requiresHumanReview,
          evidenceToolCalls: 0,
          guardrailsPassed: intake.inputGuardrailsPassed,
          guardrailsTotal: 1,
          durationMs: Date.now() - startedAt,
          inputTokens: telemetry.inputTokens,
          outputTokens: telemetry.outputTokens,
          estimatedCostUsd: null,
          retries: telemetry.retries,
          partialFailures: telemetry.partialFailures,
          traceId,
          traceIncludesSensitiveData: false,
        },
      } satisfies ClarificationResult;
    }

    const settledSpecialists = await withCustomSpan(
      () => Promise.allSettled(SPECIALISTS.map(async (specialist) => {
        const isResearcher = specialist.role === "Researcher";
        const agent = new Agent({
          name: specialist.role,
          model: specialistModel,
          modelSettings: {
            reasoning: { effort: "medium" },
            text: { verbosity: "low" },
          },
          instructions: [
            `You are the ${specialist.role} in a decision council.`,
            `Your mandate: ${specialist.mandate}`,
            `Analyze only through this lens: ${specialist.lens}.`,
            "Take a clear position. Use only the supplied brief; label uncertainty instead of inventing facts.",
            "Make findings specific and decision-relevant. The recommendation must be actionable.",
            isResearcher
              ? "For every attached evidence item, call inspect_evidence and copy the returned classifications into evidenceAssessments. If none are attached, return an empty evidenceAssessments array."
              : "Return an empty evidenceAssessments array; evidence classification belongs to the Researcher.",
          ].join(" "),
          tools: isResearcher ? [inspectEvidence] : [],
          outputType: SpecialistSchema,
        });

        const result = await withCustomSpan(
          () => withReliability(
            (signal) => run(agent, brief, { maxTurns: 4, signal, ...traceOptions(decisionId, input) }),
            telemetry,
          ),
          { data: { name: `specialist-${specialist.role.toLowerCase().replaceAll(" ", "-")}` } },
        );
        recordUsage(telemetry, result);
        if (!result.finalOutput) throw new Error(`${specialist.role} returned no analysis.`);
        return {
          analysis: SpecialistSchema.parse(result.finalOutput),
          toolInputGuardrails: result.toolInputGuardrailResults.length,
          toolOutputGuardrails: result.toolOutputGuardrailResults.length,
        };
      })),
      { data: { name: "specialist-fan-out" } },
    );

    const specialistResults = settledSpecialists.map((settled, index) => {
      if (settled.status === "fulfilled") return settled.value;
      const specialist = SPECIALISTS[index];
      telemetry.partialFailures.push(specialist.role);
      return {
        analysis: {
          role: specialist.role,
          mandate: specialist.mandate,
          stance: "Analysis unavailable",
          keyInsight: "This specialist failed after the bounded retry; the chair must reduce confidence and avoid assuming this perspective agreed.",
          findings: [
            "No specialist findings were produced.",
            "Treat this perspective as missing, not neutral.",
            "Prefer a reversible recommendation until the analysis can be rerun.",
          ],
          risks: ["Missing independent perspective", "False confidence from partial consensus"],
          recommendation: "Do not make an irreversible commitment without reviewing the missing perspective.",
          confidence: 0,
          evidenceAssessments: [],
        },
        toolInputGuardrails: 0,
        toolOutputGuardrails: 0,
      };
    });

    if (telemetry.partialFailures.length > 1) {
      throw new Error("More than one specialist failed; the council cannot produce a decision-grade memo.");
    }

    const specialists = specialistResults.map((result) => result.analysis);
    const evidenceToolCalls = specialistResults.reduce((total, result) => total + result.toolInputGuardrails, 0);
    const toolGuardrailsPassed = specialistResults.reduce(
      (total, result) => total + result.toolInputGuardrails + result.toolOutputGuardrails,
      0,
    );

    const chair = new Agent({
      name: "Chairperson",
      model: chairModel,
      modelSettings: {
        reasoning: { effort: "high" },
        text: { verbosity: "medium" },
      },
      instructions: [
        "You chair a decision council. Produce the final recommendation from the original brief and four independent analyses.",
        "Set recommendedOption to exactly one option from the brief. Do not decide by majority vote.",
        "Separate supplied facts from assumptions. Never invent evidence or imply that an assumption was verified.",
        "Preserve material disagreement and include measurable conditions that would genuinely stop or reverse the recommendation.",
        safety.requiresHumanReview
          ? "This is high-stakes advice. State clearly that a qualified human retains final authority."
          : "Make clear that the recommendation is advisory and no external action has been taken.",
      ].join(" "),
      outputType: MemoSchema,
      outputGuardrails: [createMemoGuardrail(input)],
    });

    const synthesisInput = `${brief}\n\nSPECIALIST ANALYSES:\n${JSON.stringify(specialists, null, 2)}`;
    const chairResult = await withCustomSpan(
      () => withReliability(
        (signal) => run(chair, synthesisInput, { maxTurns: 3, signal, ...traceOptions(decisionId, input) }),
        telemetry,
      ),
      { data: { name: "chair-synthesis-and-validation" } },
    );
    recordUsage(telemetry, chairResult);
    if (!chairResult.finalOutput) throw new Error("The chairperson returned no memo.");

    let finalMemo = MemoSchema.parse(chairResult.finalOutput);
    const evaluatorModel = process.env.OPENAI_EVALUATOR_MODEL ?? specialistModel;
    const evaluator = new Agent({
      name: "Decision Quality Evaluator",
      model: evaluatorModel,
      modelSettings: { reasoning: { effort: "medium" }, text: { verbosity: "low" } },
      instructions: [
        "Evaluate the chair memo against explicit acceptance criteria, not style preference.",
        "Score evidence grounding, disagreement preservation, actionability, and reversibility from 1 to 5.",
        "List unsupported claims. Require revision if any score is below 4 or any material unsupported claim exists.",
        "Revision instructions must be concrete and limited to the identified defects.",
      ].join(" "),
      outputType: EvaluationSchema,
    });
    const evaluationResult = await withCustomSpan(
      () => withReliability(
        (signal) => run(evaluator, `${brief}\n\nMEMO TO EVALUATE:\n${JSON.stringify(finalMemo, null, 2)}`, {
          maxTurns: 2,
          signal,
          ...traceOptions(decisionId, input),
        }),
        telemetry,
      ),
      { data: { name: "decision-quality-evaluation" } },
    );
    recordUsage(telemetry, evaluationResult);
    if (!evaluationResult.finalOutput) throw new Error("The evaluator returned no quality assessment.");
    const evaluationDraft = EvaluationSchema.parse(evaluationResult.finalOutput);
    let revisionPerformed = false;

    if (evaluationDraft.revisionRequired) {
      const revisionInput = [
        synthesisInput,
        `DRAFT MEMO:\n${JSON.stringify(finalMemo, null, 2)}`,
        `EVALUATOR INSTRUCTIONS:\n${evaluationDraft.revisionInstructions.join("\n")}`,
        "Revise once. Preserve correct content and address only the evaluator's defects.",
      ].join("\n\n");
      const revisionResult = await withCustomSpan(
        () => withReliability(
          (signal) => run(chair, revisionInput, { maxTurns: 3, signal, ...traceOptions(decisionId, input) }),
          telemetry,
        ),
        { data: { name: "bounded-chair-revision" } },
      );
      recordUsage(telemetry, revisionResult);
      if (!revisionResult.finalOutput) throw new Error("The bounded chair revision returned no memo.");
      finalMemo = MemoSchema.parse(revisionResult.finalOutput);
      revisionPerformed = true;
    }

    const outputGuardrailsPassed = chairResult.outputGuardrailResults.length + (revisionPerformed ? 1 : 0);
    const guardrailsPassed = intake.inputGuardrailsPassed + toolGuardrailsPassed + outputGuardrailsPassed;

    return {
      route: "decision_council",
      mode: "live",
      generatedAt: new Date().toISOString(),
      specialists,
      memo: finalMemo,
      evaluation: { ...evaluationDraft, revisionPerformed },
      approval: {
        status: "available",
        action: "accept_and_create_action_plan",
        summary: "A human decision owner must approve before an implementation plan is accepted.",
      },
      actionPlan: null,
      governance: {
        decisionId,
        intakeRoute: "decision_council",
        handoffDestination: intake.handoff.destination,
        handoffReason: intake.handoff.reason,
        decisionCategory: safety.decisionCategory,
        requiresHumanReview: safety.requiresHumanReview,
        evidenceToolCalls,
        guardrailsPassed,
        guardrailsTotal: guardrailsPassed,
        durationMs: Date.now() - startedAt,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        estimatedCostUsd: null,
        retries: telemetry.retries,
        partialFailures: telemetry.partialFailures,
        traceId,
        traceIncludesSensitiveData: false,
      },
    } satisfies DecisionResult;
  }, {
    traceId,
    groupId: decisionId,
    metadata: {
      decisionId,
      riskTolerance: input.riskTolerance,
      optionCount: input.options.length,
      evidenceCount: input.evidenceItems.length,
      mode: "live",
      workflowVersion: "decision-room-v3",
    },
  });
}

function makeGovernance(input: DecisionInput, decisionId: string, startedAt: number, route: "decision_council" | "clarification", reason: string): GovernanceSummary {
  const safety = classifyDecision(input);
  const toolCalls = route === "decision_council" ? input.evidenceItems.length : 0;
  const guardrails = route === "clarification" ? 1 : toolCalls ? 3 : 2;
  return {
    decisionId,
    intakeRoute: route,
    handoffDestination: route === "clarification" ? "Clarification Agent" : "Decision Council Coordinator",
    handoffReason: reason,
    decisionCategory: safety.decisionCategory,
    requiresHumanReview: safety.requiresHumanReview,
    evidenceToolCalls: toolCalls,
    guardrailsPassed: guardrails,
    guardrailsTotal: guardrails,
    durationMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    retries: 0,
    partialFailures: [],
    traceId: null,
    traceIncludesSensitiveData: false,
  };
}

function demoCouncil(input: DecisionInput, decisionId: string, startedAt: number): DecisionResult {
  const [primary, secondary] = input.options;
  const cautious = input.riskTolerance === "cautious";
  const verdict = cautious ? `Pilot ${primary.toLowerCase()} behind strict gates` : `Proceed with ${primary.toLowerCase()}, conditionally`;
  const evidenceAssessments = input.evidenceItems.map((item) => inspectEvidenceItem(item.claim, item.sourceType));

  const specialists: SpecialistAnalysis[] = [
    {
      role: "Researcher",
      mandate: SPECIALISTS[0].mandate,
      stance: "Evidence supports a test",
      keyInsight: "The current signals justify learning, but not yet an irreversible commitment.",
      findings: [
        evidenceAssessments.length ? `${evidenceAssessments.filter((item) => item.rating === "high").length} attached evidence item(s) rate as high reliability.` : "No explicit evidence items were attached to the brief.",
        "Observed demand is directional evidence, not proof of willingness to pay.",
        "Activation and retention by team cohort are the missing decision-grade metrics.",
      ],
      risks: ["Selection bias in feature requests", "Unclear conversion baseline"],
      recommendation: `Run ${primary.toLowerCase()} with explicit success thresholds.`,
      confidence: 78,
      evidenceAssessments,
    },
    {
      role: "Domain expert",
      mandate: SPECIALISTS[1].mandate,
      stance: "Move, but narrow the scope",
      keyInsight: "A focused release can validate the commercial thesis without turning the roadmap into a platform rewrite.",
      findings: ["The decision aligns with the stated expansion objective.", "Support capacity is a real launch constraint.", "A deliberately small promise is easier to operate and reverse."],
      risks: ["Scope expansion", "Support load"],
      recommendation: `Choose ${primary.toLowerCase()} with a small customer cohort and fixed scope.`,
      confidence: 84,
      evidenceAssessments: [],
    },
    {
      role: "Skeptic",
      mandate: SPECIALISTS[2].mandate,
      stance: `Prefer ${secondary.toLowerCase()}`,
      keyInsight: "Feature interest can masquerade as purchase intent while the real cost appears in operations.",
      findings: ["The proposal assumes demand will translate into expansion revenue.", "The estimate excludes support and billing complexity.", "A launch could distract from reliability before the commercial case is established."],
      risks: ["Opportunity cost", "Weak monetization signal"],
      recommendation: `Start with ${secondary.toLowerCase()} and require paid commitments before broadening.`,
      confidence: 72,
      evidenceAssessments: [],
    },
    {
      role: "Risk analyst",
      mandate: SPECIALISTS[3].mandate,
      stance: "Proceed only with stop conditions",
      keyInsight: "The largest downside is not the build—it is an open-ended operational commitment after launch.",
      findings: ["A staged release keeps most downside reversible.", "Support volume and reliability must be leading indicators.", "A named owner and fixed review date reduce continuation bias."],
      risks: ["Operational drag", "No clear exit threshold"],
      recommendation: "Define capacity, reliability, and conversion gates before the first customer enters.",
      confidence: 81,
      evidenceAssessments: [],
    },
  ];

  return {
    route: "decision_council",
    mode: "demo",
    generatedAt: new Date().toISOString(),
    specialists,
    memo: {
      recommendedOption: primary,
      verdict,
      summary: `The room supports a reversible version of ${primary.toLowerCase()}, not a full-scale commitment. The available signals justify action, while incomplete purchase evidence and constrained support capacity argue for a gated release with a fixed review point.`,
      facts: [input.context, `The stated risk posture is ${input.riskTolerance}.`],
      assumptions: ["Interest in the proposal may translate into paid adoption."],
      rationale: ["The decision advances the stated objective while preserving an exit path.", "Independent signals point toward demand, but the commercial evidence is incomplete.", "A narrow cohort converts the largest uncertainties into measurable outcomes."],
      disagreements: [`The domain expert favors ${primary.toLowerCase()}, while the skeptic prefers ${secondary.toLowerCase()}.`, "The council disagrees on whether current usage is strong evidence of willingness to pay."],
      conditions: ["Pause if weekly support load exceeds the team’s agreed capacity.", "Reverse course if the 30-day test misses its paid-conversion threshold.", "Expand only if retention holds without a reliability decline."],
      nextSteps: ["Write a one-page pilot charter with cohort size, price, metrics, stop conditions, and a 30-day review date.", "Recruit five representative teams willing to make a paid commitment."],
      confidence: 82,
    },
    evaluation: {
      evidenceGrounding: evidenceAssessments.length ? 4 : 3,
      disagreementPreserved: 5,
      actionability: 5,
      reversibility: 5,
      unsupportedClaims: [],
      revisionRequired: evidenceAssessments.length === 0,
      revisionInstructions: evidenceAssessments.length === 0 ? ["Make the absence of attached evidence explicit and reduce confidence."] : [],
      revisionPerformed: evidenceAssessments.length === 0,
    },
    approval: {
      status: "available",
      action: "accept_and_create_action_plan",
      summary: "A human decision owner must approve before an implementation plan is accepted.",
    },
    actionPlan: null,
    governance: makeGovernance(input, decisionId, startedAt, "decision_council", "The brief is complete enough for independent specialist analysis."),
  };
}

function demoClarification(input: DecisionInput, decisionId: string, startedAt: number, missingInformation: string[]): ClarificationResult {
  const reason = "Intake found material gaps that would make specialist analysis less reliable.";
  return {
    route: "clarification",
    mode: "demo",
    generatedAt: new Date().toISOString(),
    reason,
    priority: "required",
    missingInformation,
    governance: makeGovernance(input, decisionId, startedAt, "clarification", reason),
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const decisionId = `dec_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  try {
    const parsed = DecisionRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "The brief needs a clear decision, context, objective, and at least two options." }, { status: 400 });
    }

    const input = parsed.data as DecisionInput;
    const safety = classifyDecision(input);
    if (!safety.safeToProcess) {
      return Response.json({
        error: safety.reason,
        code: "input_guardrail",
        decisionId,
        decisionCategory: safety.decisionCategory,
      }, { status: 422 });
    }

    let result: DecisionResult | ClarificationResult;
    if (process.env.OPENAI_API_KEY) {
      result = await runLiveWorkflow(input, decisionId, startedAt);
    } else {
      const missing = findDeterministicClarifications(input, safety);
      result = missing.length
        ? demoClarification(input, decisionId, startedAt, missing)
        : demoCouncil(input, decisionId, startedAt);
    }

    let persisted = false;
    try {
      persisted = await saveDecisionSession({ id: decisionId, mode: result.mode, input, result });
    } catch (persistenceError) {
      console.error("Decision session persistence failed", persistenceError);
    }
    if (result.route === "decision_council" && !persisted) {
      result.approval = {
        status: "unavailable",
        action: "accept_and_create_action_plan",
        summary: "Configure the D1 binding to persist approval state before accepting this recommendation.",
      };
    }

    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof InputGuardrailTripwireTriggered) {
      return Response.json({ error: "The decision brief was blocked by the input guardrail.", code: "input_guardrail", decisionId }, { status: 422 });
    }
    console.error("Decision council failed", error);
    return Response.json({ error: "The governed council session was interrupted. Please try again." }, { status: 502 });
  }
}
