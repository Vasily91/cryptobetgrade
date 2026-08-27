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
// DATA SOURCE: data.json is a machine-generated snapshot of the same
// operator/complaint data embedded in dashboard.html's inline script
// (KEY_PROS, KEY_CONS, COMPLAINT_REPORTS, seedOperators(), etc.) — see
// tools/extract-data.mjs, which runs dashboard.html's real script in a
// sandboxed Node vm and reads back its computed output, so this never
// drifts into hand-maintained duplicate data. IMPORTANT: whenever
// dashboard.html's operator/complaint data changes, re-run
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

export function renderSeoPage(match) {
  if (match.kind === "operator") {
    const op = OPERATORS_BY_ID.get(match.id);
    return op ? renderOperatorPage(op) : null;
  }
  if (match.kind === "operator-complaints") {
    const op = OPERATORS_BY_ID.get(match.id);
    return op ? renderOperatorComplaintsPage(op) : null;
  }
  if (match.kind === "complaint") {
    const entry = COMPLAINT_INDEX.get(match.slug);
    return entry ? renderComplaintPage(entry.op, entry.complaint) : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function gradeClass(score) {
  if (score === null || score === undefined) return "badge-unrated";
  if (score >= 8) return "badge-good";
  if (score >= 6) return "badge-warning";
  if (score >= 4) return "badge-serious";
  return "badge-critical";
}
function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("resolved in operator")) return "st-neutral";
  if (s.includes("resolved") || s.includes("paid")) return "st-good";
  if (s.includes("rejected") || s.includes("closed")) return "st-bad";
  return "st-warn";
}
function issuePhrase(complaint) {
  return ISSUE_TAG_PHRASE[complaint.issueTag] || complaint.issueTag || "Complaint";
}
function complaintH1(op, complaint) {
  const amountPart = complaint.amount ? `${complaint.amount} ` : "";
  return `${op.name} – ${amountPart}${issuePhrase(complaint)} Complaint`;
}
function complaintTitleTag(op, complaint) {
  const amountPart = complaint.amount ? `${complaint.amount} ` : "";
  return `${op.name} ${amountPart}${issuePhrase(complaint)} Complaint | CryptoBetGrade`;
}

// ---------------------------------------------------------------------
// Shared page shell (nav/footer/design system lifted from about.html so
// these pages look like part of the site, not a bolted-on afterthought)
// ---------------------------------------------------------------------

function shell({ title, description, canonicalPath, bodyHtml, jsonLd, extraStyle }) {
  const canonical = `${SITE_URL}${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index, follow">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;800&display=swap" rel="stylesheet">
<style>
${BASE_CSS}
${extraStyle || ""}
</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
</head>
<body>
${NAV_HTML}
${bodyHtml}
${FOOTER_HTML}
</body>
</html>`;
}

