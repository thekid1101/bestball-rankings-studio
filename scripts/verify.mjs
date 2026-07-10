// Orchestrator validation harness (Phase 2). Runs every module self-check and
// enforces the no-proprietary-data policy over everything that ships (src/).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;

// 1. Run all self-checks.
const checks = readdirSync(join(root, "scripts")).filter(f => /^check-.*\.mjs$/.test(f));
for (const f of checks) {
  try {
    execFileSync(process.execPath, [join(root, "scripts", f)], { cwd: root, stdio: "pipe" });
    console.log(`PASS  ${f}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${f}\n${(e.stdout || "").toString().slice(-2000)}${(e.stderr || "").toString().slice(-2000)}`);
  }
}

// 2. Syntax-load every ESM module under src/ (editor/ui may guard DOM at call time,
// but importing must never throw in plain Node).
async function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) await walk(p);
    else if (name.endsWith(".js")) {
      try {
        await import(pathToFileURL(p).href);
        console.log(`LOAD  ${p.slice(root.length + 1)}`);
      } catch (e) {
        failures++;
        console.log(`FAIL  import ${p.slice(root.length + 1)}: ${e.message}`);
      }
    }
  }
}
await walk(join(root, "src"));

// 3. No-proprietary-data scan over src/ (shipped code). The policy bans baked-in
// ranking DATA, not vendor names: UI hint text and comments may cite ETR or
// FantasyPros as examples of user-supplied sources. A vendor mention is a failure
// only when the line also carries data signatures (inline arrays/uuids/rank maps)
// or uses a known data-blob identifier from the legacy apps.
const vendor = /\b(etr|establish\s*the\s*run|fantasypros)\b/i;
const dataSignature = /(\bETR_DEFAULT\b|\bUNDERDOG_DEFAULT\b|[0-9a-f]{8}-[0-9a-f]{4}-|\]\s*,\s*\[|:\s*\[\s*\d|\[\s*\d+\s*,\s*["']\d)/i;
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { scan(p); continue; }
    const text = readFileSync(p, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (vendor.test(line)) {
        if (dataSignature.test(line)) {
          failures++;
          console.log(`FAIL  proprietary-data ${p.slice(root.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        } else {
          console.log(`INFO  vendor mention (no data) ${p.slice(root.length + 1)}:${i + 1}`);
        }
      } else if (/\b(ETR_DEFAULT|UNDERDOG_DEFAULT)\b/.test(line)) {
        failures++;
        console.log(`FAIL  legacy data-blob identifier ${p.slice(root.length + 1)}:${i + 1}`);
      }
    });
    // Heuristic: any array literal with 50+ quoted entries on adjacent lines smells like a data blob.
    const blob = text.match(/(\[["'][^\]]{4000,}\])/);
    if (blob) {
      failures++;
      console.log(`FAIL  possible embedded data blob in ${p.slice(root.length + 1)}`);
    }
  }
}
scan(join(root, "src"));

console.log(failures === 0 ? "\nVERIFY: ALL CLEAN" : `\nVERIFY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
