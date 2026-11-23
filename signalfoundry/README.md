# SignalForge GR — Autonomous Commercial Intelligence (prototype)

**Status (2026-11-23):** source committed; automated tests on synthetic OCDS fixtures pass; **NOT DEPLOYED**. Render rejected a new free web service (free-tier quota exhausted); Vercel connected project scope requires re-authorization. There are **NO verified new sales** and PayPal remains **DISABLED**.

## Purpose
This is an independently hosted business-intelligence service that would retrieve open Greek public procurement records from Diavgis OCDS, cautiously filter tenders with future deadlines, classify CPV, create attribution-linked briefs, expose a live UI and RSS, and — only after proper merchant connection and fulfillment hardening — sell source-grounded business reports.

Diavgis source: https://diavgis.gr (CC BY 4.0), machine endpoint: https://api.diavgis.gr/ocds/releases/YYYY-MM-DD .

This product is **not unique**; the Greek procurement market has active competitors including Diavgis, GOVADI and PublicFlow. Demand, conversion and profitability have not been validated.

## Architecture
- `Scout` — externally fetches publicly documented OCDS releases.
- `Verifier` — rejects records without source IDs and a verifiably future deadline.
- `Matcher` — deterministic CPV/title classification; no ungrounded AI claims.
- `Briefmaker` — prepares grounded summaries with explicit unknowns.
- `Publisher` — dynamically serves homepage, source-linked public briefs, RSS and sitemap.
- `Commerce` — fail-closed PayPal Orders API gate; attempts a capture only after PayPal seller credentials and verification are in place.

The server scans 5 selected public issued-date packages in each cycle, not the full national register. Some API days may have additional cursor pages. The scanner is **not exhaustive**. A process that starts on free hosting may sleep, so its in-process timer alone cannot guarantee a 24/7 schedule; production requires authorized managed scheduling.

## Run and test
```sh
node --check signalfoundry/server.mjs
node --test signalfoundry/server.test.mjs
node signalfoundry/server.mjs
```

Go to http://localhost:10000 and visit `/health` and `/api/agents`.

For production, use Node >=20, `PUBLIC_ORIGIN`, a real persistent scheduler and appropriate monitoring. The data source may be temporarily unavailable, in which case the UI must never invent opportunities.

## Payment safety
Setting a PayPal email address alone does not activate payment collection. PayPal's REST API needs properly scoped live merchant credentials and fulfillment safeguards. The current PayPal integration is **not live-tested**, and secure durable order/receipt recovery (including after restart) must be completed before accepting production payments.

Never put secrets in GitHub, browser code, marketing text, or screenshots. No phantom purchases, no automatic cold-email spam, no click manipulation, and no guarantees of returns.

## Monetization
Suggested **hypothesis** (not validated): a one-time business-action brief at EUR 9.90, subject to actual willingness-to-pay tests, product differentiation and delivered value. No external distribution has been attempted or claimed.

## Attribution
Procurement data credited to **Diavgis**: https://diavgis.gr — CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ .
