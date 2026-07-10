// Self-check for src/core/references.js (contract C4). Plain node, no deps.
// All player/ranking names below are INVENTED for testing only.
import { parseReferenceText, buildReferenceSource } from "../src/core/references.js";
import { normalizeName } from "../src/core/normalize.js";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

// ---------------------------------------------------------------------
// Fake 30-player pool (invented names). Includes:
//  - a name-collision pair distinguished by pos ("Marcus Green" WR vs TE)
//  - a suffix case ("Michael Johnson Jr.")
//  - an apostrophe/hyphen case ("Dre'Quan Ashford-Bell")
//  - a diacritic case ("José Álvarez")
//  - plenty of names that never appear in any reference list (unreferenced)
// ---------------------------------------------------------------------
const rawPool = [
  ["Trevin Ashworth", "QB", "JAX"],
  ["Dre'Quan Ashford-Bell", "QB", "LAC"],
  ["Marcus Green", "WR", "CHI"],
  ["Marcus Green", "TE", "DAL"],
  ["Michael Johnson Jr.", "RB", "NYG"],
  ["José Álvarez", "WR", "MIA"],
  ["Tobias Renner", "RB", "SEA"],
  ["Quinlan Ferro", "WR", "ATL"],
  ["Bryson Okafor", "TE", "PHI"],
  ["Declan Vasquez", "WR", "DEN"],
  ["Marlowe Ibekwe", "RB", "HOU"],
  ["Soren Kalb", "QB", "MIN"],
  ["Roman Delacroix", "WR", "Las Vegas Raiders"],
  ["Xavier Thorncastle", "RB", "Green Bay Packers"],
  ["Nikolai Osei", "TE", "Buffalo Bills"],
  ["Corbin Whitlock", "WR", "NO"],
  ["Elias Marchetti", "RB", "TEN"],
  ["Griffin Solano", "QB", "ARI"],
  ["Weston Ndiaye", "WR", "KC"],
  ["Callum Brixton", "TE", "LAC"],
  ["Dashiell Okonkwo", "RB", "IND"],
  ["Percy Aldemar", "WR", "CLE"],
  ["Tremaine Vosberg", "QB", "NYJ"],
  ["Ezequiel Handley", "RB", "CAR"],
  ["Milo Castellane", "WR", "TB"],
  ["Bramwell Osei", "TE", "SF"],
  ["Fenwick Duarte", "RB", "LAR"],
  ["Sylas Kimathi", "WR", "PIT"],
  ["Anaya Whitcombe", "TE", "BAL"],
  ["North Prescott", "K", "DET"],
];
const players = rawPool.map(([name, pos, team], i) => ({
  id: `p${i + 1}`,
  name,
  nameKey: normalizeName(name),
  pos,
  team,
  adp: null,
  raw: {},
}));
assert(players.length === 30, `pool should have 30 players, got ${players.length}`);

// ---------------------------------------------------------------------
// Fixture 1: header CSV, alias headers (Rk/Name/Position/Tm instead of the
// literal Rank/Player/Pos/Team), RFC-4180 quoting (embedded comma + escaped
// quote), and a couple of names absent from the pool.
// ---------------------------------------------------------------------
const csvText = [
  "Rk,Name,Position,Tm",
  "1,Trevin Ashworth,QB,JAX",
  "2,Marcus Green,TE,DAL",
  "3,Michael Johnson,RB,NYG",
  "4,Jose Alvarez,WR,MIA",
  '5,"Nickname ""Ghost"" Rivers",WR,ZZZ',
  '6,"Faux Player, Esquire",WR,ZZZ',
].join("\n");

const csvParsed = parseReferenceText(csvText);
assertEqual(csvParsed.format, "csv", "csv fixture format detection");
assertEqual(csvParsed.entries.length, 6, "csv fixture entry count");
assertEqual(csvParsed.entries[0], { name: "Trevin Ashworth", rank: 1, pos: "QB", team: "JAX" }, "csv entry 0");
assertEqual(csvParsed.entries[4], { name: 'Nickname "Ghost" Rivers', rank: 5, pos: "WR", team: "ZZZ" }, "csv escaped-quote entry");
assertEqual(csvParsed.entries[5], { name: "Faux Player, Esquire", rank: 6, pos: "WR", team: "ZZZ" }, "csv embedded-comma entry");

