// Regenerates the COMPLAINT_SLUGS / COMPLAINT_SLUG_INDEX / matchRealPath
// block inside dashboard.html so its own client-side router recognizes the
// real, crawlable /sportsbooks/{id}, /sportsbooks/{id}/complaints, and
// /complaints/{slug} URLs (not just a "#" hash change) on a normal page
// load. Reads tools/slug-report.json (written by tools/extract-data.mjs —
// run that first) for the {opId, complaintId, slug} of every complaint,
// then rewrites everything between the AUTO-GENERATED:COMPLAINT_SLUGS
// markers in dashboard.html. Idempotent — safe to re-run any time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const slugReportPath = path.join(__dirname, "slug-report.json");
if (!fs.existsSync(slugReportPath)) {
  console.error("tools/slug-report.json not found — run `node tools/extract-data.mjs` first.");
  process.exit(1);
}
const slugReport = JSON.parse(fs.readFileSync(slugReportPath, "utf8"));

const complaintSlugs = {}; // complaintId -> slug
const complaintSlugIndex = {}; // slug -> {opId, complaintId}
for (const r of slugReport) {
  complaintSlugs[r.complaintId] = r.slug;
  complaintSlugIndex[r.slug] = { opId: r.opId, complaintId: r.complaintId };
}

const dashboardPath = path.join(root, "dashboard.html");
const html = fs.readFileSync(dashboardPath, "utf8");

const START = "/* AUTO-GENERATED:COMPLAINT_SLUGS:START — regenerate with tools/patch-dashboard.mjs, do not hand-edit */";
const END = "/* AUTO-GENERATED:COMPLAINT_SLUGS:END */";
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error("Could not find AUTO-GENERATED:COMPLAINT_SLUGS markers in dashboard.html — aborting rather than corrupting the file.");
  process.exit(1);
}

const block = `${START}
const COMPLAINT_SLUGS = ${JSON.stringify(complaintSlugs)};
const COMPLAINT_SLUG_INDEX = ${JSON.stringify(complaintSlugIndex)}; // slug -> {opId, complaintId}, for the real-path router below
// Recognizes the real, crawlable URLs (/sportsbooks/{id}, /sportsbooks/{id}/
// complaints, /complaints/{slug}) so render() shows the right view on a
// normal page load, not just on a "#" hash change. See seo-pages.js for the
// server-side counterpart that pre-renders these same views for crawlers.
function matchRealPath(pathname){
  const path = pathname.replace(/\\/+$/,"") || "/";
  let m = path.match(/^\\/sportsbooks\\/([a-z0-9-]+)\\/complaints$/);
  if(m) return { opId: m[1], tab: "complaints", complaintId: null };
  m = path.match(/^\\/sportsbooks\\/([a-z0-9-]+)$/);
  if(m) return { opId: m[1], tab: "overview", complaintId: null };
  m = path.match(/^\\/complaints\\/([a-z0-9-]+)$/);
  if(m){
    const hit = COMPLAINT_SLUG_INDEX[m[1]];
    if(hit) return { opId: hit.opId, tab: "complaints", complaintId: hit.complaintId };
  }
  return null;
}
${END}`;

const patched = html.slice(0, startIdx) + block + html.slice(endIdx + END.length);
fs.writeFileSync(dashboardPath, patched);
console.log(`dashboard.html patched: ${Object.keys(complaintSlugs).length} complaint slugs across ${new Set(slugReport.map(r => r.opId)).size} operators.`);
