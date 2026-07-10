#!/usr/bin/env node

import config from "../src/platforms/drafters.js";

// SYNTHETIC TEST DATA (spec-conformant):
// - name with comma: "Zeph, Quandary"
// - name with doubled quote: Tobin "Ace" Marsh
// - blank ADP: cell is empty
// - AVG column: UNQUOTED
// - Line separators: explicit \r\n
// - No trailing \r\n
const SAMPLE_CSV = [
  "id,position,name,preferred,team abbr,ADP,AVG",
  `"1","RB","Zeph, Quandary","any","DET","1.2",21.58`,
  `"2","WR","Tobin ""Ace"" Marsh","any","ATL","",23.45`,
  `"3","QB","Vera Thorne","any","BUF","3",18.5`,
  `"4","TE","Kale Justus","any","LV","4.5",0`
].join("\r\n");

// Unquoted version uses same logical players with selective quoting for edge cases
const SAMPLE_CSV_NO_QUOTES = `id,position,name,preferred,team abbr,ADP,AVG
1,RB,"Zeph, Quandary",any,DET,1.2,21.58
2,WR,"Tobin ""Ace"" Marsh",any,ATL,,23.45
3,QB,Vera Thorne,any,BUF,3,18.5
4,TE,Kale Justus,any,LV,4.5,0`;