const csvBuild = buildReferenceSource("CSV Source", csvParsed.entries, players);
assertEqual(csvBuild.report.total, 6, "csv report.total");
assertEqual(csvBuild.report.matched, 4, "csv report.matched");
assertEqual(
  csvBuild.report.unmatched,
  [
    { name: 'Nickname "Ghost" Rivers', rank: 5 },
    { name: "Faux Player, Esquire", rank: 6 },
  ],
  "csv report.unmatched"
);
assert(csvBuild.source.label === "CSV Source", "csv source label");
assertEqual(csvBuild.source.byName.get(normalizeName("Trevin Ashworth")), 1, "csv byName Trevin Ashworth");
// collision pair resolved by pos (Position=TE -> the TE Marcus Green)
assertEqual(csvBuild.source.byName.get(normalizeName("Marcus Green")), 2, "csv byName Marcus Green (collision, pos-resolved)");
// suffix case: "Michael Johnson" (entry) matches pool's "Michael Johnson Jr."
assertEqual(csvBuild.source.byName.get(normalizeName("Michael Johnson Jr.")), 3, "csv byName suffix match");
// diacritic case: "Jose Alvarez" (entry, no accent) matches pool's "José Álvarez"
assertEqual(csvBuild.source.byName.get(normalizeName("José Álvarez")), 4, "csv byName diacritic match");

// CSV with no rank column -> line order used as rank.
const csvNoRank = ["Player,Pos", "Roman Delacroix,WR", "Xavier Thorncastle,RB"].join("\n");
const csvNoRankParsed = parseReferenceText(csvNoRank);
assertEqual(csvNoRankParsed.format, "csv", "csv-no-rank format detection");
assertEqual(
  csvNoRankParsed.entries,
  [
    { name: "Roman Delacroix", rank: 1, pos: "WR" },
    { name: "Xavier Thorncastle", rank: 2, pos: "RB" },
  ],
  "csv-no-rank uses line order"
);

// "#" rank alias.
const csvHashRank = ["#,Player", "1,Roman Delacroix"].join("\n");
assertEqual(parseReferenceText(csvHashRank).format, "csv", "# alias detected as csv");
assertEqual(parseReferenceText(csvHashRank).entries[0].rank, 1, "# alias rank parsed");

// ---------------------------------------------------------------------
// Fixture 2: numbered list, "1." / "2)" / "3 " variants, trailing POS/TEAM
// tokens, and one line with no pos/team suffix (must not eat plain words).
// ---------------------------------------------------------------------
const numberedText = [
  "1. Dre'Quan Ashford-Bell QB LAC",
  "2) Tobias Renner RB SEA",
  "3 Quinlan Ferro WR ATL",
  "4. Bryson Okafor TE PHI",
  "5. Ghost Nobody",
].join("\n");

const numberedParsed = parseReferenceText(numberedText);
assertEqual(numberedParsed.format, "numbered", "numbered fixture format detection");
assertEqual(numberedParsed.entries.length, 5, "numbered fixture entry count");
assertEqual(numberedParsed.entries[0], { name: "Dre'Quan Ashford-Bell", rank: 1, pos: "QB", team: "LAC" }, "numbered entry 0 ('1.' style)");
assertEqual(numberedParsed.entries[1], { name: "Tobias Renner", rank: 2, pos: "RB", team: "SEA" }, "numbered entry 1 ('2)' style)");
assertEqual(numberedParsed.entries[2], { name: "Quinlan Ferro", rank: 3, pos: "WR", team: "ATL" }, "numbered entry 2 ('3 ' style)");
assertEqual(numberedParsed.entries[4], { name: "Ghost Nobody", rank: 5 }, "numbered entry with no pos/team suffix stays intact");

const numberedBuild = buildReferenceSource("Numbered Source", numberedParsed.entries, players);
assertEqual(numberedBuild.report, { matched: 4, total: 5, unmatched: [{ name: "Ghost Nobody", rank: 5 }] }, "numbered report exact");
assertEqual(numberedBuild.source.byName.get(normalizeName("Dre'Quan Ashford-Bell")), 1, "numbered byName apostrophe/hyphen match");

// Fixture 2b: numbered list edge cases (non-whitelist team token, name suffixes)
const numberedEdgeCases = [
  "3. Alex NG",
  "4. Kenneth Walker III",
  "5. Sample Player TE LAC",
].join("\n");

const numberedEdgeParsed = parseReferenceText(numberedEdgeCases);
assertEqual(numberedEdgeParsed.format, "numbered", "numbered edge cases format detection");
assertEqual(numberedEdgeParsed.entries.length, 3, "numbered edge cases entry count");
assertEqual(numberedEdgeParsed.entries[0], { name: "Alex NG", rank: 3 }, "numbered edge case: non-whitelist 'NG' stays on name");
assert(!numberedEdgeParsed.entries[0].team, "numbered edge case: 'NG' is not a valid team, so no team field");
assertEqual(numberedEdgeParsed.entries[1], { name: "Kenneth Walker III", rank: 4 }, "numbered edge case: suffix 'III' stays on name");
assert(!numberedEdgeParsed.entries[1].team, "numbered edge case: 'III' is a suffix, excluded from team/pos parsing");
assert(!numberedEdgeParsed.entries[1].pos, "numbered edge case: 'III' suffix does not create pos field");
assertEqual(numberedEdgeParsed.entries[2], { name: "Sample Player", rank: 5, pos: "TE", team: "LAC" }, "numbered edge case: valid pos/team still works");

