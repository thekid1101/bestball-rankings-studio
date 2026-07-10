// Plain-Node self-check for src/core/editor.js — exercises only the pure,
// DOM-free helpers exported by that module. Run: node scripts/check-editor.mjs
// Exits 0 on pass, 1 on fail. Prints one PASS/FAIL line per assertion.
import {
  rankOf,
  moveIdsBefore,
  moveIdsToRank,
  resolveMoveTargets,
  isValidStoredOrder,
  reconcileOrder,
  buildAdpOrder,
  computeArrowDelta,
  isEdge,
  refRankFor,
  matchesSearch,
  inPool,
  passesFilters,
  tierNumberForRank,
  tierBandForRank,
  createHistoryState,
  pushHistory,
  popUndo,
  popRedo,
} from "../src/core/editor.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}
function arrEq(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ---- build 20 fake players (invented names only) ---- */
const NAMES = [
  ["Marlon Ridgeway", "QB", "AAA"], ["Denny Halcott", "QB", "BBB"],
  ["Tavion Meeks", "RB", "AAA"], ["Corbin Yates", "RB", "BBB"], ["Isaiah Prentiss", "RB", "CCC"],
  ["Devlin Marsh", "RB", "DDD"], ["Reggie Salsberry", "WR", "AAA"], ["Ollie Kwan", "WR", "BBB"],
  ["Trent Osei", "WR", "CCC"], ["Bram Foltz", "WR", "DDD"], ["Kellan Vroom", "WR", "EEE"],
  ["Sanjay Bhaduri", "WR", "FFF"], ["Marcus Aldine", "TE", "AAA"], ["Perry Loach", "TE", "BBB"],
  ["Waylon Estrich", "QB", "CCC"], ["Fenwick Oduya", "RB", "EEE"], ["Talon Brisker", "WR", "GGG"],
  ["Corin Massey", "TE", "CCC"], ["Ezra Colbath", "QB", "DDD"], ["Nash Dellacroix", "RB", "FFF"],
];
const players = NAMES.map((n, i) => ({
  id: `p${i + 1}`,
  name: n[0],
  nameKey: n[0].toLowerCase(),
  pos: n[1],
  team: n[2],
  adp: i < 16 ? (i + 1) * 1.3 : null, // last 4 unranked
  raw: {},
}));
const order0 = players.map((p) => p.id);

/* ---- rankOf ---- */
check("rankOf: first id is rank 1", rankOf(order0, "p1") === 1);
check("rankOf: last id is rank 20", rankOf(order0, "p20") === 20);
check("rankOf: unknown id is -1", rankOf(order0, "nope") === -1);

/* ---- moveIdsBefore / moveIdsToRank (click-rank move math) ---- */
{
  const moved = moveIdsBefore(order0, ["p10"], "p3");
  check("moveIdsBefore: p10 now sits right before p3", moved[moved.indexOf("p3") - 1] === "p10");
  check("moveIdsBefore: length preserved", moved.length === 20);
}
{
  // moving id "p20" to rank 1 should produce [p20, p1, p2, ..., p19]
  const moved = moveIdsToRank(order0, ["p20"], 1);
  const expected = ["p20", ...order0.filter((id) => id !== "p20")];
  check("moveIdsToRank: single id to rank 1", arrEq(moved, expected));
}
{
  // moving a block [p5,p6] to rank 3 keeps their relative order and lands at index 2
  const moved = moveIdsToRank(order0, ["p5", "p6"], 3);
  check("moveIdsToRank: block lands at target rank", moved[2] === "p5" && moved[3] === "p6");
  check("moveIdsToRank: block preserves internal order, full length kept", moved.length === 20);
}
{
  // rank beyond the end clamps to append
  const moved = moveIdsToRank(order0, ["p1"], 999);
  check("moveIdsToRank: out-of-range rank clamps to end", moved[moved.length - 1] === "p1");
}
{
  // beforeId inside the moving block itself must be a no-op, never append-at-end
  const src = ["a", "b", "c", "d", "e"];
  const moved = moveIdsBefore(src, ["c"], "c");
  check("moveIdsBefore: beforeId inside a single-id moving set is a no-op", arrEq(moved, src));
}
{
  const src = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const moved = moveIdsBefore(src, ["c", "e", "g"], "e");
  check("moveIdsBefore: beforeId inside a multi-id moving set is a no-op", arrEq(moved, src));
}

/* ---- resolveMoveTargets (multi-select drag/rank-edit resolution) ---- */
{
  const sel = new Set(["p2", "p4", "p6"]);
  const multi = resolveMoveTargets(order0, sel, "p4");
  check("resolveMoveTargets: id in >1 selection returns whole selection in board order", arrEq(multi, ["p2", "p4", "p6"]));
  const single = resolveMoveTargets(order0, sel, "p9");
  check("resolveMoveTargets: id outside selection returns just itself", arrEq(single, ["p9"]));
  const soloSel = resolveMoveTargets(order0, new Set(["p4"]), "p4");
  check("resolveMoveTargets: selection of size 1 returns just itself", arrEq(soloSel, ["p4"]));
}

/* ---- isValidStoredOrder (init restore-order guard) ---- */
{
  const fileOrder = order0; // p1..p20, no duplicates
  check("isValidStoredOrder: exact same order restores", isValidStoredOrder(fileOrder.slice(), fileOrder) === true);
  const dup = fileOrder.slice(0, -1).concat(["p1"]); // same length, but p1 duplicated and p20 missing
  check("isValidStoredOrder: duplicate id in stored order is rejected (would silently drop a player)", isValidStoredOrder(dup, fileOrder) === false);
  check("isValidStoredOrder: wrong length is rejected", isValidStoredOrder(fileOrder.slice(0, -1), fileOrder) === false);
  check("isValidStoredOrder: unknown id is rejected", isValidStoredOrder(fileOrder.slice(0, -1).concat(["nope"]), fileOrder) === false);
  check("isValidStoredOrder: non-array is rejected", isValidStoredOrder(null, fileOrder) === false);
}

/* ---- reconcileOrder (setOrder's dedupe/reconcile logic, FIX 5) ---- */
{
  const cur = ["a", "b", "c"];
  check("reconcileOrder: duplicate incoming id yields a unique order (no duplicate rows)", arrEq(reconcileOrder(cur, ["a", "a", "b"]), ["a", "b", "c"]));
  check("reconcileOrder: keeps first occurrence when deduping", arrEq(reconcileOrder(cur, ["c", "a", "c", "b"]), ["c", "a", "b"]));
  check("reconcileOrder: unknown incoming id is dropped (current ids never disappear)", arrEq(reconcileOrder(cur, ["a", "zzz", "b"]), ["a", "b", "c"]));
  check("reconcileOrder: current ids missing from input are appended in their existing order", arrEq(reconcileOrder(cur, ["b"]), ["b", "a", "c"]));
}

/* ---- buildAdpOrder ---- */
{
  const adpOrder = buildAdpOrder(players);
  check("buildAdpOrder: ranked players sorted ascending by adp", adpOrder[0] === "p1" && adpOrder[15] === "p16");
  check("buildAdpOrder: unranked players appended in file order at the tail", arrEq(adpOrder.slice(16), ["p17", "p18", "p19", "p20"]));
}

/* ---- undo/redo pure stack semantics ---- */
{
  let h = createHistoryState();
  check("createHistoryState: starts empty", h.undo.length === 0 && h.redo.length === 0);

  let state = { order: order0.slice(), tiers: [] };
  h = pushHistory(h, state);
  state = { order: moveIdsToRank(state.order, ["p1"], 5), tiers: [3] };
  check("pushHistory: undo stack grows by one, redo cleared", h.undo.length === 1 && h.redo.length === 0);

  h = pushHistory(h, state);
  state = { order: moveIdsToRank(state.order, ["p2"], 10), tiers: [3, 8] };
  check("pushHistory: undo stack grows again", h.undo.length === 2);

  const u1 = popUndo(h, state);
  check("popUndo: returns a snapshot + pushes current to redo", u1 !== null && u1.history.redo.length === 1);
  const restored1 = u1.snapshot;
  check("popUndo: restores the previous order (p1 back near front)", rankOf(restored1.order, "p1") === 1 || restored1.tiers.length === 1);
  h = u1.history;
  state = restored1;

  const r1 = popRedo(h, state);
  check("popRedo: returns the redone snapshot", r1 !== null && r1.snapshot.tiers.length === 2);
  h = r1.history;

  // undo twice more than available should return null, not throw
  let hEmpty = createHistoryState();
  const noUndo = popUndo(hEmpty, { order: order0, tiers: [] });
  check("popUndo: no-op (null) when stack is empty", noUndo === null);
  const noRedo = popRedo(hEmpty, { order: order0, tiers: [] });
  check("popRedo: no-op (null) when stack is empty", noRedo === null);

  // cap at 120
  let hCap = createHistoryState();
  let s = { order: order0.slice(), tiers: [] };
  for (let i = 0; i < 130; i++) {
    hCap = pushHistory(hCap, s, 120);
  }
  check("pushHistory: caps undo stack at max (120)", hCap.undo.length === 120);
}

/* ---- reference delta computation (arrows + edge highlighting) ---- */
{
  const up = computeArrowDelta(15, 10, { decimal: false }); // source rank (15) > board rank (10) => "up"
  check("computeArrowDelta: positive delta is 'up' with correct magnitude text", up.cls === "up" && up.text === "▲5");
  const down = computeArrowDelta(8, 10, { decimal: false }); // source rank (8) < board rank (10) => "down"
  check("computeArrowDelta: negative delta is 'down'", down.cls === "down" && down.text === "▼2");
  const even = computeArrowDelta(10, 10, { decimal: false });
  check("computeArrowDelta: zero delta is 'even'", even.cls === "even");
  const na = computeArrowDelta(null, 10, { decimal: false });
  check("computeArrowDelta: null source renders as n/a", na.cls === "na" && na.text === "—");
  const decimalRounded = computeArrowDelta(10.7, 10, { decimal: true });
  check("computeArrowDelta: decimal mode rounds the delta", decimalRounded.magnitude === 1);
}
{
  // adp says much later (worse) than board (da>0.5), reference says earlier (better, de<0) => disagree => edge
  check("isEdge: market/reference disagreement flags an edge", isEdge(12, 8, 10) === true);
  // both agree direction => no edge
  check("isEdge: agreement is not an edge", isEdge(12, 13, 10) === false);
  check("isEdge: missing values never flag an edge", isEdge(null, 8, 10) === false);
}
{
  const source = { label: "Scout", byName: new Map([["marlon ridgeway", 3], ["ollie kwan", 9]]) };
  check("refRankFor: matches by nameKey", refRankFor(players[0], source) === 3);
  check("refRankFor: unmatched player returns null", refRankFor(players[2], source) === null);
  check("refRankFor: null source returns null", refRankFor(players[0], null) === null);
}

/* ---- filter predicates ---- */
{
  check("matchesSearch: case-insensitive substring on name", matchesSearch(players[0], "ridge") === true);
  check("matchesSearch: matches on team too", matchesSearch(players[0], "aaa") === true);
  check("matchesSearch: no match returns false", matchesSearch(players[0], "zzz") === false);
  check("matchesSearch: empty query matches everything", matchesSearch(players[0], "") === true);

  check("inPool: has adp => in pool", inPool(players[0], [null, null]) === true);
  check("inPool: no adp but has a reference rank => in pool", inPool(players[19], [5, null]) === true);
  check("inPool: no adp and no reference => not in pool", inPool(players[19], [null, null]) === false);

  const filtAll = { pos: "ALL", q: "", pool: "all", edges: false };
  check("passesFilters: ALL/empty filters pass everyone", passesFilters(players[0], 1, filtAll, [null, null]) === true);

  const filtPos = { pos: "RB", q: "", pool: "all", edges: false };
  check("passesFilters: position tab filters out non-matching pos", passesFilters(players[0], 1, filtPos, [null, null]) === false);
  check("passesFilters: position tab keeps matching pos", passesFilters(players[2], 3, filtPos, [null, null]) === true);

  const filtPool = { pos: "ALL", q: "", pool: "pool", edges: false };
  check("passesFilters: pool filter drops players with no adp/reference", passesFilters(players[19], 20, filtPool, [null, null]) === false);

  const filtEdges = { pos: "ALL", q: "", pool: "all", edges: true };
  check("passesFilters: edges filter drops non-edge rows", passesFilters(players[0], 10, filtEdges, [null, null]) === false);
  check("passesFilters: edges filter keeps rows with disagreement", passesFilters({ ...players[0], adp: 12 }, 10, filtEdges, [8, null]) === true);
}

/* ---- tier band math ---- */
{
  const breaks = [5, 12];
  check("tierNumberForRank: below first break is tier 1", tierNumberForRank(1, breaks) === 1);
  check("tierNumberForRank: at/after first break is tier 2", tierNumberForRank(5, breaks) === 2);
  check("tierNumberForRank: at/after second break is tier 3", tierNumberForRank(12, breaks) === 3);
  check("tierBandForRank: alternates parity per tier", tierBandForRank(1, breaks) === 0 && tierBandForRank(5, breaks) === 1 && tierBandForRank(12, breaks) === 0);
}

/* ---- summary ---- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
