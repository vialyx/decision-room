export type RiskTolerance = "cautious" | "balanced" | "bold";

export type EvidenceSourceType =
  | "customer_interview"
  | "analytics"
  | "survey"
  | "estimate"
  | "assumption";

export type EvidenceItem = {
  claim: string;
  sourceType: EvidenceSourceType;
};

export type EvidenceAssessment = EvidenceItem & {
  reliability: number;
  rating: "low" | "medium" | "high";
  warning: string | null;
};

export type DecisionInput = {
  decision: string;
  context: string;
  options: string[];
  objectives: string;
  riskTolerance: RiskTolerance;
  evidenceItems: EvidenceItem[];
};

export type SpecialistAnalysis = {
  role: string;
  mandate: string;
  stance: string;
  keyInsight: string;
  findings: string[];
  risks: string[];
  recommendation: string;
  confidence: number;
  evidenceAssessments: EvidenceAssessment[];
};

export type DecisionMemo = {
  recommendedOption: string;
  verdict: string;
  summary: string;
  facts: string[];
  assumptions: string[];
  rationale: string[];
  disagreements: string[];
  conditions: string[];
  nextSteps: string[];
  confidence: number;
};

export type DecisionCategory =
  | "product"
  | "engineering"
  | "operations"
  | "employment"
  | "medical"
  | "legal"
  | "financial";

export type GovernanceSummary = {
  decisionId: string;
  intakeRoute: "decision_council" | "clarification";
  handoffDestination: string;
  handoffReason: string;
  decisionCategory: DecisionCategory;
  requiresHumanReview: boolean;
  evidenceToolCalls: number;
  guardrailsPassed: number;
  guardrailsTotal: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  retries: number;
  partialFailures: string[];
  traceId: string | null;
  traceIncludesSensitiveData: false;
};

export type DecisionEvaluation = {
  evidenceGrounding: number;
  disagreementPreserved: number;
  actionability: number;
  reversibility: number;
  unsupportedClaims: string[];
  revisionRequired: boolean;
  revisionInstructions: string[];
  revisionPerformed: boolean;
};

export type DecisionApproval = {
  status: "available" | "pending" | "approved" | "rejected" | "unavailable";
  action: "accept_and_create_action_plan";
  summary: string;
};

export type ActionPlan = {
  status: "approved" | "rejected";
  recommendedOption: string;
  objective: string;
  tasks: Array<{
    title: string;
    ownerRole: string;
    dueInDays: number;
    successMeasure: string;
  }>;
  approvedAt: string | null;
};

export type DecisionResult = {
  route: "decision_council";
  mode: "demo" | "live";
  generatedAt: string;
  specialists: SpecialistAnalysis[];
  memo: DecisionMemo;
  evaluation: DecisionEvaluation;
  approval: DecisionApproval;
  actionPlan: ActionPlan | null;
  governance: GovernanceSummary;
};

export type ClarificationResult = {
  route: "clarification";
  mode: "demo" | "live";
  generatedAt: string;
  reason: string;
  priority: "required" | "recommended";
  missingInformation: string[];
  governance: GovernanceSummary;
};

export type DecisionApiResult = DecisionResult | ClarificationResult;
