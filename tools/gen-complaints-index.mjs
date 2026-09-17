// Regenerates complaints-index.json: a lean, purpose-built aggregate of
// every curated complaint across every operator, for the public
// complaints.html hub page (a cross-operator searchable/filterable list —
// see complaints.html for the page itself). Complements, not replaces,
// COMPLAINT_REPORTS: complaints.html fetches THIS file client-side (small,
// pre-aggregated) rather than the much larger data.json (which carries a
// lot complaints.html doesn't need, like rendered per-page HTML) or
// dashboard-data.js (600KB+ of unrelated operator profile fields).
//
// Run this AFTER tools/extract-data.mjs + the `cp tools/extracted-data.json
// data.json` step (it reads data.json), and re-run it any time
// COMPLAINT_REPORTS changes, same trigger as tools/gen-sitemap.mjs. See
// tools/README.md for the full pipeline order.
//
// Two things here intentionally DUPLICATE logic that also lives inside
// dashboard.html's inline script, because data.json doesn't carry the
// original priority field or a status->cls mapping, and complaints.html
// doesn't load dashboard.html's script:
//   1. COMPLAINT_STATUS_META's cls mapping (good/bad/neutral) — copy this
//      block from dashboard.html if that dict ever changes.
//   2. The issueTag -> display-category taxonomy — this is NEW (no
//      equivalent existed before this file), built 16 Sep 2026 specifically
//      for complaints.html's "Complaints by issue type" chart, grouping the
//      ~40 raw issueTag strings into 7 meaningful buckets + "Other".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));

// ---- 1. status -> cls, copied from dashboard.html's COMPLAINT_STATUS_META ----
const STATUS_CLS = {
  "Resolved": "good",
  "Resolved/listing": "good",
  "Resolved in operator's favor": "bad",
  "Operator position upheld": "bad",
  "Rejected": "bad",
  "Rejected after operator evidence": "bad",
  "Unresolved": "bad",
  "Unresolved / sportsbook scope": "bad",
  "Closed - player stopped responding": "neutral",
  "Closed - sportsbook scope": "neutral",
  "Resolved by player": "neutral",
  "Public complaint": "neutral",
  "Community report": "neutral",
  "Community/scam report": "neutral",
  "Forum report": "neutral",
};
function statusCls(status) {
  return STATUS_CLS[status] || "neutral"; // unmapped statuses (Open, Unknown, Complaint listing, ...) read as "unclear", same spirit as dashboard.html's own fallback
}