const BASE_CSS = `
  :root{
    --brand:#0b6e4f; --brand-dark:#074a35; --brand-light:#e6f4ec; --brand-lighter:#f3faf6;
    --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --ink-muted:#898781;
    --line:#e1e0d9; --border:rgba(11,11,11,0.10);
    --good:#0ca30c; --good-bg:#e5f6e0; --good-ink:#0a5c0a;
    --warning:#fab219; --warning-bg:#fff3dc; --warning-ink:#8a5c00;
    --serious:#ec835a; --serious-bg:#fdebe2; --serious-ink:#a3441f;
    --critical:#d03b3b; --critical-bg:#fbe5e5; --critical-ink:#8f1f1f;
    --gold:#c8860d; --gold-bg:#fdf1da; --gold-ink:#8a5c00;
    --radius:14px;
  }
  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}
  body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;}
  a{color:inherit;}
  .wrap{max-width:1160px;margin:0 auto;padding:0 24px;}
  nav{position:sticky;top:0;z-index:50;background:linear-gradient(135deg, var(--brand) 0%, var(--brand-dark) 100%);box-shadow:0 4px 18px rgba(7,74,53,0.28);}
  nav .wrap{display:flex;align-items:center;justify-content:space-between;padding-top:14px;padding-bottom:14px;}
  .logo{display:flex;align-items:center;gap:10px;font-size:18.5px;letter-spacing:-0.3px;text-decoration:none;font-family:'Poppins',system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .logo .mark{position:relative;width:34px;height:34px;border-radius:10px;flex:none;background:#fff;padding:4px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.28);}
  .logo .mark svg{width:100%;height:100%;}
  .logo .wordmark-light{font-weight:600;color:rgba(255,255,255,0.72);}
  .logo .wordmark-bold{font-weight:800;color:#fff;}
  .navlinks{display:flex;gap:8px;font-size:13.5px;font-weight:600;color:rgba(255,255,255,0.9);}
  .navlinks a{text-decoration:none;display:flex;align-items:center;gap:6px;white-space:nowrap;color:rgba(255,255,255,0.9);background:rgba(255,255,255,0.08);padding:8px 14px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,0.14);transition:.15s ease;}
  .navlinks a:hover{background:rgba(255,255,255,0.2);color:#fff;}
  .btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;background:var(--brand);color:#fff;padding:10px 18px;border-radius:999px;font-weight:700;font-size:14px;text-decoration:none;border:none;cursor:pointer;transition:.15s;}
  .btn:hover{background:var(--brand-dark);}
  .btn-outline{background:#fff;color:var(--brand-dark);border:1.5px solid var(--brand);display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:999px;font-weight:700;font-size:14px;text-decoration:none;}
  .btn-outline:hover{background:var(--brand-light);}
  .btn-sm{padding:8px 14px;font-size:13px;}
  @media (max-width:820px){ .navlinks{display:none;} }
  .breadcrumb{font-size:12.5px;color:var(--ink-muted);padding:16px 0 0;}
  .breadcrumb a{color:var(--ink-2);text-decoration:none;font-weight:600;}
  .breadcrumb a:hover{color:var(--brand-dark);}
  .page-hero{padding:28px 0 32px;}
  .page-hero .kicker{display:inline-block;background:var(--brand-light);color:var(--brand-dark);font-size:12.5px;font-weight:700;letter-spacing:.03em;padding:6px 14px;border-radius:999px;margin-bottom:16px;}
  .page-hero h1{font-size:clamp(24px,3.6vw,36px);margin:0 0 14px;letter-spacing:-0.6px;}
  .page-hero p.lede{max-width:720px;margin:0;color:var(--ink-2);font-size:15.5px;}
  .hero-row{display:flex;flex-wrap:wrap;gap:24px;align-items:center;margin-top:18px;}
  .grade-pill{display:inline-flex;align-items:center;padding:5px 14px;border-radius:999px;font-size:13px;font-weight:700;}
  .badge-good{background:var(--good-bg);color:var(--good-ink);}
  .badge-warning{background:var(--warning-bg);color:var(--warning-ink);}
  .badge-serious{background:var(--serious-bg);color:var(--serious-ink);}
  .badge-critical{background:var(--critical-bg);color:var(--critical-ink);}
  .badge-unrated{background:var(--line);color:var(--ink-muted);}
  .score-big{font-size:34px;font-weight:800;letter-spacing:-1px;}
  .score-big span{font-size:14px;font-weight:600;color:var(--ink-muted);}
  section{padding:0 0 48px;}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 24px;box-shadow:0 4px 14px rgba(11,11,11,0.04);}
  .section-title{font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-muted);margin:0 0 14px;font-weight:700;}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  @media (max-width:760px){ .grid-2{grid-template-columns:1fr;} }
  .pc-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;}
  @media (max-width:560px){ .pc-grid{grid-template-columns:1fr;} }
  .pc-item{display:flex;gap:8px;align-items:flex-start;font-size:14px;color:var(--ink-2);margin-bottom:8px;}
  .pc-good svg{color:var(--good);flex:none;margin-top:2px;}
  .pc-bad svg{color:var(--critical);flex:none;margin-top:2px;}
  .fact-list{margin:0;padding:0;list-style:none;font-size:14px;}
  .fact-list li{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--line);}
  .fact-list li:last-child{border-bottom:none;}
  .fact-list .k{color:var(--ink-muted);}
  .fact-list .v{color:var(--ink);font-weight:600;text-align:right;}
  .stat-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px;}
  .stat-box{background:var(--page);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:120px;}
  .stat-box .n{font-size:22px;font-weight:800;}
  .stat-box .l{font-size:12px;color:var(--ink-muted);}
  .complaint-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 22px;margin-bottom:14px;box-shadow:0 4px 14px rgba(11,11,11,0.04);}
  .complaint-card h3{margin:0 0 8px;font-size:16px;}
  .complaint-card h3 a{color:var(--ink);text-decoration:none;}
  .complaint-card h3 a:hover{color:var(--brand-dark);text-decoration:underline;}
  .complaint-meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--ink-muted);margin-bottom:10px;}
  .status-pill{display:inline-flex;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:700;}
  .st-good{background:var(--good-bg);color:var(--good-ink);}
  .st-bad{background:var(--critical-bg);color:var(--critical-ink);}
  .st-warn{background:var(--warning-bg);color:var(--warning-ink);}
  .st-neutral{background:var(--line);color:var(--ink-2);}
  .complaint-card p{margin:0;color:var(--ink-2);font-size:14px;}
  .prose p{color:var(--ink-2);font-size:15px;margin:0 0 14px;}
  .amount-tag{font-weight:800;color:var(--ink);}
  .source-link{font-weight:600;color:var(--brand-dark);text-decoration:none;}
  .source-link:hover{text-decoration:underline;}
  .disclaimer{background:var(--brand-lighter);border:1px solid var(--brand-light);border-radius:12px;padding:14px 18px;font-size:13px;color:var(--ink-2);margin-top:24px;}
  footer{background:#fff;border-top:1px solid var(--line);padding:36px 0 30px;margin-top:20px;}
  .footer-grid{display:flex;justify-content:space-between;flex-wrap:wrap;gap:32px;margin-bottom:24px;}
  .footer-col h5{font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-muted);margin:0 0 12px;}
  .footer-col a{display:block;font-size:14px;color:var(--ink-2);text-decoration:none;margin-bottom:8px;}
  .footer-col a:hover{color:var(--brand-dark);}
  .footer-bottom{border-top:1px solid var(--line);padding-top:20px;font-size:12.5px;color:var(--ink-muted);line-height:1.7;}
`;

