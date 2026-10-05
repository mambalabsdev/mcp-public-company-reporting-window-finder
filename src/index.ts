#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

// The immutable actor ID. A Store rename never breaks these calls; a slug would.
const ACTOR_ID = "uINxR7a1IW8qUTRUX";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoint carries a platform
// ceiling of 300 seconds on the HTTP wait and answers 408 past it while the run
// keeps going and keeps billing. Starting the run, polling it to a terminal
// status, and then reading the dataset waits as long as the actor needs.
//
// How long the actor run itself may take, in seconds: long enough for a large
// batch, short enough that a hung run cannot bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;
// How long this wrapper waits: the run's own timeout plus two minutes, so the
// run's TIMED-OUT status is what the caller sees.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS ?? 3000);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// memory=1024 matches the actor's own defaultRunOptions.memoryMbytes.
// an unspecified memory can run at 2048 MB, which would
// be a silent DOUBLING here: apify-actor-start bills one event per GB, minimum
// one, so an unspecified memory charges the buyer two start events instead of
// one. Passing it explicitly restores the actor's declared default. Keep this in
// step with defaultRunOptions.memoryMbytes on the actor.
async function runActor(
  mode: string,
  toolLabel: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  // `mode` is set by the tool and is never a caller argument. Five tools, five
  // modes, so a caller cannot ask one tool to behave as another.
  const input = { ...compact(args), mode };
  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${toolLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${toolLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}&memory=1024`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${toolLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${toolLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${toolLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${toolLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${toolLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${toolLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset. Pass actor output through unchanged: the wrapper never
  // reinterprets a status field.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${toolLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${toolLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${toolLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-public-company-reporting-window-finder",
  version: pkg.version,
});

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

server.registerTool(
  "resolve_company",
  {
    title: "Resolve Company",
    description:
      "Resolve a domain, ticker, ISIN, LEI, CIK or company name to a listed company identity. Returns 44 fields per input: legal name, primary ticker, ISIN, LEI, CIK, domain, primary exchange, country, currency, sector, security type, public float band, shares outstanding, and the provenance of each. Every input returns exactly one row, including the ones that match nothing, which come back with match_method set to no_match and every other field null. Read matched_on to see which identifier produced the row. Use this when you hold identifiers and need the listed identity behind them; use qualify_company for a yes or no on listed status, get_reporting_timing for dates, and build_company_universe when you hold filters rather than identifiers. The filter inputs (exchange_codes, country_codes, regions, sectors, and the rest) narrow which matched rows come back. Charged per company row returned, including a no_match row, because the lookup ran either way. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: { title: "Resolve Company", ...ANNOTATIONS },
    inputSchema: {
      company_domain: z.string().optional().describe("A single bare domain, e.g. stripe.com. The Clay column shape. Used by resolve, qualify and timing."),
      company_domains: z.array(z.string()).optional().describe("Many domains at once. Used by resolve, qualify and timing."),
      tickers: z.array(z.string()).optional().describe("Exchange tickers, e.g. NWLG. Matched against the primary ticker and every venue listing."),
      isins: z.array(z.string()).optional().describe("12 character ISINs."),
      leis: z.array(z.string()).optional().describe("20 character Legal Entity Identifiers."),
      ciks: z.array(z.string()).optional().describe("SEC Central Index Keys, with or without leading zeros."),
      company_names: z.array(z.string()).optional().describe("Legal or trading names. Matched on a normalized name. Former names are not available: the alias table carries tickers and ISINs only."),
      exchange_codes: z.array(z.string()).optional().describe("ISO 10383 MICs. 18 venues are covered."),
      country_codes: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2, e.g. US, GB, FR."),
      regions: z.array(z.string()).optional().describe("Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it."),
      sectors: z.array(z.string()).optional().describe("SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe."),
      security_types: z.array(z.string()).optional().describe("ordinary_shares, depositary_receipt, preferred_shares."),
      public_float_bands: z.array(z.string()).optional().describe("micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset."),
      fiscal_year_end_months: z.array(z.string()).optional().describe("Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset."),
      exclude_december_fiscal_year_end: z.enum(["false", "true"]).optional().describe("Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter."),
      cadences: z.array(z.string()).optional().describe("quarterly, semiannual, annual, unknown."),
      operating_companies_only: z.enum(["false", "true"]).optional().describe("Drop funds, trusts and other non operating entities. Sent as a string for Clay compatibility."),
      exclude_blank_checks: z.enum(["false", "true"]).optional().describe("Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter."),
      foreign_private_issuer: z.enum(["any", "only", "exclude"]).optional().describe("Filter on foreign private issuer status."),
      us_registrant_only: z.enum(["false", "true"]).optional().describe("Keep only companies carrying an SEC CIK."),
      min_provenance_confidence: z.enum(["any", "high"]).optional().describe("Set to high to exclude rows whose source terms were never read."),
      exclude_name_only_matches: z.enum(["false", "true"]).optional().describe("Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters."),
      exclude_share_alike: z.enum(["false", "true"]).optional().describe("Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product."),
    },
  },
  async (args) => runActor("resolve", "Resolve Company", args as Record<string, unknown>),
);

server.registerTool(
  "qualify_company",
  {
    title: "Qualify Company",
    description:
      "Answer whether a company is publicly listed. Takes the same identifiers as resolve_company and returns a listed status verdict per input. Set listed_only to keep only the companies proven to be listed, or suppress_listed to remove them, which is what you want when selling only into private companies. By default an unmatched company returns is_listed null rather than false, because a non match may mean the company is private OR that the dataset does not hold its domain; set assume_unmatched_is_private to true to opt into reading a non match as private. Use this to split a prospect list into listed and private companies before outreach; use resolve_company when you need the full identity fields. Identify companies with company_domain, company_domains, tickers, isins, leis, ciks, or company_names; every other input is an optional filter shared with resolve_company (exchange, country, region, sector, security type, float band, fiscal year end, cadence, and data quality switches). Charged per company row returned. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: { title: "Qualify Company", ...ANNOTATIONS },
    inputSchema: {
      company_domain: z.string().optional().describe("A single bare domain, e.g. stripe.com. The Clay column shape. Used by resolve, qualify and timing."),
      company_domains: z.array(z.string()).optional().describe("Many domains at once. Used by resolve, qualify and timing."),
      tickers: z.array(z.string()).optional().describe("Exchange tickers, e.g. NWLG. Matched against the primary ticker and every venue listing."),
      isins: z.array(z.string()).optional().describe("12 character ISINs."),
      leis: z.array(z.string()).optional().describe("20 character Legal Entity Identifiers."),
      ciks: z.array(z.string()).optional().describe("SEC Central Index Keys, with or without leading zeros."),
      company_names: z.array(z.string()).optional().describe("Legal or trading names. Matched on a normalized name. Former names are not available: the alias table carries tickers and ISINs only."),
      exchange_codes: z.array(z.string()).optional().describe("ISO 10383 MICs. 18 venues are covered."),
      country_codes: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2, e.g. US, GB, FR."),
      regions: z.array(z.string()).optional().describe("Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it."),
      sectors: z.array(z.string()).optional().describe("SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe."),
      security_types: z.array(z.string()).optional().describe("ordinary_shares, depositary_receipt, preferred_shares."),
      public_float_bands: z.array(z.string()).optional().describe("micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset."),
      fiscal_year_end_months: z.array(z.string()).optional().describe("Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset."),
      exclude_december_fiscal_year_end: z.enum(["false", "true"]).optional().describe("Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter."),
      cadences: z.array(z.string()).optional().describe("quarterly, semiannual, annual, unknown."),
      operating_companies_only: z.enum(["false", "true"]).optional().describe("Drop funds, trusts and other non operating entities. Sent as a string for Clay compatibility."),
      exclude_blank_checks: z.enum(["false", "true"]).optional().describe("Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter."),
      foreign_private_issuer: z.enum(["any", "only", "exclude"]).optional().describe("Filter on foreign private issuer status."),
      us_registrant_only: z.enum(["false", "true"]).optional().describe("Keep only companies carrying an SEC CIK."),
      min_provenance_confidence: z.enum(["any", "high"]).optional().describe("Set to high to exclude rows whose source terms were never read."),
      exclude_name_only_matches: z.enum(["false", "true"]).optional().describe("Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters."),
      exclude_share_alike: z.enum(["false", "true"]).optional().describe("Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product."),
      listed_only: z.enum(["false", "true"]).optional().describe("qualify mode. Keep only rows proven to be publicly listed."),
      suppress_listed: z.enum(["false", "true"]).optional().describe("qualify mode. Remove companies proven to be publicly listed, for anyone selling only into private companies. It removes what we can prove is listed; it does not warrant that the remainder is private."),
      assume_unmatched_is_private: z.enum(["false", "true"]).optional().describe("qualify mode. By default an unmatched company returns is_listed null, because a non match may mean the company is private OR that we do not hold its domain. Set true to opt into reading a non match as private, which sets is_listed false."),
    },
  },
  async (args) => runActor("qualify", "Qualify Company", args as Record<string, unknown>),
);

server.registerTool(
  "get_reporting_timing",
  {
    title: "Get Reporting Timing",
    description:
      "Find when a public company next reports, and when to reach out around it. Returns 75 fields per input: fiscal year end, derived reporting cadence and its confidence, the next reporting event with its type, period and date, days to event, and the open and close of an outreach window you define with window_lead_days and window_lag_days, which default to 70 and 42. window_status is one of open, not_yet, closed_passed or no_event and is the field to filter on. Dates are PREDICTED from filing history, not announced: read next_event_is_estimate and confidence_band, whose thresholds sit at 0.80 and 0.50. TIMING ROWS COVER US COMPANIES ONLY. A non US company resolves fully for identity and returns a stated timing_unavailable_reason rather than a guessed date, and is still charged as a timing row because the work ran. Charged per timing row returned, never additionally as a resolved company. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: { title: "Get Reporting Timing", ...ANNOTATIONS },
    inputSchema: {
      company_domain: z.string().optional().describe("A single bare domain, e.g. stripe.com. The Clay column shape. Used by resolve, qualify and timing."),
      company_domains: z.array(z.string()).optional().describe("Many domains at once. Used by resolve, qualify and timing."),
      tickers: z.array(z.string()).optional().describe("Exchange tickers, e.g. NWLG. Matched against the primary ticker and every venue listing."),
      isins: z.array(z.string()).optional().describe("12 character ISINs."),
      leis: z.array(z.string()).optional().describe("20 character Legal Entity Identifiers."),
      ciks: z.array(z.string()).optional().describe("SEC Central Index Keys, with or without leading zeros."),
      company_names: z.array(z.string()).optional().describe("Legal or trading names. Matched on a normalized name. Former names are not available: the alias table carries tickers and ISINs only."),
      exchange_codes: z.array(z.string()).optional().describe("ISO 10383 MICs. 18 venues are covered."),
      country_codes: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2, e.g. US, GB, FR."),
      regions: z.array(z.string()).optional().describe("Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it."),
      sectors: z.array(z.string()).optional().describe("SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe."),
      security_types: z.array(z.string()).optional().describe("ordinary_shares, depositary_receipt, preferred_shares."),
      public_float_bands: z.array(z.string()).optional().describe("micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset."),
      fiscal_year_end_months: z.array(z.string()).optional().describe("Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset."),
      exclude_december_fiscal_year_end: z.enum(["false", "true"]).optional().describe("Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter."),
      cadences: z.array(z.string()).optional().describe("quarterly, semiannual, annual, unknown."),
      operating_companies_only: z.enum(["false", "true"]).optional().describe("Drop funds, trusts and other non operating entities. Sent as a string for Clay compatibility."),
      exclude_blank_checks: z.enum(["false", "true"]).optional().describe("Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter."),
      foreign_private_issuer: z.enum(["any", "only", "exclude"]).optional().describe("Filter on foreign private issuer status."),
      us_registrant_only: z.enum(["false", "true"]).optional().describe("Keep only companies carrying an SEC CIK."),
      min_provenance_confidence: z.enum(["any", "high"]).optional().describe("Set to high to exclude rows whose source terms were never read."),
      exclude_name_only_matches: z.enum(["false", "true"]).optional().describe("Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters."),
      exclude_share_alike: z.enum(["false", "true"]).optional().describe("Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product."),
      event_types: z.array(z.string()).optional().describe("full_year_results, half_year_results, quarterly_results, trading_update, annual_report_publication, sustainability_report_publication, agm, proxy_filing, capital_markets_day."),
      window_lead_days: z.string().optional().describe("How many days before the event the outreach window opens. Default 70."),
      window_lag_days: z.string().optional().describe("How many days before the event the outreach window closes. Default 42. Must be less than the lead."),
      window_statuses: z.array(z.string()).optional().describe("Keep only rows in these window states: open, not_yet, closed_passed, no_event."),
      max_days_to_event: z.string().optional().describe("Drop rows whose next event is further away than this. A cost control."),
      min_cadence_confidence: z.string().optional().describe("0 to 1. Rows whose cadence confidence falls below this return a null timing block with a stated reason rather than a guess. Quarterly cadence averages 0.94, annual 0.40, semiannual 0.21."),
      include_constrained_period: z.enum(["true", "false"]).optional().describe("Emit the period in which a listed company is constrained in what it can announce, derived from the same window numbers. Useful for campaign and announcement timing."),
    },
  },
  async (args) => runActor("timing", "Get Reporting Timing", args as Record<string, unknown>),
);

server.registerTool(
  "build_company_universe",
  {
    title: "Build Company Universe",
    description:
      "Build a list of listed companies from filters rather than from identifiers you already hold. Filter by exchange, country, region, sector, security type, public float band, fiscal year end month, reporting cadence, operating status and foreign private issuer status. Returns 44 fields per company, the same shape resolve_company returns. At least one filter is required, so a bare call cannot pull the whole universe. This tool does NOT accept company identifiers: use resolve_company, qualify_company or get_reporting_timing for specific companies. SET limit EXPLICITLY. It defaults to 1000 and you are charged per company row returned, so an unbounded call is an expensive call. Truncation is always reported, never silent. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: { title: "Build Company Universe", ...ANNOTATIONS },
    inputSchema: {
      exchange_codes: z.array(z.string()).optional().describe("ISO 10383 MICs. 18 venues are covered."),
      country_codes: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2, e.g. US, GB, FR."),
      regions: z.array(z.string()).optional().describe("Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it."),
      sectors: z.array(z.string()).optional().describe("SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe."),
      security_types: z.array(z.string()).optional().describe("ordinary_shares, depositary_receipt, preferred_shares."),
      public_float_bands: z.array(z.string()).optional().describe("micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset."),
      fiscal_year_end_months: z.array(z.string()).optional().describe("Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset."),
      exclude_december_fiscal_year_end: z.enum(["false", "true"]).optional().describe("Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter."),
      cadences: z.array(z.string()).optional().describe("quarterly, semiannual, annual, unknown."),
      operating_companies_only: z.enum(["false", "true"]).optional().describe("Drop funds, trusts and other non operating entities. Sent as a string for Clay compatibility."),
      exclude_blank_checks: z.enum(["false", "true"]).optional().describe("Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter."),
      foreign_private_issuer: z.enum(["any", "only", "exclude"]).optional().describe("Filter on foreign private issuer status."),
      us_registrant_only: z.enum(["false", "true"]).optional().describe("Keep only companies carrying an SEC CIK."),
      min_provenance_confidence: z.enum(["any", "high"]).optional().describe("Set to high to exclude rows whose source terms were never read."),
      exclude_name_only_matches: z.enum(["false", "true"]).optional().describe("Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters."),
      exclude_share_alike: z.enum(["false", "true"]).optional().describe("Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product."),
      limit: z.string().optional().describe("Maximum rows for universe and season. Truncation is always reported, never silent."),
    },
  },
  async (args) => runActor("universe", "Build Company Universe", args as Record<string, unknown>),
);

server.registerTool(
  "get_reporting_season",
  {
    title: "Get Reporting Season",
    description:
      "Show how reporting load is distributed over time, so you can find the busy weeks and the quiet ones. Returns aggregate rows per bucket, not per company: period start and end, event count, company count, estimated share and mean confidence. Bucket by week or month with season_group_by, and optionally split by sector, country or exchange with season_split_by. The window defaults to today through 180 days out; set season_from and season_to for another. At least one filter is required and company identifiers are not accepted. Use this to plan campaign timing across a market, not to time one account; for a single company use get_reporting_timing. Narrow the population with the same filters build_company_universe takes (exchange_codes, country_codes, regions, sectors, public_float_bands, cadences). Charged per aggregate row returned, which is far fewer rows than the companies behind them. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: { title: "Get Reporting Season", ...ANNOTATIONS },
    inputSchema: {
      exchange_codes: z.array(z.string()).optional().describe("ISO 10383 MICs. 18 venues are covered."),
      country_codes: z.array(z.string()).optional().describe("ISO 3166-1 alpha-2, e.g. US, GB, FR."),
      regions: z.array(z.string()).optional().describe("Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it."),
      sectors: z.array(z.string()).optional().describe("SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe."),
      security_types: z.array(z.string()).optional().describe("ordinary_shares, depositary_receipt, preferred_shares."),
      public_float_bands: z.array(z.string()).optional().describe("micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset."),
      fiscal_year_end_months: z.array(z.string()).optional().describe("Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset."),
      exclude_december_fiscal_year_end: z.enum(["false", "true"]).optional().describe("Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter."),
      cadences: z.array(z.string()).optional().describe("quarterly, semiannual, annual, unknown."),
      operating_companies_only: z.enum(["false", "true"]).optional().describe("Drop funds, trusts and other non operating entities. Sent as a string for Clay compatibility."),
      exclude_blank_checks: z.enum(["false", "true"]).optional().describe("Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter."),
      foreign_private_issuer: z.enum(["any", "only", "exclude"]).optional().describe("Filter on foreign private issuer status."),
      us_registrant_only: z.enum(["false", "true"]).optional().describe("Keep only companies carrying an SEC CIK."),
      min_provenance_confidence: z.enum(["any", "high"]).optional().describe("Set to high to exclude rows whose source terms were never read."),
      exclude_name_only_matches: z.enum(["false", "true"]).optional().describe("Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters."),
      exclude_share_alike: z.enum(["false", "true"]).optional().describe("Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product."),
      limit: z.string().optional().describe("Maximum rows for universe and season. Truncation is always reported, never silent."),
      event_types: z.array(z.string()).optional().describe("full_year_results, half_year_results, quarterly_results, trading_update, annual_report_publication, sustainability_report_publication, agm, proxy_filing, capital_markets_day."),
      season_group_by: z.enum(["week", "month"]).optional().describe("season mode. Bucket size."),
      season_split_by: z.enum(["none", "sector", "country", "exchange_code"]).optional().describe("season mode. Optional second dimension."),
      season_from: z.string().optional().describe("season mode. ISO date. Defaults to today."),
      season_to: z.string().optional().describe("season mode. ISO date. Defaults to 180 days from today."),
    },
  },
  async (args) => runActor("season", "Get Reporting Season", args as Record<string, unknown>),
);

const transport = new StdioServerTransport();
await server.connect(transport);
