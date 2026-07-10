// Reference-source importer + name-matcher (contract C4).
// Turns user-pasted rankings text (ETR/FantasyPros/own projections/etc.) into a
// ReferenceSource the editor can join against the player pool by nameKey.
//
// Pure ESM, no DOM. Never bakes in any third-party rankings data — parsing is
// purely structural (CSV/numbered-list/bare-list) and the player pool always
// comes from the caller.
import { normalizeName } from "./normalize.js";

// ---- header alias tables (csv format) --------------------------------
const RANK_ALIASES = new Set(["rank", "rk", "#"]);
const PLAYER_ALIASES = new Set(["player", "name"]);
const POS_ALIASES = new Set(["pos", "position"]);
const TEAM_ALIASES = new Set(["team", "tm"]);

// ---- known position codes (numbered format trailing-token parsing) ---
const POS_CODES = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);

// ---- NFL team abbreviations whitelist (numbered format trailing-token parsing) ---
const TEAM_CODES = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
  "DET", "GB", "HOU", "IND", "JAX", "JAC", "KC", "LV", "LVR", "LAC",
  "LAR", "LA", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT",
  "SEA", "SF", "TB", "TEN", "WAS", "WSH", "OAK", "SD", "STL",
]);

// ---- name suffixes to exclude from token parsing ---
const SUFFIXES = new Set(["JR", "SR", "I", "II", "III", "IV", "V"]);

// A line counts as "junk" (skipped) if it has no letters at all (blank,
// stray punctuation/number-only lines, etc).
function hasLetters(s) {
  return /[A-Za-z]/.test(s);
}

// ---- RFC-4180 CSV tokenizer (whole-text, handles quoted commas/quotes/
// embedded newlines) -----------------------------------------------------
function parseCSVRows(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // dropped; \n (below) terminates the row for both \r\n and lone \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function entriesFromCsvRows(csvRows) {
  const header = csvRows[0].map((h) => h.trim().toLowerCase());
  const rankIdx = header.findIndex((h) => RANK_ALIASES.has(h));
  const playerIdx = header.findIndex((h) => PLAYER_ALIASES.has(h));
  const posIdx = header.findIndex((h) => POS_ALIASES.has(h));
  const teamIdx = header.findIndex((h) => TEAM_ALIASES.has(h));

  const entries = [];
  let order = 1;
  for (let i = 1; i < csvRows.length; i++) {
    const row = csvRows[i];
    const nameRaw = playerIdx >= 0 ? row[playerIdx] : undefined;
    if (!nameRaw || !hasLetters(nameRaw)) continue; // blank/junk row
    const name = nameRaw.trim();

    let rank = order; // rank column missing/blank -> line order
    if (rankIdx >= 0 && row[rankIdx] != null && row[rankIdx].trim() !== "") {
      const n = Number(row[rankIdx].trim());
      if (Number.isFinite(n)) rank = n;
    }

    const entry = { name, rank };
    if (posIdx >= 0 && row[posIdx] && row[posIdx].trim()) {
      entry.pos = row[posIdx].trim().toUpperCase();
    }
    if (teamIdx >= 0 && row[teamIdx] && row[teamIdx].trim()) {
      entry.team = row[teamIdx].trim();
    }
    entries.push(entry);
    order++;
  }
  return entries;
}

// "1. Name POS TEAM" / "2) Name" / "3 Name" — leading number is the rank;
// up to two trailing ALL-CAPS tokens are peeled off the end as POS/TEAM when
// they look the part (POS must be a known code; TEAM is any 2-4 letter
// all-caps token). Order-independent ("Name POS TEAM" or "Name TEAM POS").
function parseNumberedEntries(rawLines) {
  const entries = [];
  let order = 1;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || !hasLetters(line)) continue;

    const m = line.match(/^(\d+)[.)]?\s+(.*)$/);
    let rank;
    let rest;
    if (m) {
      const n = Number(m[1]);
      rank = Number.isFinite(n) ? n : order;
      rest = m[2].trim();
    } else {
      // Text doesn't have a leading number on this line; fall back to line
      // order rather than dropping it.
      rank = order;
      rest = line;
    }
    if (!rest || !hasLetters(rest)) continue;

    const tokens = rest.split(/\s+/);
    let pos;
    let team;
    let guard = 0;
    while (guard < 2 && tokens.length > 1) {
      guard++;
      const token = tokens[tokens.length - 1];
      if (!/^[A-Z]{1,4}$/.test(token)) break;
      // Exclude name suffixes from being parsed as pos/team tokens
      if (SUFFIXES.has(token)) break;
      if (!pos && POS_CODES.has(token)) {
        pos = token;
        tokens.pop();
        continue;
      }
      if (!team && TEAM_CODES.has(token)) {
        team = token;
        tokens.pop();
        continue;
      }
      break;
    }
    const name = tokens.join(" ").trim();
    if (!name) continue;

    const entry = { name, rank };
    if (pos) entry.pos = pos;
    if (team) entry.team = team;
    entries.push(entry);
    order++;
  }
  return entries;
}

