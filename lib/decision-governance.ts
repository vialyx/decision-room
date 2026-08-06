import { tool } from "@openai/agents";
import { z } from "zod";
import type {
  DecisionCategory,
  DecisionInput,
  DecisionMemo,
  EvidenceAssessment,
  EvidenceSourceType,
} from "@/lib/decision-types";

export const EvidenceSourceSchema = z.enum([
  "customer_interview",
  "analytics",
  "survey",
  "estimate",
  "assumption",
]);

export const EvidenceItemSchema = z.object({
  claim: z.string().trim().min(4).max(400),
  sourceType: EvidenceSourceSchema,
});

export const EvidenceAssessmentSchema = z.object({
  claim: z.string(),
  sourceType: EvidenceSourceSchema,
  reliability: z.number().int().min(0).max(100),
  rating: z.enum(["low", "medium", "high"]),
  warning: z.string().nullable(),
});

export const DecisionRequestSchema = z.object({
  decision: z.string().trim().min(12).max(240),
  context: z.string().trim().min(20).max(2400),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(5),
  objectives: z.string().trim().min(8).max(800),
  riskTolerance: z.enum(["cautious", "balanced", "bold"]),
  evidenceItems: z.array(EvidenceItemSchema).max(6).default([]),
});

export const SpecialistSchema = z.object({
  role: z.string(),
  mandate: z.string(),
  stance: z.string(),
  keyInsight: z.string(),
  findings: z.array(z.string()).min(3).max(4),
  risks: z.array(z.string()).min(2).max(4),
  recommendation: z.string(),
  confidence: z.number().int().min(0).max(100),
  evidenceAssessments: z.array(EvidenceAssessmentSchema).max(6),
});

export const MemoSchema = z.object({
  recommendedOption: z.string(),
  verdict: z.string(),
  summary: z.string(),
  facts: z.array(z.string()).min(2).max(5),
  assumptions: z.array(z.string()).min(1).max(4),
  rationale: z.array(z.string()).min(3).max(5),
  disagreements: z.array(z.string()).min(2).max(4),
  conditions: z.array(z.string()).min(3).max(4),
  nextSteps: z.array(z.string()).min(2).max(4),
  confidence: z.number().int().min(0).max(100),
});

export const ClarificationSchema = z.object({
  reason: z.string(),
  priority: z.enum(["required", "recommended"]),
  missingInformation: z.array(z.string()).min(1).max(5),
});

export const CouncilReadySchema = z.object({
  reason: z.string(),
  readinessSummary: z.string(),
});

export const ClarificationHandoffSchema = z.object({
  missingInformation: z.array(z.string()).min(1).max(5),
  reason: z.string(),
  priority: z.enum(["required", "recommended"]),
});

export const CouncilHandoffSchema = z.object({
  reason: z.string(),
  readinessSummary: z.string(),
});

const RELIABILITY: Record<EvidenceSourceType, number> = {
  analytics: 90,
  customer_interview: 78,
  survey: 65,
  estimate: 45,
  assumption: 20,
};

const PROMPT_INJECTION = /ignore (all|any|the|previous)|system prompt|developer message|reveal (your|the) instructions|jailbreak|do not follow/i;
const SECRET_PATTERN = /(?:sk-[a-z0-9_-]{12,}|api[_ -]?key|password\s*[:=]|bearer\s+[a-z0-9._-]{12,})/i;
const PERSONAL_DATA = /\b\d{3}-\d{2}-\d{4}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export type SafetyAssessment = {
  safeToProcess: boolean;
  decisionCategory: DecisionCategory;
  requiresHumanReview: boolean;
  reason: string;
};

export function classifyDecision(input: Pick<DecisionInput, "decision" | "context" | "objectives">): SafetyAssessment {
  const text = `${input.decision}\n${input.context}\n${input.objectives}`;
  const category: DecisionCategory = /hire|fire|layoff|promotion|employee|candidate/i.test(text)
    ? "employment"
    : /diagnos|treatment|patient|medical|clinical/i.test(text)
      ? "medical"
      : /lawsuit|contract|legal|compliance|regulat/i.test(text)
        ? "legal"
        : /invest|loan|portfolio|financial|credit/i.test(text)
          ? "financial"
          : /deploy|architecture|technical|engineering|database/i.test(text)
            ? "engineering"
            : /support|vendor|process|operations|capacity/i.test(text)
              ? "operations"
              : "product";

  if (PROMPT_INJECTION.test(text)) {
    return { safeToProcess: false, decisionCategory: category, requiresHumanReview: true, reason: "Prompt-injection instructions were detected in the brief." };
  }
  if (SECRET_PATTERN.test(text)) {
    return { safeToProcess: false, decisionCategory: category, requiresHumanReview: true, reason: "The brief appears to contain a secret or credential." };
  }
  if (PERSONAL_DATA.test(text)) {
    return { safeToProcess: false, decisionCategory: category, requiresHumanReview: true, reason: "Remove personal data before sending this brief to the council." };
  }

  const requiresHumanReview = ["employment", "medical", "legal", "financial"].includes(category);
  return {
    safeToProcess: true,
    decisionCategory: category,
    requiresHumanReview,
    reason: requiresHumanReview
      ? "This is a high-stakes category; the council may advise, but a qualified human must make the decision."
      : "The brief passed the blocking input checks.",
  };
}

