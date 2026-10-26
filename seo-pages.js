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

  // A single community-submitted (live, D1-backed) complaint — e.g.
  // /sportsbooks/rakebit/complaints/lost-500-usd-withdrawal-7, or a bare
  // /sportsbooks/rakebit/complaints/7 (still accepted, for links shared
  // before the descriptive slug was added). Distinct from the curated
  // /complaints/{slug} route below: this id is the live complaints.id from
  // the database, not a build-time slug, so it needs a request-time DB
  // fetch (see communityComplaintMeta) rather than a data.json lookup. The
  // text before the trailing dash-digit group is cosmetic only — it isn't
  // looked up, only the id is — but communityComplaintMeta always builds
  // its canonicalPath from the *current* title, so every URL for a given
  // complaint consolidates onto one canonical link regardless of which
  // slug text a visitor actually arrived on.
  let m = path.match(/^\/sportsbooks\/([a-z0-9-]+)\/complaints\/([a-z0-9-]+)$/);
  if (m) {
    const idMatch = m[2].match(/(?:^|-)(\d+)$/);
    if (idMatch) return { kind: "community-complaint", opId: m[1], id: Number(idMatch[1]) };
  }

  m = path.match(/^\/sportsbooks\/([a-z0-9-]+)\/complaints$/);
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
      `SELECT id, title, description, amount, status, created_at FROM complaints
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
const CBG_STATUS_CLASS = { open: "bad", awaiting_response: "pending", resolved: "good", rejected: "neutral" };

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
// Mirrors dashboard.html's cbgSlugify exactly — descriptive text in a
// community-complaint URL is cosmetic only (matchSeoRoute/matchRealPath
// both key off the trailing dash-digit group), but keeping the two
// generators identical means the link a visitor clicks already matches
// the canonical URL this file settles on, so there's no visible mismatch
// on first paint.
function slugify(s, maxLen) {
  maxLen = maxLen || 60;
  let slug = String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-+[^-]*$/, "");
  return slug || "complaint";
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

function communityComplaintsHtml(rows, operatorName, operatorSlug) {
  if (!rows.length) {
    return `<div class="empty-note">No community-submitted complaints yet — be the first to file one if you've had an issue with ${esc(operatorName)}.</div>`;
  }
  // Each card links to its own permalink (/sportsbooks/{slug}/complaints/
  // {descriptive-slug}-{id} — see matchSeoRoute's "community-complaint"
  // kind and dashboard.html's matching complaints-list card link) so every live
  // thread has a real, shareable, crawlable URL of its own, not just a
  // click target inside this list. A plain full navigation — dashboard.
  // html's own client JS (cbgLoadComplaints) replaces this whole list
  // with its own fetch once it hydrates, so no onclick interception is
  // needed here; the href alone is what crawlers, no-JS visitors, and
  // anyone copying the URL actually use.
  return rows.map(c => `
    <a class="complaint" href="/sportsbooks/${esc(operatorSlug || "")}/complaints/${slugify(c.title)}-${c.id}" style="display:block;text-decoration:none;color:inherit;">
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
    </a>
  `).join("");
}

// ---------------------------------------------------------------------
// A single community complaint's own page (/sportsbooks/{slug}/complaints/
// {id}) — see matchSeoRoute's "community-complaint" kind above. Unlike the
// curated /complaints/{slug} pages (static, from data.json), this is a
// live thread fetched from D1 at request time, so it always reflects the
// real current state (status, and any admin visibility/redaction applied
// to a message — see worker.js's getComplaint for the matching
// public-viewer filtering this mirrors).
// ---------------------------------------------------------------------

async function fetchCommunityComplaintThread(env, id, opSlug) {
  try {
    // public_summary may not exist yet on a given DB until
    // /api/admin/migrate-complaint-summary has run once — fall back to the
    // plain query, same guarded pattern used elsewhere in this file and in
    // worker.js's getComplaint.
    let complaint;
    try {
      complaint = await env.DB.prepare(
        `SELECT id, operator_slug, operator_name, title, description, public_summary, amount, status, created_at, updated_at FROM complaints WHERE id = ?`
      ).bind(id).first();
    } catch (e) {
      complaint = await env.DB.prepare(
        `SELECT id, operator_slug, operator_name, title, description, amount, status, created_at, updated_at FROM complaints WHERE id = ?`
      ).bind(id).first();
    }
    if (!complaint || complaint.operator_slug !== opSlug) return null;
    if (!PUBLIC_COMPLAINT_STATUSES.includes(complaint.status)) return null;

    // visible/public_body may not exist yet on a given DB until
    // /api/admin/migrate-message-visibility has run once — fall back to
    // the plain query, same guarded pattern as worker.js's getComplaint.
    let rows;
    try {
      rows = await env.DB.prepare(
        `SELECT author_role, body, created_at, visible, public_body FROM complaint_messages WHERE complaint_id = ? ORDER BY created_at ASC`
      ).bind(id).all();
    } catch (e) {
      rows = await env.DB.prepare(
        `SELECT author_role, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY created_at ASC`
      ).bind(id).all();
    }
    const messages = (rows.results || [])
      .filter(m => (m.visible == null ? 1 : m.visible) !== 0)
      .map(m => ({
        author_role: m.author_role,
        body: m.public_body != null && m.public_body !== "" ? m.public_body : m.body,
        created_at: m.created_at,
      }));

    return { complaint, messages };
  } catch (e) {
    console.error("SEO page: community complaint thread fetch failed:", e);
    return null;
  }
}