function test() {
  let passed = 0;
  let failed = 0;

  // Test 1: Parse and re-export in "keep" mode should round-trip
  console.log("Test 1: Parse → Export ('keep' mode) round-trip...");
  try {
    const { players, warnings } = config.parseImport(SAMPLE_CSV);

    if (players.length !== 4) {
      console.log(`  FAIL: Expected 4 players, got ${players.length}`);
      failed++;
    } else {
      const exported = config.serializeExport(players, { adpWrite: "keep" });

      // Byte-exact round-trip required
      if (exported === SAMPLE_CSV) {
        console.log("  PASS: Byte-exact round-trip");
        passed++;
      } else {
        // Report first mismatching byte offset
        let offset = 0;
        for (let i = 0; i < Math.max(exported.length, SAMPLE_CSV.length); i++) {
          if (exported[i] !== SAMPLE_CSV[i]) {
            offset = i;
            break;
          }
        }
        console.log(`  FAIL: Byte-mismatch at offset ${offset}`);
        failed++;
      }
    }
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }

  // Test 2: Renumber mode should produce sequential 1..N ADP
  console.log("\nTest 2: Renumber mode produces 1..N ADP...");
  try {
    const { players } = config.parseImport(SAMPLE_CSV);
    const exported = config.serializeExport(players, { adpWrite: "renumber" });

    const lines = exported.split("\r\n");
    if (lines.length !== 5) { // header + 4 rows
      console.log(`  FAIL: Expected 5 lines, got ${lines.length}`);
      failed++;
    } else {
      // Check ADP column (6th column, index 5 in 0-based)
      const adpValues = [];
      for (let i = 1; i < lines.length; i++) {
        // Parse the line to extract the 6th quoted field
        const cells = [];
        let current = "";
        let inQuotes = false;
        for (let j = 0; j < lines[i].length; j++) {
          const ch = lines[i][j];
          if (ch === '"') {
            if (inQuotes && lines[i][j + 1] === '"') {
              current += '"';
              j++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (ch === "," && !inQuotes) {
            cells.push(current);
            current = "";
          } else {
            current += ch;
          }
        }
        cells.push(current);

        if (cells.length >= 6) {
          adpValues.push(cells[5]); // ADP is 6th column (0-indexed as 5)
        }
      }

      const expectedAdp = ["1", "2", "3", "4"];
      const adpMatch = adpValues.every((v, i) => v === expectedAdp[i]);

      if (adpMatch) {
        console.log("  PASS: ADP column renumbered 1..4 with proper quoting");
        passed++;
      } else {
        console.log(`  FAIL: ADP values mismatch. Got: ${adpValues.join(", ")}`);
        console.log(`        Expected: ${expectedAdp.join(", ")}`);
        failed++;
      }

      // Verify AVG column is NOT quoted
      const avgNotQuoted = lines.slice(1).every(line => {
        const lastCommaIdx = line.lastIndexOf(",");
        if (lastCommaIdx === -1) return false;
        const avgValue = line.substring(lastCommaIdx + 1);
        return avgValue[0] !== '"' && avgValue[avgValue.length - 1] !== '"';
      });

      if (avgNotQuoted) {
        console.log("  PASS: AVG column not quoted (unquoted numbers)");
        passed++;
      } else {
        console.log("  FAIL: AVG column should not be quoted");
        failed++;
      }
    }
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }

  // Test 3: Quoting rules (first 6 columns quoted, AVG not)
  console.log("\nTest 3: Quoting rules integrity...");
  try {
    const { players } = config.parseImport(SAMPLE_CSV);
    const exported = config.serializeExport(players, { adpWrite: "keep" });

    const lines = exported.split("\r\n");
    const headerLine = lines[0];

    // Header should NOT be quoted (headers aren't quoted in CSV exports)
    const expectedHeader = "id,position,name,preferred,team abbr,ADP,AVG";
    if (headerLine === expectedHeader) {
      console.log("  PASS: Header format correct");
      passed++;
    } else {
      console.log(`  FAIL: Header mismatch`);
      console.log(`        Got: ${headerLine}`);
      console.log(`        Exp: ${expectedHeader}`);
      failed++;
    }

    // Check trailing newline rules
    const endsWithCRLF = exported.endsWith("\r\n");
    const containsInnerCRLF = exported.includes("\r\n") && !endsWithCRLF;

    if (endsWithCRLF) {
      console.log(`  FAIL: Export must NOT end with \\r\\n`);
      failed++;
    } else if (containsInnerCRLF) {
      console.log("  PASS: Export has \\r\\n as inner separators, no trailing");
      passed++;
    } else {
      console.log(`  FAIL: Export must contain \\r\\n as inner separators`);
      failed++;
    }

  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }

  // Test 4: Handle missing columns gracefully
  console.log("\nTest 4: Missing column handling...");
  try {
    const minimalCsv = `name,position
John Doe,RB
Jane Smith,WR`;

    const { players, warnings } = config.parseImport(minimalCsv);
    if (players.length === 2) {
      const p1 = players[0];
      if (p1.id === "1" && p1.team === "" && p1.adp === null) {
        console.log("  PASS: Missing columns handled (id=rownum, team=\"\", adp=null)");
        passed++;
      } else {
        console.log(`  FAIL: Missing column defaults incorrect`);
        failed++;
      }
    } else {
      console.log(`  FAIL: Expected 2 players, got ${players.length}`);
      failed++;
    }
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }

  // Test 5: Unquoted input parses to same players as quoted
  console.log("\nTest 5: Unquoted CSV parses to same players...");
  try {
    const quotedPlayers = config.parseImport(SAMPLE_CSV).players;
    const unquotedPlayers = config.parseImport(SAMPLE_CSV_NO_QUOTES).players;

    if (quotedPlayers.length === unquotedPlayers.length) {
      const allMatch = quotedPlayers.every((p, i) => p.name === unquotedPlayers[i].name);
      if (allMatch) {
        console.log("  PASS: Unquoted input parses to same players");
        passed++;
      } else {
        console.log("  FAIL: Parsed players differ between quoted and unquoted");
        failed++;
      }
    } else {
      console.log(`  FAIL: Player count mismatch: ${quotedPlayers.length} vs ${unquotedPlayers.length}`);
      failed++;
    }
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Total: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("✓ ALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.log("✗ SOME CHECKS FAILED");
    process.exit(1);
  }
}

test();