// ---- 2. issueTag -> category bucket ----
// Built 16 Sep 2026 from the full set of issueTag strings present in
// COMPLAINT_REPORTS at that time (grep issueTag:" across dashboard-data.js
// to regenerate the source list if this ever drifts). Anything not
// explicitly listed falls into "Other" rather than erroring, so a future
// new issueTag never breaks the build — but SHOULD be added here
// deliberately the next time this file is touched.
const CATEGORY_ORDER = [
  "Withdrawal & payout delays",
  "KYC / verification disputes",
  "Winnings & balance confiscated",
  "Account closure / restriction",
  "Multi-account / arbitrage allegations",
  "Voided or adjusted bets",
  "Bonus & responsible-gambling disputes",
  "Other",
];
const ISSUE_CATEGORY = {
  "Funds locked in betting-integrity review": "Withdrawal & payout delays",
  "Withdrawal withheld pending betting-integrity review": "Withdrawal & payout delays",
  "Withdrawal withheld pending verification dispute": "Withdrawal & payout delays",
  "Withdrawal repeatedly failed / payment-processing dispute": "Withdrawal & payout delays",
  "Withdrawal cancelled / funds not returned": "Withdrawal & payout delays",
  "Sportsbook withdrawal cancelled dispute": "Withdrawal & payout delays",
  "Deposit not credited / payment processing dispute": "Withdrawal & payout delays",
  "Deposit not credited / payment-processing dispute": "Withdrawal & payout delays",
  "Crypto withdrawal method removed": "Withdrawal & payout delays",
  "Small-balance withdrawal suspended pending wagering/payment check": "Withdrawal & payout delays",
  "Balance/account access restricted dispute": "Withdrawal & payout delays",
  "Withdrawal delay / speed dispute": "Withdrawal & payout delays",

  "Account blocked after KYC video review": "KYC / verification disputes",
  "Account blocked after document rejected in KYC review": "KYC / verification disputes",
  "Account closed after missed verification deadline": "KYC / verification disputes",

  "Winnings confiscated / forfeited": "Winnings & balance confiscated",
  "Balance including deposit confiscated": "Winnings & balance confiscated",
  "Only original deposit returned": "Winnings & balance confiscated",
  "Sportsbook winnings not paid dispute": "Winnings & balance confiscated",

  "Account blocked after withdrawal request": "Account closure / restriction",
  "Account closed after sportsbook/provider flag": "Account closure / restriction",
  "Account closed after winning streak": "Account closure / restriction",
  "Account closed after withdrawal request": "Account closure / restriction",
  "Sportsbook account closed / deposit not refunded dispute": "Account closure / restriction",
  "Sportsbook account closed / withdrawal blocked dispute": "Account closure / restriction",
  "Account compromised / unauthorized redemption": "Account closure / restriction",

  "Multi-account / arbitrage betting dispute": "Multi-account / arbitrage allegations",
  "Multi-account allegation / cashout ban dispute": "Multi-account / arbitrage allegations",
  "Multi-account allegation / funds withheld dispute": "Multi-account / arbitrage allegations",
  "Multi-account arbitrage-betting dispute": "Multi-account / arbitrage allegations",
  "Multi-account sportsbook-limits dispute": "Multi-account / arbitrage allegations",
  "Sportsbook arbitrage / value-betting dispute": "Multi-account / arbitrage allegations",
  "Sportsbook value-betting dispute": "Multi-account / arbitrage allegations",
  "Duplicate-account dispute": "Multi-account / arbitrage allegations",

  "Winning bets voided after settlement": "Voided or adjusted bets",
  "Bet settlement / balance-adjustment dispute": "Voided or adjusted bets",
  "Provably-fair game dispute": "Voided or adjusted bets",
  "Stop-loss functionality dispute": "Voided or adjusted bets",
  "Sports bets not accepted / wagering-method dispute": "Voided or adjusted bets",

  "Bonus terms dispute": "Bonus & responsible-gambling disputes",
  "Responsible-gambling / self-exclusion dispute": "Bonus & responsible-gambling disputes",
};
function categoryFor(issueTag) {
  return ISSUE_CATEGORY[issueTag] || "Other";
}

// ---- 3. amount -> approx USD parser ----
// Deliberately conservative: only a plain, single, undisputed figure parses
// — "Not stated", ranges, multiple figures in one string, anything flagged
// disputed/claimed/alleged is excluded from the sum rather than guessed at.
// Recognizes a $/€/£ symbol OR a 3-5 letter currency/crypto code (either
// side of the number: "USD 19,000" or "1,870 USDT") against the fixed,
// illustrative-only FX_TO_USD table below (not live rates — the UI must
// disclose this). Extended 2026-09-18: the original version only matched
// $/€/£, which silently excluded ~136 of 436 complaints (mostly the
// Bitcointalk-tracker batch, sourced as "USD 1,234"/"CAD 2,000"/crypto
// amounts, not symbol-prefixed) from the disputed-amount total — see
// tools/README.md or ask the site owner if that undercount is raised again.
const FX_TO_USD = {
  "$": 1, "€": 1.08, "£": 1.27,
  USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, PHP: 0.017, INR: 0.011,
  AZN: 0.59, ARS: 0.001, NOK: 0.091, RUB: 0.011, UAH: 0.024, PLN: 0.25,
  KZT: 0.0019, HUF: 0.0026, THB: 0.028,
  USDT: 1, USDC: 1, MBTC: 110, BTC: 110000, SOL: 190,
};
function parseApproxUsd(amount) {
  if (!amount || typeof amount !== "string") return null;
  const a = amount.trim();
  const lower = a.toLowerCase();
  if (/disput|claim|alleg|varies|not specified|unclear/.test(lower)) return null; // not a confirmed figure
  if (/\d\s*[-–—]\s*\d/.test(a)) return null; // a range ("6-7 BTC", "1,400–1,500 USDT"), not a single figure
  const symbolCount = (a.match(/[$€£]/g) || []).length;
  if (symbolCount > 1) return null; // ambiguous multi-figure strings ("$1,394 deposits / $506 withdrawal")
  if (/\//.test(a) || / and /i.test(a)) return null; // multiple amounts combined

  let m, currency, numStr, suffix;
  if (symbolCount === 1) {
    m = a.match(/^[~≈]?\s*([$€£])\s?([\d,]+(?:\.\d+)?)\s*(million|m|k)?\b/i);
    if (!m) return null;
    [, currency, numStr, suffix] = m;
  } else {
    // code-first: "USD 19,000" / "~USD 40,000"
    m = a.match(/^[~≈]?\s*([A-Za-z]{2,5})\s+([\d,]+(?:\.\d+)?)\s*(million|m|k)?\b/i);
    if (m) {
      [, currency, numStr, suffix] = m;
    } else {
      // number-first: "1,870 USDT" / "~88 mBTC" / "2,849 SOL"
      m = a.match(/^[~≈]?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{2,5})\b/i);
      if (!m) return null;
      [, numStr, currency] = m;
    }
    if (!FX_TO_USD.hasOwnProperty(currency.toUpperCase())) return null; // unrecognized code/word, don't guess
    currency = currency.toUpperCase();
  }

  let num = parseFloat(numStr.replace(/,/g, ""));
  if (Number.isNaN(num)) return null;
  if (suffix) {
    const s = suffix.toLowerCase();
    if (s === "million" || s === "m") num *= 1_000_000;
    if (s === "k") num *= 1_000;
  }
  const rate = FX_TO_USD[currency];
  if (!rate) return null;
  return num * rate;
}

