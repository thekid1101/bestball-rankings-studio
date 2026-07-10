import underdogConfig from "../src/platforms/underdog.js";
import { normalizeName } from "../src/core/normalize.js";

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `Expected "${expected}", got "${actual}"`
    );
  }
}

// Test 1: Parse a minimal CSV with quoted fields containing commas
test("Parse CSV with quoted comma", () => {
  const csv =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '123,John,"Doe, Jr.",5,10.5,5000,RB1,RB,NYG,",active",5\n';

  const result = underdogConfig.parseImport(csv);
  assert(result.players.length === 1, "Should parse 1 player");
  const p = result.players[0];
  assertEqual(p.name, "John Doe, Jr.", "Should handle quoted field with comma");
  assertEqual(p.adp, 5, "Should parse ADP as number");
  assertEqual(p.pos, "RB", "Should uppercase position");
});

// Test 2: Parse with missing columns and defaults
test("Parse with missing columns and defaults", () => {
  const csv =
    'firstName,lastName,adp\n' +
    'Jane,Smith,\n' + // adp is blank -> "-"
    'Bob,Jones,-\n'; // adp is "-" -> null

  const result = underdogConfig.parseImport(csv);
  assert(result.players.length === 2, "Should parse 2 players");
  const p1 = result.players[0];
  assert(p1.adp === null, "Blank ADP should be null");
  const p2 = result.players[1];
  assert(p2.adp === null, "'-' ADP should be null");
});

// Test 3: Round-trip with "keep" mode - byte-faithful (header AND data quoted as per esc())
test("Round-trip with keep mode preserves byte-fidelity", () => {
  const original =
    '"id","firstName","lastName","adp","projectedPoints","salary","positionRank","slotName","teamName","lineupStatus","byeWeek"\n' +
    '"101","Tom","Brady","1","25.0","8000","QB1","QB","TB","active","6"\n' +
    '"102","Derrick","Henry","5","22.0","7500","RB1","RB","TEN","active","7"';

  const parsed = underdogConfig.parseImport(original);
  const serialized = underdogConfig.serializeExport(parsed.players, {
    adpWrite: "keep",
  });

  assertEqual(serialized, original, "Keep mode should round-trip exactly");
});

// Test 3b: Aliased/differently-cased headers must still keep-mode export with
// all fields intact under the canonical quoted header (nothing blanked)
test("Keep mode export uses canonical header even with aliased upload headers", () => {
  const aliased =
    'ID,FirstName,LastName,ADP,ProjectedPoints,Salary,PositionRank,SlotName,TeamName,LineupStatus,ByeWeek\n' +
    '901,Wendell,Hackett,4,19.5,6200,WR1,WR,DAL,active,9\n';

  const expected =
    '"id","firstName","lastName","adp","projectedPoints","salary","positionRank","slotName","teamName","lineupStatus","byeWeek"\n' +
    '"901","Wendell","Hackett","4","19.5","6200","WR1","WR","DAL","active","9"';

  const parsed = underdogConfig.parseImport(aliased);
  const serialized = underdogConfig.serializeExport(parsed.players, {
    adpWrite: "keep",
  });

  assertEqual(
    serialized,
    expected,
    "Keep mode should map aliased headers to canonical columns without blanking values"
  );
});

// Test 3c: Missing salary/projectedPoints columns get the source's defaults
// ("1" and "0.0") baked in at parse time, applied in keep-mode export
test("Missing salary/projectedPoints columns default to 1 and 0.0", () => {
  const csv =
    'id,firstName,lastName,adp,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '911,Dez,Fontaine,7,WR2,WR,SEA,active,11\n';

  const expected =
    '"id","firstName","lastName","adp","projectedPoints","salary","positionRank","slotName","teamName","lineupStatus","byeWeek"\n' +
    '"911","Dez","Fontaine","7","0.0","1","WR2","WR","SEA","active","11"';

  const parsed = underdogConfig.parseImport(csv);
  const serialized = underdogConfig.serializeExport(parsed.players, {
    adpWrite: "keep",
  });

  assertEqual(
    serialized,
    expected,
    "Missing salary/projectedPoints should default to 1/0.0 in keep-mode export"
  );
});

// Test 4: "renumber" mode produces sequential ADP and position counters
test("Renumber mode: sequential ADP and position counters", () => {
  const csv =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '"201","Patrick","Mahomes","3","28.0","9000","QB1","QB","KC","active",""\n' +
    '"202","Travis","Kelce","10","20.0","8000","TE1","TE","KC","active",""\n' +
    '"203","Lamar","Jackson","2","27.0","8500","QB2","QB","BAL","active",""';

  const parsed = underdogConfig.parseImport(csv);
  const reordered = [parsed.players[2], parsed.players[0], parsed.players[1]]; // reorder by position
  const serialized = underdogConfig.serializeExport(reordered, {
    adpWrite: "renumber",
    keepDash: false,
  });

  const lines = serialized.split("\n");
  assert(lines.length === 4, "Should have header + 3 data rows");

  // Row 1 (Lamar Jackson): adp should be "1", positionRank should be "QB1"
  assert(
    lines[1].includes(',"1",') && lines[1].includes(',"QB1",'),
    "Row 1 should have adp=1 and positionRank=QB1"
  );

  // Row 2 (Patrick Mahomes): adp should be "2", positionRank should be "QB2"
  assert(
    lines[2].includes(',"2",') && lines[2].includes(',"QB2",'),
    "Row 2 should have adp=2 and positionRank=QB2"
  );

  // Row 3 (Travis Kelce): adp should be "3", positionRank should be "TE1"
  assert(
    lines[3].includes(',"3",') && lines[3].includes(',"TE1",'),
    "Row 3 should have adp=3 and positionRank=TE1"
  );
});

