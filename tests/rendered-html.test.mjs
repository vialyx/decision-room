import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-api`);
  return (await import(workerUrl.href)).default;
}

test("server-renders the Decision Room workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Decision Room/);
  assert.match(html, /Make the call/);
  assert.match(html, /Convene the room/);
  assert.match(html, /The council/);
  assert.match(html, /Chairperson’s memo/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships a real Agents SDK orchestration route", async () => {
  const route = await readFile(new URL("app/api/decision/route.ts", templateRoot), "utf8");
  const packageJson = await readFile(new URL("package.json", templateRoot), "utf8");

  assert.match(route, /from "@openai\/agents"/);
  assert.match(route, /Promise\.all\(specialistRuns\)/);
  assert.match(route, /name: "Chairperson"/);
  assert.match(route, /OPENAI_API_KEY/);
  assert.match(packageJson, /"@openai\/agents"/);
});

test("runs the keyless demo council end to end", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "Should we launch a paid team plan this quarter?",
        context: "We have strong team usage but limited support capacity and a six-week engineering estimate.",
        options: ["Launch this quarter", "Run a private beta", "Delay"],
        objectives: "Validate expansion revenue without reducing reliability.",
        riskTolerance: "balanced",
      }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "demo");
  assert.equal(result.specialists.length, 4);
  assert.match(result.memo.verdict, /proceed|pilot/i);
});