// One name per line; line order is rank.
function parseBareEntries(rawLines) {
  const entries = [];
  let order = 1;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || !hasLetters(line)) continue;
    entries.push({ name: line, rank: order });
    order++;
  }
  return entries;
}

export function parseReferenceText(text) {
  const rawLines = String(text || "").split(/\r\n|\r|\n/);
  const contentLines = rawLines.filter(hasLetters);
  if (contentLines.length === 0) return { entries: [], format: "bare" };

  // csv: header row (first non-blank CSV row) has a recognized player-alias
  // column. Checked first since it's the most structured/unambiguous format.
  const csvRows = parseCSVRows(text).filter((row) => row.some((f) => f && f.trim() !== ""));
  if (csvRows.length > 0) {
    const header = csvRows[0].map((h) => h.trim().toLowerCase());
    const hasPlayerHeader = header.length > 1 && header.some((h) => PLAYER_ALIASES.has(h));
    if (hasPlayerHeader) {
      return { entries: entriesFromCsvRows(csvRows), format: "csv" };
    }
  }

  // numbered: majority of content lines start with "<digits><.|)>? <text>".
  const numberedCount = contentLines.filter((l) => /^\s*\d+[.)]?\s+\S/.test(l)).length;
  if (numberedCount / contentLines.length >= 0.5) {
    return { entries: parseNumberedEntries(rawLines), format: "numbered" };
  }

  return { entries: parseBareEntries(rawLines), format: "bare" };
}

function playerKey(p) {
  return p.nameKey || normalizeName(p.name);
}

// Loose team match: player.team may be a full name ("Cincinnati Bengals") or
// an abbreviation ("CIN"); entry.team is whatever the pasted text had. Treat
// it as a match if either normalized string contains/starts with the other.
function teamsLooselyMatch(playerTeam, entryTeam) {
  if (!playerTeam || !entryTeam) return false;
  const a = String(playerTeam).trim().toLowerCase();
  const b = String(entryTeam).trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export function buildReferenceSource(label, entries, players) {
  // candidate index: nameKey -> Player[] (usually length 1; >1 on a genuine
  // name collision in the pool, e.g. two real players who share a name).
  const index = new Map();
  for (const p of players) {
    const key = playerKey(p);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  }

  const byName = new Map();
  const unmatched = [];
  let matched = 0;

  for (const entry of entries) {
    const key = normalizeName(entry.name);
    const candidates = index.get(key);
    if (!candidates || candidates.length === 0) {
      unmatched.push({ name: entry.name, rank: entry.rank });
      continue;
    }

    let player = candidates[0];
    if (candidates.length > 1) {
      let resolved = null;
      if (entry.pos) {
        resolved = candidates.find((c) => c.pos && c.pos.toUpperCase() === entry.pos.toUpperCase());
      }
      if (!resolved && entry.team) {
        resolved = candidates.find((c) => teamsLooselyMatch(c.team, entry.team));
      }
      // Neither pos nor team disambiguates (or entry supplied neither): fall
      // back to the first candidate. Note: byName is keyed by nameKey only
      // (contract C4), so which physical candidate we "pick" here can't
      // change the stored value — the rank is written under the shared name
      // key either way. This still counts as matched (not unmatched); we
      // just can't do better than "first" without more signal from the
      // pasted text.
      player = resolved || candidates[0];
    }

    const pKey = playerKey(player);
    if (!byName.has(pKey)) {
      // First entry to claim a given nameKey wins (keeps the better/earlier
      // rank when the pasted text has a duplicate/typo'd row).
      byName.set(pKey, entry.rank);
    }
    matched++;
  }

  return {
    source: { label, byName },
    report: { matched, total: entries.length, unmatched },
  };
}
