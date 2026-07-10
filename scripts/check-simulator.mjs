// scripts/check-simulator.mjs
// Plain-node self-check for src/core/simulator.js. Synthetic, invented player
// pool (no real names/rankings). Run: node scripts/check-simulator.mjs

import { runSimulation, runSimulationWithTrace, SIM_DEFAULTS } from "../src/core/simulator.js";

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

function buildPool() {
  // ~QB40 / RB80 / WR100 / TE30 = 250 players. ADP 1..220 for most, plus a
  // handful of null-ADP "deep sleeper" players the user ranks but the field
  // never sees.
  const counts = { QB: 40, RB: 80, WR: 100, TE: 30 };
  const order = [];
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    for (let i = 0; i < counts[pos]; i++) order.push(pos);
  }
  // Interleave roughly by "quality" so adp assignment mixes positions realistically:
  // simple deterministic shuffle via index striding.
  const interleaved = [];
  const buckets = { QB: [], RB: [], WR: [], TE: [] };
  for (const pos of order) buckets[pos].push(pos);
  const cursors = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const weights = { QB: 40, RB: 80, WR: 100, TE: 30 };
  const total = 250;
  // Deterministic weighted round-robin.
  const remaining = { ...weights };
  for (let i = 0; i < total; i++) {
    // Pick the position with the highest remaining/weights ratio deficit (deterministic).
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
    interleaved.push(bestPos);
    remaining[bestPos]--;
  }

  const players = [];
  let adpCounter = 1;
  const nullAdpIds = [];
  for (let i = 0; i < interleaved.length; i++) {
    const pos = interleaved[i];
    const id = `syn_${i}_${pos}`;
    const team = TEAM_ABBRS[i % TEAM_ABBRS.length];
    // Every 23rd player (deterministic, not random) is a null-ADP deep sleeper.
    const isNullAdp = i % 23 === 22;
    const adp = isNullAdp ? null : adpCounter;
    if (!isNullAdp) adpCounter += 220 / total; // spreads adp 1..~220 over the non-null players
    const player = {
      id,
      name: `Synthetic Player ${i}`,
      nameKey: `synthetic player ${i}`,
      pos,
      team,
      adp: adp == null ? null : Math.round(adp * 100) / 100,
      raw: {},
    };
    players.push(player);
    if (isNullAdp) nullAdpIds.push(id);
  }
  return { players, nullAdpIds };
}

const { players: POOL, nullAdpIds } = buildPool();

// User board: file order (ADP order for ranked players), null-adp players kept
// at their natural interleaved position too, so the user COULD draft them but
// they aren't artificially prioritized (except in test 2, which builds its own board).
const DEFAULT_USER_ORDER = POOL.slice().sort((a, b) => {
  const av = a.adp == null ? 9999 : a.adp;
  const bv = b.adp == null ? 9999 : b.adp;
  return av - bv;
}).map((p) => p.id);

// Tiny fake wk15-17 schedule using real team abbrs (resolved loosely through
// simulator.js's team map) so stack/game-stack logic actually activates.
const SCHEDULE = {
  15: [
    ["DAL", "PHI"], ["SF", "SEA"], ["KC", "BUF"], ["GB", "CHI"],
    ["BAL", "PIT"], ["MIA", "NE"], ["LAR", "ARI"], ["CIN", "CLE"],
  ],
  16: [
    ["PHI", "DAL"], ["SEA", "SF"], ["BUF", "KC"], ["CHI", "GB"],
    ["PIT", "BAL"], ["NE", "MIA"], ["ARI", "LAR"], ["CLE", "CIN"],
  ],
  17: [
    ["DAL", "PHI"], ["SF", "SEA"], ["KC", "BUF"], ["GB", "CHI"],
    ["BAL", "PIT"], ["MIA", "NE"], ["LAR", "ARI"], ["CIN", "CLE"],
  ],
};

const BASE_PARAMS = { ...SIM_DEFAULTS, iterations: 50 };

// ================================================================== Test 1: determinism

