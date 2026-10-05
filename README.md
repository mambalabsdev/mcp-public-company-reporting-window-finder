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

## Parameters

Every parameter is optional unless a tool says otherwise. The Tools column names the tools that accept it.

| Parameter | Type | Tools | Description |
|---|---|---|---|
| `company_domain` | string | `resolve_company`, `qualify_company`, `get_reporting_timing` | A single bare domain, e.g. stripe.com. The Clay column shape. Used by resolve, qualify and timing. |
| `company_domains` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | Many domains at once. Used by resolve, qualify and timing. |
| `tickers` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | Exchange tickers, e.g. NWLG. Matched against the primary ticker and every venue listing. |
| `isins` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | 12 character ISINs. |
| `leis` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | 20 character Legal Entity Identifiers. |
| `ciks` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | SEC Central Index Keys, with or without leading zeros. |
| `company_names` | string[] | `resolve_company`, `qualify_company`, `get_reporting_timing` | Legal or trading names. Matched on a normalized name. Former names are not available: the alias table carries tickers and ISINs only. |
| `exchange_codes` | string[] | all five | ISO 10383 MICs. 18 venues are covered. |
| `country_codes` | string[] | all five | ISO 3166-1 alpha-2, e.g. US, GB, FR. |
| `regions` | string[] | all five | Shorthand for a set of venues and countries: us, uk, eu. Widens an explicit exchange or country filter rather than replacing it. |
| `sectors` | string[] | all five | SEC SIC descriptions, e.g. Pharmaceutical Preparations. Populated on roughly 65 percent of the publishable universe. |
| `security_types` | string[] | all five | ordinary_shares, depositary_receipt, preferred_shares. |
| `public_float_bands` | string[] | all five | micro, small, mid, large, mega, unknown. Size runs on public float because market capitalization is not populated anywhere in this dataset. |
| `fiscal_year_end_months` | string[] | all five | Integers 1 to 12. Fiscal year end is effectively a United States field in this dataset. |
| `exclude_december_fiscal_year_end` | string (`false`, `true`) | all five | Keep only companies whose fiscal year ends in a month other than December, the accounts whose budget cycle is out of phase with a calendar quarter. |
| `cadences` | string[] | all five | quarterly, semiannual, annual, unknown. |
| `operating_companies_only` | string (`false`, `true`) | all five | Drop funds, trusts and other non operating entities. |
| `exclude_blank_checks` | string (`false`, `true`) | all five | Drop pre deal SPACs. Separate from the operating company filter: a blank check shell is flagged as an operating company and passes every ordinary firmographic filter. |
| `foreign_private_issuer` | string (`any`, `only`, `exclude`) | all five | Filter on foreign private issuer status. |
| `us_registrant_only` | string (`false`, `true`) | all five | Keep only companies carrying an SEC CIK. |
| `min_provenance_confidence` | string (`any`, `high`) | all five | Set to high to exclude rows whose source terms were never read. |
| `exclude_name_only_matches` | string (`false`, `true`) | all five | Drop rows whose identity link rests on a name and country agreeing rather than on an identifier. Use this wherever a wrong identity link matters. |
| `exclude_share_alike` | string (`false`, `true`) | all five | Drop rows derived from CC BY-SA sources, whose share alike condition may not suit a closed product. |
| `listed_only` | string (`false`, `true`) | `qualify_company` | qualify mode. Keep only rows proven to be publicly listed. |
| `suppress_listed` | string (`false`, `true`) | `qualify_company` | qualify mode. Remove companies proven to be publicly listed, for anyone selling only into private companies. It removes what we can prove is listed; it does not warrant that the remainder is private. |
| `assume_unmatched_is_private` | string (`false`, `true`) | `qualify_company` | qualify mode. By default an unmatched company returns is_listed null, because a non match may mean the company is private OR that we do not hold its domain. Set true to opt into reading a non match as private, which sets is_listed false. |
| `event_types` | string[] | `get_reporting_timing`, `get_reporting_season` | full_year_results, half_year_results, quarterly_results, trading_update, annual_report_publication, sustainability_report_publication, agm, proxy_filing, capital_markets_day. |
| `window_lead_days` | string | `get_reporting_timing` | How many days before the event the outreach window opens. Default 70. |
| `window_lag_days` | string | `get_reporting_timing` | How many days before the event the outreach window closes. Default 42. Must be less than the lead. |
| `window_statuses` | string[] | `get_reporting_timing` | Keep only rows in these window states: open, not_yet, closed_passed, no_event. |
| `max_days_to_event` | string | `get_reporting_timing` | Drop rows whose next event is further away than this. A cost control. |
| `min_cadence_confidence` | string | `get_reporting_timing` | 0 to 1. Rows whose cadence confidence falls below this return a null timing block with a stated reason rather than a guess. Quarterly cadence averages 0.94, annual 0.40, semiannual 0.21. |
| `include_constrained_period` | string (`true`, `false`) | `get_reporting_timing` | Emit the period in which a listed company is constrained in what it can announce, derived from the same window numbers. Useful for campaign and announcement timing. |
| `limit` | string | `build_company_universe`, `get_reporting_season` | Maximum rows for universe and season. Truncation is always reported, never silent. |
| `season_group_by` | string (`week`, `month`) | `get_reporting_season` | season mode. Bucket size. |
| `season_split_by` | string (`none`, `sector`, `country`, `exchange_code`) | `get_reporting_season` | season mode. Optional second dimension. |
| `season_from` | string | `get_reporting_season` | season mode. ISO date. Defaults to today. |
| `season_to` | string | `get_reporting_season` | season mode. ISO date. Defaults to 180 days from today. |

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
