export type RiskTolerance = "cautious" | "balanced" | "bold";

export type DecisionInput = {
  decision: string;
  context: string;
  options: string[];
  objectives: string;
  riskTolerance: RiskTolerance;
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
};

export type DecisionMemo = {
  verdict: string;
  summary: string;
  rationale: string[];
  disagreements: string[];
  conditions: string[];
  nextSteps: string[];
  confidence: number;
};

export type DecisionResult = {
  mode: "demo" | "live";
  generatedAt: string;
  specialists: SpecialistAnalysis[];
  memo: DecisionMemo;
};
