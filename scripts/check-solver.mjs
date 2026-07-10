// scripts/check-solver.mjs
// Plain-node self-check for src/core/solver.js (reverse solver). Synthetic,
// invented player pool only. Run: node scripts/check-solver.mjs

import { solveTargets, diffOrders, SOLVER_DEFAULTS } from "../src/core/solver.js";
import { runSimulation } from "../src/core/simulator.js";

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

// ---------------------------------------------------------------- synthetic pool

const TEAM_ABBRS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
  "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
];

// 250 invented players, positions interleaved by a deterministic weighted
// round-robin (QB40/RB80/WR100/TE30), ADP 1..250 in order.
function buildPool() {
  const weights = { QB: 40, RB: 80, WR: 100, TE: 30 };
  const remaining = { ...weights };
  const players = [];
  for (let i = 0; i < 250; i++) {
    let bestPos = null;
    let bestScore = -Infinity;
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      if (remaining[pos] <= 0) continue;
      const score = remaining[pos] / weights[pos];
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
    remaining[bestPos]--;
    players.push({
      id: `syn_${i}_${bestPos}`,
      name: `Synthetic Player ${i}`,
      nameKey: `synthetic player ${i}`,
      pos: bestPos,
      team: TEAM_ABBRS[i % TEAM_ABBRS.length],
      adp: i + 1,
      raw: {},
    });
  }
  return players;
}

const POOL = buildPool();
const DEFAULT_ORDER = POOL.map((p) => p.id);

const SCHEDULE = {
  15: [["DAL", "PHI"], ["SF", "SEA"], ["KC", "BUF"], ["GB", "CHI"], ["BAL", "PIT"], ["MIA", "NE"], ["LAR", "ARI"], ["CIN", "CLE"]],
  16: [["PHI", "DAL"], ["SEA", "SF"], ["BUF", "KC"], ["CHI", "GB"], ["PIT", "BAL"], ["NE", "MIA"], ["ARI", "LAR"], ["CLE", "CIN"]],
  17: [["DAL", "PHI"], ["SF", "SEA"], ["KC", "BUF"], ["GB", "CHI"], ["BAL", "PIT"], ["MIA", "NE"], ["LAR", "ARI"], ["CIN", "CLE"]],
};

// Fixed build (Underdog-style 3/5/7/3 over 18 rounds), 12 teams.
const BUILD = { QB: 3, RB: 5, WR: 7, TE: 3 };
const PARAMS = { nTeams: 12, nRounds: 18, userPosMin: BUILD, userPosMax: BUILD };

// ============================================== Test 1: feasible target converges

{
  // Probe: place a mid-board WR at rank 30 and measure his exposure with
  // RANDOM seating (random smooths the per-slot exposure cliffs into a curve)
  // — that value is achievable BY CONSTRUCTION, so the solver (starting from
  // the default ADP order, where he sits deeper) must reach it.
  const wr = POOL.find((p) => p.pos === "WR" && p.adp >= 40 && p.adp <= 60);
  const probeAt = 29; // 0-indexed rank 30 — contested: the field reaches his ADP about when the user does
  const reordered = DEFAULT_ORDER.filter((id) => id !== wr.id);
  reordered.splice(probeAt, 0, wr.id);
  const probe = runSimulation({ players: POOL, userOrder: reordered, userSlot: "random", params: { ...PARAMS, iterations: 400 }, seed: 4242, schedule: SCHEDULE });
  const probed = probe.exposures.find((e) => e.id === wr.id);
  const target = probed ? probed.pct : 0;
  assert(target > 0.1 && target < 0.95, `probe target is meaningfully mid-range (${(target * 100).toFixed(1)}%)`);

  let sawRoundProgress = false;
  const result = solveTargets({
    players: POOL,
    initialOrder: DEFAULT_ORDER,
    targets: [{ id: wr.id, pct: target }],
    userSlot: "random",
    params: PARAMS,
    seed: 90210,
    schedule: SCHEDULE,
    solver: { batchIterations: 250, tolerance: 0.04, maxRounds: 25 },
    onProgress: (info) => {
      if (info.phase === "round") sawRoundProgress = true;
    },
  });

  assert(result.status === "converged", `feasible single target converges (status=${result.status}, reasons=${JSON.stringify(result.reasons)})`);
  const pt = result.perTarget[0];
  assert(pt.withinTol && Math.abs(pt.achieved - target) <= 0.04 * (1 + SOLVER_DEFAULTS.confirmSlack), `achieved ${(pt.achieved * 100).toFixed(1)}% within tolerance of target ${(target * 100).toFixed(1)}%`);
  assert(result.confirmed === true, "converged result was re-verified on a fresh seed");
  assert(pt.rankAfter < pt.rankBefore, `targeted player moved up the board (${pt.rankBefore} -> ${pt.rankAfter})`);
  assert(sawRoundProgress, "onProgress fired with round-phase updates");

  // Free variables: untargeted players keep their relative order exactly.
  const beforeRest = DEFAULT_ORDER.filter((id) => id !== wr.id);
  const afterRest = result.order.filter((id) => id !== wr.id);
  assert(JSON.stringify(beforeRest) === JSON.stringify(afterRest), "untargeted players' relative order is preserved");
  assert(result.order.length === DEFAULT_ORDER.length && new Set(result.order).size === result.order.length, "proposed order is a permutation of the board (no dupes/drops)");
  assert(diffOrders(DEFAULT_ORDER, result.order).some((m) => m.id === wr.id), "diffOrders reports the targeted player's move");
}