// Test 5: keepDash mode blanks players beyond original ranked count
test("keepDash: blanks players beyond original ranked count", () => {
  const csv =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '"301","Player","One","1","20.0","5000","","","","",""\n' +
    '"302","Player","Two","2","19.0","5000","","","","",""\n' +
    '"303","Player","Three","-","18.0","5000","","","","",""\n' +
    '"304","Player","Four","-","17.0","5000","","","","",""';

  const parsed = underdogConfig.parseImport(csv);
  // Reorder: keep in order
  const reordered = [
    parsed.players[0],
    parsed.players[1],
    parsed.players[2],
    parsed.players[3],
  ];
  const serialized = underdogConfig.serializeExport(reordered, {
    adpWrite: "renumber",
    keepDash: true,
  });

  const lines = serialized.split("\n");
  // Players 1,2 should have adp 1,2
  assert(lines[1].includes(',"1",'), "Row 1 should have adp=1");
  assert(lines[2].includes(',"2",'), "Row 2 should have adp=2");
  // Players 3,4 should have adp="-" (quoted)
  assert(
    lines[3].includes('"-"') && lines[3].split(',')[6] === '',
    "Row 3 should have adp=\"-\" and blank positionRank"
  );
  assert(
    lines[4].includes('"-"') && lines[4].split(',')[6] === '',
    "Row 4 should have adp=\"-\" and blank positionRank"
  );
});

// Test 6: normalizeAdpToSlot returns the adp value
test("normalizeAdpToSlot returns ADP", () => {
  const player = { adp: 10 };
  assertEqual(
    underdogConfig.normalizeAdpToSlot(player),
    10,
    "Should return ADP value"
  );

  const unranked = { adp: null };
  assert(
    underdogConfig.normalizeAdpToSlot(unranked) === null,
    "Should return null for unranked"
  );
});

// Test 7: Case-insensitive header aliases
test("Case-insensitive header aliases", () => {
  const csv =
    'FIRSTNAME,LASTNAME,ADP,projectedPoints,Salary,positionRank,SlotName,TeamName,ID\n' +
    'Kirk,Cousins,8,18.5,6000,QB1,QB,MIN,401\n';

  const result = underdogConfig.parseImport(csv);
  assert(result.players.length === 1, "Should parse despite mixed-case header");
  const p = result.players[0];
  assertEqual(p.name, "Kirk Cousins", "Should parse despite mixed-case header");
  assertEqual(p.pos, "QB", "Should parse position from mixed-case header");
});

// Test 8: Line ending flexibility (\r\n, \r, \n)
test("Line ending flexibility", () => {
  const csvCrlf =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\r\n' +
    '501,A,B,1,10,1000,,,,\r\n';
  const csvLf =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '501,A,B,1,10,1000,,,,\n';
  const csvCr =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\r' +
    '501,A,B,1,10,1000,,,,\r';

  const r1 = underdogConfig.parseImport(csvCrlf);
  const r2 = underdogConfig.parseImport(csvLf);
  const r3 = underdogConfig.parseImport(csvCr);

  assert(r1.players.length === 1, "Should handle CRLF");
  assert(r2.players.length === 1, "Should handle LF");
  assert(r3.players.length === 1, "Should handle CR");
});

// Test 9: keepDash respects the boundary of originally-ranked players
test("keepDash respects ranked boundary", () => {
  const csv =
    'id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek\n' +
    '"701","Ranked","One","1","20.0","5000","","","","",""\n' +
    '"702","Ranked","Two","2","19.0","5000","","","","",""\n' +
    '"703","Unranked","Deep","-","15.0","5000","","","","",""';

  const parsed = underdogConfig.parseImport(csv);
  // Reorder: keep ranked players first, unranked at end
  const reordered = [parsed.players[0], parsed.players[1], parsed.players[2]];
  const serialized = underdogConfig.serializeExport(reordered, {
    adpWrite: "renumber",
    keepDash: true,
  });

  const lines = serialized.split("\n");
  // Ranked players get renumbered
  assert(lines[1].includes(',"1",'), "Player 1 should have adp=1");
  assert(lines[2].includes(',"2",'), "Player 2 should have adp=2");
  // Unranked player at end gets dashed
  assert(
    lines[3].includes('"-"') && lines[3].split(',')[6] === '',
    "Unranked player should have adp=\"-\" and blank positionRank"
  );
});

// Summary
console.log("\n---");
console.log(`${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
