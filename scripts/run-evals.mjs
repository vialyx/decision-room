import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const fixtures = JSON.parse(await readFile(new URL("evals/fixtures.json", root), "utf8"));
const workerUrl = new URL("dist/server/index.js", root);
workerUrl.searchParams.set("eval", `${process.pid}-${Date.now()}`);
const worker = (await import(workerUrl.href)).default;

const observations = [];
for (const fixture of fixtures) {
  const started = performance.now();
  const response = await worker.fetch(
    new Request("http://localhost/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture.input),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const output = await response.json();
  observations.push({ fixture, status: response.status, output, latencyMs: performance.now() - started });
}

const percent = (passed, total) => Number(((passed / total) * 100).toFixed(1));
const expectedBlocked = observations.filter(({ fixture }) => fixture.expect.status === 422);
const expectedAllowed = observations.filter(({ fixture }) => fixture.expect.status === 200);
const councils = observations.filter(({ output }) => output.route === "decision_council");
const latencies = observations.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
const correctStatus = observations.filter(({ fixture, status }) => fixture.expect.status === status).length;
const correctRoute = expectedAllowed.filter(({ fixture, output }) => fixture.expect.route === output.route).length;
const correctCategory = expectedAllowed.filter(({ fixture, output }) => fixture.expect.category === output.governance?.decisionCategory).length;
const trueBlocked = expectedBlocked.filter(({ status, output }) => status === 422 && output.code === "input_guardrail").length;
const trueAllowed = expectedAllowed.filter(({ status }) => status === 200).length;
const structured = expectedAllowed.filter(({ output }) =>
  output && typeof output === "object" && output.governance?.decisionId &&
  (output.route === "clarification" ? Array.isArray(output.missingInformation) : Array.isArray(output.specialists) && output.memo && output.evaluation),
).length;
const disagreementPreserved = councils.filter(({ output }) => output.memo.disagreements.length >= 2).length;
const unsupportedClaims = councils.reduce((total, { output }) => total + output.evaluation.unsupportedClaims.length, 0);
const revisionActivations = councils.filter(({ output }) => output.evaluation.revisionPerformed).length;

const results = {
  generatedAt: new Date().toISOString(),
  mode: "keyless deterministic demo",
  fixtureCount: fixtures.length,
  metrics: {
    statusAccuracyPct: percent(correctStatus, observations.length),
    routingAccuracyPct: percent(correctRoute, expectedAllowed.length),
    categoryAccuracyPct: percent(correctCategory, expectedAllowed.length),
    guardrailRecallPct: percent(trueBlocked, expectedBlocked.length),
    guardrailSpecificityPct: percent(trueAllowed, expectedAllowed.length),
    structuredOutputRatePct: percent(structured, expectedAllowed.length),
    disagreementPreservationPct: percent(disagreementPreserved, councils.length),
    unsupportedClaimsPerCouncil: Number((unsupportedClaims / councils.length).toFixed(2)),
    revisionActivationPct: percent(revisionActivations, councils.length),
    meanLatencyMs: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1)),
    p95LatencyMs: Number(latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(1)),
  },
  failures: observations.filter(({ fixture, status, output }) =>
    fixture.expect.status !== status ||
    (fixture.expect.route && fixture.expect.route !== output.route) ||
    (fixture.expect.category && fixture.expect.category !== output.governance?.decisionCategory) ||
    (fixture.expect.code && fixture.expect.code !== output.code),
  ).map(({ fixture, status, output }) => ({ id: fixture.id, expected: fixture.expect, actual: { status, route: output.route, category: output.governance?.decisionCategory, code: output.code } })),
};

await mkdir(new URL("evals/results/", root), { recursive: true });
await writeFile(new URL("evals/results/latest.json", root), `${JSON.stringify(results, null, 2)}\n`);

assert.equal(results.failures.length, 0, JSON.stringify(results.failures, null, 2));
assert.equal(results.metrics.structuredOutputRatePct, 100);
assert.equal(results.metrics.disagreementPreservationPct, 100);
assert.equal(results.metrics.guardrailRecallPct, 100);

console.log(JSON.stringify(results, null, 2));