// ============================================== Test 2: infeasible target reports failure

{
  // 90% exposure for the consensus #1 pick from a LATE fixed seat (1.12): the
  // field takes him in the first eleven picks essentially always, so even
  // ranked #1 on the user's board he can't be had. Must report, not thrash.
  const top = POOL[0];
  const result = solveTargets({
    players: POOL,
    initialOrder: DEFAULT_ORDER,
    targets: [{ id: top.id, pct: 0.9 }],
    userSlot: 12,
    params: PARAMS,
    seed: 555,
    schedule: SCHEDULE,
    solver: { batchIterations: 200, tolerance: 0.03, maxRounds: 25 },
  });

  assert(result.status === "failed", `infeasible target reports failure (status=${result.status})`);
  const pt = result.perTarget[0];
  assert(pt.reachable === false, "target is flagged unreachable");
  assert(typeof pt.note === "string" && pt.note.includes("unreachable"), `unreachable note explains the cap (note=${JSON.stringify(pt.note)})`);
  assert(pt.achieved != null && pt.achieved < 0.5, `closest achieved value is reported (${(pt.achieved * 100).toFixed(1)}%)`);
  assert(result.reasons.length > 0, "failure reasons are reported");
  assert(result.roundsUsed <= 6, `boundary cap detected quickly (${result.roundsUsed} rounds, not a full thrash)`);
}

// ============================================== Test 3: determinism

{
  const args = () => ({
    players: POOL,
    initialOrder: DEFAULT_ORDER,
    targets: [{ id: POOL[0].id, pct: 0.9 }],
    userSlot: 12,
    params: PARAMS,
    seed: 555,
    schedule: SCHEDULE,
    solver: { batchIterations: 200, tolerance: 0.03, maxRounds: 25 },
  });
  const r1 = solveTargets(args());
  const r2 = solveTargets(args());
  assert(JSON.stringify(r1) === JSON.stringify(r2), "same seed + inputs => byte-identical solver result");
}

// ============================================== Test 4: provable joint infeasibility (precheck)

{
  const qbs = POOL.filter((p) => p.pos === "QB").slice(0, 4);
  const result = solveTargets({
    players: POOL,
    initialOrder: DEFAULT_ORDER,
    targets: qbs.map((p) => ({ id: p.id, pct: 0.99 })), // 3.96 rosters of QB vs build cap 3
    userSlot: 1,
    params: PARAMS,
    seed: 777,
    schedule: SCHEDULE,
  });
  assert(result.status === "failed", "over-capacity QB targets fail");
  assert(result.draftsRun === 0, "provably-impossible target set fails BEFORE any drafts run");
  assert(result.reasons.some((r) => /jointly impossible/.test(r)), `precheck reason names the joint impossibility (${JSON.stringify(result.reasons)})`);
  assert(result.order.length === DEFAULT_ORDER.length && JSON.stringify(result.order) === JSON.stringify(DEFAULT_ORDER), "board is returned untouched on precheck failure");
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS (0 failures)");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