// ---------------------------------------------------------------------
// Fixture 3: bare one-name-per-line list.
// ---------------------------------------------------------------------
const bareText = ["Roman Delacroix", "Xavier Thorncastle", "Nikolai Osei", "Zzyzx Unknownperson", "Corbin Whitlock"].join("\n");
const bareParsed = parseReferenceText(bareText);
assertEqual(bareParsed.format, "bare", "bare fixture format detection");
assertEqual(
  bareParsed.entries,
  [
    { name: "Roman Delacroix", rank: 1 },
    { name: "Xavier Thorncastle", rank: 2 },
    { name: "Nikolai Osei", rank: 3 },
    { name: "Zzyzx Unknownperson", rank: 4 },
    { name: "Corbin Whitlock", rank: 5 },
  ],
  "bare entries use line order as rank"
);

const bareBuild = buildReferenceSource("Bare Source", bareParsed.entries, players);
assertEqual(bareBuild.report, { matched: 4, total: 5, unmatched: [{ name: "Zzyzx Unknownperson", rank: 4 }] }, "bare report exact");
// team given as full name in pool ("Las Vegas Raiders") vs abbreviation-free entry still matches by name.
assertEqual(bareBuild.source.byName.get(normalizeName("Roman Delacroix")), 1, "bare byName full-team-name player still matches by name");

// ---------------------------------------------------------------------
// Blank/junk-line skipping across all formats.
// ---------------------------------------------------------------------
const junkyBare = "\n\n   \nRoman Delacroix\n---\n\nCorbin Whitlock\n42\n";
const junkyParsed = parseReferenceText(junkyBare);
assertEqual(junkyParsed.format, "bare", "junky text still detected as bare");
assertEqual(
  junkyParsed.entries,
  [
    { name: "Roman Delacroix", rank: 1 },
    { name: "Corbin Whitlock", rank: 2 },
  ],
  "blank + letterless junk lines skipped"
);

// ---------------------------------------------------------------------
// Collision resolution: pos match, team match, and no-info fallback all
// succeed (matched, not unmatched) and never throw.
// ---------------------------------------------------------------------
const collisionByPos = buildReferenceSource("X", [{ name: "Marcus Green", rank: 10, pos: "WR" }], players);
assertEqual(collisionByPos.report, { matched: 1, total: 1, unmatched: [] }, "collision resolved by pos: matched");
assertEqual(collisionByPos.source.byName.get(normalizeName("Marcus Green")), 10, "collision resolved by pos: rank stored");

const collisionByTeam = buildReferenceSource("X", [{ name: "Marcus Green", rank: 11, team: "Dallas" }], players);
assertEqual(collisionByTeam.report, { matched: 1, total: 1, unmatched: [] }, "collision resolved by loose team match: matched");

const collisionFallback = buildReferenceSource("X", [{ name: "Marcus Green", rank: 12 }], players);
assertEqual(collisionFallback.report, { matched: 1, total: 1, unmatched: [] }, "collision fallback (no pos/team info): still matched, no throw");

// ---------------------------------------------------------------------
// Duplicate entries for the same name: first (better rank) wins in byName,
// but both still count as matched.
// ---------------------------------------------------------------------
const dupeEntries = [
  { name: "Trevin Ashworth", rank: 1 },
  { name: "Trevin Ashworth", rank: 99 },
];
const dupeBuild = buildReferenceSource("X", dupeEntries, players);
assertEqual(dupeBuild.report, { matched: 2, total: 2, unmatched: [] }, "duplicate entries both counted matched");
assertEqual(dupeBuild.source.byName.get(normalizeName("Trevin Ashworth")), 1, "duplicate entries: first (better) rank wins");
assertEqual(dupeBuild.source.byName.size, 1, "duplicate entries collapse to one byName key");

// ---------------------------------------------------------------------
// Empty input.
// ---------------------------------------------------------------------
const emptyParsed = parseReferenceText("");
assertEqual(emptyParsed, { entries: [], format: "bare" }, "empty text -> no entries");
const emptyBuild = buildReferenceSource("X", [], players);
assertEqual(emptyBuild.report, { matched: 0, total: 0, unmatched: [] }, "empty entries -> empty report");

// ---------------------------------------------------------------------
if (failures === 0) {
  console.log("PASS: all reference importer/matcher checks passed");
  process.exit(0);
} else {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
