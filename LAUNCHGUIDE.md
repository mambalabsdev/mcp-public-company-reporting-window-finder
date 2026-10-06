# Public Company Earnings Dates and Reporting Window Finder MCP Server

## Tagline
Find when a public company reports next, and the outreach window to work around it.

## Description
An MCP server that exposes the Mamba Labs Public Company Earnings Dates and Reporting Window Finder actor on Apify (immutable Actor ID `uINxR7a1IW8qUTRUX`). Give it a domain, ticker, ISIN, LEI, or CIK and it returns when that company reports: fiscal year end, reporting cadence, the next reporting date, days to event, and the open and close of an outreach window you define.

The server exposes five tools, one per actor mode. You never pass a mode; each tool sets it and exposes only the inputs that mode uses. `resolve_company` returns identity and venue. `qualify_company` returns a listed status verdict. `get_reporting_timing` returns the timing block and the outreach window. `build_company_universe` builds a company list from filters. `get_reporting_season` returns reporting load per week or month.

Timing rows cover US companies only. Identity, venue, and classification resolve worldwide across the publishable universe, but reporting dates come from US SEC filing history. A non US company resolves fully and returns a stated `timing_unavailable_reason` instead of a guessed date. Dates are predicted from filing history, not announced, and every row carries its confidence. It is built for sales, investor relations, and agency teams who time outreach around reporting cycles.

## Setup Requirements
- `APIFY_TOKEN` (required): Your Apify API token. Every tool call runs the actor on your Apify account and is billed there per row returned. https://console.apify.com/account/integrations

## Category
Business Tools

## Features
- Look up a company by domain, ticker, ISIN, LEI, CIK, or name
- Fiscal year end, reporting cadence, next reporting date, and days to event
- An outreach window with a lead and lag you set, defaults 70 and 42 days
- `window_status` of open, not_yet, closed_passed, or no_event against today
- Optional constrained period output for campaign and announcement timing
- Listed status qualification, with an option to suppress proven listed companies
- Build a company universe from exchange, country, region, sector, float band, and cadence filters
- Reporting season aggregates by week or month, split by sector, country, or exchange
- Confidence on every predicted date; unknown cadence returns a reason instead of a guess
- Provenance filters for name only matches and share alike sources
- 18 exchange venues covered
- Runs locally through npx with one environment variable

## Getting Started
- "When does NWLG report next, and is the outreach window open today?"
- "Which US software companies with a non December fiscal year end report in the next 60 days?"
- "Is stripe.com a publicly listed company?"
- "Show me the reporting load per week for UK listed companies over the next quarter."
- Tool: resolve_company: Resolve identifiers to identity and venue.
- Tool: qualify_company: Return a listed status verdict for each company.
- Tool: get_reporting_timing: Return fiscal year end, cadence, next event, and the outreach window.
- Tool: build_company_universe: Build a company list from filters. Set `limit` explicitly; it defaults to 1000 rows and each row is billed.
- Tool: get_reporting_season: Return reporting load per week or month. Set `limit` explicitly.

## Tags
earnings dates, earnings calendar, reporting dates, fiscal year end, reporting cadence, public companies, listed companies, sec filings, outreach timing, sales timing, investor relations, account based marketing, ticker lookup, isin, lei, cik, company universe, reporting season, gtm, clay, apify

## Documentation URL
https://github.com/mambalabsdev/mcp-public-company-reporting-window-finder#readme

## Health Check URL
Not applicable. This is a local stdio server run through npx.