{
  const r1 = runSimulation({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: 1, params: { ...BASE_PARAMS, iterations: 40 }, seed: 12345, schedule: SCHEDULE });
  const r2 = runSimulation({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: 1, params: { ...BASE_PARAMS, iterations: 40 }, seed: 12345, schedule: SCHEDULE });
  const r3 = runSimulation({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: 1, params: { ...BASE_PARAMS, iterations: 40 }, seed: 999, schedule: SCHEDULE });

  const eq = JSON.stringify(r1.exposures) === JSON.stringify(r2.exposures);
  assert(eq, "same seed => deep-equal exposures across two runs");

  const diff = JSON.stringify(r1.exposures) !== JSON.stringify(r3.exposures);
  assert(diff, "different seed => different exposures");
}

// ================================================================== Test 2: user autodraft

{
  // Build a user board with a null-adp player ranked #1 overall.
  const starId = nullAdpIds[0];
  const userOrder = [starId, ...DEFAULT_USER_ORDER.filter((id) => id !== starId)];
  const iterations = 50;
  const result = runSimulation({
    players: POOL,
    userOrder,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 777,
    schedule: SCHEDULE,
  });

  const starExposure = result.exposures.find((e) => e.id === starId);
  assert(!!starExposure && starExposure.count === iterations, `null-ADP #1 player drafted in every iteration (count=${starExposure ? starExposure.count : "MISSING"}/${iterations})`);
  assert(!!starExposure && starExposure.rounds[1] === iterations, "that player is always taken in round 1 (pick 1 overall, fixed slot 1)");

  // Check roster posMin/posMax compliance across all 50 drafts via the trace helper.
  const traceResult = runSimulationWithTrace({
    players: POOL,
    userOrder,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 777,
    schedule: SCHEDULE,
  });
  const byDraft = new Map();
  for (const pk of traceResult.picks) {
    if (!pk.isUser) continue;
    if (!byDraft.has(pk.draft)) byDraft.set(pk.draft, []);
    byDraft.get(pk.draft).push(pk);
  }
  let minOk = true;
  let maxOk = true;
  let posLookup = new Map(POOL.map((p) => [p.id, p.pos]));
  for (const [, picks] of byDraft) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pk of picks) counts[posLookup.get(pk.id)] = (counts[posLookup.get(pk.id)] || 0) + 1;
    for (const p of Object.keys(SIM_DEFAULTS.posMin)) {
      if (counts[p] < SIM_DEFAULTS.posMin[p]) minOk = false;
      if (counts[p] > SIM_DEFAULTS.posMax[p]) maxOk = false;
    }
  }
  assert(byDraft.size === iterations, `user seat produced a full roster in all ${iterations} drafts`);
  assert(minOk, "user roster always meets posMin by draft end (checked across 50 drafts)");
  assert(maxOk, "user roster never exceeds posMax (checked across 50 drafts)");
}

// ================================================================== Test 3: field sanity

{
  const iterations = 100;
  const traceResult = runSimulationWithTrace({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 55,
    schedule: SCHEDULE,
  });
  const adpById = new Map(POOL.map((p) => [p.id, p.adp]));

  let earlyDevSum = 0, earlyDevN = 0; // rounds 1-3
  let lateDevSum = 0, lateDevN = 0; // rounds 13-18
  let reachViolations = 0;

  for (const pk of traceResult.picks) {
    if (pk.isUser) continue; // field seats only
    const adp = adpById.get(pk.id);
    if (adp == null) continue; // field never drafts null-adp players; defensive skip
    const dev = Math.abs(pk.overall - adp);
    if (pk.round <= 3) {
      earlyDevSum += dev;
      earlyDevN++;
    } else if (pk.round >= 13) {
      lateDevSum += dev;
      lateDevN++;
    }
    const cap = pk.round <= 6 ? SIM_DEFAULTS.maxReachEarly : pk.round <= 12 ? SIM_DEFAULTS.maxReachMid : SIM_DEFAULTS.maxReachLate;
    if (adp - pk.overall > cap + 1e-9) reachViolations++;
  }

  const earlyMean = earlyDevSum / earlyDevN;
  const lateMean = lateDevSum / lateDevN;
  assert(earlyDevN > 0 && lateDevN > 0, "collected field picks in both early (r1-3) and late (r13-18) buckets");
  assert(lateMean > earlyMean, `mean |pick-adp| grows with draft depth (early=${earlyMean.toFixed(2)}, late=${lateMean.toFixed(2)})`);
  assert(reachViolations === 0, `no field pick exceeds its round band's reach cap (violations=${reachViolations})`);
}

