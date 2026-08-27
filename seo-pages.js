// Server-rendered, crawlable pages for the operator/complaint database.
//
// WHY THIS FILE EXISTS: dashboard.html is a single-page app whose routing
// lives entirely in the URL "#" fragment (e.g. #/operator/stake/complaint/
// cst1). Fragments are never sent to the server, so Google only ever sees
// one URL — /dashboard — no matter which operator or complaint is open;
// hundreds of complaint records were effectively invisible to search. This
// module gives each operator and each complaint a real path
// (/sportsbooks/{id}, /sportsbooks/{id}/complaints, /complaints/{slug})
// that returns actual HTTP 200 HTML — real <title>, <h1>, and full content
// — instead of the generic SPA shell.
//
// HOW IT STAYS PIXEL-IDENTICAL TO THE APP: rather than a hand-built
// lookalike template (which drifted visually from the real dashboard and
// was confusing — see conversation history), this fetches the real
// dashboard.html, and:
//   1. swaps in a page-specific <title>/description/canonical/JSON-LD,
//   2. pre-fills the normally-empty `#view` div with the ACTUAL rendered
//      HTML for that operator/complaint (captured from dashboard.html's
//      own render pipeline — see tools/extract-data.mjs),
//   3. adds <base href="/"> so the nav's relative links still resolve
//      correctly from a nested path like /sportsbooks/x/complaints.
// dashboard.html's own script is also patched (tools/patch-dashboard.mjs)
// to recognize these real paths on load, so once client JS boots it
// re-renders the identical view — full tabs/filters/admin login all still
// work, this is not a stripped-down copy.
//
// DATA SOURCE: data.json is a machine-generated snapshot of dashboard.html's
// inline script output (see tools/extract-data.mjs, which runs the real
// script in a sandboxed Node vm and reads back its computed rendering) —
// this never drifts into hand-maintained duplicate data. IMPORTANT:
// whenever dashboard.html's operator/complaint data changes, re-run
// `node tools/extract-data.mjs` and redeploy the refreshed data.json
// alongside it, or these pages will show stale content.

import DATA from "./data.json";

const SITE_URL = "https://cryptobetgrade.com";

const OPERATORS_BY_ID = new Map(DATA.operators.map(op => [op.id, op]));
const COMPLAINT_INDEX = new Map(); // slug -> { op, complaint }
for (const op of DATA.operators) {
  for (const c of op.complaints) {
    COMPLAINT_INDEX.set(c.slug, { op, complaint: c });
  }
}

const ISSUE_TAG_PHRASE = {
  "Account closed after sportsbook/provider flag": "Account Closure",
  "Account compromised / unauthorized redemption": "Account Compromise",
  "Balance including deposit confiscated": "Balance Confiscation",
  "Funds locked in betting-integrity review": "Funds Locked in Review",
  "Only original deposit returned": "Partial Refund",
  "Responsible-gambling / self-exclusion dispute": "Self-Exclusion Dispute",
  "Winning bets voided after settlement": "Voided Bets",
  "Winnings confiscated / forfeited": "Winnings Confiscation",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function issuePhrase(c) { return ISSUE_TAG_PHRASE[c.issueTag] || c.issueTag || "Complaint"; }

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------

export function matchSeoRoute(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";

  let m = path.match(/^\/sportsbooks\/([a-z0-9-]+)\/complaints$/);
  if (m) return { kind: "operator-complaints", id: m[1] };

  m = path.match(/^\/sportsbooks\/([a-z0-9-]+)$/);
  if (m) return { kind: "operator", id: m[1] };

  m = path.match(/^\/complaints\/([a-z0-9-]+)$/);
  if (m) return { kind: "complaint", slug: m[1] };

  return null;
}

// ---------------------------------------------------------------------
// Per-route metadata (title/description/canonical/JSON-LD/view HTML)
// ---------------------------------------------------------------------

function operatorMeta(op) {
  return {
    title: `${op.name} Review — Trust Score, KYC & Complaints | CryptoBetGrade`,
    description: `${op.name} reviewed: Trust Score ${op.score ?? "—"}/10, ${op.complaintStats.total} reported complaints, licensing, KYC stance, and payout reliability — independently assessed by CryptoBetGrade.`,
    canonicalPath: `/sportsbooks/${op.id}`,
    viewHtml: op.overviewHtml,
    jsonLd: breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard.html`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
    ]),
  };
}

function operatorComplaintsMeta(op) {
  return {
    title: `${op.name} Complaints — ${op.complaints.length} Reported Cases | CryptoBetGrade`,
    description: `${op.complaints.length} publicly-sourced complaints reported against ${op.name}, with outcomes, disputed amounts, and links to the original source.`,
    canonicalPath: `/sportsbooks/${op.id}/complaints`,
    viewHtml: op.complaintsHtml,
    jsonLd: breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard.html`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Complaints", `${SITE_URL}/sportsbooks/${op.id}/complaints`],
    ]),
  };
}

function complaintMeta(op, c) {
  const amountPart = c.amount ? `${c.amount} ` : "";
  const phrase = issuePhrase(c);
  return {
    title: `${op.name} ${amountPart}${phrase} Complaint | CryptoBetGrade`,
    description: `${op.name} complaint: ${c.whatHappened.length > 180 ? c.whatHappened.slice(0, 177) + "…" : c.whatHappened}`,
    canonicalPath: `/complaints/${c.slug}`,
    viewHtml: c.html,
    jsonLd: breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard.html`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Complaints", `${SITE_URL}/sportsbooks/${op.id}/complaints`],
      [phrase, `${SITE_URL}/complaints/${c.slug}`],
    ]),
  };
}

function breadcrumb(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
  };
}

function metaFor(match) {
  if (match.kind === "operator") {
    const op = OPERATORS_BY_ID.get(match.id);
    return op ? operatorMeta(op) : null;
  }
  if (match.kind === "operator-complaints") {
    const op = OPERATORS_BY_ID.get(match.id);
    return op ? operatorComplaintsMeta(op) : null;
  }
  if (match.kind === "complaint") {
    const entry = COMPLAINT_INDEX.get(match.slug);
    return entry ? complaintMeta(entry.op, entry.complaint) : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// Render: fetch the real dashboard.html and graft in page-specific
// metadata + the pre-rendered view content.
// ---------------------------------------------------------------------

export async function renderSeoPage(match, env, request) {
  const meta = metaFor(match);
  if (!meta) return null;

  const dashUrl = new URL("/dashboard.html", request.url);
  const dashResp = await env.ASSETS.fetch(new Request(dashUrl, request));
  if (!dashResp.ok) return null;
  let html = await dashResp.text();

  const canonical = `${SITE_URL}${meta.canonicalPath}`;
  const headExtra = `<base href="/">
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${canonical}">
<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>
</head>`;

  html = html.replace(/<title>.*?<\/title>/s, `<title>${esc(meta.title)}</title>`);
  html = html.replace("</head>", headExtra);
  html = html.replace(
    '<div class="wrap" id="view"></div>',
    `<div class="wrap" id="view">${meta.viewHtml}</div>`
  );

  return html;
}
