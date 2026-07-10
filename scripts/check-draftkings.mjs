#!/usr/bin/env node

import draftkings from "../src/platforms/draftkings.js";
import { normalizeName } from "../src/core/normalize.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    process.exit(1);
  }
}

// Test 1: Round-trip CSV with edge cases
console.log("Test 1: Round-trip CSV with edge cases...");

const sampleCsv = `ID,Name,Position,ADP,Team,,Instructions\r
1001,"Smith, John",QB,12.5,KC\r
1002,Jane Doe,WR,,NYJ\r
1003,"Bob ""The King"" Jones",RB,5.2,LV\r
1004,"Alice NL
Test",TE,8.0,SF\r
`;

const { players: parsed, warnings } = draftkings.parseImport(sampleCsv);

assert(parsed.length === 4, `Expected 4 players, got ${parsed.length}`);
assert(parsed[0].id === "1001", `Player 0 ID: expected "1001", got "${parsed[0].id}"`);
assert(parsed[0].name === "Smith, John", `Player 0 name: expected "Smith, John", got "${parsed[0].name}"`);
assert(parsed[0].pos === "QB", `Player 0 pos: expected "QB", got "${parsed[0].pos}"`);
assert(parsed[0].adp === 12.5, `Player 0 ADP: expected 12.5, got ${parsed[0].adp}`);
assert(parsed[0].team === "KC", `Player 0 team: expected "KC", got "${parsed[0].team}"`);

assert(parsed[1].adp === null, `Player 1 ADP (blank): expected null, got ${parsed[1].adp}`);

assert(parsed[2].name === `Bob "The King" Jones`, `Player 2 name with escaped quotes: expected 'Bob "The King" Jones', got "${parsed[2].name}"`);

assert(parsed[3].name === "Alice NL\nTest", `Player 3 name with newline: expected 'Alice NL\\nTest', got "${parsed[3].name}"`);

// Test 2: Serialize back and verify byte-for-byte match
console.log("Test 2: Serialize and verify byte-for-byte match...");

const serialized = draftkings.serializeExport(parsed, { adpWrite: "keep" });

if (serialized !== sampleCsv) {
  console.error(`\nRound-trip FAILED. Diff:\n`);
  console.error(`Expected (${sampleCsv.length} bytes):\n${JSON.stringify(sampleCsv)}\n`);
  console.error(`Got (${serialized.length} bytes):\n${JSON.stringify(serialized)}\n`);

  // Find first difference
  for (let i = 0; i < Math.max(sampleCsv.length, serialized.length); i++) {
    if (sampleCsv[i] !== serialized[i]) {
      console.error(`First diff at position ${i}:`);
      console.error(`  Expected: ${JSON.stringify(sampleCsv.substring(Math.max(0, i - 20), i + 20))}`);
      console.error(`  Got:      ${JSON.stringify(serialized.substring(Math.max(0, i - 20), i + 20))}`);
      break;
    }
  }
  process.exit(1);
}

assert(serialized === sampleCsv, "CSV round-trip should match exactly");

// Test 3: nameKey normalization
console.log("Test 3: nameKey normalization...");

assert(parsed[0].nameKey === normalizeName("Smith, John"), `Player 0 nameKey should be normalized`);
assert(parsed[2].nameKey === normalizeName(`Bob "The King" Jones`), `Player 2 nameKey should be normalized`);

// Test 4: normalizeAdpToSlot
console.log("Test 4: normalizeAdpToSlot behavior...");

assert(draftkings.normalizeAdpToSlot(parsed[0]) === 12.5, `Expected normalizeAdpToSlot(12.5) = 12.5`);
assert(draftkings.normalizeAdpToSlot(parsed[1]) === null, `Expected normalizeAdpToSlot(null) = null`);

// Test 5: Config fields
console.log("Test 5: Config fields...");

assert(draftkings.id === "draftkings", `Expected id="draftkings"`);
assert(draftkings.label === "DraftKings", `Expected label="DraftKings"`);
assert(draftkings.accent === "#5fa0dd", `Expected accent="#5fa0dd"`);
assert(draftkings.joinKey === "numericId", `Expected joinKey="numericId"`);
assert(draftkings.adpMode === "rowOrder", `Expected adpMode="rowOrder"`);
assert(draftkings.keepDeepUnranked === false, `Expected keepDeepUnranked=false`);
assert(draftkings.exportFilename === "draftkings_rankings.csv", `Expected exportFilename="draftkings_rankings.csv"`);
assert(Array.isArray(draftkings.columns), `Expected columns to be an array`);
assert(draftkings.columns.length === 1, `Expected 1 column`);
assert(draftkings.columns[0].key === "adp", `Expected column key="adp"`);
assert(draftkings.columns[0].kind === "gold", `Expected column kind="gold"`);

console.log("✓ All tests passed!");
process.exit(0);
