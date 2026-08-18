# Public Company Earnings Dates and Reporting Window Finder MCP Server

[![smithery badge](https://smithery.ai/badge/@mambalabsdev/mcp-public-company-reporting-window-finder)](https://smithery.ai/server/@mambalabsdev/mcp-public-company-reporting-window-finder)

MCP server for the Mamba Labs [Public Company Earnings Dates and Reporting Window Finder](https://apify.com/mambalabs/public-company-reporting-window-finder) actor on Apify.

Give it a domain, ticker, ISIN, LEI or CIK and it tells you **when that public company reports**, and when to reach out around it: fiscal year end, reporting cadence, the next reporting date, days to event, and the open and close of an outreach window you define.

> **Timing rows cover US companies only.** Identity, venue and classification resolve worldwide across the publishable universe. Reporting dates come from US SEC filing history and exist for US companies alone. A non US company resolves fully and returns a stated `timing_unavailable_reason` rather than a guessed date, and is still charged as a timing row because the lookup ran.

## Five tools, one per actor mode

| Tool | Takes | Returns |
|---|---|---|
| `resolve_company` | identifiers | identity and venue, 44 fields |
| `qualify_company` | identifiers | a listed status verdict |
| `get_reporting_timing` | identifiers | fiscal year end, cadence, next event, the outreach window, 75 fields |
| `build_company_universe` | filters | a company list |
| `get_reporting_season` | filters | reporting load per week or month |

You never pass `mode`. Each tool sets it, and each tool exposes only the inputs its mode actually uses.

`build_company_universe` and `get_reporting_season` build a list from filters and do **not** accept company identifiers. Set `limit` explicitly on both: it defaults to 1000 and you are charged per row returned.

## Install

```json
{
  "mcpServers": {
    "mamba-public-company-reporting-window-finder": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-public-company-reporting-window-finder"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get a token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations).

## Reading the output

**Dates are predicted, not announced.** `next_event_is_estimate` is true for a date derived from filing history. `confidence_band` sits at 0.80 and 0.50, computed on the weakest link in the chain, so `confidence_effective` is the minimum of the event and cadence confidences rather than an average.

**`window_status` is the field to filter on.** It is `open`, `not_yet`, `closed_passed` or `no_event` against today. `no_event` is the state a company lands in when there is no reporting event to build a window from.

**Unknown cadence is refused, not guessed.** A company whose filing history is too short or irregular returns a null cadence with a reason instead of an invented date.

**A row that resolves nothing is still billed.** An identifier that matches no public company returns `match_method` of `no_match` with every other field null. That is a real answer and the lookup ran to produce it.

## Cost

Pay per event on Apify, charged for rows returned rather than rows filtered out.

| Event | Price |
|---|---|
| Company resolved | $0.006 per row |
| Timing row returned | $0.012 per row |
| Reporting season aggregate | $0.05 per row |
| Actor start | $0.00005 per run |

Volume discounts of 5, 10 and 15 percent apply on the Apify Bronze, Silver and Gold plans. A timing row is never additionally charged as a resolved company.

## Part of the Mamba Labs GTM Suite

[Browse the full suite on Apify](https://apify.com/mambalabs).

## License

MIT
