// Regenerates the HERO_SEARCH_OPERATORS array inside index.html — the list
// that powers the homepage hero search box's autocomplete. Reads data.json
// (written by extract-data.mjs, step 2) so it can never drift from the real
// dashboard.html operator list the way the old hand-maintained array did
// (confirmed stale on 2026-09-05, when 15 added operators were unsearchable
// from the homepage). Run whenever an operator is added or removed — see
// tools/README.md step 5b. Idempotent — safe to re-run any time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));

const entries = DATA.operators.map(op => `{name:${JSON.stringify(op.name)}, id:${JSON.stringify(op.id)}}`);

// Wrap at a readable width (matches the hand-authored file's look) rather
// than one operator per line or one giant line.
const lines = [];
let cur = "  ";
for (const entry of entries) {
  const piece = entry + ", ";
  if (cur.length + piece.length > 88 && cur.trim().length) {
    lines.push(cur.replace(/\s+$/, ""));
    cur = "  ";
  }
  cur += piece;
}
if (cur.trim().length) lines.push(cur.replace(/,\s*$/, ""));

const arrayBody = lines.join("\n");

const dashboardPath = path.join(root, "index.html");
const html = fs.readFileSync(dashboardPath, "utf8");

const START = "/* AUTO-GENERATED:HERO_SEARCH_OPERATORS:START — regenerate with tools/gen-hero-search.mjs, do not hand-edit */";
const END = "/* AUTO-GENERATED:HERO_SEARCH_OPERATORS:END */";
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error("Could not find AUTO-GENERATED:HERO_SEARCH_OPERATORS markers in index.html — aborting rather than corrupting the file.");
  process.exit(1);
}

const block = `${START}
const HERO_SEARCH_OPERATORS = [
${arrayBody}
];
${END}`;

const patched = html.slice(0, startIdx) + block + html.slice(endIdx + END.length);
fs.writeFileSync(dashboardPath, patched);
console.log(`index.html patched: ${DATA.operators.length} operators in HERO_SEARCH_OPERATORS.`);