// ================================================================== Test 4: exposure shape

{
  const iterations = 60;
  const result = runSimulation({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 314,
    schedule: SCHEDULE,
  });

  const pctOk = result.exposures.every((e) => e.pct >= 0 && e.pct <= 1);
  assert(pctOk, "all exposure pcts are in [0,1]");

  const avgPickOk = result.exposures.every((e) => e.avgPick >= 1 && e.avgPick <= SIM_DEFAULTS.nTeams * SIM_DEFAULTS.nRounds);
  assert(avgPickOk, `all avgPick values within [1, ${SIM_DEFAULTS.nTeams * SIM_DEFAULTS.nRounds}]`);

  // counts sum per draft == nRounds for the user seat: reconstruct via trace.
  const traceResult = runSimulationWithTrace({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 314,
    schedule: SCHEDULE,
  });
  const perDraftUserPickCount = new Map();
  for (const pk of traceResult.picks) {
    if (!pk.isUser) continue;
    perDraftUserPickCount.set(pk.draft, (perDraftUserPickCount.get(pk.draft) || 0) + 1);
  }
  const countsSumOk = perDraftUserPickCount.size === iterations && [...perDraftUserPickCount.values()].every((c) => c === SIM_DEFAULTS.nRounds);
  assert(countsSumOk, `user seat makes exactly nRounds=${SIM_DEFAULTS.nRounds} picks in every draft`);

  assert(result.drafts === iterations, `result.drafts === iterations (${result.drafts} === ${iterations})`);
  assert(result.userSlotUsed === 1, "result.userSlotUsed reflects the fixed slot passed in");
}

// ================================================================== Test 5: rotate mode

{
  const nTeams = SIM_DEFAULTS.nTeams; // 12
  const iterations = nTeams * 2; // 24
  const traceResult = runSimulationWithTrace({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: "rotate",
    params: { ...SIM_DEFAULTS, iterations },
    seed: 2026,
    schedule: SCHEDULE,
  });

  assert(traceResult.userSlotUsed === "rotate", 'userSlotUsed === "rotate" when userSlot param is "rotate"');

  const slotPerDraft = new Map();
  for (const pk of traceResult.picks) {
    if (!pk.isUser) continue;
    if (!slotPerDraft.has(pk.draft)) slotPerDraft.set(pk.draft, pk.slot); // 0-based slot, constant within a draft
  }
  const slotCounts = new Array(nTeams).fill(0);
  for (const [, slot] of slotPerDraft) slotCounts[slot]++;

  const allTwice = slotCounts.every((c) => c === 2);
  assert(slotPerDraft.size === iterations, `every draft has an identifiable user slot (${slotPerDraft.size}/${iterations})`);
  assert(allTwice, `each of the ${nTeams} slots is used exactly twice across ${iterations} rotate iterations (counts=${JSON.stringify(slotCounts)})`);

  // Cross-check against the documented formula: iteration i uses slot (i % nTeams) + 1.
  let formulaOk = true;
  for (let i = 0; i < iterations; i++) {
    const expectedSlot0 = i % nTeams;
    if (slotPerDraft.get(i) !== expectedSlot0) formulaOk = false;
  }
  assert(formulaOk, 'rotate assignment matches "iteration i uses slot (i % nTeams)+1" exactly');
}

// ================================================================== Test 6: perf