const NAV_HTML = `<nav>
  <div class="wrap">
    <a href="/index.html" class="logo">
      <span class="mark"><svg viewBox="0 0 24 24"><path d="M12 2 L19.5 5.2 V11.6 C19.5 17 16.2 20.7 12 22 C7.8 20.7 4.5 17 4.5 11.6 V5.2 Z" fill="#0b6e4f"/><path d="M12.8 8.8 A3.7 3.7 0 1 0 12.8 16.2" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="12.9" y="13.8" width="1.5" height="3.2" rx="0.5" fill="#8fcdae"/><rect x="15" y="11.6" width="1.5" height="5.4" rx="0.5" fill="#c9b467"/><rect x="17.1" y="9.4" width="1.5" height="7.6" rx="0.5" fill="#c8860d"/></svg></span>
      <span><span class="wordmark-light">Crypto</span><span class="wordmark-bold">BetGrade</span></span>
    </a>
    <div class="navlinks">
      <a href="/index.html">Home</a>
      <a href="/dashboard.html">Sportsbooks</a>
      <a href="/analytics.html">Analytics</a>
      <a href="/methodology.html">How scoring works</a>
    </div>
  </div>
</nav>`;

const FOOTER_HTML = `<footer>
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-col">
        <h5>Product</h5>
        <a href="/methodology.html">How scoring works</a>
        <a href="/dashboard.html">Leaderboard</a>
        <a href="/analytics.html">Market analytics</a>
      </div>
      <div class="footer-col">
        <h5>Company</h5>
        <a href="/about.html">About</a>
        <a href="mailto:disputes@cryptobetgrade.com?subject=Dispute%20a%20complaint%20or%20score">Contact / submit a dispute</a>
      </div>
      <div class="footer-col">
        <h5>Legal</h5>
        <a href="/privacy-policy.html">Privacy Policy</a>
        <a href="/cookies.html">Cookies</a>
      </div>
    </div>
    <div class="footer-bottom">
      <p><b>18+.</b> Gambling can be addictive — please play responsibly.</p>
      <p>Complaint records are drawn from public sources (AskGamblers, Casino Guru, Trustpilot, Reddit, and similar) and cited individually. Some sportsbook listings include an affiliate link, clearly marked — affiliate relationships never influence Trust Scores.</p>
    </div>
  </div>
</footer>`;

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const X_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// ---------------------------------------------------------------------
// Operator page — /sportsbooks/{id}
// ---------------------------------------------------------------------

