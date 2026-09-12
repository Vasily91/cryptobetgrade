// Loads dashboard.html's single inline <script> in a Node vm sandbox with
// minimal DOM stubs, then pulls out the fully-seeded operator/complaint data
// by calling the same globally-exposed functions the real page uses
// (seedOperators, findOp, render, setDetailTab, goComplaint, ...).
//
// Why this approach: dashboard.html has no separate data file — all
// operator/complaint content lives inside JS object literals executed only
// in the browser. Re-typing that data by hand for a static-site generator
// would drift out of sync every time the dashboard is edited. Instead we
// execute the real script and read back its real output.

import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "..", "dashboard.html");
const html = fs.readFileSync(htmlPath, "utf8");

// dashboard.html now carries several small inline <script> blocks alongside
// the one real app script (theme-toggle init, mobile-nav hamburger wiring,
// the ?file=1 auto-open-complaint-picker helper — all added after this
// extractor was first written, each just a few hundred/thousand chars). The
// actual app script (seedOperators/render/etc.) is unmistakably the largest
// by a wide margin, so pick that one rather than requiring exactly one block.
const scriptMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (scriptMatches.length === 0) {
  console.error("No inline <script> blocks found at all — dashboard.html may have changed shape.");
  process.exit(1);
}
let source = scriptMatches[0][1];
for (const m of scriptMatches) if (m[1].length > source.length) source = m[1];
if (source.length < 50000) {
  console.error(`Largest inline <script> block is only ${source.length} chars — doesn't look like the real app script. Aborting rather than extracting garbage.`);
  process.exit(1);
}
console.log(`Using the largest of ${scriptMatches.length} inline <script> blocks (${source.length} chars).`);

// The big static data constants (COMPLAINT_REPORTS, TERMS_INFO, COMPANY_INFO,
// ...) live in dashboard-data.js, loaded via a plain synchronous
// <script src="/dashboard-data.js"> tag placed right before the main inline
// script (so the two share one global scope, same as in the browser — see
// dashboard-data.js's own header comment for why this file exists at all).
// Replicate that load order here so the sandboxed run sees the same globals
// the real page does.
const dataFilePath = path.join(__dirname, "..", "dashboard-data.js");
if (fs.existsSync(dataFilePath)) {
  const dataFileSource = fs.readFileSync(dataFilePath, "utf8");
  source = dataFileSource + "\n" + source;
  console.log(`Prepended dashboard-data.js (${dataFileSource.length} chars).`);
}

// ---- minimal fake DOM ----
const elementRegistry = new Map();
function makeFakeElement(id) {
  const el = {
    id,
    _innerHTML: "",
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; },
    value: "",
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    dataset: {},
    children: [],
    addEventListener(){}, removeEventListener(){},
    click(){}, focus(){}, blur(){}, scrollIntoView(){},
    appendChild(c){ return c; }, remove(){},
    closest(){ return null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; },
  };
  return el;
}
function getElementById(id) {
  if (!elementRegistry.has(id)) elementRegistry.set(id, makeFakeElement(id));
  return elementRegistry.get(id);
}

const fakeLocation = { hash: "", search: "", pathname: "/dashboard", href: "https://cryptobetgrade.com/dashboard" };

const sandbox = {
  console,
  URLSearchParams,
  Intl,
  Math,
  JSON,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  RegExp,
  Map,
  Set,
  Promise,
  location: fakeLocation,
  document: {
    getElementById,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeFakeElement("__created__"),
    addEventListener() {},
  },
  addEventListener() {},
  removeEventListener() {},
  window: null, // set to sandbox itself below
  localStorage: {
    _data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  },
  alert() {}, confirm() { return false; },
  fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  Blob: class { constructor() {} },
  URL,
  navigator: { userAgent: "node" },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "dashboard-inline.js" });

// ---- slug generation for individual complaint pages ----
// Format: {operatorId}-{amount}-{issue}, e.g. "stake-9725-usdc-winnings-confiscated".
// Descriptive words over opaque ids (per Google's URL guidance) while the
// short internal id (cst1, cbp7, ...) stays as a DB-style key, never the
// public URL.