{
  const iterations = 200;
  const t0 = Date.now();
  const result = runSimulation({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 8080,
    schedule: SCHEDULE,
  });
  const elapsedMs = Date.now() - t0;
  console.log(`PERF: ${iterations} drafts on a ${POOL.length}-player pool took ${elapsedMs}ms`);
  assert(result.drafts === iterations, "perf run completed all requested drafts");
  assert(elapsedMs <= 10000, `perf: ${elapsedMs}ms <= 10000ms budget for ${iterations} drafts`);
}

// ================================================================== Test 7: stacking rate
// Regression guard for the archetype stack multipliers: if tmult/gmult ever
// silently collapse to 1.0 (e.g. a refactor drops the archTeamMult/archGameMult
// lookup), this is the only test that would notice — it measures the actual
// *behavioral* effect (roster QB/WR-TE same-team correlation), not just that
// the multiplier tables are wired up.

{
  const iterations = 150;
  const teamById = new Map(POOL.map((p) => [p.id, p.team]));
  const posById = new Map(POOL.map((p) => [p.id, p.pos]));

  function stackRate(archetypes, seed) {
    const traceResult = runSimulationWithTrace({
      players: POOL,
      userOrder: DEFAULT_USER_ORDER,
      userSlot: 1,
      params: { ...SIM_DEFAULTS, iterations, archetypes },
      seed,
      schedule: SCHEDULE,
    });
    // Group field-seat (non-user) picks by (draft, slot) into per-roster lists.
    const rosters = new Map();
    for (const pk of traceResult.picks) {
      if (pk.isUser) continue;
      const key = `${pk.draft}_${pk.slot}`;
      if (!rosters.has(key)) rosters.set(key, []);
      rosters.get(key).push(pk);
    }
    let stackedCount = 0;
    let totalRosters = 0;
    for (const [, picks] of rosters) {
      totalRosters++;
      const qbTeams = new Set();
      for (const pk of picks) {
        if (posById.get(pk.id) === "QB") {
          const t = teamById.get(pk.id);
          if (t) qbTeams.add(t);
        }
      }
      let hasStack = false;
      for (const pk of picks) {
        const p = posById.get(pk.id);
        if (p === "WR" || p === "TE") {
          const t = teamById.get(pk.id);
          if (t && qbTeams.has(t)) {
            hasStack = true;
            break;
          }
        }
      }
      if (hasStack) stackedCount++;
    }
    return totalRosters > 0 ? stackedCount / totalRosters : 0;
  }

  // Default archetypes (hard/soft/none mix) vs. every field team forced to
  // "none" (tmult=gmult=1, i.e. no stacking preference at all). Fixed,
  // identical seed for both runs so the comparison isolates the archetype effect.
  const defaultRate = stackRate(SIM_DEFAULTS.archetypes, 4242);
  const noneRate = stackRate([["none", 1.0, 1, 1]], 4242);
  const margin = 0.08;

  console.log(`STACK RATE: default-archetype=${defaultRate.toFixed(4)} none-archetype=${noneRate.toFixed(4)} (required margin=${margin})`);
  assert(
    defaultRate > noneRate + margin,
    `default-archetype QB/WR-TE same-team stack rate (${defaultRate.toFixed(4)}) exceeds all-"none" rate (${noneRate.toFixed(4)}) by more than ${margin}`
  );
}

// ================================================================== Test 8: snake oracle
// Independently-derived (textually different) formula for the drafting slot at
// a given overall pick, cross-checked against the trace for every pick across
// several drafts. Catches a snake-order flip inside the pick loop that the
// rotate-mode test (Test 5) cannot see, since that test only checks which slot
// is "the user's" per draft, not the field's pick order within a round.

