# Data pipeline — run in this order

`dashboard.html` + `dashboard-data.js` together are the single source of
truth for all operator/complaint data (it lives inside inline/external
`<script>` code, not a JSON data file). **As of 2026-09-12, the big static
data constants live in `dashboard-data.js`, NOT in dashboard.html anymore**
— this was split out (see `dashboard-data.js`'s own header comment) so this
~550KB payload, previously re-sent in full inside every single one of the
~450 dynamic `/sportsbooks/{id}` and `/complaints/{slug}` pages, is instead
one separately-cacheable file the browser fetches once and reuses across
every page navigation. If you're looking for `COMPLAINT_REPORTS`,
`TERMS_INFO`, `COMPANY_INFO`, `PROFILE_SIDEBAR`, `PROFILE_STATS`,
`RESTRICTED_COUNTRIES`, `KEY_CONS`, `ARBITRAGE_CLAUSE`, or
`BONUS_KYC_CHECKLIST` to edit operator/complaint data, **edit
`dashboard-data.js`**, not dashboard.html. Everything else —
`COMPLAINT_SLUGS`/`COMPLAINT_SLUG_INDEX`/`matchRealPath` (auto-generated,
see step 4) and all rendering/app logic — stays in dashboard.html, loaded
via a plain synchronous `<script src="/dashboard-data.js"></script>` tag
placed immediately before dashboard.html's main inline `<script>` (both
non-module/non-defer, so execution order — and therefore correctness — is
identical to when this was one file: dashboard-data.js's top-level `const`s
are just as visible to the code in the inline script that follows it as
they were when in the same block).

Everything downstream — `data.json`, the SEO pages (`seo-pages.js`),
`sitemap.xml`, and the homepage hero card (`hero-operator.json`) — is
machine-generated FROM dashboard.html + dashboard-data.js together and goes
stale the moment either file's data changes without a re-run. Whenever you
edit anything inside `TRUST_BREAKDOWN`, `COMPLAINT_REPORTS`, or any other
seeded operator data, run the full pipeline below before deploying —
skipping a step is exactly how the homepage hero card went stale twice (it
kept showing "BC.Game 9.0" after the score had already changed) before
`gen-hero.mjs` existed.

1. **Balance-check both dashboard.html AND dashboard-data.js** before doing
   anything else — a quick `node -e` counting `{`/`}`, `[`/`]`, `(`/`)` in
   each file. Catches a typo before it corrupts every downstream artifact.
   Note dashboard-data.js carries a known, confirmed-harmless pre-existing
   1-paren imbalance (inherited from dashboard.html's own long-standing
   quirk when this was all one file) — a consistent 1-off delta there is
   expected, not a regression; watch that it doesn't grow.

2. `node tools/extract-data.mjs`
   Runs dashboard-data.js + dashboard.html's real inline script (in that
   order — dashboard-data.js first, exactly like the browser) in a
   sandboxed Node `vm` and reads back its actual computed output (operators,
   complaints, breakdown,
   onchain stats, slugs, rendered HTML per page, …). Writes
   `tools/extracted-data.json` and `tools/slug-report.json`.

3. `cp tools/extracted-data.json data.json`
   `data.json` is what `seo-pages.js` (SSR operator/complaint pages) and
   `tools/gen-hero.mjs` (homepage hero card) both read from.

4. `node tools/patch-dashboard.mjs`
   Regenerates the `COMPLAINT_SLUGS` / `COMPLAINT_SLUG_INDEX` /
   `matchRealPath` blocks inside dashboard.html so its own router recognizes
   the real `/sportsbooks/{id}` and `/complaints/{slug}` URLs. Idempotent —
   safe to re-run. Never hand-edit these generated blocks.

5. `node tools/gen-sitemap.mjs`
   Only needed when operator/complaint URLs were added or removed (not
   needed for a pure score/complaint-text edit). Regenerates `sitemap.xml`.

5b. `node tools/gen-hero-search.mjs`
   Only needed when an operator was added or removed (same trigger as step
   5) — regenerates the `HERO_SEARCH_OPERATORS` array inside `index.html`,
   which powers the homepage hero search box's autocomplete. This list is
   hand-authored HTML/JS, not derived from dashboard.html at page-load time
   like the sportsbooks list is, so it silently goes stale on every new
   operator otherwise — confirmed stale on 2026-09-05, when 15 operators
   added since the block was last hand-updated were all unsearchable from
   the homepage. Safe to re-run any time.

6. `node tools/gen-hero.mjs && cp tools/hero-operator.json hero-operator.json`
   Regenerates the homepage hero card snapshot: whichever operator currently
   has the highest `score` in `data.json`. `index.html` fetches
   `/hero-operator.json` client-side on every load, so the hero card always
   shows the real current #1 automatically — but only if this file is
   regenerated (and redeployed) every time scores change. **This step is
   easy to forget because nothing else in the pipeline touches the
   homepage — that's exactly what caused the staleness bug this step now
   prevents.**

7. Local sanity check — a `node -e` reading the fresh `data.json` (and, if
   scores changed, `hero-operator.json`) to confirm the numbers/top operator
   are what you expect, before deploying anything.

8. Deploy: upload the changed files (typically `dashboard.html` AND
   `dashboard-data.js` together whenever operator/complaint data changed —
   they're two halves of one app now, always redeploy both even if only one
   of them actually changed content, to avoid a stale/fresh mismatch between
   them — plus `data.json`, `sitemap.xml` when regenerated,
   `hero-operator.json` + `index.html` when scores changed, and `index.html`
   again whenever step 5b ran — an operator addition/removal touches
   `index.html` for that reason alone, even when the hero score didn't
   change) via the GitHub web-upload
   flow at
   `https://github.com/Vasily91/cryptobetgrade/upload/main`, commit, wait for
   Cloudflare propagation (~10–20s), then verify live rather than trusting
   the commit alone:
   - `fetch('/hero-operator.json')` should return the expected top operator.
   - Reading `document.getElementById('heroName'|'heroScore'|...)` on the
     live homepage (after the page has had a moment to run its fetch) should
     match, not just the static HTML fallback values.

9. Optional but recommended when URLs changed: ping IndexNow so Bing/Yandex
   re-crawl immediately instead of waiting for their own schedule. The site's
   IndexNow key is `ce8e0ff843924306aeec4eb6d31b453d`, hosted (and must stay
   hosted) at `https://cryptobetgrade.com/ce8e0ff843924306aeec4eb6d31b453d.txt`
   — do not delete that file, Bing revalidates against it. To ping, run this
   in a browser tab on the `cryptobetgrade.com` origin (server-to-server
   calls to `api.indexnow.org` get blocked; a same-origin browser tab can
   still fire individual GET pings to `bing.com/indexnow` with `mode:
   'no-cors'` — see the one-time bulk-submit done on 2026-09-04, which
   pinged all 332 sitemap URLs this way):
   ```js
   fetch("https://www.bing.com/indexnow?url=" + encodeURIComponent(URL) +
     "&key=ce8e0ff843924306aeec4eb6d31b453d", {mode: "no-cors"});
   ```
   Google has no equivalent push API — Search Console (already verified,
   sitemap already submitted) just needs its own crawl schedule to catch up.