const ISSUE_TAG_SLUGS = {
  "Account closed after sportsbook/provider flag": "account-closed",
  "Account compromised / unauthorized redemption": "account-compromised",
  "Balance including deposit confiscated": "balance-confiscated",
  "Funds locked in betting-integrity review": "funds-locked-review",
  "Only original deposit returned": "deposit-only-returned",
  "Responsible-gambling / self-exclusion dispute": "self-exclusion-dispute",
  "Winning bets voided after settlement": "bets-voided",
  "Winnings confiscated / forfeited": "winnings-confiscated",
};

const CURRENCY_SYMBOL_CODE = { "$": "usd", "€": "eur", "£": "gbp", "A$": "aud", "C$": "cad", "S/.": "pen" };

function parseAmountSlug(raw) {
  if (!raw) return "";
  const s = raw.replace(/~/g, "").trim();

  // symbol-first: $3,000 / €18,500 / A$300,000 / C$2,133 / S/.3,257
  let m = s.match(/(A\$|C\$|S\/\.|[$€£])\s?([\d][\d,.]*)/);
  if (m) {
    const code = CURRENCY_SYMBOL_CODE[m[1]] || "usd";
    const num = m[2].replace(/[,.](?=\d{3}(\D|$))/g, "").replace(/\.\d+$/, "").replace(/,/g, "");
    return `${num}-${code}`;
  }
  // number-first with a trailing currency code: 9,725 USDC / 16,000 DKK / 6,868,467 KZT
  m = s.match(/([\d][\d,.]*)\s?(BTC|mBTC|USDC|USDT|SOL|EUR|USD|PLN|DKK|UAH|KZT|NOK|RUB|CAD|GBP)\b/i);
  if (m) {
    const num = m[1].replace(/[,.](?=\d{3}(\D|$))/g, "").replace(/\.\d+$/, "").replace(/,/g, "");
    return `${num}-${m[2].toLowerCase()}`;
  }
  // currency-code-first with a trailing number: CAD 400
  m = s.match(/\b(BTC|mBTC|USDC|USDT|SOL|EUR|USD|PLN|DKK|UAH|KZT|NOK|RUB|CAD|GBP)\s?([\d][\d,.]*)/i);
  if (m) {
    const num = m[2].replace(/[,.](?=\d{3}(\D|$))/g, "").replace(/\.\d+$/, "").replace(/,/g, "");
    return `${num}-${m[1].toLowerCase()}`;
  }
  // bare number, no currency marker at all (rare data anomaly)
  m = s.match(/([\d][\d,]*)/);
  if (m) return m[1].replace(/,/g, "");
  return "";
}