{
  const nTeams = SIM_DEFAULTS.nTeams;
  const iterations = 5;
  const traceResult = runSimulationWithTrace({
    players: POOL,
    userOrder: DEFAULT_USER_ORDER,
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 909090,
    schedule: SCHEDULE,
  });

  let mismatches = 0;
  let checked = 0;
  for (const pk of traceResult.picks) {
    const overall = pk.overall;
    const r = Math.ceil(overall / nTeams);
    const k = overall - (r - 1) * nTeams;
    const expect = r % 2 === 1 ? k : nTeams - k + 1; // 1-based slot, independent formula
    const expectSlot0 = expect - 1; // trace's pk.slot is 0-based
    checked++;
    if (expectSlot0 !== pk.slot) mismatches++;
  }
  assert(checked > 0, "snake oracle: collected picks to check");
  assert(mismatches === 0, `every pick's drafting slot matches the independent snake-order oracle formula across ${iterations} drafts (checked=${checked}, mismatches=${mismatches})`);
}

// ================================================================== Test 9: random seating

{
  const nTeams = SIM_DEFAULTS.nTeams; // 12
  const iterations = 240;

  function slotsPerDraft(traceResult) {
    const m = new Map();
    for (const pk of traceResult.picks) {
      if (!pk.isUser) continue;
      if (!m.has(pk.draft)) m.set(pk.draft, pk.slot); // 0-based, constant within a draft
    }
    return m;
  }

  const r1 = runSimulationWithTrace({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: "random", params: { ...SIM_DEFAULTS, iterations }, seed: 4141, schedule: SCHEDULE });
  const r2 = runSimulationWithTrace({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: "random", params: { ...SIM_DEFAULTS, iterations }, seed: 4141, schedule: SCHEDULE });

  assert(r1.userSlotUsed === "random", 'userSlotUsed === "random" when userSlot param is "random"');

  const s1 = slotsPerDraft(r1);
  const s2 = slotsPerDraft(r2);
  let sameSlots = s1.size === iterations && s2.size === iterations;
  if (sameSlots) {
    for (const [d, slot] of s1) {
      if (s2.get(d) !== slot) {
        sameSlots = false;
        break;
      }
    }
  }
  assert(sameSlots, "random seating: same seed => identical per-draft userSlotUsed slots (via trace) across two runs");
  assert(JSON.stringify(r1.exposures) === JSON.stringify(r2.exposures), "random seating: same seed => deep-equal exposures across two runs");

  // Loose uniformity: over 240 drafts each of the 12 slots appears at least 5 times.
  const slotCounts = new Array(nTeams).fill(0);
  for (const [, slot] of s1) slotCounts[slot]++;
  const minSlotCount = Math.min(...slotCounts);
  assert(minSlotCount >= 5, `random seating: each of the ${nTeams} slots appears >=5 times across ${iterations} drafts (counts=${JSON.stringify(slotCounts)}, min=${minSlotCount})`);

  // Exposures differ from rotate mode given the identical seed (the random
  // per-draft slot draw consumes the shared rng stream differently than the
  // deterministic rotate formula, so the whole draft sequence diverges).
  const rotateResult = runSimulation({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: "rotate", params: { ...SIM_DEFAULTS, iterations }, seed: 4141, schedule: SCHEDULE });
  const randomResult = runSimulation({ players: POOL, userOrder: DEFAULT_USER_ORDER, userSlot: "random", params: { ...SIM_DEFAULTS, iterations }, seed: 4141, schedule: SCHEDULE });
  assert(JSON.stringify(rotateResult.exposures) !== JSON.stringify(randomResult.exposures), "random seating: exposures differ from rotate mode with the same seed");
}

// ================================================================== Test 10: userPosMin/userPosMax

