import { normalizeName } from "../core/normalize.js";

// CSV RFC-4180 line splitter: handles quoted fields with "" escapes
function splitLine(line, delim = ",") {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delim && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

// CSV field escaper: quote and double internal quotes (replicate source exactly)
function esc(v) {
  return v === "" || v == null ? "" : '"' + String(v).replace(/"/g, '""') + '"';
}

export default {
  id: "underdog",
  label: "Underdog",
  accent: "#f0c56d",
  joinKey: "uuid",
  adpMode: "rewriteAdpColumn",
  keepDeepUnranked: true,
  columns: [{ key: "adp", label: "UD ADP", kind: "gold" }],
  rosterShape: { positions: ["QB", "RB", "WR", "TE"] },
  exportFilename: "underdog_rankings.csv",

  parseImport(text) {
    const players = [];
    const warnings = [];

    // Split lines, filter empties
    const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length);
    if (!lines.length) {
      warnings.push("Empty file");
      return { players, warnings };
    }

    // Parse header: keep original names and create lowercase map for finding
    const headerCells = splitLine(lines[0]);
    const originalHeaders = headerCells.map((h) => h.trim());
    const head = originalHeaders.map((h) => h.toLowerCase());

    const find = (...names) => {
      // Exact match first
      for (const n of names) {
        const i = head.indexOf(n);
        if (i >= 0) return i;
      }
      // Substring match fallback
      for (let i = 0; i < head.length; i++) {
        if (names.some((n) => head[i].includes(n))) return i;
      }
      return -1;
    };

    const iId = find("id");
    const iF = find("firstname", "first");
    const iL = find("lastname", "last");
    const iAdp = find("adp");
    const iProj = find("projectedpoints", "proj", "points");
    const iSal = find("salary");
    const iPR = find("positionrank", "posrank");
    const iSlot = find("slotname", "slot", "position", "pos");
    const iTeam = find("teamname", "team");
    const iLine = find("lineupstatus", "status");
    const iBye = find("byeweek", "bye");

    // Parse rows
    for (let k = 1; k < lines.length; k++) {
      try {
        const cells = splitLine(lines[k]);

        // Helper to safely get cell with trimming
        const g = (i) => (i >= 0 && cells[i] != null ? cells[i].trim() : "");

        // Extract canonical fields
        const id = g(iId) || String(k);
        const firstName = g(iF);
        const lastName = g(iL);
        const name = `${firstName} ${lastName}`.trim();
        const nameKey = normalizeName(name);
        const adpStr = g(iAdp) || "-";
        const adp = adpStr === "-" || adpStr === "" ? null : parseFloat(adpStr);

        // Build raw object keyed by the ELEVEN CANONICAL names (not the upload's
        // literal header text), with the source's missing-value defaults baked in
        // so keep-mode re-export matches the source exactly.
        const raw = {
          id,
          firstName,
          lastName,
          adp: adpStr,
          projectedPoints: g(iProj) || "0.0",
          salary: g(iSal) || "1",
          positionRank: g(iPR),
          slotName: g(iSlot),
          teamName: g(iTeam),
          lineupStatus: g(iLine),
          byeWeek: g(iBye),
        };

        // Skip rows without name
        if (!name) {
          warnings.push(`Row ${k}: skipped (no name)`);
          continue;
        }

        // Build canonical player
        const player = {
          id,
          name,
          nameKey,
          pos: g(iSlot).toUpperCase() || "",
          team: g(iTeam) || "",
          adp: isNaN(adp) ? null : adp,
          raw,
        };

        players.push(player);
      } catch (e) {
        warnings.push(`Row ${k}: ${e.message}`);
      }
    }

    return { players, warnings };
  },

  serializeExport(orderedPlayers, opts = {}) {
    const { adpWrite = "renumber", keepDash = false } = opts;

    // Canonical column order for rowFields
    const CANONICAL_HEADER = [
      "id",
      "firstName",
      "lastName",
      "adp",
      "projectedPoints",
      "salary",
      "positionRank",
      "slotName",
      "teamName",
      "lineupStatus",
      "byeWeek",
    ];

    // Header (exact order as per contract, quoted like the source's esc())
    const header = CANONICAL_HEADER.map(esc).join(",");

    const lines = [header];

    // For keep mode: just reorder, preserve all fields byte-faithfully
    if (adpWrite === "keep") {
      orderedPlayers.forEach((p) => {
        const row = [];
        CANONICAL_HEADER.forEach((colName) => {
          const value = p.raw[colName] || "";
          row.push(esc(value));
        });
        lines.push(row.join(","));
      });
      return lines.join("\n");
    }

    // renumber mode: recompute adp and positionRank
    // Find the last player who had an original ADP (was ranked)
    let lastRanked = -1;
    orderedPlayers.forEach((p, i) => {
      if (p.adp != null) {
        lastRanked = i;
      }
    });

    // Position counters for positionRank
    const posCounters = {};

    orderedPlayers.forEach((p, i) => {
      const inZone = keepDash ? i <= lastRanked : true;

      let newAdp, newPrank;
      if (inZone) {
        newAdp = String(i + 1);
        const pos = p.pos;
        posCounters[pos] = (posCounters[pos] || 0) + 1;
        newPrank = pos + posCounters[pos];
      } else {
        newAdp = "-";
        newPrank = "";
      }

      // Build row from raw, overwriting adp and positionRank
      const row = [];
      CANONICAL_HEADER.forEach((colName) => {
        let value;
        if (colName === "adp") {
          value = newAdp;
        } else if (colName === "positionRank") {
          value = newPrank;
        } else {
          value = p.raw[colName] || "";
        }
        row.push(esc(value));
      });

      lines.push(row.join(","));
    });

    return lines.join("\n");
  },

  normalizeAdpToSlot(player) {
    return player.adp;
  },
};