async function communityComplaintMeta(env, match) {
  const op = OPERATORS_BY_ID.get(match.opId);
  if (!op || !env?.DB) return null;
  const thread = await fetchCommunityComplaintThread(env, match.id, match.opId);
  if (!thread) return null;
  const c = thread.complaint;
  const amountPart = c.amount ? `${c.amount} ` : "";
  const titlePhrase = truncate(c.title, 60);
  const canonicalPath = `/sportsbooks/${op.id}/complaints/${slugify(c.title)}-${c.id}`;
  return {
    title: `${op.name} ${amountPart}Complaint — ${titlePhrase} | CryptoBetGrade`,
    description: `Community complaint against ${op.name}: ${truncate(c.public_summary || c.description || "", 180)}`,
    canonicalPath,
    viewHtml: op.complaintsHtml,
    jsonLd: [breadcrumb([
      ["Home", `${SITE_URL}/`],
      ["Sportsbooks", `${SITE_URL}/dashboard`],
      [op.name, `${SITE_URL}/sportsbooks/${op.id}`],
      ["Complaints", `${SITE_URL}/sportsbooks/${op.id}/complaints`],
      [titlePhrase, `${SITE_URL}${canonicalPath}`],
    ])],
    thread,
  };
}

// Mirrors dashboard.html's renderCommunityComplaintDetail +
// cbgLoadCommunityDetail combined (no async split needed here — the DB
// fetch already happened in communityComplaintMeta) so the page a
// crawler or pre-hydration visitor sees matches, structurally, what the
// client renders in place once it hydrates: a back-link plus the
// .cbg-cdx hero/stat-row/discussion/aside card layout, same redesign as
// the live client view — not a shortened summary and not a modal. The
// .cbg-cdx CSS itself lives in dashboard.html's <style> block, which this
// page's shell is built from (see renderSeoPage), so no styles are
// duplicated here.
function communityComplaintThreadHtml(c, messages, operatorName) {
  const msgsHtml = messages.map(m => {
    const roleClass = m.author_role === "admin" ? "admin" : m.author_role === "operator" ? "operator" : "";
    const roleLabel = m.author_role === "admin" ? "CryptoBetGrade team" : m.author_role === "operator" ? `${esc(operatorName)} · Operator` : "Submitter";
    const initial = m.author_role === "admin" ? "C" : m.author_role === "operator" ? (operatorName || "O").trim().charAt(0).toUpperCase() : "S";
    return `
    <div class="message ${roleClass}">
      <div class="message-top">
        <div class="avatar">${initial}</div>
        <div><div class="author">${roleLabel}</div><div class="date">${dateShort(m.created_at)}</div></div>
      </div>
      <div class="message-body">${esc(m.body)}</div>
    </div>
  `;
  }).join("") || `<div class="empty-note">No messages yet.</div>`;
  const replyBlock = c.status === "pending_review"
    ? `<div class="login">This is still awaiting review — replies open once it's approved.</div>`
    : `<div class="login"><a href="#" onclick="return cbgOpenAuthModal && cbgOpenAuthModal()">Log in</a> to join the discussion.</div>`;
  const msgCount = messages.length;
  return `
      <span class="back-link" onclick="backToComplaints('${esc(c.operator_slug)}')">← Back to all complaints</span>
      <div class="cbg-cdx">
        <div class="layout">
          <article class="card main-card">
            <section class="hero">
              <p class="eyebrow">Player complaint / ${esc(operatorName)}</p>
              <div class="badges">
                <span class="badge ${CBG_STATUS_CLASS[c.status] || "neutral"}">${CBG_STATUS_LABEL[c.status] || c.status}</span>
                <span class="badge neutral">Community report · Unverified</span>
              </div>
              <h1>${esc(c.title)}</h1>
              <p class="lead">A publicly submitted dispute involving ${esc(operatorName)}. The allegations below reflect the submitter's account and have not been independently established.</p>
            </section>
            <div class="content">
              <div class="stat-row">
                <div class="stat"><div class="stat-label">Disputed amount</div><div class="stat-value">${c.amount ? esc(c.amount) : "Not stated"}</div></div>
                <div class="stat"><div class="stat-label">Operator</div><div class="stat-value">${esc(operatorName)}</div></div>
                <div class="stat"><div class="stat-label">Current status</div><div class="stat-value small">${CBG_STATUS_LABEL[c.status] || c.status}</div></div>
              </div>
              <section>
                <h2>Case overview</h2>
                <p class="summary">${esc(c.public_summary || c.description)}</p>
              </section>
              <div class="divider"></div>
              <section>
                <div class="thread-header"><h2 style="margin:0">Complaint discussion</h2><span class="thread-count">${msgCount} message${msgCount === 1 ? "" : "s"}</span></div>
                ${msgsHtml}
                ${replyBlock}
              </section>
            </div>
          </article>
          <aside class="card aside">
            <h3>About this complaint</h3>
            <p>This complaint was submitted directly to CryptoBetGrade by a visitor and reviewed before publication.</p>
            <div class="rule"></div>
            <h3>How complaints are handled</h3>
            <p>CryptoBetGrade documents player allegations, available evidence, operator responses and case outcomes. Publication does not establish wrongdoing. See <a href="methodology.html">How scoring works</a>.</p>
            <div class="notice">
              <strong>Evidence matters</strong>
              <p>${esc(operatorName)} has an opportunity to respond. Case status may change as new information becomes available.</p>
            </div>
          </aside>
        </div>
      </div>
  `;
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
  // "community-complaint" needs a live D1 fetch (the specific thread) to
  // build its meta/title/description, so it can't go through metaFor's
  // synchronous data.json-only lookup like every other kind.
  const meta = match.kind === "community-complaint"
    ? await communityComplaintMeta(env, match)
    : metaFor(match);
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

  // "community-complaint" gets special handling: meta.viewHtml (= the
  // operator's normal op.complaintsHtml snapshot — stat tiles, the live
  // community-list placeholder, and the sourced-complaints list below it)
  // is only the DEFAULT Complaints tab. We want this one page's Complaints
  // tab-panel to instead show just a back-link + this single complaint's
  // full detail card, exactly mirroring dashboard.html's own
  // activeCommunityComplaintId branch (renderComplaintsTab). The known,
  // literal "Complaints" section-title div marks where that default body
  // starts inside the fragment, and (per renderDetail's own template) the
  // fragment's content genuinely ends right there too — renderComplaintsTab's
  // own output is the last thing in it, followed only by the tab-panel's
  // and the page wrapper's two closing </div> tags — so slicing from that
  // anchor to the end of the fragment and appending those same two closing
  // tags swaps the whole default body for the single-complaint view
  // without disturbing the nav/header/tab-bar chrome above it.
  let viewHtml = meta.viewHtml;
  if (match.kind === "community-complaint") {
    const anchor = '<div class="section-title" style="margin-top:0;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">';
    const anchorIdx = viewHtml.indexOf(anchor);
    if (anchorIdx !== -1) {
      const op = OPERATORS_BY_ID.get(match.opId);
      const detail = communityComplaintThreadHtml(meta.thread.complaint, meta.thread.messages, op?.name || "");
      viewHtml = viewHtml.slice(0, anchorIdx) + detail + "</div>\n    </div>\n  ";
    }
  }
  html = html.replace(
    '<div class="wrap" id="view"></div>',
    `<div class="wrap" id="view">${viewHtml}</div>`
  );

  // Splice in the live, visitor-submitted complaints list for the normal
  // Complaints-tab page — env.DB is present on the deployed Worker;
  // guarded here mainly so local/test environments without a DB binding
  // degrade to the static "Loading…" placeholder instead of throwing.
  // "community-complaint" doesn't need this: its single-complaint content
  // was already built from a live DB fetch above, via communityComplaintMeta.
  if (match.kind === "operator-complaints" && env?.DB) {
    const op = OPERATORS_BY_ID.get(match.id);
    const placeholder = `<div id="cbgComplaints-${match.id}"><div class="empty-note">Loading…</div></div>`;
    if (html.includes(placeholder)) {
      const inner = communityComplaintsHtml(await fetchCommunityComplaints(env, match.id), op?.name || "", match.id);
      html = html.replace(placeholder, `<div id="cbgComplaints-${match.id}">${inner}</div>`);
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