function baseSlug(operatorId, complaint) {
  const amountSlug = parseAmountSlug(complaint.amount);
  const issueSlug = ISSUE_TAG_SLUGS[complaint.issueTag] || slugifyWords(complaint.issueTag);
  return [operatorId, amountSlug, issueSlug].filter(Boolean).join("-");
}
function slugifyWords(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ---- pull data back out via the globally-exposed functions ----
const operators = sandbox.seedOperators();

const slugReport = [];
operators.forEach(op => {
  const seen = new Map(); // base slug -> count, for per-operator disambiguation
  op.complaints.forEach(c => {
    const base = baseSlug(op.id, c);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    c.slug = n === 1 ? base : `${base}-${n}`;
    slugReport.push({ opId: op.id, complaintId: c.id, amount: c.amount, slug: c.slug });
  });
});

// ---- capture the REAL rendered HTML for each page via the SPA's own render
// pipeline, so the SSR pages are pixel-identical to the interactive app
// instead of a hand-built lookalike template. ----
function viewHtml() { return getElementById("view").innerHTML; }

const complaintSlugIndex = {}; // slug -> {opId, complaintId}

// KYC_STANCE_LABEL lives in dashboard.html as a `const`, which (unlike a
// `function` declaration) doesn't attach to the vm sandbox as a global —
// replicated here rather than reaching into the vm for a 3-entry lookup.
const KYC_LABEL_SHORT = { conditional: "Conditional", required: "Required", unclear: "Unclear" };

const out = {
  // Was hardcoded to a fixed "2026-08-27" string, so every regeneration —
  // no matter when it actually ran — stamped the same false date. Harmless
  // while nothing on-site displays it, but a landmine for whenever a future
  // "data as of" badge (e.g. on the homepage hero card) starts reading it.
  generatedAt: new Date().toISOString().slice(0, 10),
  operators: operators.map(op => {
    const grade = sandbox.gradeInfo(op.score);
    const rel = sandbox.reliabilityInfo(op);
    const stats = sandbox.complaintStats(op);

    fakeLocation.hash = `#/operator/${op.id}`;
    sandbox.render();
    const overviewHtml = viewHtml();

    sandbox.setDetailTab(op.id, "complaints");
    const complaintsHtml = viewHtml();

    const complaints = op.complaints.map(c => {
      fakeLocation.hash = `#/operator/${op.id}/complaint/${c.id}`;
      sandbox.render();
      complaintSlugIndex[c.slug] = { opId: op.id, complaintId: c.id };
      return {
        id: c.id,
        slug: c.slug,
        title: c.title,
        category: c.category,
        issueTag: c.issueTag,
        amount: c.amount,
        status: c.status,
        verified: c.verified,
        source: c.source,
        sourceUrl: c.sourceUrl,
        whatHappened: c.whatHappened,
        operatorReason: c.operatorReason,
        html: viewHtml(),
      };
    });

    return {
      id: op.id,
      name: op.name,
      type: op.type,
      score: op.score,
      gradeLabel: grade.label,
      reliabilityLabel: rel.label,
      overview: op.overview,
      keyPros: op.keyPros,
      keyCons: op.keyCons,
      sidebar: op.sidebar,
      stats: op.stats,
      complaintStats: stats,
      complaints,
      complaintsNote: op.complaintsNote,
      affiliateUrl: op.affiliateUrl,
      logoDomain: op.logoDomain,
      overviewHtml,
      complaintsHtml,
      // Added for the homepage's dynamic "current top operator" hero card
      // (see gen-hero.mjs / index.html) — breakdown/onchain/annualVolume
      // mirror the same fields already on the live op object in
      // dashboard.html, just not previously exported to data.json.
      breakdown: op.breakdown,
      onchain: op.onchain,
      annualVolume: op.annualVolume,
      payoutTimeShort: sandbox.payoutTimeShort(op),
      jurisdictionShort: sandbox.jurisdictionShort(op),
      kycLabelShort: KYC_LABEL_SHORT[sandbox.kycStanceOf(op.name)] || "Unclear",
    };
  }),
  complaintSlugIndex,
};

fs.writeFileSync(path.join(__dirname, "extracted-data.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(__dirname, "slug-report.json"), JSON.stringify(slugReport, null, 2));
console.log(`Extracted ${out.operators.length} operators.`);
console.log(`Total complaints: ${out.operators.reduce((s, o) => s + o.complaints.length, 0)}`);

// Flag anything where amount parsing produced no currency-ish token, or slugs
// that collided and got a numeric suffix — worth a human glance before publishing.
const noAmount = slugReport.filter(r => !/-[a-z]{2,5}$/i.test(r.slug.split("-").slice(-2).join("-")) && !/\d/.test(r.slug));
const suffixed = slugReport.filter(r => /-\d+$/.test(r.slug) && /-\d+-\d+$/.test(r.slug) === false && /-(2|3|4|5)$/.test(r.slug));
console.log(`Slugs with a disambiguation suffix (collision): ${suffixed.length}`);
suffixed.forEach(r => console.log(`  ${r.opId} / ${r.complaintId} / "${r.amount}" -> ${r.slug}`));