// ---- 4. build the flat item list + aggregates ----
const items = [];
const categoryCounts = Object.fromEntries(CATEGORY_ORDER.map(c => [c, 0]));
const statusCounts = { good: 0, bad: 0, neutral: 0 };
let amountUsdTotal = 0;
let amountIncludedCount = 0;

const operatorsOut = [];
for (const op of DATA.operators) {
  if (!op.complaints.length) continue;
  operatorsOut.push({ id: op.id, name: op.name, logoDomain: op.logoDomain || "", score: op.score, complaintCount: op.complaints.length });
  for (const c of op.complaints) {
    const cls = statusCls(c.status);
    const category = categoryFor(c.issueTag);
    const amountUsdApprox = parseApproxUsd(c.amount);
    categoryCounts[category]++;
    statusCounts[cls]++;
    if (amountUsdApprox != null) {
      amountUsdTotal += amountUsdApprox;
      amountIncludedCount++;
    }
    items.push({
      id: c.id,
      slug: c.slug,
      title: c.title,
      operatorId: op.id,
      operatorName: op.name,
      operatorLogoDomain: op.logoDomain || "",
      amount: c.amount,
      amountUsdApprox,
      category,
      issueTag: c.issueTag,
      status: c.status,
      statusCls: cls,
      verified: c.verified,
      source: c.source,
      sourceUrl: c.sourceUrl,
    });
  }
}

operatorsOut.sort((a, b) => b.complaintCount - a.complaintCount);

const categories = CATEGORY_ORDER.map(key => ({ key, count: categoryCounts[key] }))
  .filter(c => c.count > 0)
  .sort((a, b) => b.count - a.count);

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  totalComplaints: items.length,
  totalOperators: operatorsOut.length,
  statusCounts,
  categories,
  amountStats: {
    totalUsdApprox: Math.round(amountUsdTotal),
    includedCount: amountIncludedCount,
    totalCount: items.length,
  },
  operators: operatorsOut,
  items,
};

fs.writeFileSync(path.join(root, "complaints-index.json"), JSON.stringify(out));
console.log(`complaints-index.json written: ${out.totalComplaints} complaints across ${out.totalOperators} operators.`);
console.log(`Status split — resolved(good): ${statusCounts.good}, unresolved(bad): ${statusCounts.bad}, unclear(neutral): ${statusCounts.neutral}`);
console.log(`Amount: ~$${out.amountStats.totalUsdApprox.toLocaleString()} approx, from ${amountIncludedCount}/${items.length} cleanly-parseable entries.`);
console.log("Category breakdown:", categories.map(c => `${c.key}=${c.count}`).join(", "));