function renderOperatorPage(op) {
  const g = gradeClass(op.score);
  const breadcrumb = `<div class="wrap breadcrumb"><a href="/">Home</a> / <a href="/dashboard.html">Sportsbooks</a> / ${esc(op.name)}</div>`;

  const facts = [
    ["Licence", op.sidebar?.license],
    ["Launched", op.sidebar?.launched],
    ["Minimum deposit", op.sidebar?.minDeposit],
    ["Welcome bonus", op.sidebar?.welcomeBonus],
    ["Cryptocurrencies", op.sidebar?.cryptocurrencies],
    ["Markets", op.stats?.markets],
    ["Odds format", op.stats?.oddsFormat],
    ["Max win / withdrawal", op.stats?.maxWin],
    ["Support", op.stats?.support],
    ["Mobile app", op.stats?.mobileApp],
  ].filter(([, v]) => v);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Sportsbooks", item: `${SITE_URL}/dashboard.html` },
      { "@type": "ListItem", position: 3, name: op.name, item: `${SITE_URL}/sportsbooks/${op.id}` },
    ],
  };

  const body = `
${breadcrumb}
<header class="page-hero">
  <div class="wrap">
    <span class="kicker">SPORTSBOOK REVIEW</span>
    <h1>${esc(op.name)} Review</h1>
    <p class="lede">${esc(op.overview || `${op.name} is a crypto sportsbook covered in CryptoBetGrade's independent Trust Score database.`)}</p>
    <div class="hero-row">
      <div class="score-big">${op.score === null || op.score === undefined ? "—" : op.score.toFixed(1)}<span>/10</span></div>
      <span class="grade-pill ${g}">${esc(op.gradeLabel)}</span>
      ${op.reliabilityLabel && op.reliabilityLabel !== "—" ? `<span class="grade-pill badge-unrated">Payout reliability: ${esc(op.reliabilityLabel)}</span>` : ""}
    </div>
  </div>
</header>
<section>
  <div class="wrap grid-2">
    <div class="card">
      <div class="section-title">Pros &amp; cons</div>
      <div class="pc-grid">
        <div>${(op.keyPros || []).map(p => `<div class="pc-item pc-good">${CHECK_ICON}<span>${esc(p)}</span></div>`).join("") || `<div class="pc-item"><span style="color:var(--ink-muted);">Not yet assessed</span></div>`}</div>
        <div>${(op.keyCons || []).map(c => `<div class="pc-item pc-bad">${X_ICON}<span>${esc(c)}</span></div>`).join("")}</div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Quick facts</div>
      <ul class="fact-list">
        ${facts.map(([k, v]) => `<li><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></li>`).join("")}
      </ul>
    </div>
  </div>
