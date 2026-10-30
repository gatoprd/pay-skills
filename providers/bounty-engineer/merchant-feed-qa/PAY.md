---
name: merchant-feed-qa
title: "Bounty Engineer Merchant Feed & GTIN QA"
description: "Validate uploaded merchant RSS/XML and JSON feeds for GTIN/EAN errors, duplicate IDs, invalid prices, inventory values and missing product attributes with reproducible results."
use_case: "Use before Google Merchant Center feed imports or when diagnosing product disapprovals, invalid GTINs, variant mismatches and missing attributes."
category: shopping
service_url: https://bounty-engineer-x402-prod.onrender.com
version: v1
openapi:
  path: openapi.json
---

# Merchant Feed QA

Machine-readable merchant product data QA via a real paid x402 API. Send either uploaded `feed_xml` (RSS/XML) or an `items` JSON array, maximum 1,000 products, and get structured diagnostic issues, summary counts, field coverage and a SHA-256 evidence hash.

**Live price:** 4.90 USDC per accepted request (consult the runtime HTTP 402 challenge before authorizing). Supported buyer rails shown by production: Solana mainnet USDC and Base mainnet USDC. The buyer selects and signs their own transaction. No signup or API key.

**Limitations:** Uploaded feed checks only: no access to private Google Merchant Center accounts, no fetching seller URLs, no approval/certification promise, no GS1 ownership claim. A free, non-billable demo is available at `GET /v1/merchant-feed-audit/demo`.

## Spend-aware usage

- Validate product data in bulk rather than paying per item.
- Reject malformed XML and empty input locally before paying.
- Use the free demo to inspect output shape, then call the paid endpoint with the exact feed you wish to validate.
- Check the actual runtime 402 terms, network, asset, payee and price with your own spending policy.
- Do not infer a paid settlement from receiving 402 or reading this listing.

API guide: https://bounty-engineer-x402-prod.onrender.com/solutions/merchant-feed-qa
