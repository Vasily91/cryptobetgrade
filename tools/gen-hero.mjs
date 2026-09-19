// Regenerates hero-operator.json: a snapshot of whichever operator
// currently has the highest Trust Score in data.json. index.html fetches
// /hero-operator.json client-side on every load (see its own hero-card
// script), so the homepage hero card always shows the real current #1 —
// but only if this file is regenerated (and redeployed) every time scores
// change. Easy to forget because nothing else in the pipeline touches the
// homepage — that's exactly what caused the hero card to go stale twice
// (kept showing "BC.Game 9.0" after the score had already changed) before
// this script existed. Run after every score change — see
// tools/README.md step 6. Idempotent — safe to re-run any time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));

function fmtUsdShort(amount) {
  if (typeof amount !== "number" || !isFinite(amount)) return undefined;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e3) return `$${Math.round(amount / 1e3)}K`;
  return `$${amount}`;
}

// Pulls "25+ sports" style fragments out of stats.markets, e.g.
// "Casino (5,000+ slots), live casino, sportsbook (25+ sports)".
function sportsShortOf(op) {
  const markets = op.stats && op.stats.markets;
  if (!markets) return undefined;
  const m = markets.match(/(\d+\+?\s*sports?)/i);
  return m ? m[1].replace(/\s+/, " ") : undefined;
}

// sidebar.cryptocurrencies is a comma-separated list, e.g. "BTC, ETH, LTC,
// ...". Reported as "{count}+ coins" (an "at least" figure, same convention
// as the sportsShort fragment) since the listed set is rarely exhaustive.
function cryptoShortOf(op) {
  const list = op.sidebar && op.sidebar.cryptocurrencies;
  if (!list) return undefined;
  const count = list.split(",").map(s => s.trim()).filter(Boolean).length;
  return count ? `${count}+ coins` : undefined;
}

const withScore = DATA.operators.filter(op => typeof op.score === "number");
if (!withScore.length) {
  console.error("No operators with a numeric score in data.json — aborting.");
  process.exit(1);
}
const top = withScore.reduce((best, op) => (op.score > best.score ? op : best));

const hero = {
  generatedAt: new Date().toISOString().slice(0, 10),
  id: top.id,
  name: top.name,
  logoDomain: top.logoDomain,
  jurisdictionShort: top.jurisdictionShort,
  score: top.score,
  gradeLabel: top.gradeLabel,
  breakdown: top.breakdown,
  deposits24hShort: top.onchain ? fmtUsdShort(top.onchain.deposits24h) : undefined,
  depositsRank: top.onchain ? top.onchain.rank : undefined,
  annualVolumeShort: top.annualVolume ? fmtUsdShort(top.annualVolume.amount) : undefined,
  annualVolumeYoy: top.annualVolume ? top.annualVolume.yoy : undefined,
  payoutShort: top.payoutTimeShort,
  sportsShort: sportsShortOf(top),
  cryptoShort: cryptoShortOf(top),
  kycLabelShort: top.kycLabelShort,
};

// Drop undefined keys so the JSON stays clean (matches the hand-written
// file's shape — it never carried explicit nulls for missing fields).
for (const k of Object.keys(hero)) if (hero[k] === undefined) delete hero[k];

fs.writeFileSync(path.join(__dirname, "hero-operator.json"), JSON.stringify(hero, null, 2) + "\n");
fs.writeFileSync(path.join(root, "hero-operator.json"), JSON.stringify(hero, null, 2) + "\n");
console.log(`hero-operator.json written: ${hero.name} (score ${hero.score}).`);
