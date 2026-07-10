#!/usr/bin/env node
// Self-check for src/core/csv.js (contract C4). Plain node, no deps.
//
// Table-tests escapeCsvCell() against the byte-exact behavior of the three
// quoters it replaced (drafters quoteCell = "always", draftkings cell =
// "needed", underdog esc = "nonEmpty"), plus a few parseCsvRows sanity
// checks for the emptyRowMode/keepEmptyRows options each adapter relies on.
import { parseCsvRows, escapeCsvCell } from "../src/core/csv.js";

let failures = 0;
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------
// escapeCsvCell table: empty string, plain word, comma, quote, newline —
// against each mode, matching the OLD per-adapter functions byte-for-byte.
// ---------------------------------------------------------------------
const VALUES = {
  empty: "",
  plain: "word",
  comma: "a,b",
  quote: 'a"b',
  newline: "a\nb",
};

// mode "always" (old drafters quoteCell: always quote, double internal quotes)
assertEqual(escapeCsvCell(VALUES.empty, "always"), '""', 'always: empty string');
assertEqual(escapeCsvCell(VALUES.plain, "always"), '"word"', 'always: plain word');
assertEqual(escapeCsvCell(VALUES.comma, "always"), '"a,b"', 'always: value with comma');
assertEqual(escapeCsvCell(VALUES.quote, "always"), '"a""b"', 'always: value with quote');
assertEqual(escapeCsvCell(VALUES.newline, "always"), '"a\nb"', 'always: value with newline');

// mode "needed" (old draftkings cell: quote only if , " or \n present)
assertEqual(escapeCsvCell(VALUES.empty, "needed"), "", 'needed: empty string');
assertEqual(escapeCsvCell(VALUES.plain, "needed"), "word", 'needed: plain word');
assertEqual(escapeCsvCell(VALUES.comma, "needed"), '"a,b"', 'needed: value with comma');
assertEqual(escapeCsvCell(VALUES.quote, "needed"), '"a""b"', 'needed: value with quote');
assertEqual(escapeCsvCell(VALUES.newline, "needed"), '"a\nb"', 'needed: value with newline');

// mode "nonEmpty" (old underdog esc: "" / null stays bare; else always-quote)
assertEqual(escapeCsvCell(VALUES.empty, "nonEmpty"), "", 'nonEmpty: empty string');
assertEqual(escapeCsvCell(null, "nonEmpty"), "", 'nonEmpty: null stays bare');
assertEqual(escapeCsvCell(undefined, "nonEmpty"), "", 'nonEmpty: undefined stays bare');
assertEqual(escapeCsvCell(VALUES.plain, "nonEmpty"), '"word"', 'nonEmpty: plain word');
assertEqual(escapeCsvCell(VALUES.comma, "nonEmpty"), '"a,b"', 'nonEmpty: value with comma');
assertEqual(escapeCsvCell(VALUES.quote, "nonEmpty"), '"a""b"', 'nonEmpty: value with quote');
assertEqual(escapeCsvCell(VALUES.newline, "nonEmpty"), '"a\nb"', 'nonEmpty: value with newline');

// ---------------------------------------------------------------------
// parseCsvRows: core RFC-4180 mechanics (quotes, embedded commas/newlines,
// "" escapes, mixed \r\n|\r|\n separators).
// ---------------------------------------------------------------------
assertEqual(
  JSON.stringify(parseCsvRows('a,"b,c","d""e"\nf,g,h')),
  JSON.stringify([["a", "b,c", 'd"e'], ["f", "g", "h"]]),
  "basic quoted-comma + escaped-quote parse"
);

assertEqual(
  JSON.stringify(parseCsvRows('a,"line1\nline2",c')),
  JSON.stringify([["a", "line1\nline2", "c"]]),
  "embedded newline inside quotes stays in one row"
);

assertEqual(
  JSON.stringify(parseCsvRows("a,b\r\nc,d\re,f\ng,h")),
  JSON.stringify([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]),
  "mixed \\r\\n | \\r | \\n row separators"
);

// emptyRowMode "trimmed" (draftkings): drop rows whose cells all trim empty.
assertEqual(
  JSON.stringify(parseCsvRows("a,b\n\n  \n,,\nc,d")),
  JSON.stringify([["a", "b"], ["c", "d"]]),
  'emptyRowMode "trimmed" drops blank/whitespace/all-empty-cell rows'
);

// emptyRowMode "raw" (drafters/underdog): only literally-empty lines drop;
// a whitespace-only line survives as a single-cell row.
assertEqual(
  JSON.stringify(parseCsvRows("a,b\n\n   \nc,d", { emptyRowMode: "raw" })),
  JSON.stringify([["a", "b"], ["   "], ["c", "d"]]),
  'emptyRowMode "raw" keeps whitespace-only lines, drops only truly-blank ones'
);

// keepEmptyRows (references): nothing dropped internally, including blank
// lines and a trailing blank row before EOF.
assertEqual(
  JSON.stringify(parseCsvRows("\n\na\n\n", { keepEmptyRows: true })),
  JSON.stringify([[""], [""], ["a"], [""]]),
  "keepEmptyRows retains every row, no phantom trailing row after final \\n"
);

if (failures === 0) {
  console.log("PASS: all csv.js checks passed");
  process.exit(0);
} else {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
