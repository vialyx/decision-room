import { Agent, run } from "@openai/agents";
import { z } from "zod";
import type { DecisionInput, DecisionResult, SpecialistAnalysis } from "@/lib/decision-types";

export const runtime = "nodejs";

const DecisionRequestSchema = z.object({
  decision: z.string().trim().min(12).max(240),
  context: z.string().trim().min(20).max(2400),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(5),
  objectives: z.string().trim().min(8).max(800),
  riskTolerance: z.enum(["cautious", "balanced", "bold"]),
});

const SpecialistSchema = z.object({
  role: z.string(),
  mandate: z.string(),
  stance: z.string(),
  keyInsight: z.string(),
  findings: z.array(z.string()).min(3).max(4),
  risks: z.array(z.string()).min(2).max(4),
  recommendation: z.string(),
  confidence: z.number().int().min(0).max(100),
});

const MemoSchema = z.object({
  verdict: z.string(),
  summary: z.string(),
  rationale: z.array(z.string()).min(3).max(5),
  disagreements: z.array(z.string()).min(2).max(4),
  conditions: z.array(z.string()).min(3).max(4),
  nextSteps: z.array(z.string()).min(2).max(4),
  confidence: z.number().int().min(0).max(100),
});

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

function buildBrief(input: DecisionInput) {
  return [
    `DECISION: ${input.decision}`,
    `CONTEXT: ${input.context}`,
    `OPTIONS: ${input.options.join(" | ")}`,
    `SUCCESS CRITERIA: ${input.objectives}`,
    `RISK POSTURE: ${input.riskTolerance}`,
  ].join("\n");
}

async function runLiveCouncil(input: DecisionInput): Promise<DecisionResult> {
  const specialistModel = process.env.OPENAI_SPECIALIST_MODEL ?? "gpt-5.6-terra";
  const chairModel = process.env.OPENAI_CHAIR_MODEL ?? "gpt-5.6-sol";
  const brief = buildBrief(input);

  const specialistRuns = SPECIALISTS.map(async (specialist) => {
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
      ].join(" "),
      outputType: SpecialistSchema,
    });

    const result = await run(agent, brief, { maxTurns: 3 });
    if (!result.finalOutput) throw new Error(`${specialist.role} returned no analysis.`);
    return SpecialistSchema.parse(result.finalOutput);
  });

  const specialists = await Promise.all(specialistRuns);
  const chair = new Agent({
    name: "Chairperson",
    model: chairModel,
    modelSettings: {
      reasoning: { effort: "high" },
      text: { verbosity: "medium" },
    },
    instructions: [
      "You chair a decision council. Produce the final recommendation from the original brief and four independent analyses.",
      "Do not decide by majority vote. Weigh evidence quality, surface real disagreement, and match the recommendation to the stated risk posture.",
      "Prefer reversible next steps when uncertainty is material. State conditions that would genuinely reverse the recommendation.",
      "Lead with a crisp verdict. Preserve important caveats without hedging the decision away.",
    ].join(" "),
    outputType: MemoSchema,
  });

  const synthesisInput = `${brief}\n\nSPECIALIST ANALYSES:\n${JSON.stringify(specialists, null, 2)}`;
  const chairResult = await run(chair, synthesisInput, { maxTurns: 3 });
  if (!chairResult.finalOutput) throw new Error("The chairperson returned no memo.");

  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    specialists,
    memo: MemoSchema.parse(chairResult.finalOutput),
  };
}

