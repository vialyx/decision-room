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
  traceId: string | null;
  traceIncludesSensitiveData: false;
};

export type DecisionResult = {
  route: "decision_council";
  mode: "demo" | "live";
  generatedAt: string;
  specialists: SpecialistAnalysis[];
  memo: DecisionMemo;
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
