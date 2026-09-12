// Regenerates sitemap.xml: keeps the existing static pages, then appends
// every /sportsbooks/{id}, /sportsbooks/{id}/complaints, and /complaints/
// {slug} URL from data.json. Re-run this after re-running extract-data.mjs
// whenever dashboard.html's operator/complaint data changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));

const STATIC_URLS = [
  { loc: "https://cryptobetgrade.com/", changefreq: "daily", priority: "1.0" },
  { loc: "https://cryptobetgrade.com/dashboard", changefreq: "daily", priority: "0.9" },
  { loc: "https://cryptobetgrade.com/analytics", changefreq: "daily", priority: "0.8" },
  { loc: "https://cryptobetgrade.com/methodology", changefreq: "monthly", priority: "0.6" },
  { loc: "https://cryptobetgrade.com/research", changefreq: "weekly", priority: "0.6" },
  { loc: "https://cryptobetgrade.com/research-verifying-sportsbook-complaints", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/research-confiscated-winnings-value-betting", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/research-betby-sportsbook-complaints", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/research-arbitrage-vs-value-betting", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/research-no-kyc-sportsbooks-requested-kyc", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/research-bcgame-vs-500casino-same-bet-different-outcome", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/about", changefreq: "monthly", priority: "0.5" },
  { loc: "https://cryptobetgrade.com/privacy-policy", changefreq: "yearly", priority: "0.2" },
  { loc: "https://cryptobetgrade.com/cookies", changefreq: "yearly", priority: "0.2" },
];

const urls = [...STATIC_URLS];
for (const op of DATA.operators) {
  urls.push({ loc: `https://cryptobetgrade.com/sportsbooks/${op.id}`, changefreq: "weekly", priority: "0.8" });
  if (op.complaints.length) {
    urls.push({ loc: `https://cryptobetgrade.com/sportsbooks/${op.id}/complaints`, changefreq: "weekly", priority: "0.7" });
  }
  for (const c of op.complaints) {
    urls.push({ loc: `https://cryptobetgrade.com/complaints/${c.slug}`, changefreq: "monthly", priority: "0.6" });
  }
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
  .map(u => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`)
  .join("\n")}\n</urlset>\n`;

fs.writeFileSync(path.join(root, "sitemap.xml"), xml);
console.log(`sitemap.xml written with ${urls.length} URLs (${urls.length - STATIC_URLS.length} new).`);
