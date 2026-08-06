"use client";

import { FormEvent, useMemo, useState } from "react";
import type {
  DecisionApiResult,
  DecisionInput,
  EvidenceSourceType,
  SpecialistAnalysis,
} from "@/lib/decision-types";

const SAMPLE: DecisionInput = {
  decision: "Should we launch a paid team plan this quarter?",
  context:
    "We have 4,200 active users, 18% weekly team usage, and repeated requests for shared workspaces. Engineering estimates six weeks for an initial release. Growth is strong, but support capacity is tight.",
  options: ["Launch this quarter", "Run a private beta", "Delay until next quarter"],
  objectives:
    "Increase expansion revenue without damaging reliability or distracting from the core product.",
  riskTolerance: "balanced",
  evidenceItems: [
    { claim: "18% of weekly active users collaborate with a team", sourceType: "analytics" },
    { claim: "Shared workspaces are a repeated customer request", sourceType: "customer_interview" },
  ],
};

const EVIDENCE_LABELS: Record<EvidenceSourceType, string> = {
  analytics: "Analytics",
  customer_interview: "Customer interview",
  survey: "Survey",
  estimate: "Estimate",
  assumption: "Assumption",
};

const AGENT_SHELLS = [
  { role: "Researcher", monogram: "RS", tone: "violet" },
  { role: "Domain expert", monogram: "DX", tone: "blue" },
  { role: "Skeptic", monogram: "SK", tone: "coral" },
  { role: "Risk analyst", monogram: "RA", tone: "gold" },
];

function SpecialistCard({ analysis, index }: { analysis: SpecialistAnalysis; index: number }) {
  const shell = AGENT_SHELLS[index] ?? AGENT_SHELLS[0];

  return (
    <article className={`specialist-card tone-${shell.tone}`}>
      <div className="specialist-topline">
        <div className="agent-identity">
          <span className="agent-mark" aria-hidden="true">{shell.monogram}</span>
          <div>
            <p className="eyebrow">Specialist {String(index + 1).padStart(2, "0")}</p>
            <h3>{analysis.role}</h3>
          </div>
        </div>
        <span className="confidence">{analysis.confidence}%</span>
      </div>
      <p className="mandate">{analysis.mandate}</p>
      <div className="position-row">
        <span>Position</span>
        <strong>{analysis.stance}</strong>
      </div>
      <p className="key-insight">“{analysis.keyInsight}”</p>
      <ul className="finding-list">
        {analysis.findings.slice(0, 3).map((finding) => (
          <li key={finding}>{finding}</li>
        ))}
      </ul>
      <div className="agent-recommendation">
        <span>Recommends</span>
        <p>{analysis.recommendation}</p>
      </div>
      {analysis.evidenceAssessments.length > 0 && (
        <div className="evidence-assessment-count">
          Tool-classified evidence · {analysis.evidenceAssessments.length}
        </div>
      )}
    </article>
  );
}