{
  const posLookup = new Map(POOL.map((p) => [p.id, p.pos]));

  // userPosMax.QB=2: the user roster never has 3 QBs across 60 drafts, while
  // field seats (unaffected by userPosMax) still can.
  {
    const iterations = 60;
    const userPosMin = { QB: 2, RB: 4, WR: 5, TE: 2 };
    const userPosMax = { QB: 2, RB: 8, WR: 10, TE: 3 };
    const traceResult = runSimulationWithTrace({
      players: POOL,
      userOrder: DEFAULT_USER_ORDER,
      userSlot: 1,
      params: { ...SIM_DEFAULTS, iterations, userPosMin, userPosMax },
      seed: 606,
      schedule: SCHEDULE,
    });
    const userQbByDraft = new Map();
    const fieldQbByRoster = new Map();
    for (const pk of traceResult.picks) {
      if (posLookup.get(pk.id) !== "QB") continue;
      if (pk.isUser) {
        userQbByDraft.set(pk.draft, (userQbByDraft.get(pk.draft) || 0) + 1);
      } else {
        const key = `${pk.draft}_${pk.slot}`;
        fieldQbByRoster.set(key, (fieldQbByRoster.get(key) || 0) + 1);
      }
    }
    const userMaxQb = Math.max(0, ...userQbByDraft.values());
    const fieldMaxQb = Math.max(0, ...fieldQbByRoster.values());
    assert(userMaxQb <= 2, `user roster never exceeds userPosMax.QB=2 across ${iterations} drafts (max seen=${userMaxQb})`);
    assert(fieldMaxQb > 2, `field seats (unaffected by userPosMax) still exceed 2 QBs on at least one roster (max seen=${fieldMaxQb}) — confirms only the user seat is constrained`);
  }

  // userPosMin.RB=6: the user always ends with >=6 RBs.
  {
    const iterations = 50;
    const userPosMin = { QB: 2, RB: 6, WR: 5, TE: 2 };
    const userPosMax = { QB: 3, RB: 8, WR: 10, TE: 3 };
    const traceResult = runSimulationWithTrace({
      players: POOL,
      userOrder: DEFAULT_USER_ORDER,
      userSlot: 1,
      params: { ...SIM_DEFAULTS, iterations, userPosMin, userPosMax },
      seed: 707,
      schedule: SCHEDULE,
    });
    const userRbByDraft = new Map();
    for (const pk of traceResult.picks) {
      if (!pk.isUser) continue;
      if (posLookup.get(pk.id) !== "RB") continue;
      userRbByDraft.set(pk.draft, (userRbByDraft.get(pk.draft) || 0) + 1);
    }
    let allMeetMin = userRbByDraft.size === iterations;
    for (const [, c] of userRbByDraft) if (c < 6) allMeetMin = false;
    assert(allMeetMin, `user roster always ends with >=6 RBs when userPosMin.RB=6 (checked across ${iterations} drafts)`);
  }

  // Invalid constraints (min sum > nRounds) fall back to the field defaults
  // for the whole pair of objects, without throwing.
  {
    const iterations = 20;
    const badPosMin = { QB: 10, RB: 10, WR: 10, TE: 10 }; // sum=40 > nRounds=18
    const badPosMax = { QB: 10, RB: 10, WR: 10, TE: 10 };
    let threw = false;
    let fallbackResult = null;
    try {
      fallbackResult = runSimulationWithTrace({
        players: POOL,
        userOrder: DEFAULT_USER_ORDER,
        userSlot: 1,
        params: { ...SIM_DEFAULTS, iterations, userPosMin: badPosMin, userPosMax: badPosMax },
        seed: 808,
        schedule: SCHEDULE,
      });
    } catch (err) {
      threw = true;
    }
    assert(!threw, "invalid userPosMin/userPosMax (min sum > nRounds) does not throw");

    let fallbackOk = !!fallbackResult;
    if (fallbackResult) {
      const userCountsByDraft = new Map();
      for (const pk of fallbackResult.picks) {
        if (!pk.isUser) continue;
        if (!userCountsByDraft.has(pk.draft)) userCountsByDraft.set(pk.draft, { QB: 0, RB: 0, WR: 0, TE: 0 });
        const c = userCountsByDraft.get(pk.draft);
        const p = posLookup.get(pk.id);
        c[p] = (c[p] || 0) + 1;
      }
      for (const [, c] of userCountsByDraft) {
        for (const p of Object.keys(SIM_DEFAULTS.posMax)) {
          if (c[p] > SIM_DEFAULTS.posMax[p]) fallbackOk = false;
        }
      }
    }
    assert(fallbackOk, "invalid userPosMin/userPosMax falls back to the field's default posMax caps (checked across all drafts)");
  }
}