export function findDeterministicClarifications(input: DecisionInput, safety: SafetyAssessment): string[] {
  const missing: string[] = [];
  const normalized = input.options.map((option) => option.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  if (new Set(normalized).size !== normalized.length) missing.push("Make each option distinct and non-overlapping.");
  if (/\b(and|plus)\b/i.test(input.decision) && input.decision.split(/\b(?:and|plus)\b/i).length > 2) {
    missing.push("Separate the combined request into one decision at a time.");
  }
  if (!/\d|increase|decrease|reduce|avoid|maintain|validate|improve|protect|within|without/i.test(input.objectives)) {
    missing.push("Define a measurable objective or explicit success criterion.");
  }
  if (safety.requiresHumanReview) missing.push("Name the qualified human who will review the recommendation before action.");
  return missing;
}

export function inspectEvidenceItem(claim: string, sourceType: EvidenceSourceType): EvidenceAssessment {
  const reliability = RELIABILITY[sourceType];
  return {
    claim,
    sourceType,
    reliability,
    rating: reliability >= 75 ? "high" : reliability >= 45 ? "medium" : "low",
    warning: sourceType === "assumption"
      ? "This is an assumption, not independently verified evidence."
      : sourceType === "estimate"
        ? "Validate the estimate against observed outcomes before making an irreversible commitment."
        : null,
  };
}

export const inspectEvidence = tool({
  name: "inspect_evidence",
  description: "Evaluate one supplied evidence item and classify its reliability using deterministic business rules.",
  parameters: EvidenceItemSchema,
  outputSchema: EvidenceAssessmentSchema,
  inputGuardrails: [{
    name: "evidence_argument_safety",
    run: async ({ toolCall }) => {
      try {
        const parsed = EvidenceItemSchema.parse(JSON.parse(toolCall.arguments));
        if (PROMPT_INJECTION.test(parsed.claim) || SECRET_PATTERN.test(parsed.claim) || PERSONAL_DATA.test(parsed.claim)) {
          return { behavior: { type: "rejectContent", message: "Evidence was rejected because it contains unsafe instructions, secrets, or personal data." }, outputInfo: { safe: false } } as const;
        }
        return { behavior: { type: "allow" }, outputInfo: { safe: true } } as const;
      } catch {
        return { behavior: { type: "throwException" }, outputInfo: { safe: false, reason: "Malformed evidence arguments" } } as const;
      }
    },
  }],
  outputGuardrails: [{
    name: "evidence_result_integrity",
    run: async ({ output }) => {
      const valid = EvidenceAssessmentSchema.safeParse(output).success;
      return valid
        ? { behavior: { type: "allow" }, outputInfo: { valid: true } } as const
        : { behavior: { type: "throwException" }, outputInfo: { valid: false } } as const;
    },
  }],
  execute: async ({ claim, sourceType }) => inspectEvidenceItem(claim, sourceType),
});

export function createInputGuardrail(safety: SafetyAssessment) {
  return {
    name: "decision_brief_safety",
    runInParallel: false,
    execute: async () => ({
      tripwireTriggered: !safety.safeToProcess,
      outputInfo: safety,
    }),
  };
}

export function createMemoGuardrail(input: DecisionInput) {
  return {
    name: "decision_grade_memo",
    execute: async ({ agentOutput }: { agentOutput: unknown }) => {
      const parsed = MemoSchema.safeParse(agentOutput);
      if (!parsed.success) return { tripwireTriggered: true, outputInfo: { reason: "Memo shape was invalid." } };

      const memo = parsed.data as DecisionMemo;
      const selected = input.options.some((option) => option.toLowerCase() === memo.recommendedOption.trim().toLowerCase());
      const measurableConditions = memo.conditions.filter((condition) => /\d|if|when|until|threshold|exceed|below|above|pause|stop|reverse/i.test(condition)).length;
      const responsible = selected
        && memo.disagreements.length >= 2
        && memo.facts.length >= 2
        && memo.assumptions.length >= 1
        && measurableConditions >= 2;

      return {
        tripwireTriggered: !responsible,
        outputInfo: {
          selectedKnownOption: selected,
          disagreementPreserved: memo.disagreements.length >= 2,
          factsSeparatedFromAssumptions: memo.facts.length >= 2 && memo.assumptions.length >= 1,
          measurableStopConditions: measurableConditions,
        },
      };
    },
  };
}