function demoCouncil(input: DecisionInput): DecisionResult {
  const [primary, secondary] = input.options;
  const cautious = input.riskTolerance === "cautious";
  const verdict = cautious ? `Pilot ${primary.toLowerCase()} behind strict gates` : `Proceed with ${primary.toLowerCase()}, conditionally`;

  const specialists: SpecialistAnalysis[] = [
    {
      role: "Researcher",
      mandate: SPECIALISTS[0].mandate,
      stance: "Evidence supports a test",
      keyInsight: "The current signals justify learning, but not yet an irreversible commitment.",
      findings: [
        "Observed demand is directional evidence, not proof of willingness to pay.",
        "The six-week estimate creates a relatively affordable learning window.",
        "Activation and retention by team cohort are the missing decision-grade metrics.",
      ],
      risks: ["Selection bias in feature requests", "Unclear conversion baseline"],
      recommendation: `Run ${primary.toLowerCase()} with explicit success thresholds.`,
      confidence: 78,
    },
    {
      role: "Domain expert",
      mandate: SPECIALISTS[1].mandate,
      stance: "Move, but narrow the scope",
      keyInsight: "A focused release can validate the commercial thesis without turning the roadmap into a platform rewrite.",
      findings: [
        "The decision aligns with the stated expansion objective.",
        "Support capacity is a real launch constraint, not a secondary detail.",
        "A deliberately small promise is easier to operate and reverse.",
      ],
      risks: ["Scope expansion", "Support load"],
      recommendation: `Choose ${primary.toLowerCase()} with a small customer cohort and fixed scope.`,
      confidence: 84,
    },
    {
      role: "Skeptic",
      mandate: SPECIALISTS[2].mandate,
      stance: `Prefer ${secondary.toLowerCase()}`,
      keyInsight: "Feature interest can masquerade as purchase intent while the real cost appears in operations.",
      findings: [
        "The proposal assumes demand will translate into expansion revenue.",
        "Six engineering weeks excludes support, documentation, and billing complexity.",
        "A launch could distract from reliability before the commercial case is established.",
      ],
      risks: ["Opportunity cost", "Weak monetization signal"],
      recommendation: `Start with ${secondary.toLowerCase()} and require paid commitments before broadening.`,
      confidence: 72,
    },
    {
      role: "Risk analyst",
      mandate: SPECIALISTS[3].mandate,
      stance: "Proceed only with stop conditions",
      keyInsight: "The largest downside is not the build—it is an open-ended operational commitment after launch.",
      findings: [
        "A staged release keeps most downside reversible.",
        "Support volume and reliability must be leading indicators, not retrospective lessons.",
        "A named owner and a fixed review date reduce continuation bias.",
      ],
      risks: ["Operational drag", "No clear exit threshold"],
      recommendation: "Define capacity, reliability, and conversion gates before the first customer enters.",
      confidence: 81,
    },
  ];

  return {
    mode: "demo",
    generatedAt: new Date().toISOString(),
    specialists,
    memo: {
      verdict,
      summary: `The room supports a reversible version of ${primary.toLowerCase()}, not a full-scale commitment. The demand signal and manageable build estimate justify action, while weak purchase evidence and constrained support capacity argue for a gated release with a fixed review point.`,
      rationale: [
        "The decision advances the stated objective while preserving an exit path.",
        "Independent signals point toward real demand, but the commercial evidence is incomplete.",
        "A narrow cohort converts the largest uncertainties into measurable outcomes.",
      ],
      disagreements: [
        `The domain expert favors ${primary.toLowerCase()}, while the skeptic prefers ${secondary.toLowerCase()}.`,
        "The council disagrees on whether current usage is strong evidence of willingness to pay.",
      ],
      conditions: [
        "Pause if support load exceeds the team’s agreed weekly capacity.",
        "Reverse course if the test misses its paid-conversion threshold.",
        "Expand only if team retention holds without a reliability decline.",
      ],
      nextSteps: [
        "Write a one-page pilot charter with cohort size, price, success metrics, stop conditions, and a 30-day review date.",
        "Recruit five representative teams willing to make a paid commitment.",
      ],
      confidence: 82,
    },
  };
}

export async function POST(request: Request) {
  try {
    const parsed = DecisionRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "The brief needs a clear decision, context, objective, and at least two options." }, { status: 400 });
    }

    const result = process.env.OPENAI_API_KEY
      ? await runLiveCouncil(parsed.data)
      : demoCouncil(parsed.data);

    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Decision council failed", error);
    return Response.json(
      { error: "The council session was interrupted. Please try again." },
      { status: 502 },
    );
  }
}