</section>
<section>
  <div class="wrap">
    <div class="card">
      <div class="section-title">Complaint record</div>
      <p style="margin:0 0 14px;color:var(--ink-2);font-size:14.5px;">${op.complaintStats.total} reported complaint${op.complaintStats.total === 1 ? "" : "s"} on file, drawn from public sources like AskGamblers, Casino Guru, Trustpilot, and Reddit.</p>
      <div class="stat-row">
        <div class="stat-box"><div class="n">${op.complaintStats.total}</div><div class="l">Total complaints</div></div>
        <div class="stat-box"><div class="n">${op.complaintStats.ongoing}</div><div class="l">Unresolved / ongoing</div></div>
        <div class="stat-box"><div class="n">${op.complaintStats.verified}</div><div class="l">Independently verified</div></div>
      </div>
      ${op.complaintStats.total ? `<div style="margin-top:18px;"><a class="btn" href="/sportsbooks/${op.id}/complaints">See all ${op.name} complaints →</a></div>` : ""}
    </div>
  </div>
</section>
<section>
  <div class="wrap" style="display:flex;gap:14px;flex-wrap:wrap;">
    <a class="btn-outline" href="/dashboard.html#/operator/${op.id}">Open interactive profile (filters, tabs) →</a>
    ${op.affiliateUrl ? `<a class="btn" href="${esc(op.affiliateUrl)}" target="_blank" rel="noopener sponsored nofollow">Visit ${esc(op.name)} →</a>` : ""}
  </div>
</section>
`;

  return shell({
    title: `${op.name} Review — Trust Score, KYC &amp; Complaints | CryptoBetGrade`.replace(/&amp;/g, "&"),
    description: `${op.name} reviewed: Trust Score ${op.score ?? "—"}/10, ${op.complaintStats.total} reported complaints, licensing, KYC stance, and payout reliability — independently assessed by CryptoBetGrade.`,
    canonicalPath: `/sportsbooks/${op.id}`,
    bodyHtml: body,
    jsonLd,
  });
}

// ---------------------------------------------------------------------
// Operator complaints list — /sportsbooks/{id}/complaints
// ---------------------------------------------------------------------

function renderOperatorComplaintsPage(op) {
  const breadcrumb = `<div class="wrap breadcrumb"><a href="/">Home</a> / <a href="/dashboard.html">Sportsbooks</a> / <a href="/sportsbooks/${op.id}">${esc(op.name)}</a> / Complaints</div>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Sportsbooks", item: `${SITE_URL}/dashboard.html` },
      { "@type": "ListItem", position: 3, name: op.name, item: `${SITE_URL}/sportsbooks/${op.id}` },
      { "@type": "ListItem", position: 4, name: "Complaints", item: `${SITE_URL}/sportsbooks/${op.id}/complaints` },
    ],
  };

  const cards = op.complaints.map(c => `
    <div class="complaint-card">
      <h3><a href="/complaints/${c.slug}">${esc(c.title)}</a></h3>
      <div class="complaint-meta">
        ${c.amount ? `<span class="amount-tag">${esc(c.amount)}</span>` : ""}
        <span class="status-pill ${statusClass(c.status)}">${esc(c.status)}</span>
        <span>${esc(c.issueTag)}</span>
        ${c.verified ? `<span>✓ Verified outcome</span>` : ""}
      </div>
      <p>${esc(c.whatHappened.length > 220 ? c.whatHappened.slice(0, 217) + "…" : c.whatHappened)}</p>
    </div>`).join("");

  const body = `
${breadcrumb}
<header class="page-hero">
  <div class="wrap">
    <span class="kicker">COMPLAINT RECORDS</span>
    <h1>${esc(op.name)} — Complaint Reports</h1>
    <p class="lede">${op.complaints.length} complaint${op.complaints.length === 1 ? "" : "s"} reported against ${esc(op.name)}, each drawn from a public, individually-cited source.${op.complaintsNote ? " " + esc(op.complaintsNote) : ""}</p>
  </div>
</header>
<section>
  <div class="wrap">
    ${cards || `<p style="color:var(--ink-2);">No complaints are currently on file for ${esc(op.name)}.</p>`}
    <div style="margin-top:8px;"><a class="btn-outline" href="/sportsbooks/${op.id}">← Back to ${esc(op.name)} review</a></div>
  </div>
</section>
`;

  return shell({
    title: `${op.name} Complaints — ${op.complaints.length} Reported Cases | CryptoBetGrade`,
    description: `${op.complaints.length} publicly-sourced complaints reported against ${op.name}, with outcomes, disputed amounts, and links to the original source.`,
    canonicalPath: `/sportsbooks/${op.id}/complaints`,
    bodyHtml: body,
    jsonLd,
  });
}

