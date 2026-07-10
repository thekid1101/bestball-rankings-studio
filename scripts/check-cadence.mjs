// scripts/check-cadence.mjs
// Plain-node self-check for src/core/cadence.js. No test framework, no Math.random
// (seeded mulberry32 PRNG for reproducibility). Run: node scripts/check-cadence.mjs

import { computeCadence, CADENCE_DEFAULTS } from "../src/core/cadence.js";

let failures = 0;
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function fail(msg) {
  failures++;
  console.log(`FAIL: ${msg}`);
}
function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

// ---------- seeded PRNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- synthetic 60-player board ----------
// Interleaved pattern (per 10): RB,WR,RB,WR,QB,RB,WR,TE,RB,WR -> 24 RB, 24 WR, 6 QB, 6 TE.
const PATTERN = ["RB", "WR", "RB", "WR", "QB", "RB", "WR", "TE", "RB", "WR"];
const BOARD_SIZE = 60;

function buildPlayers(rng) {
  const players = new Map();
  const ids = [];
  for (let i = 1; i <= BOARD_SIZE; i++) {
    const id = `p${i}`;
    const pos = PATTERN[(i - 1) % PATTERN.length];
    // adpSlot / refRank: noisy around boardRank i, sometimes null.
    const hasAdp = rng() > 0.15;
    const hasRef = rng() > 0.15;
    const adpSlot = hasAdp ? Math.max(1, i + Math.round((rng() - 0.5) * 20)) : null;
    const refRank = hasRef ? Math.max(1, i + Math.round((rng() - 0.5) * 20)) : null;
    players.set(id, { id, name: `Player ${i}`, pos, adpSlot, refRank });
    ids.push(id);
  }
  return { players, ids };
}

function posSeq(order, players, pos) {
  return order.filter((id) => players.get(id).pos === pos);
}

function paramsFor(rng, order) {
  return {
    lamQB: rng(),
    lamTE: rng(),
    w: rng(),
    cap: rng() > 0.2 ? order.length : Math.floor(rng() * order.length),
    adpSlotOf: (p) => p.adpSlot,
    refRankOf: (p) => p.refRank,
  };
}

// ---------- Test 1 + 2: invariant across 200 randomized trials ----------
const TRIALS = 200;
let invariantFailures = 0;
let rbWrFailures = 0;
for (let trial = 0; trial < TRIALS; trial++) {
  const rng = mulberry32(1000 + trial);
  const { players, ids } = buildPlayers(rng);
  const order = shuffle(ids, rng);
  const params = paramsFor(rng, order);

  const { newOrder } = computeCadence({ order, players, params });

  // newOrder must be a permutation of order
  if (newOrder.length !== order.length || new Set(newOrder).size !== order.length) {
    invariantFailures++;
    continue;
  }

  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const before = posSeq(order, players, pos);
    const after = posSeq(newOrder, players, pos);
    const same = before.length === after.length && before.every((id, i) => id === after[i]);
    if (!same) {
      invariantFailures++;
      if (pos === "RB" || pos === "WR") rbWrFailures++;
      break;
    }
  }
}
assert(invariantFailures === 0, `within-position order invariant holds across ${TRIALS} randomized trials (${invariantFailures} failures)`);
assert(rbWrFailures === 0, `RB/WR relative order unchanged across ${TRIALS} randomized trials (${rbWrFailures} failures)`);