export default function Home() {
  const [brief, setBrief] = useState<DecisionInput>(SAMPLE);
  const [optionDraft, setOptionDraft] = useState("");
  const [evidenceDraft, setEvidenceDraft] = useState("");
  const [evidenceSource, setEvidenceSource] = useState<EvidenceSourceType>("analytics");
  const [result, setResult] = useState<DecisionApiResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  const canRun = useMemo(
    () => brief.decision.trim().length >= 12 && brief.context.trim().length >= 20,
    [brief],
  );

  function update<K extends keyof DecisionInput>(key: K, value: DecisionInput[K]) {
    setBrief((current) => ({ ...current, [key]: value }));
  }

  function addOption() {
    const value = optionDraft.trim();
    if (!value || brief.options.includes(value) || brief.options.length >= 5) return;
    update("options", [...brief.options, value]);
    setOptionDraft("");
  }

  function addEvidence() {
    const claim = evidenceDraft.trim();
    if (!claim || brief.evidenceItems.length >= 6) return;
    update("evidenceItems", [...brief.evidenceItems, { claim, sourceType: evidenceSource }]);
    setEvidenceDraft("");
  }

  async function convene(event: FormEvent) {
    event.preventDefault();
    if (!canRun) return;

    setIsRunning(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brief),
      });
      const payload = (await response.json()) as DecisionApiResult | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : "The room could not reach a decision.");
      }
      setResult(payload as DecisionApiResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something interrupted the session.");
    } finally {
      setIsRunning(false);
    }
  }

  const decisionResult = result?.route === "decision_council" ? result : null;
  const clarification = result?.route === "clarification" ? result : null;

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Decision Room home">
          <span className="brand-seal" aria-hidden="true"><i /><i /><i /></span>
          <span>Decision Room</span>
        </a>
        <div className="header-status">
          <span className="status-dot" />
          <span>4 specialists</span>
          <span className="status-divider" />
          <span>1 chair</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="kicker">MULTI-AGENT DECISION INTELLIGENCE</p>
          <h1>Make the call.<br /><em>See the disagreement.</em></h1>
        </div>
        <p className="hero-copy">
          Bring one consequential decision. A council of independent specialists
          will test it from every angle, then a chairperson will turn the debate
          into a clear, conditional recommendation.
        </p>
      </section>

      <div className="workspace">
        <aside className="brief-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Session brief</p>
              <h2>Frame the decision</h2>
            </div>
            <span className="step-number">01</span>
          </div>

          <form onSubmit={convene}>
            <label className="field">
              <span>Decision</span>
              <textarea
                value={brief.decision}
                onChange={(event) => update("decision", event.target.value)}
                rows={2}
                maxLength={240}
                placeholder="What decision needs to be made?"
              />
              <small>{brief.decision.length}/240</small>
            </label>

            <label className="field">
              <span>Context & evidence</span>
              <textarea
                value={brief.context}
                onChange={(event) => update("context", event.target.value)}
                rows={6}
                maxLength={2400}
                placeholder="Share the facts, constraints, and signals the room should know."
              />
            </label>

            <div className="field evidence-field">
              <span>Evidence items <i>optional</i></span>
              <div className="evidence-list">
                {brief.evidenceItems.map((item, index) => (
                  <div className="evidence-chip" key={`${item.claim}-${index}`}>
                    <div>
                      <b>{EVIDENCE_LABELS[item.sourceType]}</b>
                      <p>{item.claim}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => update("evidenceItems", brief.evidenceItems.filter((_, itemIndex) => itemIndex !== index))}
                      aria-label={`Remove evidence: ${item.claim}`}
                    >×</button>
                  </div>
                ))}
              </div>
              <div className="evidence-entry">
                <select
                  value={evidenceSource}
                  onChange={(event) => setEvidenceSource(event.target.value as EvidenceSourceType)}
                  aria-label="Evidence source type"
                >
                  {Object.entries(EVIDENCE_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
                <input
                  value={evidenceDraft}
                  onChange={(event) => setEvidenceDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addEvidence();
                    }
                  }}
                  maxLength={400}
                  placeholder="Add one claim or signal"
                  aria-label="Evidence claim"
                />
                <button type="button" onClick={addEvidence} aria-label="Add evidence item">+</button>
              </div>
              <small>Each item is classified by a guarded Researcher tool.</small>
            </div>

            <div className="field">
              <span>Options on the table</span>
              <div className="option-list">
                {brief.options.map((option) => (
                  <button
                    type="button"
                    className="option-chip"
                    key={option}
                    onClick={() => update("options", brief.options.filter((item) => item !== option))}
                    aria-label={`Remove option: ${option}`}
                  >
                    {option}<b aria-hidden="true">×</b>
                  </button>
                ))}
              </div>
              <div className="option-entry">
                <input
                  value={optionDraft}
                  onChange={(event) => setOptionDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addOption();
                    }
                  }}
                  maxLength={80}
                  placeholder="Add another option"
                  aria-label="Add another option"
                />
                <button type="button" onClick={addOption} aria-label="Add option">+</button>
              </div>
            </div>

            <label className="field">
              <span>Success looks like</span>
              <textarea
                value={brief.objectives}
                onChange={(event) => update("objectives", event.target.value)}
                rows={3}
                maxLength={800}
                placeholder="What outcome matters most?"
              />
            </label>

            <fieldset className="risk-field">
              <legend>Risk posture</legend>
              <div className="risk-options">
                {(["cautious", "balanced", "bold"] as const).map((risk) => (
                  <label key={risk}>
                    <input
                      type="radio"
                      name="risk"
                      value={risk}
                      checked={brief.riskTolerance === risk}
                      onChange={() => update("riskTolerance", risk)}
                    />
                    <span>{risk}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <button className="convene-button" type="submit" disabled={!canRun || isRunning}>
              <span>{isRunning ? "Council in session" : "Convene the room"}</span>
              <b aria-hidden="true">{isRunning ? "···" : "→"}</b>
            </button>
            <p className="form-note">Intake routes first. Guarded analysis runs only when the brief is ready. No external actions are taken.</p>
          </form>
        </aside>

        <section className="council-panel" aria-live="polite">
          <div className="council-heading">
            <div>
              <p className="eyebrow">The council</p>
              <h2>{isRunning ? "Intake is routing the brief" : clarification ? "Clarification required" : decisionResult ? "Four independent readings" : "Ready to deliberate"}</h2>
            </div>
            <div className={`session-state ${isRunning ? "is-running" : ""}`}>
              <span />{isRunning ? "Routing" : clarification ? "Needs input" : decisionResult ? "Complete" : "Standing by"}
            </div>
          </div>

          {error && <div className="error-banner" role="alert">{error}</div>}

          {result && (
            <div className="governance-strip" aria-label="Governed workflow summary">
              <div><span>Decision</span><strong>{result.governance.decisionId}</strong></div>
              <div><span>SDK handoff</span><strong>{result.governance.handoffDestination}</strong></div>
              <div><span>Evidence tools</span><strong>{result.governance.evidenceToolCalls}</strong></div>
              <div><span>Guardrails</span><strong>{result.governance.guardrailsPassed}/{result.governance.guardrailsTotal} passed</strong></div>
              <div><span>Trace policy</span><strong>Sensitive data off</strong></div>
            </div>
          )}

          {clarification && (
            <article className="clarification-card">
              <p className="eyebrow">Intake → Clarification Agent · {clarification.priority}</p>
              <h3>The council paused before analysis.</h3>
              <p>{clarification.reason}</p>
              <ul>{clarification.missingInformation.map((item) => <li key={item}>{item}</li>)}</ul>
              <small>No specialist or chair tokens were spent after this route.</small>
            </article>
          )}

          {!decisionResult ? (
            <div className={`agent-grid empty ${isRunning ? "loading" : ""}`}>
              {AGENT_SHELLS.map((agent, index) => (
                <article className={`agent-placeholder tone-${agent.tone}`} key={agent.role}>
                  <div className="agent-placeholder-top">
                    <span className="agent-mark">{agent.monogram}</span>
                    <span className="waiting-line" />
                  </div>
                  <p>{agent.role}</p>
                  <span className="placeholder-copy" />
                  <span className="placeholder-copy short" />
                  <div className="agent-state">
                    <i />{isRunning ? `Agent ${index + 1} is working` : "Awaiting the brief"}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="agent-grid">
              {decisionResult.specialists.map((analysis, index) => (
                <SpecialistCard analysis={analysis} index={index} key={analysis.role} />
              ))}
            </div>
          )}

          <article className={`memo ${decisionResult ? "has-result" : ""}`}>
            <div className="memo-rail">
              <span className="chair-mark">CH</span>
              <span className="rail-line" />
              <span className="vertical-label">CHAIRPERSON’S MEMO</span>
            </div>
            <div className="memo-body">
              {!decisionResult ? (
                <div className="memo-empty">
                  <p className="eyebrow">Final synthesis</p>
                  <h2>The chair is waiting for the council.</h2>
                  <p>Once every specialist has submitted a position, their strongest agreements and disagreements will be weighed here.</p>
                </div>
              ) : (
                <>
                  <div className="memo-header">
                    <div>
                      <p className="eyebrow">Final synthesis · {decisionResult.mode === "live" ? "Live council" : "Demo council"}</p>
                      <h2>{decisionResult.memo.verdict}</h2>
                    </div>
                    <div className="memo-confidence">
                      <strong>{decisionResult.memo.confidence}%</strong>
                      <span>confidence</span>
                    </div>
                  </div>
                  <p className="memo-summary">{decisionResult.memo.summary}</p>
                  <div className="evidence-ledger">
                    <div>
                      <h3>Facts used</h3>
                      <ul>{decisionResult.memo.facts.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                    <div>
                      <h3>Assumptions kept visible</h3>
                      <ul>{decisionResult.memo.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                  </div>
                  <div className="memo-columns">
                    <div>
                      <h3>Why this call</h3>
                      <ul>{decisionResult.memo.rationale.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                    <div className="disagreement-box">
                      <h3>Where the room disagreed</h3>
                      <ul>{decisionResult.memo.disagreements.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                  </div>
                  <div className="conditions">
                    <h3>Conditions that would change the call</h3>
                    <div>{decisionResult.memo.conditions.map((item, index) => <p key={item}><b>0{index + 1}</b>{item}</p>)}</div>
                  </div>
                  <div className="next-step">
                    <span>Next move</span>
                    <p>{decisionResult.memo.nextSteps[0]}</p>
                    <b aria-hidden="true">→</b>
                  </div>
                </>
              )}
            </div>
          </article>
        </section>
      </div>

      <footer>
        <p>DECISION ROOM <span>·</span> OPENAI AGENTS SDK</p>
        <p>Better judgment through structured disagreement.</p>
      </footer>
    </main>
  );
}
