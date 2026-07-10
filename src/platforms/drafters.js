import { normalizeName } from "../core/normalize.js";
import { parseCsvRows, escapeCsvCell } from "../core/csv.js";

// ASSUMPTIONS & DECISIONS (verified against draft_rankings_editor.html source):
// 1. ADP "0" or blank → null (not 0); matches relevant() check: num(adp)>0
// 2. Preferred defaults to "any"; team defaults to "" per parseCSV behavior
// 3. Export: NO trailing \r\n; matches out.join("\r\n") without final separator
// 4. Position: stored lowercase in raw, uppercased in canonical Player.pos
// 5. Raw object keyed by canonical header names (id, position, name, preferred, team abbr, ADP, AVG)
//    to enable byte-faithful keep-mode round-trip
// 6. First 6 columns quoted with "" doubling; AVG unquoted (per toCSV serialization)

function parseImport(text) {
  const players = [];
  const warnings = [];

  // emptyRowMode "raw": matches the old split-then-filter(l.length) behavior
  // (only literally-blank lines are dropped; whitespace-only lines survive).
  const rows = parseCsvRows(text, { emptyRowMode: "raw" });
  if (!rows.length) {
    return { players, warnings };
  }

  // Parse header with case-insensitive, flexible matching
  const headParsed = rows[0];
  const head = headParsed.map((h) => h.trim().toLowerCase());

  // Fuzzy header matching: exact match first, then substring match
  const find = (...names) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    for (let i = 0; i < head.length; i++) {
      if (names.some((n) => head[i].includes(n))) return i;
    }
    return -1;
  };

  const iId = find("id");
  const iPos = find("position", "pos");
  const iName = find("name");
  const iPref = find("preferred");
  const iTeam = find("team abbr", "team");
  const iAdp = find("adp");
  const iAvg = find("avg");

  // Require name and position
  if (iName < 0 || iPos < 0) {
    warnings.push("Missing required columns (name, position)");
    return { players, warnings };
  }

  // Parse rows
  for (let k = 1; k < rows.length; k++) {
    try {
      const cells = rows[k];

      // Helper to safely get and trim cell
      const g = (i) => (i >= 0 && cells[i] != null ? cells[i].trim() : "");

      const id = iId >= 0 ? g(iId) : String(k);
      const name = g(iName);
      const pos = g(iPos);
      const pref = iPref >= 0 ? g(iPref) : "";
      const team = iTeam >= 0 ? g(iTeam) : "";
      const adpStr = iAdp >= 0 ? g(iAdp) : "0";
      const avgStr = iAvg >= 0 ? g(iAvg) : "0";

      // Skip rows without name or position
      if (!name || !pos) {
        warnings.push(`Row ${k}: skipped (missing name or position)`);
        continue;
      }

      // Parse ADP: empty, "0", or non-numeric → null
      let adp = null;
      if (adpStr && adpStr !== "" && adpStr !== "0") {
        const parsed = parseFloat(adpStr);
        if (!isNaN(parsed) && parsed > 0) {
          adp = parsed;
        }
      }

      // Build canonical player
      const player = {
        id,
        name,
        nameKey: normalizeName(name),
        pos: pos.toUpperCase(),
        team,
        adp,
        raw: {
          id,
          position: pos,
          name,
          preferred: pref || "any",
          "team abbr": team,
          ADP: adpStr,
          AVG: avgStr,
        },
      };

      players.push(player);
    } catch (e) {
      warnings.push(`Row ${k}: ${e.message}`);
    }
  }

  return { players, warnings };
}

// Quote a cell: quote and double internal quotes
function quoteCell(v) {
  return escapeCsvCell(v, "always");
}

function serializeExport(orderedPlayers, opts = {}) {
  const { adpWrite = "renumber" } = opts;

  const HEADER = "id,position,name,preferred,team abbr,ADP,AVG";
  const lines = [HEADER];

  orderedPlayers.forEach((p, i) => {
    // Determine ADP value: renumber as 1..N, or keep original
    let adpValue;
    if (adpWrite === "renumber") {
      adpValue = String(i + 1);
    } else {
      // keep mode: use raw ADP string
      adpValue = p.raw?.ADP || (p.adp ? String(p.adp) : "");
    }

    // First 6 columns: all quoted with "" doubling
    // AVG: unquoted, as-is
    // Prefer raw values for byte-faithful round-trip; fallback to canonical fields
    const row = [
      quoteCell(p.raw?.id || p.id),
      quoteCell(p.raw?.position || p.pos),
      quoteCell(p.raw?.name || p.name),
      quoteCell(p.raw?.preferred || "any"),
      quoteCell(p.raw?.["team abbr"] || p.team),
      quoteCell(adpValue),
    ].join(",") + "," + (p.raw?.AVG || "");

    lines.push(row);
  });

  // Join with \r\n, no trailing newline
  return lines.join("\r\n");
}

function normalizeAdpToSlot(player) {
  return player.adp;
}

export default {
  id: "drafters",
  label: "Drafters",
  accent: "#63e3ad",
  joinKey: "numericId",
  adpMode: "rewriteAdpColumn",
  keepDeepUnranked: false,
  columns: [{ key: "adp", label: "Src ADP", kind: "gold" }],
  rosterShape: { positions: ["QB", "RB", "WR", "TE"] },
  exportFilename: "drafters_players.csv",
  // Optional (C1): seeds the Simulate panel's Teams/Rounds inputs and the
  // "Fixed build" per-position roster-rule defaults. 18 rounds is an
  // assumption (mirrors UD) pending a real Drafters draft config.
  simDefaults: { teams: 12, rounds: 18, fixedBuild: { QB: 3, RB: 5, WR: 7, TE: 3 } },

  parseImport,
  serializeExport,
  normalizeAdpToSlot,
};
