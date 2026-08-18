import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

const ACTOR_ID = "uINxR7a1IW8qUTRUX";

// The expected input list is derived from a FIXTURE COPIED FROM THE LIVE ACTOR,
// test/fixtures/live-input-schema.json, produced by
// scripts/sync-input-schema-fixture.mjs straight off the build record. It is
// deliberately NOT derived from src/index.ts.
//
// A parity check built from the thing it is checking is not a check. On
// 2026-08-16 a sibling wrapper's hand maintained list had been reconciled
// against the tool rather than against the actor, so when the actor gained an
// input and the tool did not, the list agreed with the tool and the test passed
// while asserting something false.
const LIVE = JSON.parse(readFileSync(join(repo, "test", "fixtures", "live-input-schema.json"), "utf8"));
const LIVE_PROPS = LIVE.schema.properties;

// `source_tag` is editor: hidden, set by Mamba Labs task plumbing rather than by
// a caller. `mode` is set by the tool, never by the caller: that is the whole
// point of having five tools instead of one.
const ACTOR_INPUTS = Object.entries(LIVE_PROPS)
  .filter(([, spec]) => spec.editor !== "hidden")
  .map(([name]) => name)
  .filter((name) => name !== "mode");

const TOOLS = [
  "resolve_company",
  "qualify_company",
  "get_reporting_timing",
  "build_company_universe",
  "get_reporting_season",
];

// Which inputs each mode actually consumes, read off the actor's own
// src/validate.js: IDENTIFIER_MODES is resolve, qualify and timing;
// FILTER_MODES is universe and season; config.filters and config.options are
// read by every mode.
const IDENT = ["company_domain", "company_domains", "tickers", "isins", "leis", "ciks", "company_names"];
const FILTER_ONLY_TOOLS = ["build_company_universe", "get_reporting_season"];

function listTools() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.APIFY_TOKEN;
    const child = spawn(process.execPath, [join(repo, "build", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 20000);

    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result);
        }
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", reject);

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrapper-test", version: "0.0.0" } },
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

const byName = (result) => Object.fromEntries(result.tools.map((t) => [t.name, t]));

test("serves all five tools with no APIFY_TOKEN set", async () => {
  const result = await listTools();
  assert.equal(result.tools.length, 5);
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [...TOOLS].sort());
  for (const t of result.tools) assert.ok(t.description.length > 0, `${t.name} has no description`);
});

test("the union of the five tools exposes every live actor input", async () => {
  // This is the parity assertion. One tool cannot expose everything, because
  // each mode ignores what it does not use, so the check is on the union.
  const result = await listTools();
  const union = new Set();
  for (const t of result.tools) {
    for (const k of Object.keys(t.inputSchema.properties)) union.add(k);
  }
  assert.deepEqual([...union].sort(), [...ACTOR_INPUTS].sort());
});

test("no tool exposes an input the live actor does not have", async () => {
  const result = await listTools();
  for (const t of result.tools) {
    const unknown = Object.keys(t.inputSchema.properties).filter((k) => !ACTOR_INPUTS.includes(k));
    assert.deepEqual(unknown, [], `${t.name} exposes inputs the actor does not have: ${unknown.join(", ")}`);
  }
});

test("mode is never a caller argument on any tool", async () => {
  // Five tools exist so the caller never picks a mode. If `mode` leaked onto a
  // schema, a caller could make one tool behave as another and the narrowing
  // would be decorative.
  const result = await listTools();
  for (const t of result.tools) {
    assert.ok(!("mode" in t.inputSchema.properties), `${t.name} exposes mode`);
  }
});

test("the filter modes forbid company identifiers", async () => {
  // src/validate.js throws for an identifier in universe or season. Encoding it
  // in the schema means the client never makes the call, rather than paying a
  // round trip to be told no.
  const tools = byName(await listTools());
  for (const name of FILTER_ONLY_TOOLS) {
    const props = Object.keys(tools[name].inputSchema.properties);
    const leaked = IDENT.filter((i) => props.includes(i));
    assert.deepEqual(leaked, [], `${name} accepts identifiers: ${leaked.join(", ")}`);
  }
});

