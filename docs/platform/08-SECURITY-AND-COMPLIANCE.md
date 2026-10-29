# 08 — Security and compliance

## 1. Threat model (what we protect)

| Asset | Threat | Control |
|---|---|---|
| Tenant data (prompts, results, client names) | Cross-tenant read via bug or key misuse | RLS on every table; key → profile/brand injection in one repository helper; tenancy tests in CI |
| Platform API keys | Leak from agent configs / logs | Hash-only storage; prefix display; scopes; brand restriction; expiry; revocation ≤ 60 s; secret scanning pattern `cs_live_[A-Za-z0-9]{40,}` registered for GitHub push protection |
| Provider keys (BYOK) | DB dump, insider | AES-256-GCM envelope encryption; data key in Worker/Actions secrets (`CREDENTIALS_KEK`); decrypted only inside the worker at use time; never returned by any API; last-4 display |
| Spend | Runaway runs, malicious agent | Per-profile and per-brand monthly caps; run cost preview; `runs:write` scope; per-key rate limits; alert at 80% |
| Webhooks | SSRF via user-supplied URL | Allow only https, block private IP ranges after DNS resolution, timeout 5 s |
| MCP | Prompt injection via stored answers reaching an agent | Tool outputs mark answer text as untrusted data (`"source":"engine_answer"`); write tools need explicit args, deletes need `confirm:true` |
| Extension worker | Malicious job sent to a user's browser | Jobs are only prompt text + engine; the extension renders nothing from the server as code; prompts length-limited; profile-scoped leases |

## 2. Authentication & sessions
- Supabase Auth (magic link, Google). JWT verified in the Worker with the project JWKS.
- Owners can require Google SSO domain for a profile (v1.1).
- All admin actions (keys, members, credentials) in `audit_log`.

## 3. Secrets management
| Secret | Where |
|---|---|
| Supabase service role key, `CREDENTIALS_KEK`, platform provider keys | Cloudflare Worker secrets + GitHub Actions encrypted secrets (worker) |
| Local dev | `.dev.vars` / `.env` (gitignored); `.env.example` committed |
Rotate the KEK by re-encrypting `provider_credentials` in a maintenance job (versioned `kek_id` column, v1.1).

## 4. Terms-of-service posture per collection method

| Method | Position |
|---|---|
| Official APIs (OpenAI, Google, Perplexity, Anthropic) | Within terms. Respect each provider's usage policies and attribution/display requirements (e.g. Google Search Suggestions for grounded Gemini results). |
| UI-scrape vendors (DataForSEO, Bright Data, Apify) | The vendor operates the collection and carries that risk; we consume a data product under their terms. Keep the vendor named in our docs/privacy policy as a sub-processor. |
| Extension browser worker | Automation of a consumer service whose terms (OpenAI's, as quoted by third parties) prohibit automated extraction outside the API. Keep it **opt-in, user-initiated, human-paced, on the user's own account**, with the same explicit warning the extension already shows, and recommend a dedicated account. Not the default for any engine. |
| Self-run headless scraping fleet | **Not built.** High ban risk, constant anti-bot maintenance, clearer ToS breach. |

## 5. Privacy & data protection
- Data processed: account emails, prompts (business data), engine answers (public-web derived).
  No end-user personal data is intentionally collected.
- Publish a privacy policy listing sub-processors: Cloudflare, Supabase, GitHub (Actions), each
  enabled collector vendor and LLM provider.
- Region: choose Supabase region closest to users (e.g. `ap-south-1` Mumbai for India); R2 location hint.
- Retention configurable per profile; account deletion removes DB rows and R2 prefix within 30 days.
- India DPDP Act / GDPR: provide export + deletion endpoints; DPA template once external customers exist.
- The Chrome-store extension's "nothing leaves your device" promise stays true by default; the
  cloud connector is opt-in and must be disclosed in the store listing's data-use section before shipping.

## 6. Secure development
- CI: typecheck, unit tests (including the ported extension suite), tenancy isolation tests, `npm audit`/OSV scan, secret scanning.
- Dependency pinning with lockfile; Renovate weekly.
- Least privilege: Worker uses anon key + JWT for user requests where possible; service role only in the worker and key-auth path.
- Logs never include prompt text at info level, never include keys; request IDs on every log line.