// ---------------------------------------------------------------------
// Single complaint — /complaints/{slug}
// ---------------------------------------------------------------------

function renderComplaintPage(op, c) {
  const breadcrumb = `<div class="wrap breadcrumb"><a href="/">Home</a> / <a href="/dashboard.html">Sportsbooks</a> / <a href="/sportsbooks/${op.id}">${esc(op.name)}</a> / <a href="/sportsbooks/${op.id}/complaints">Complaints</a> / ${esc(issuePhrase(c))}</div>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Sportsbooks", item: `${SITE_URL}/dashboard.html` },
      { "@type": "ListItem", position: 3, name: op.name, item: `${SITE_URL}/sportsbooks/${op.id}` },
      { "@type": "ListItem", position: 4, name: "Complaints", item: `${SITE_URL}/sportsbooks/${op.id}/complaints` },
      { "@type": "ListItem", position: 5, name: issuePhrase(c), item: `${SITE_URL}/complaints/${c.slug}` },
    ],
  };

  const body = `
${breadcrumb}
<header class="page-hero">
  <div class="wrap">
    <span class="kicker">${esc(op.name.toUpperCase())} COMPLAINT</span>
    <h1>${esc(complaintH1(op, c))}</h1>
    <div class="hero-row" style="margin-top:10px;">
      <span class="status-pill ${statusClass(c.status)}" style="font-size:13px;padding:6px 14px;">${esc(c.status)}</span>
      ${c.verified ? `<span class="grade-pill badge-good">✓ Independently verified outcome</span>` : `<span class="grade-pill badge-unrated">Unverified / community report</span>`}
    </div>
  </div>
</header>
<section>
  <div class="wrap grid-2">
    <div class="card">
      <div class="section-title">What happened</div>
      <div class="prose"><p>${esc(c.whatHappened)}</p></div>
      ${c.operatorReason ? `<div class="section-title" style="margin-top:18px;">${esc(op.name)}'s stated reason</div><div class="prose"><p>${esc(c.operatorReason)}</p></div>` : ""}
    </div>
    <div class="card">
      <div class="section-title">Case details</div>
      <ul class="fact-list">
        <li><span class="k">Sportsbook</span><span class="v"><a href="/sportsbooks/${op.id}" style="color:var(--brand-dark);">${esc(op.name)}</a></span></li>
        ${c.amount ? `<li><span class="k">Disputed amount</span><span class="v">${esc(c.amount)}</span></li>` : ""}
        <li><span class="k">Category</span><span class="v">${esc(c.issueTag)}</span></li>
        <li><span class="k">Status</span><span class="v">${esc(c.status)}</span></li>
        <li><span class="k">Source</span><span class="v"><a class="source-link" href="${esc(c.sourceUrl)}" target="_blank" rel="noopener nofollow">${esc(c.source)} ↗</a></span></li>
      </ul>
      <div class="disclaimer">Drawn from a public complaint source, cited above — verify it yourself before relying on it. CryptoBetGrade doesn't adjudicate disputes; "status" reflects what the cited source reports.</div>
    </div>
  </div>
</section>
<section>
  <div class="wrap" style="display:flex;gap:14px;flex-wrap:wrap;">
    <a class="btn-outline" href="/sportsbooks/${op.id}/complaints">← All ${esc(op.name)} complaints</a>
    <a class="btn-outline" href="/sportsbooks/${op.id}">${esc(op.name)} full review →</a>
  </div>
</section>
`;

  return shell({
    title: complaintTitleTag(op, c),
    description: `${op.name} complaint: ${c.whatHappened.length > 180 ? c.whatHappened.slice(0, 177) + "…" : c.whatHappened}`,
    canonicalPath: `/complaints/${c.slug}`,
    bodyHtml: body,
    jsonLd,
  });
}
