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
// whenever dashboard.html's operator/complaint data changes, run the full
// pipeline in tools/README.md (extract-data.mjs -> data.json ->
// patch-dashboard.mjs -> gen-sitemap.mjs if URLs changed -> gen-hero.mjs for
// the homepage hero card) and redeploy the refreshed files, or these pages
// (and the homepage hero card) will show stale content.

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
  const jsonLd = [
    breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
    ]),
  ];
  const review = reviewJsonLd(op);
  if (review) jsonLd.push(review);
  const faq = faqJsonLd(op);
  if (faq) jsonLd.push(faq);
  return {
    title: `${op.name} Review — Trust Score, KYC & Complaints | CryptoBetGrade`,
    description: `${op.name} reviewed: Trust Score ${op.score ?? "—"}/10, ${op.complaintStats.total} reported complaints, licensing, KYC stance, and payout reliability — independently assessed by CryptoBetGrade.`,
    canonicalPath: `/sportsbooks/${op.id}`,
    viewHtml: op.overviewHtml,
    jsonLd,
  };
}

function operatorComplaintsMeta(op) {
  return {
    title: `${op.name} Complaints — ${op.complaints.length} Reported Cases | CryptoBetGrade`,
    description: `${op.complaints.length} publicly-sourced complaints reported against ${op.name}, with outcomes, disputed amounts, and links to the original source.`,
    canonicalPath: `/sportsbooks/${op.id}/complaints`,
    viewHtml: op.complaintsHtml,
    jsonLd: [breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Complaints", `${SITE_URL}/sportsbooks/${op.id}/complaints`],
    ])],
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
    jsonLd: [breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Complaints", `${SITE_URL}/sportsbooks/${op.id}/complaints`],
      [phrase, `${SITE_URL}/complaints/${c.slug}`],
    ])],
  };
}

function breadcrumb(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
  };
}

// Single-review structured data so eligible operator pages can show a star
// rating in Google search results. Only emitted when op.score is a real
// number (Trust Score is left null for a handful of very new/thin-data
// operators — no score means no fabricated rating). Uses the editorial
// "Review" type (one review, by CryptoBetGrade, of the operator), not
// AggregateRating — we don't aggregate multiple third-party ratings, this
// is our own independently-researched assessment.
function reviewJsonLd(op) {
  if (typeof op.score !== "number" || Number.isNaN(op.score)) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Review",
    itemReviewed: {
      "@type": "Organization",
      name: op.name,
      url: `${SITE_URL}/sportsbooks/${op.id}`,
    },
    reviewRating: {
      "@type": "Rating",
      ratingValue: op.score,
      bestRating: 10,
      worstRating: 0,
    },
    name: `${op.name} Review`,
    author: { "@type": "Organization", name: "CryptoBetGrade", url: SITE_URL },
    publisher: { "@type": "Organization", name: "CryptoBetGrade", url: SITE_URL },
    reviewBody: op.overview ? (op.overview.length > 600 ? op.overview.slice(0, 597) + "…" : op.overview) : undefined,
  };
}

// FAQ structured data for operator pages — built only from fields that
// already exist in data.json (min deposit, markets, complaint counts), each
// gated on the underlying field actually being present. No invented
// content: an operator with no min-deposit figure simply gets no min-deposit
// question, rather than a fabricated placeholder answer.
function faqJsonLd(op) {
  const qas = [];
  qas.push({
    q: `Is ${op.name} safe and trustworthy?`,
    a: typeof op.score === "number" && !Number.isNaN(op.score)
      ? `CryptoBetGrade rates ${op.name} ${op.score.toFixed(1)}/10 (${op.gradeLabel}), based on licensing, payout reliability, KYC practice, complaint record and terms fairness — see the full sourced breakdown on this page.`
      : `${op.name} has not yet been assigned a Trust Score by CryptoBetGrade. See this page for the research completed so far.`,
  });
  if (op.sidebar?.minDeposit) {
    qas.push({ q: `What is the minimum deposit at ${op.name}?`, a: op.sidebar.minDeposit });
  }
  if (op.stats?.markets) {
    qas.push({ q: `What sports and markets does ${op.name} offer?`, a: op.stats.markets });
  }
  qas.push({
    q: `How many complaints has ${op.name} received?`,
    a: op.complaintStats.total > 0
      ? `${op.complaintStats.total} publicly-sourced complaint${op.complaintStats.total === 1 ? "" : "s"} ${op.complaintStats.total === 1 ? "has" : "have"} been logged against ${op.name}, with ${op.complaintStats.ongoing} still unresolved or ongoing. See the full complaint log on this page for details and sources.`
      : (op.complaintsNote || `No complaints have been logged against ${op.name} in CryptoBetGrade's research so far.`),
  });
  if (qas.length < 2) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: qas.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
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

  // Cloudflare's static-asset handling 307-redirects "/dashboard.html" ->
  // "/dashboard" (clean URLs). A normal browser fetch() follows that
  // silently, but env.ASSETS.fetch() does not auto-follow it, so requesting
  // the extensionless clean URL directly avoids the redirect entirely.
  const dashUrl = new URL("/dashboard", request.url);
  const dashResp = await env.ASSETS.fetch(new Request(dashUrl, request));
  if (!dashResp.ok) return null;
  let html = await dashResp.text();
  if (!html.includes('<div class="wrap" id="view"></div>')) return null;

  // dashboard.html (the template this fetches) now carries its own static
  // description/canonical/OG/Twitter tags for when /dashboard is visited
  // directly. Strip those before grafting this route's page-specific ones
  // in below, or the page would ship two conflicting canonical links and
  // two meta descriptions — Search Console treats duplicate canonicals as
  // an invalid signal and effectively ignores both.
  html = html
    .replace(/<meta name="description"[^>]*>\n?/i, "")
    .replace(/<link rel="canonical"[^>]*>\n?/i, "")
    .replace(/<meta property="og:[^"]*"[^>]*>\n?/gi, "")
    .replace(/<meta name="twitter:[^"]*"[^>]*>\n?/gi, "");

  const canonical = `${SITE_URL}${meta.canonicalPath}`;
  const jsonLdBlocks = meta.jsonLd.map(obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`).join("\n");
  const headExtra = `<base href="/">
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="CryptoBetGrade">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${SITE_URL}/og-image.png">
${jsonLdBlocks}
</head>`;

  html = html.replace(/<title>.*?<\/title>/s, `<title>${esc(meta.title)}</title>`);
  html = html.replace("</head>", headExtra);
  html = html.replace(
    '<div class="wrap" id="view"></div>',
    `<div class="wrap" id="view">${meta.viewHtml}</div>`
  );

  return html;
}