test("the identifier modes accept every identifier the actor accepts", async () => {
  const tools = byName(await listTools());
  for (const name of ["resolve_company", "qualify_company", "get_reporting_timing"]) {
    const props = Object.keys(tools[name].inputSchema.properties);
    const missing = IDENT.filter((i) => !props.includes(i));
    assert.deepEqual(missing, [], `${name} is missing identifiers: ${missing.join(", ")}`);
  }
});

test("timing inputs sit only on the timing tool", async () => {
  const tools = byName(await listTools());
  for (const field of ["window_lead_days", "window_lag_days", "window_statuses", "max_days_to_event", "min_cadence_confidence", "include_constrained_period"]) {
    assert.ok(field in tools.get_reporting_timing.inputSchema.properties, `timing tool missing ${field}`);
    for (const other of ["resolve_company", "qualify_company", "build_company_universe"]) {
      assert.ok(!(field in tools[other].inputSchema.properties), `${other} should not carry ${field}`);
    }
  }
});

test("season inputs sit only on the season tool", async () => {
  const tools = byName(await listTools());
  for (const field of ["season_group_by", "season_split_by", "season_from", "season_to"]) {
    assert.ok(field in tools.get_reporting_season.inputSchema.properties, `season tool missing ${field}`);
    for (const other of TOOLS.filter((t) => t !== "get_reporting_season")) {
      assert.ok(!(field in tools[other].inputSchema.properties), `${other} should not carry ${field}`);
    }
  }
});

test("qualify inputs sit only on the qualify tool", async () => {
  const tools = byName(await listTools());
  for (const field of ["listed_only", "suppress_listed", "assume_unmatched_is_private"]) {
    assert.ok(field in tools.qualify_company.inputSchema.properties, `qualify tool missing ${field}`);
    for (const other of TOOLS.filter((t) => t !== "qualify_company")) {
      assert.ok(!(field in tools[other].inputSchema.properties), `${other} should not carry ${field}`);
    }
  }
});

test("every exposed input carries the live schema's own description", async () => {
  const result = await listTools();
  for (const t of result.tools) {
    for (const [name, spec] of Object.entries(t.inputSchema.properties)) {
      assert.ok(spec.description?.trim(), `${t.name}.${name} has no description`);
      const live = LIVE_PROPS[name]?.description;
      if (live) assert.equal(spec.description, live, `${t.name}.${name} description drifted from the live schema`);
    }
  }
});

test("source pins the immutable actor id, not a Store slug", () => {
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  assert.ok(src.includes(`"${ACTOR_ID}"`), "actor id missing from source");
  // The call must go to /v2/acts/<immutable id>, never /v2/acts/<user>~<slug>.
  // A slug breaks on a Store rename; the id never does. The MCP server's own
  // name legitimately contains the slug, so this checks the API path only.
  assert.ok(src.includes("/v2/acts/${ACTOR_ID}/"), "the API path does not use the actor id");
  assert.ok(!/acts\/[a-z-]*~/.test(src), "source calls the actor by user~slug");
});

test("package identity matches the locked naming convention", () => {
  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  const key = Object.keys(mcp.mcpServers);
  assert.deepEqual(key, ["mamba-public-company-reporting-window-finder"]);
  assert.deepEqual(mcp.mcpServers[key[0]].args, ["-y", pkg.name]);
  assert.equal(pkg.name, "@mambalabsdev/mcp-public-company-reporting-window-finder");
  assert.equal(pkg.mcpName, "com.mambabuilt/mcp-public-company-reporting-window-finder");
});

test("the package ships only the declared allowlist", () => {
  assert.deepEqual(pkg.files, ["build", "README.md", "LICENSE", "SECURITY.md"]);
  assert.deepEqual(Object.keys(pkg.bin), [pkg.name.split("/")[1]]);
  assert.equal(pkg.bin[Object.keys(pkg.bin)[0]], "./build/index.js");
});

test("the parity fixture came from this actor, not a sibling", () => {
  assert.equal(LIVE._provenance.actorId, ACTOR_ID);
  assert.match(LIVE._provenance.source, /actor-builds\//);
  assert.ok(LIVE._provenance.buildNumber, "fixture records the build it came from");
});

test("the buyer facing coverage limit travels with the wrapper", () => {
  // Timing rows are US only. A buyer who learns that after paying asks for a
  // refund, so it is on the tool description and in the README.
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  assert.match(readme, /US compan/i);
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  assert.match(src, /TIMING ROWS COVER US COMPANIES ONLY/);
});
