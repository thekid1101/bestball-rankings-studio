import { normalizeName } from "../core/normalize.js";
import { parseCsvRows, escapeCsvCell } from "../core/csv.js";

function parseImport(text) {
  const players = [];
  const warnings = [];

  // Parse CSV rows, handling quoted cells with newlines. Default
  // emptyRowMode "trimmed" drops rows whose cells all trim to empty.
  const rows = parseCsvRows(text);

  if (rows.length === 0) {
    return { players, warnings };
  }

  // Parse header
  const headerCells = rows[0];
  const headers = headerCells.map(h => h.trim().toLowerCase());

  // Find column indices
  const idIdx = headers.findIndex(h => h === "id");
  const nameIdx = headers.findIndex(h => h === "name");
  const posIdx = headers.findIndex(h => h === "position");
  const adpIdx = headers.findIndex(h => h === "adp");
  const teamIdx = headers.findIndex(h => h === "team");

  // Validate required columns
  if (idIdx === -1 || nameIdx === -1 || posIdx === -1) {
    warnings.push("Missing required columns (ID, Name, Position)");
    return { players, warnings };
  }

  // Parse data rows
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];

    try {
      // Extract fields
      const id = cells[idIdx]?.trim() || "";
      const name = cells[nameIdx]?.trim() || "";
      const pos = cells[posIdx]?.trim() || "";
      const adpStr = adpIdx !== -1 ? (cells[adpIdx]?.trim() || "") : "";
      const team = teamIdx !== -1 ? (cells[teamIdx]?.trim() || "") : "";

      // Validate required fields
      if (!id || !name || !pos) {
        warnings.push(`Row ${i + 1}: Missing required fields (id, name, or position)`);
        continue;
      }

      // Parse ADP
      let adp = null;
      if (adpStr && adpStr !== "") {
        const parsed = parseFloat(adpStr);
        if (!isNaN(parsed)) {
          adp = parsed;
        }
      }

      // Create player
      const player = {
        id,
        name,
        nameKey: normalizeName(name),
        pos: pos.toUpperCase(),
        team,
        adp,
        raw: {
          ID: id,
          Name: name,
          Position: pos,
          ADP: adpStr,
          Team: team
        }
      };

      players.push(player);
    } catch (err) {
      warnings.push(`Row ${i + 1}: Failed to parse (${err.message})`);
    }
  }

  return { players, warnings };
}

// RFC-4180 cell quoting: quote if contains comma, quote, or newline
function cell(v) {
  return escapeCsvCell(v, "needed");
}

function serializeExport(orderedPlayers, opts) {
  const rows = ["ID,Name,Position,ADP,Team,,Instructions"];

  for (const player of orderedPlayers) {
    const adpValue = player.raw?.ADP !== undefined ? player.raw.ADP : (player.adp ? String(player.adp) : "");
    const row = [
      cell(player.id),
      cell(player.name),
      cell(player.raw?.Position || player.pos),
      cell(adpValue),
      cell(player.team)
    ];
    rows.push(row.join(","));
  }

  return rows.join("\r\n") + "\r\n";
}

function normalizeAdpToSlot(player) {
  return player.adp;
}

export default {
  id: "draftkings",
  label: "DraftKings",
  accent: "#5fa0dd",
  joinKey: "numericId",
  adpMode: "rowOrder",
  keepDeepUnranked: false,
  columns: [{ key: "adp", label: "DK ADP", kind: "gold" }],
  rosterShape: { positions: ["QB", "RB", "WR", "TE"] },
  exportFilename: "draftkings_rankings.csv",
  // Optional (C1): seeds the Simulate panel's Teams/Rounds inputs and the
  // "Fixed build" per-position roster-rule defaults. DK best ball drafts
  // run 20 rounds (vs. 18 for UD/Drafters).
  simDefaults: { teams: 12, rounds: 20, fixedBuild: { QB: 3, RB: 6, WR: 8, TE: 3 } },

  parseImport,
  serializeExport,
  normalizeAdpToSlot
};