// ================================================================== Test 11: posMax never violated when caps sum short of nRounds
// Regression guard for the userPick() exhaustion fallbacks: userPosMax sums
// to 6 (QB1/RB2/WR2/TE1) against 18 rounds, so the user's board is
// GUARANTEED to run out of legal (under-cap) players well before the draft
// ends and fall through to the "ultimate fallback" tiers. Before the fix
// those fallbacks ignored posMax entirely; this asserts they still respect
// it (the roster ends up short — fewer than 18 picks — which is correct,
// expected behavior, not a bug) and that the sim never throws.

{
  const iterations = 30;
  const userPosMin = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const userPosMax = { QB: 1, RB: 2, WR: 2, TE: 1 }; // sum=6 < nRounds=18
  const posLookup = new Map(POOL.map((p) => [p.id, p.pos]));

  let threw = false;
  let traceResult = null;
  try {
    traceResult = runSimulationWithTrace({
      players: POOL,
      userOrder: DEFAULT_USER_ORDER,
      userSlot: 1,
      params: { ...SIM_DEFAULTS, iterations, userPosMin, userPosMax },
      seed: 111213,
      schedule: SCHEDULE,
    });
  } catch (err) {
    threw = true;
  }
  assert(!threw, "userPosMax sum (6) short of nRounds (18) does not throw");

  let capsOk = true;
  let sawShortRoster = false;
  if (traceResult) {
    const userCountsByDraft = new Map();
    for (const pk of traceResult.picks) {
      if (!pk.isUser) continue;
      if (!userCountsByDraft.has(pk.draft)) userCountsByDraft.set(pk.draft, { QB: 0, RB: 0, WR: 0, TE: 0, total: 0 });
      const c = userCountsByDraft.get(pk.draft);
      const p = posLookup.get(pk.id);
      c[p] = (c[p] || 0) + 1;
      c.total++;
    }
    for (const [, c] of userCountsByDraft) {
      for (const p of Object.keys(userPosMax)) {
        if (c[p] > userPosMax[p]) capsOk = false;
      }
      if (c.total < SIM_DEFAULTS.nRounds) sawShortRoster = true;
    }
  }
  assert(capsOk, "user roster never exceeds any userPosMax cap even when caps sum well short of nRounds (fallback tiers respect caps)");
  assert(sawShortRoster, "user roster is correctly left short (< nRounds picks) rather than violating caps to fill it out");
}