// ---------- Test 3: a behind-market QB moves up; an at/ahead-of-anchor QB doesn't move down ----------
{
  // Isolated scenario: single QB, no TE, rest RB/WR — avoids inter-QB interaction effects.
  const players = new Map();
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const id = `s${i}`;
    const pos = i % 2 === 0 ? "RB" : "WR";
    players.set(id, { id, pos, adpSlot: null, refRank: null });
    ids.push(id);
  }
  // Behind-market QB: boardRank 15, anchor ~5 (far ahead of its board position -> should move up).
  players.set("qbBehind", { id: "qbBehind", pos: "QB", adpSlot: 5, refRank: 5 });
  const orderBehind = [...ids.slice(0, 14), "qbBehind", ...ids.slice(14)]; // boardRank 15
  const resBehind = computeCadence({
    order: orderBehind,
    players,
    params: { lamQB: 1, lamTE: 0.65, w: 0.7, cap: orderBehind.length, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const beforeRankBehind = orderBehind.indexOf("qbBehind") + 1;
  const afterRankBehind = resBehind.newOrder.indexOf("qbBehind") + 1;
  assert(afterRankBehind < beforeRankBehind, `behind-market QB moves up (before=${beforeRankBehind}, after=${afterRankBehind})`);

  // At/ahead-of-anchor QB: boardRank 3, anchor 10 (boardRank <= anchor -> pull=0 -> must not move down).
  const players2 = new Map(players);
  players2.delete("qbBehind");
  players2.set("qbAhead", { id: "qbAhead", pos: "QB", adpSlot: 10, refRank: 10 });
  const orderAhead = ["qbAhead", ...ids.slice(0, 19)]; // boardRank 1, far ahead of anchor 10
  const resAhead = computeCadence({
    order: orderAhead,
    players: players2,
    params: { lamQB: 1, lamTE: 0.65, w: 0.7, cap: orderAhead.length, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const beforeRankAhead = orderAhead.indexOf("qbAhead") + 1;
  const afterRankAhead = resAhead.newOrder.indexOf("qbAhead") + 1;
  assert(afterRankAhead <= beforeRankAhead, `at/ahead-of-anchor QB doesn't move down (before=${beforeRankAhead}, after=${afterRankAhead})`);
}

// ---------- Test 4: lam=0 -> newOrder identical to input ----------
{
  const rng = mulberry32(999);
  const { players, ids } = buildPlayers(rng);
  const order = shuffle(ids, rng);
  const { newOrder, moves } = computeCadence({
    order,
    players,
    params: { lamQB: 0, lamTE: 0, w: 0.7, cap: order.length, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const identical = order.every((id, i) => id === newOrder[i]);
  assert(identical, "lam=0 (QB and TE) leaves newOrder identical to input order");
  assert(moves.length === 0, "lam=0 produces zero moves");
}

// ---------- Test 5: cap excludes deeper players (gate is on anchor <= cap, per reference source) ----------
{
  const players = new Map();
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const id = `d${i}`;
    const pos = i % 2 === 0 ? "RB" : "WR";
    players.set(id, { id, pos, adpSlot: null, refRank: null });
    ids.push(id);
  }
  // QB at boardRank 15, anchor 5 (behind market -> eligible for a big pull, IF its
  // anchor clears the cap gate). cap=3 -> anchor(5) > cap(3) -> excluded, pull must be 0.
  players.set("qbDeep", { id: "qbDeep", pos: "QB", adpSlot: 5, refRank: 5 });
  const order = [...ids.slice(0, 14), "qbDeep", ...ids.slice(14)];
  const res = computeCadence({
    order,
    players,
    params: { lamQB: 1, lamTE: 1, w: 0.7, cap: 3, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const beforeRank = order.indexOf("qbDeep") + 1;
  const afterRank = res.newOrder.indexOf("qbDeep") + 1;
  assert(afterRank === beforeRank, `cap excludes players whose anchor exceeds cap (qbDeep stays at rank ${beforeRank})`);

  // Same player, cap raised to clear anchor 5 -> should now be pulled up.
  const res2 = computeCadence({
    order,
    players,
    params: { lamQB: 1, lamTE: 1, w: 0.7, cap: 10, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const afterRank2 = res2.newOrder.indexOf("qbDeep") + 1;
  assert(afterRank2 < beforeRank, `raising cap above anchor re-enables the pull (before=${beforeRank}, after=${afterRank2})`);
}

// ---------- Test 6: CADENCE_DEFAULTS sanity + perPosition/moves shape ----------
{
  assert(
    CADENCE_DEFAULTS.lamQB === 0.65 && CADENCE_DEFAULTS.lamTE === 0.65 && CADENCE_DEFAULTS.w === 0.7,
    "CADENCE_DEFAULTS matches contract {lamQB:0.65, lamTE:0.65, w:0.7}"
  );

  const rng = mulberry32(42);
  const { players, ids } = buildPlayers(rng);
  const order = shuffle(ids, rng);
  const res = computeCadence({
    order,
    players,
    params: { ...CADENCE_DEFAULTS, cap: order.length, adpSlotOf: (p) => p.adpSlot, refRankOf: (p) => p.refRank },
  });
  const qbCount = ids.filter((id) => players.get(id).pos === "QB").length;
  const teCount = ids.filter((id) => players.get(id).pos === "TE").length;
  assert(res.perPosition.QB.length === qbCount, `perPosition.QB lists all ${qbCount} QBs`);
  assert(res.perPosition.TE.length === teCount, `perPosition.TE lists all ${teCount} TEs`);
  assert(
    res.perPosition.QB.every((m) => typeof m.id === "string" && typeof m.before === "number" && typeof m.after === "number"),
    "perPosition.QB entries have {id, before, after}"
  );
  assert(
    res.moves.every((m) => typeof m.id === "string" && typeof m.from === "number" && typeof m.to === "number" && m.from !== m.to),
    "moves entries have {id, from, to} and only include players whose rank actually changed"
  );
}

console.log("");
if (failures === 0) {
  console.log(`ALL PASS (0 failures)`);
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
