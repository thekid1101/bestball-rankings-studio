// Shared RFC-4180 CSV tokenizer + cell-quoter (contract C4). Single source of
// truth — import this; never reimplement per module.
//
// Four platform/reference modules used to carry their own hand-rolled CSV
// parser and their own cell-quoting helper. All four parsers implement the
// same core grammar (double-quoted cells, "" as an escaped quote, commas and
// newlines allowed inside quotes) but differ in one dimension: how a "blank
// row" gets dropped. That dimension is exposed here as options rather than
// forked into separate functions, so every caller shares one tokenizer.
//
//   - draftkings.js: drops a row (mid-file or trailing) when every cell,
//     joined together, trims to "". This happens *during* parsing.
//     -> parseCsvRows(text)  // emptyRowMode: "trimmed" (default)
//   - drafters.js / underdog.js: used to split text into physical lines
//     first (via /\r\n|\r|\n/) and drop only lines with raw length 0 (a
//     literal blank line); a line that is merely whitespace, or a quoted
//     empty field ("" is 2 raw chars), survived. "raw" mode reproduces that
//     exact rule while still tokenizing the whole text in one pass.
//     -> parseCsvRows(text, { emptyRowMode: "raw" })
//   - references.js: never dropped rows internally — filtering happened at
//     the call site instead. keepEmptyRows preserves that (no internal drop
//     at all; caller decides).
//     -> parseCsvRows(text, { keepEmptyRows: true })
//
// escapeCsvCell(value, mode) reproduces the three existing quoters:
//   - "always"   (drafters quoteCell):  always quote, double internal quotes
//   - "needed"   (draftkings cell):     quote only if value has , " or \n
//   - "nonEmpty" (underdog esc):        "" / null stays bare; else "always"

export function parseCsvRows(text, opts = {}) {
  const { keepEmptyRows = false, emptyRowMode = "trimmed" } = opts;
  const s = text == null ? "" : String(text);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // Raw character count for the row currently being built, excluding the
  // row-terminator itself (\r, \n, or \r\n) — mirrors the .length of the
  // physical line the old per-line parsers filtered on.
  let rawLen = 0;

  const isBlank = () => {
    if (emptyRowMode === "raw") return rawLen === 0;
    // "trimmed": every cell, concatenated, trims to empty (draftkings rule)
    return row.join("").trim().length === 0;
  };

  const flush = () => {
    row.push(field);
    if (keepEmptyRows || !isBlank()) {
      rows.push(row);
    }
    row = [];
    field = "";
    rawLen = 0;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];

    if (!inQuotes && (ch === "\r" || ch === "\n")) {
      if (ch === "\r" && next === "\n") i++; // \r\n counts as one separator
      flush();
      continue;
    }

    rawLen++;

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        rawLen++;
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch === ",") {
      row.push(field);
      field = "";
    } else {
      field += ch;
    }
  }

  // Trailing row with no final line terminator.
  if (field.length > 0 || row.length > 0) {
    flush();
  }

  return rows;
}

export function escapeCsvCell(value, mode = "needed") {
  if (mode === "nonEmpty" && (value === "" || value == null)) {
    return "";
  }

  const v = String(value);

  if (mode === "needed") {
    if (v.includes(",") || v.includes('"') || v.includes("\n")) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }

  // "always" and "nonEmpty" (non-empty branch) both always-quote.
  return '"' + v.replace(/"/g, '""') + '"';
}