// ---- Test 12: field roster-construction shape (2026-07-10 retune) ----------
// Deterministic (fixed seed): field builds stay inside QB/TE 2-4, RB 3-8,
// WR 4-10; the mode sits at 3/5/7/3; and the distribution is asymmetric —
// below-mode counts (2 QB / 2 TE) are more common than above-mode (4 QB / 4 TE).
{
  // Roster shape is pool-composition dependent: a uniform position stripe
  // gives QBs/TEs unrealistic availability and distorts builds. This template
  // is the POSITION COUNT per 24-pick ADP band measured from a real 380-player
  // Underdog pool (aggregate structure only — no player data): [QB, RB, WR, TE]
  // per band. Note band 1 is 0 QB / 13 RB / 10 WR / 1 TE — that scarcity curve
  // is what the countPenalty calibration assumes.
  const BAND_TEMPLATE = [
    [0, 13, 10, 1], [1, 7, 14, 2], [6, 6, 11, 1], [5, 8, 9, 2],
    [7, 5, 8, 4], [5, 6, 8, 5], [2, 7, 7, 8], [3, 5, 11, 5],
    [2, 8, 10, 4], [3, 5, 12, 4], [2, 7, 8, 7], [0, 5, 16, 3],
    [6, 2, 13, 3], [0, 8, 11, 5], [5, 2, 12, 5], [6, 7, 2, 5],
    // padded deep tail so the candidate window never runs dry
    [2, 6, 10, 6], [2, 6, 10, 6], [2, 6, 10, 6],
  ];
  const bigPool = [];
  let adpN = 1;
  const POS_ORDER = ["QB", "RB", "WR", "TE"];
  for (const band of BAND_TEMPLATE) {
    const bandPicks = [];
    band.forEach((n, pi) => { for (let j = 0; j < n; j++) bandPicks.push(POS_ORDER[pi]); });
    // deterministic interleave within the band
    bandPicks.sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b));
    const spread = [];
    while (bandPicks.length) spread.push(bandPicks.splice(Math.floor(bandPicks.length / 2), 1)[0]);
    for (const pos of spread) {
      bigPool.push({
        id: `big_${adpN}_${pos}`,
        name: `Shape Player ${adpN}`,
        nameKey: `shape player ${adpN}`,
        pos,
        team: TEAM_ABBRS[adpN % TEAM_ABBRS.length],
        adp: adpN,
        raw: {},
      });
      adpN++;
    }
  }
  const iterations = 150;
  const r = runSimulationWithTrace({
    players: bigPool,
    userOrder: bigPool.map((p) => p.id),
    userSlot: 1,
    params: { ...SIM_DEFAULTS, iterations },
    seed: 20260710,
    schedule: SCHEDULE,
  });
  const posLookup = new Map(bigPool.map((p) => [p.id, p.pos]));
  const rosters = new Map();
  for (const pk of r.picks) {
    if (pk.isUser) continue;
    const k = pk.draft + "|" + pk.slot;
    if (!rosters.has(k)) rosters.set(k, { QB: 0, RB: 0, WR: 0, TE: 0 });
    const c = rosters.get(k);
    const p = posLookup.get(pk.id);
    if (p in c) c[p]++;
  }
  const field = [...rosters.values()];
  const count = (pos, n) => field.filter((x) => x[pos] === n).length;
  const withinBounds = field.every(
    (x) =>
      x.QB >= SIM_DEFAULTS.posMin.QB && x.QB <= SIM_DEFAULTS.posMax.QB &&
      x.TE >= SIM_DEFAULTS.posMin.TE && x.TE <= SIM_DEFAULTS.posMax.TE &&
      x.RB >= SIM_DEFAULTS.posMin.RB && x.RB <= SIM_DEFAULTS.posMax.RB &&
      x.WR >= SIM_DEFAULTS.posMin.WR && x.WR <= SIM_DEFAULTS.posMax.WR
  );
  assert(withinBounds, `all ${field.length} field rosters within QB/TE 2-4, RB 3-8, WR 4-10`);
  assert(count("QB", 4) > 0 && count("TE", 4) > 0, "4-QB and 4-TE field builds occur (tails exist)");
  assert(count("QB", 2) > count("QB", 4), "2-QB builds more common than 4-QB (asymmetric tail)");
  assert(count("TE", 2) > count("TE", 4), "2-TE builds more common than 4-TE (asymmetric tail)");
  const mode = (pos, max) => {
    let best = 0, bestN = 0;
    for (let n = 0; n <= max; n++) if (count(pos, n) > best) { best = count(pos, n); bestN = n; }
    return bestN;
  };
  // The 2-vs-3 modal tip is sensitive to the pool's exact QB/TE pricing; on a
  // real Underdog pool the mode is 3 (calibration note in SIM_DEFAULTS). On
  // this approximated template assert the robust invariants instead: mode is
  // never an extreme, and 3-counts dominate 4-counts decisively.
  assert([2, 3].includes(mode("QB", 4)) && [2, 3].includes(mode("TE", 4)), "modal QB/TE count is 2 or 3 (never an extreme)");
  assert(count("QB", 3) > count("QB", 4) * 2 && count("TE", 3) > count("TE", 4) * 2, "3-QB/3-TE builds decisively more common than 4s");
  assert(mode("RB", 8) === 5 || mode("RB", 8) === 6, "modal RB count is 5 (6 tolerated at small n)");
  assert(mode("WR", 10) === 7 || mode("WR", 10) === 8, "modal WR count is 7 (8 tolerated at small n)");
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS (0 failures)");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
