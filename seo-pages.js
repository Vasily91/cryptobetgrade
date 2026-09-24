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

  m = path.match(/^\/sportsbooks\/([a-z0-9-]+)\/reviews$/);
  if (m) return { kind: "operator-reviews", id: m[1] };

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
    description: `${op.name} reviewed: Trust Score ${op.score ?? "—"}/10, ${op.complaintStats.total} reported complaints, licensing, KYC stance, and payout reliability — independently assessed by CryptoBetGrade. Read visitor complaints and reviews, or submit your own.`,
    canonicalPath: `/sportsbooks/${op.id}`,
    viewHtml: op.overviewHtml,
    jsonLd,
  };
}

function operatorComplaintsMeta(op) {
  return {
    title: `${op.name} Complaints — ${op.complaints.length} Reported Cases | CryptoBetGrade`,
    description: `${op.complaints.length} publicly-sourced complaints reported against ${op.name}, plus complaints filed directly with CryptoBetGrade by visitors — read outcomes and disputed amounts, or file your own complaint.`,
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

function operatorReviewsMeta(op) {
  return {
    title: `${op.name} Reviews — Visitor Ratings & Feedback | CryptoBetGrade`,
    description: `Real visitor reviews and star ratings for ${op.name}, submitted directly and checked by CryptoBetGrade before publishing — read them, or write your own.`,
    canonicalPath: `/sportsbooks/${op.id}/reviews`,
    viewHtml: op.reviewsHtml,
    jsonLd: [breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Reviews", `${SITE_URL}/sportsbooks/${op.id}/reviews`],
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
  // These two exist to make explicit, in structured data search engines and
  // AI crawlers actually parse, that CryptoBetGrade is not just an
  // aggregator of third-party complaint sites — visitors can file a
  // complaint or leave a star review directly here, reviewed by
  // CryptoBetGrade before it's published. See the Complaints/Reviews tabs
  // on this same page (and file-a-complaint.html / write-a-review.html).
  qas.push({
    q: `Can I file a complaint about ${op.name} directly with CryptoBetGrade?`,
    a: `Yes — visitors can file a complaint about ${op.name} directly on this site. Every submission is reviewed by CryptoBetGrade before it's published, and the submitter can post follow-up updates once it's live. See the Complaints tab on this page.`,
  });
  qas.push({
    q: `Can I leave a review of ${op.name}?`,
    a: `Yes — visitors can rate ${op.name} from 1 to 5 stars and leave a written review directly on this site. Reviews are checked by CryptoBetGrade before publishing. See the Reviews tab on this page.`,
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
  if (match.kind === "operator-reviews") {
    const op = OPERATORS_BY_ID.get(match.id);
    return op ? operatorReviewsMeta(op) : null;
  }
  if (match.kind === "complaint") {
    const entry = COMPLAINT_INDEX.get(match.slug);
    return entry ? complaintMeta(entry.op, entry.complaint) : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// Live, visitor-submitted content (complaints + reviews), rendered
// server-side at request time from D1 — NOT part of data.json, which is a
// build-time snapshot with no database access. Without this, every
// crawler that doesn't execute JS (most of them, including most LLM
// crawlers) would only ever see the curated, third-party-sourced dataset
// on these pages — i.e. exactly the "we're just an aggregator" signal
// this exists to fix. dashboard.html's own client JS (cbgLoadComplaints /
// cbgLoadReviews) re-fetches and re-renders over this once it hydrates,
// so this only has to be reasonable markup for the pre-hydration/no-JS
// case, not pixel-identical to the client render.
// ---------------------------------------------------------------------

const PUBLIC_COMPLAINT_STATUSES = ["open", "awaiting_response", "resolved", "rejected"];

async function fetchCommunityComplaints(env, slug) {
  try {
    const placeholders = PUBLIC_COMPLAINT_STATUSES.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT title, description, amount, status, created_at FROM complaints
       WHERE operator_slug = ? AND status IN (${placeholders})
       ORDER BY created_at DESC LIMIT 30`
    ).bind(slug, ...PUBLIC_COMPLAINT_STATUSES).all();
    return rows.results || [];
  } catch (e) {
    console.error("SEO page: community complaints fetch failed:", e);
    return [];
  }
}

async function fetchApprovedReviews(env, slug) {
  try {
    const rows = await env.DB.prepare(
      `SELECT r.rating, r.title, r.body, r.created_at, u.email AS submitter_email
       FROM reviews r JOIN users u ON u.id = r.submitter_user_id
       WHERE r.operator_slug = ? AND r.status = 'approved'
       ORDER BY r.created_at DESC LIMIT 30`
    ).bind(slug).all();
    return rows.results || [];
  } catch (e) {
    // Also covers the reviews table not existing yet on a fresh deploy
    // before the one-time /api/admin/migrate-reviews ping has run — fail
    // to an empty list rather than a 500 for the whole page.
    console.error("SEO page: reviews fetch failed:", e);
    return [];
  }
}

const CBG_STATUS_LABEL = { open: "Open", awaiting_response: "Awaiting response", resolved: "Resolved", rejected: "Rejected" };
const CBG_STATUS_CLASS = { open: "bad", awaiting_response: "bad", resolved: "good", rejected: "neutral" };

function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n).trim() + "…" : s;
}
function dateShort(iso) {
  try { return new Date(String(iso).replace(" ", "T") + "Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }
  catch (e) { return String(iso || ""); }
}
function maskEmail(email) {
  const at = (email || "").indexOf("@");
  if (at < 1) return "Verified user";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  const hiddenLen = Math.max(local.length - visible.length, 3);
  return `${visible}${"*".repeat(hiddenLen)}@${domain}`;
}
function starsHtml(rating, size) {
  size = size || 15;
  const n = Math.round(rating || 0);
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${i <= n ? "#f5a623" : "none"}" stroke="#f5a623" stroke-width="1.5" style="vertical-align:-3px;"><polygon points="12 2.5 15.09 8.9 22.18 9.9 17.09 14.85 18.27 21.9 12 18.6 5.73 21.9 6.91 14.85 1.82 9.9 8.91 8.9"/></svg>`;
  }
  return out;
}

function communityComplaintsHtml(rows, operatorName) {
  if (!rows.length) {
    return `<div class="empty-note">No community-submitted complaints yet — be the first to file one if you've had an issue with ${esc(operatorName)}.</div>`;
  }
  return rows.map(c => `
    <div class="complaint">
      <div class="row1">
        <div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
            <span class="unverified-tag">Community report</span>
          </div>
          <div class="ctitle">${esc(c.title)}</div>
          <div class="cmeta">${esc(truncate(c.description, 120))}</div>
        </div>
        <span class="status-chip status-${CBG_STATUS_CLASS[c.status] || "neutral"}">${CBG_STATUS_LABEL[c.status] || c.status}</span>
      </div>
      <div class="cmeta" style="margin-top:8px;">${c.amount ? esc(c.amount) + " at stake" : "Amount not stated"} · filed ${dateShort(c.created_at)}</div>
    </div>
  `).join("");
}

function reviewsHtmlBlocks(rows, operatorName) {
  const count = rows.length;
  const average = count ? rows.reduce((s, r) => s + r.rating, 0) / count : null;
  const summary = count ? `
      <div class="sidebar-box" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="font-size:32px;font-weight:800;color:var(--ink);line-height:1;">${average.toFixed(1)}</div>
        <div>
          <div>${starsHtml(average, 18)}</div>
          <div class="cmeta" style="margin-top:4px;">${count} review${count === 1 ? "" : "s"}</div>
        </div>
      </div>
    ` : `<div class="empty-note">No reviews yet — be the first to rate your experience with ${esc(operatorName)}.</div>`;

  const list = rows.map(r => `
    <div class="complaint">
      <div class="row1">
        <div>
          <div style="margin-bottom:6px;">${starsHtml(r.rating)}</div>
          ${r.title ? `<div class="ctitle">${esc(r.title)}</div>` : ""}
          <div class="cmeta" style="white-space:pre-wrap;color:var(--ink-2);">${esc(r.body)}</div>
        </div>
      </div>
      <div class="cmeta" style="margin-top:8px;">${esc(maskEmail(r.submitter_email))} · ${dateShort(r.created_at)}</div>
    </div>
  `).join("");

  return { summary, list };
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

  // Splice in the live, visitor-submitted content (see the big comment
  // above fetchCommunityComplaints) — env.DB is present on the deployed
  // Worker; guarded here mainly so local/test environments without a DB
  // binding degrade to the static "Loading…" placeholder instead of
  // throwing.
  if (match.kind === "operator-complaints" && env?.DB) {
    const op = OPERATORS_BY_ID.get(match.id);
    const rows = await fetchCommunityComplaints(env, match.id);
    const placeholder = `<div id="cbgComplaints-${match.id}"><div class="empty-note">Loading…</div></div>`;
    if (html.includes(placeholder)) {
      html = html.replace(placeholder, `<div id="cbgComplaints-${match.id}">${communityComplaintsHtml(rows, op?.name || "")}</div>`);
    }
  }
  if (match.kind === "operator-reviews" && env?.DB) {
    const op = OPERATORS_BY_ID.get(match.id);
    const rows = await fetchApprovedReviews(env, match.id);
    const { summary, list } = reviewsHtmlBlocks(rows, op?.name || "");
    const summaryPlaceholder = `<div id="cbgReviewsSummary-${match.id}" style="margin-bottom:18px;"><div class="empty-note">Loading…</div></div>`;
    const listPlaceholder = `<div id="cbgReviewsList-${match.id}"></div>`;
    if (html.includes(summaryPlaceholder)) {
      html = html.replace(summaryPlaceholder, `<div id="cbgReviewsSummary-${match.id}" style="margin-bottom:18px;">${summary}</div>`);
    }
    if (html.includes(listPlaceholder)) {
      html = html.replace(listPlaceholder, `<div id="cbgReviewsList-${match.id}">${list}</div>`);
    }
  }

  return html;
}
