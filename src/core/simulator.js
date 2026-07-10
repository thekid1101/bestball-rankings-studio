// src/core/simulator.js
// Pure algorithm module — no DOM, importable in plain Node. Ports the field
// draft simulator from "BBM Draft simulator/sim.py" (see METHODOLOGY.md for
// the calibration intent). One seat (userSlot) is replaced with a deterministic
// autodrafter that walks the user's own board (userOrder); the other nTeams-1
// seats are a faithful port of sim.py's softmax/Gumbel field model.
//
// Determinism: every random draw goes through the seeded mulberry32 PRNG
// passed in via `seed`. No Math.random(), no Date.now(), no other ambient
// randomness/time anywhere in this file — same seed + inputs => byte-identical
// output.

export const SIM_DEFAULTS = {
  nTeams: 12,
  nRounds: 18,
  iterations: 200,
  sigmaBase: 0.9,
  sigmaSlope: 0.065,
  poolSize: 35,
  maxReachEarly: 18,
  maxReachMid: 26,
  maxReachLate: 40,
  archetypes: [
    ["hard", 0.5, 5, 1.8],
    ["soft", 0.38, 2.5, 1.35],
    ["none", 0.12, 1, 1],
  ],
  tasteSd: 0.35,
  tasteRounds: 8,
  rbStackDiscount: 0.45,
  gameStackMinRound: 6,
  posMin: { QB: 2, RB: 4, WR: 5, TE: 2 },
  posMax: { QB: 3, RB: 8, WR: 10, TE: 3 },
  countPenalty: {
    QB: [1.0, 0.55, 0.06],
    TE: [1.0, 0.6, 0.12],
    RB: [1.0, 1.0, 1.0, 1.0, 0.9, 0.75, 0.5, 0.25],
    WR: [1.0, 1.0, 1.0, 1.0, 1.0, 0.95, 0.85, 0.7, 0.5, 0.3],
  },
  urgencyStartRound: 10,
  urgencyMult: 1.35,
};

// ---------------------------------------------------------------- team map
// Factual NFL team full-name <-> abbreviation map (32 teams). Not proprietary
// rankings data — used only to resolve a player's `team` string so team-stack
// and playoff game-stack bonuses can key off it. Unresolved team strings just
// get no stack bonus (never throw).

const TEAM_TABLE = [
  ["ARI", "Arizona Cardinals"],
  ["ATL", "Atlanta Falcons"],
  ["BAL", "Baltimore Ravens"],
  ["BUF", "Buffalo Bills"],
  ["CAR", "Carolina Panthers"],
  ["CHI", "Chicago Bears"],
  ["CIN", "Cincinnati Bengals"],
  ["CLE", "Cleveland Browns"],
  ["DAL", "Dallas Cowboys"],
  ["DEN", "Denver Broncos"],
  ["DET", "Detroit Lions"],
  ["GB", "Green Bay Packers"],
  ["HOU", "Houston Texans"],
  ["IND", "Indianapolis Colts"],
  ["JAX", "Jacksonville Jaguars"],
  ["KC", "Kansas City Chiefs"],
  ["LAC", "Los Angeles Chargers"],
  ["LAR", "Los Angeles Rams"],
  ["LV", "Las Vegas Raiders"],
  ["MIA", "Miami Dolphins"],
  ["MIN", "Minnesota Vikings"],
  ["NE", "New England Patriots"],
  ["NO", "New Orleans Saints"],
  ["NYG", "New York Giants"],
  ["NYJ", "New York Jets"],
  ["PHI", "Philadelphia Eagles"],
  ["PIT", "Pittsburgh Steelers"],
  ["SEA", "Seattle Seahawks"],
  ["SF", "San Francisco 49ers"],
  ["TB", "Tampa Bay Buccaneers"],
  ["TEN", "Tennessee Titans"],
  ["WAS", "Washington Commanders"],
];

export const FULL_NAME_TO_ABBR = new Map(TEAM_TABLE.map(([abbr, full]) => [full, abbr]));
export const ABBR_TO_FULL_NAME = new Map(TEAM_TABLE.map(([abbr, full]) => [abbr, full]));

const ABBR_SET = new Set(TEAM_TABLE.map(([abbr]) => abbr));
const FULL_NAME_LOWER_TO_ABBR = new Map(TEAM_TABLE.map(([abbr, full]) => [full.toLowerCase(), abbr]));

// Resolve a platform team string ("DAL", "Dallas Cowboys", "dallas cowboys", ...)
// to a canonical abbreviation, loosely (exact abbr or exact full name, case-
// insensitive). Returns null when unresolved — callers must treat that as "no
// stack bonus", never throw.
export function resolveTeam(teamStr) {
  if (teamStr == null) return null;
  const str = String(teamStr).trim();
  if (!str) return null;
  const upper = str.toUpperCase();
  if (ABBR_SET.has(upper)) return upper;
  const abbr = FULL_NAME_LOWER_TO_ABBR.get(str.toLowerCase());
  return abbr || null;
}

// ---------------------------------------------------------------- seeded PRNG

// mulberry32 — small, fast, deterministic 32-bit PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uniformOpen(rng) {
  // uniform in (0,1), guarded away from the 0/1 endpoints so log() never blows up.
  let u = rng();
  if (u <= 0) u = 1e-12;
  if (u >= 1) u = 1 - 1e-12;
  return u;
}

function gumbelSample(rng) {
  const u = uniformOpen(rng);
  return -Math.log(-Math.log(u));
}

function gaussianSample(rng) {
  const u1 = uniformOpen(rng);
  const u2 = uniformOpen(rng);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function weightedChoice(rng, names, probs) {
  const u = rng();
  let cum = 0;
  for (let i = 0; i < names.length; i++) {
    cum += probs[i];
    if (u < cum) return names[i];
  }
  return names[names.length - 1];
}

// ---------------------------------------------------------------- schedule

// Builds teamAbbr -> Set(teamAbbr) of pooled week 15/16/17 opponents from the
// injected schedule JSON ({"15":[[away,home],...], "16":[...], "17":[...]}).
// Games with an unresolved team on either side are silently skipped.
function buildOpponents(schedule) {
  const opponents = new Map();
  if (!schedule) return opponents;
  const add = (a, b) => {
    if (!opponents.has(a)) opponents.set(a, new Set());
    opponents.get(a).add(b);
  };
  for (const wk of ["15", "16", "17"]) {
    const games = schedule[wk];
    if (!Array.isArray(games)) continue;
    for (const game of games) {
      if (!Array.isArray(game) || game.length < 2) continue;
      const away = resolveTeam(game[0]);
      const home = resolveTeam(game[1]);
      if (!away || !home) continue;
      add(away, home);
      add(home, away);
    }
  }
  return opponents;
}

// ---------------------------------------------------------------- field pick

// Chooses the field's pick for `slot` at overall pick `overall`. Mirrors
// sim.py's simulate() inner loop: candidate pool (head-pointer scan of the
// ADP-sorted field pool) -> hard reach cap -> forced-fill mask -> per-candidate
// behavior multipliers -> Gumbel-max sample. Returns a global player index, or
// -1 if the field pool is fully exhausted (should not happen in practice).
function fieldPick(ctx, rng, head, slot, overall, rnd) {
  const { fieldOrder, adp, pos, teamAbbr, isPC, P, archs, archTeamMult, archGameMult, rbTaste, wrTaste, counts, qbTeams, pcTeams, stackOpp, opponents, globalTaken } = ctx;

  // candidate pool: next poolSize available by ADP, scanning forward from head.
  const cand = [];
  let j = head;
  while (cand.length < P.poolSize && j < fieldOrder.length) {
    const gi = fieldOrder[j];
    if (!globalTaken[gi]) cand.push(gi);
    j++;
  }

  // hard reach cap by round band
  const cap = rnd <= 6 ? P.maxReachEarly : rnd <= 12 ? P.maxReachMid : P.maxReachLate;
  let filtered = cand.filter((gi) => adp[gi] - overall <= cap);
  if (filtered.length === 0) filtered = [fieldOrder[head]];

  // forced fill: restrict to deficit positions when remaining picks == remaining minimums
  const c = counts[slot];
  const deficit = {};
  let needTotal = 0;
  for (const p of Object.keys(P.posMin)) {
    const d = Math.max(0, P.posMin[p] - (c[p] || 0));
    deficit[p] = d;
    needTotal += d;
  }
  const picksLeft = P.nRounds - (rnd - 1);
  if (picksLeft <= needTotal) {
    const masked = filtered.filter((gi) => (deficit[pos[gi]] || 0) > 0);
    if (masked.length > 0) filtered = masked;
  }

  const sigma = P.sigmaBase + P.sigmaSlope * overall;
  const tmult = archTeamMult[archs[slot]];
  const gmult = archGameMult[archs[slot]];

  let bestIdx = -1;
  let bestVal = -Infinity;
  for (const gi of filtered) {
    const p = pos[gi];
    const cnt = c[p] || 0;
    const posMaxP = P.posMax[p] != null ? P.posMax[p] : Infinity;
    if (cnt >= posMaxP) continue; // -inf, never chosen

    const cpArr = P.countPenalty[p];
    let m = cpArr ? (cnt < cpArr.length ? cpArr[cnt] : cpArr[cpArr.length - 1]) : 1;

    if (rnd <= P.tasteRounds) {
      if (p === "RB") m *= rbTaste[slot];
      else if (p === "WR") m *= wrTaste[slot];
    }

    if ((deficit[p] || 0) > 0 && rnd >= P.urgencyStartRound) {
      m *= Math.pow(P.urgencyMult, rnd - P.urgencyStartRound + 1);
    }

    const t = teamAbbr[gi];
    if (t) {
      if ((p === "WR" || p === "TE") && qbTeams[slot].has(t)) {
        m *= pcTeams[slot].has(t) ? Math.pow(tmult, 0.65) : tmult;
      } else if (p === "RB" && qbTeams[slot].has(t)) {
        m *= 1 + (tmult - 1) * P.rbStackDiscount;
      } else if (p === "QB" && pcTeams[slot].has(t)) {
        m *= tmult;
      }
      if (rnd >= P.gameStackMinRound && stackOpp[slot].has(t)) {
        m *= isPC[gi] ? gmult : 1 + (gmult - 1) * 0.5;
      }
    }

    if (!(m > 0)) continue; // log(m) would be -inf
    const logw = -(adp[gi] - overall) / sigma + Math.log(m);
    const val = logw + gumbelSample(rng);
    if (val > bestVal) {
      bestVal = val;
      bestIdx = gi;
    }
  }

  // All candidates capped out (every position already maxed) — mirrors numpy's
  // argmax-over-all-(-inf) tie behavior of returning the first candidate.
  if (bestIdx === -1) bestIdx = filtered[0];
  return bestIdx;
}

// ---------------------------------------------------------------- user pick

// Deterministic autodraft for the user seat: highest available player in
// userOrder that (a) is under posMax for its position and (b) satisfies
// forced-fill when remaining picks == remaining minimum deficits. No noise.
function userPick(userOrderGlobal, globalTaken, pos, posMax, posMin, countsForSlot, picksLeft, allIndicesFallback) {
  const deficit = {};
  let needTotal = 0;
  for (const p of Object.keys(posMin)) {
    const d = Math.max(0, posMin[p] - (countsForSlot[p] || 0));
    deficit[p] = d;
    needTotal += d;
  }
  const forced = picksLeft <= needTotal;

  const scan = (requireDeficit) => {
    for (const gi of userOrderGlobal) {
      if (globalTaken[gi]) continue;
      const p = pos[gi];
      const cnt = countsForSlot[p] || 0;
      const cap = posMax[p] != null ? posMax[p] : Infinity;
      if (cnt >= cap) continue;
      if (requireDeficit && !(deficit[p] > 0)) continue;
      return gi;
    }
    return null;
  };

  let choice = forced ? scan(true) : null;
  if (choice == null) choice = scan(false);
  if (choice != null) return choice;

  // Ultimate fallbacks (should essentially never trigger with sane posMax sums):
  // any untaken player in the user's own order, ignoring caps...
  for (const gi of userOrderGlobal) {
    if (!globalTaken[gi]) return gi;
  }
  // ...or, if userOrder itself is exhausted/short, any untaken player at all.
  for (const gi of allIndicesFallback) {
    if (!globalTaken[gi]) return gi;
  }
  return -1;
}

// ------------------------------------------------ user positional constraints

// Resolves the positional min/max bounds to use for the USER seat only. When
// userPosMin/userPosMax aren't supplied, the user seat just uses the field's
// posMin/posMax (existing behavior, unchanged). When they ARE supplied, they
// must be complete {QB,RB,WR,TE, ...rosteredPos} objects with 0 <= min <= max
// per position and sum(min) <= nRounds (otherwise the user seat could be
// forced into an impossible/undrafted state). Any missing key or violation
// defensively falls back to the field defaults for the WHOLE pair of objects
// (never throws) rather than trying to partially repair a broken override.
function resolveUserPosBounds(userPosMin, userPosMax, fieldPosMin, fieldPosMax, nRounds, rosteredPos) {
  if (!userPosMin && !userPosMax) return { posMin: fieldPosMin, posMax: fieldPosMax };
  const posMin = userPosMin || fieldPosMin;
  const posMax = userPosMax || fieldPosMax;
  let sumMin = 0;
  for (const p of rosteredPos) {
    const mn = posMin[p];
    const mx = posMax[p];
    if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn < 0 || mn > mx) {
      return { posMin: fieldPosMin, posMax: fieldPosMax };
    }
    sumMin += mn;
  }
  if (sumMin > nRounds) return { posMin: fieldPosMin, posMax: fieldPosMax };
  return { posMin, posMax };
}

// ---------------------------------------------------------------- main entry

// Shared implementation behind the frozen `runSimulation` export. `trace`, when
// passed an array, gets a {draft, overall, round, slot, id, isUser} record
// pushed per pick — used only by `runSimulationWithTrace` (a test-only export,
// additive to the contract) so the self-check can inspect field-seat behavior
// without changing runSimulation's frozen return shape.
function simulateCore({ players, userOrder, userSlot, params, seed, onDraftDone, schedule }, trace) {
  // Shallow merge: a partial `params` fully replaces any nested default object
  // it touches (e.g. posMin/posMax/countPenalty/archetypes) rather than being
  // merged key-by-key into it — nested overrides must be passed complete.
  const P = { ...SIM_DEFAULTS, ...(params || {}) };
  const nTeams = P.nTeams;
  const nRounds = P.nRounds;
  const nPicks = nTeams * nRounds;
  const iterations = P.iterations;

  // This sim covers only the platform's rostered positions (the keys of
  // posMin/posMax, e.g. QB/RB/WR/TE). Positions outside that set (e.g. K,
  // DST) are filtered from both the field pool and the user's draftable set
  // up front — otherwise they'd bypass posMax caps and count-penalty scaling
  // entirely (posMin/posMax/countPenalty are all keyed only by rostered pos).
  const rosteredPos = new Set(Object.keys(P.posMin));
  players = players.filter((pl) => rosteredPos.has(pl.pos));

  // User-seat-only positional constraint override (optional, see
  // resolveUserPosBounds for the validation/fallback rules). Field seats
  // always keep P.posMin/P.posMax regardless of this.
  const { posMin: userPosMinResolved, posMax: userPosMaxResolved } = resolveUserPosBounds(
    P.userPosMin,
    P.userPosMax,
    P.posMin,
    P.posMax,
    nRounds,
    rosteredPos
  );

  const n = players.length;
  const ids = new Array(n);
  const pos = new Array(n);
  const teamAbbr = new Array(n);
  const adp = new Array(n);
  const isPC = new Array(n);
  const idToGlobal = new Map();
  for (let i = 0; i < n; i++) {
    const pl = players[i];
    ids[i] = pl.id;
    idToGlobal.set(pl.id, i);
    pos[i] = pl.pos;
    teamAbbr[i] = resolveTeam(pl.team);
    const n_ = pl.adp == null || String(pl.adp).trim() === "" ? NaN : Number(pl.adp);
    adp[i] = Number.isFinite(n_) ? n_ : NaN;
    isPC[i] = pl.pos === "WR" || pl.pos === "TE";
  }

  const fieldOrder = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(adp[i])) fieldOrder.push(i);
  fieldOrder.sort((a, b) => adp[a] - adp[b]);

  const userOrderGlobal = [];
  for (const id of userOrder || []) {
    const gi = idToGlobal.get(id);
    if (gi != null) userOrderGlobal.push(gi);
  }
  const allIndicesFallback = [];
  for (let i = 0; i < n; i++) allIndicesFallback.push(i);

  const opponents = buildOpponents(schedule);

  const archNames = P.archetypes.map((a) => a[0]);
  const archProbs = P.archetypes.map((a) => a[1]);
  const archTeamMult = {};
  const archGameMult = {};
  for (const a of P.archetypes) {
    archTeamMult[a[0]] = a[2];
    archGameMult[a[0]] = a[3];
  }

  const rng = mulberry32(seed >>> 0);

  const exposureMap = new Map(); // globalIdx -> { count, pickSum, rounds:{r:n} }
  const recordExposure = (gi, overall, rnd) => {
    let rec = exposureMap.get(gi);
    if (!rec) {
      rec = { count: 0, pickSum: 0, rounds: {} };
      exposureMap.set(gi, rec);
    }
    rec.count++;
    rec.pickSum += overall;
    rec.rounds[rnd] = (rec.rounds[rnd] || 0) + 1;
  };

  let draftsRun = 0;
  let stopped = false;

  for (let d = 0; d < iterations; d++) {
    // "random" draws a fresh uniform slot per draft off the SAME seeded rng
    // stream used for everything else in this draft (archetypes, taste, field
    // picks) — deterministic per seed, no Math.random(). Drawn before those so
    // its consumption of the stream is stable regardless of what else changes.
    let slotThisDraft;
    if (userSlot === "rotate") slotThisDraft = (d % nTeams) + 1;
    else if (userSlot === "random") slotThisDraft = Math.floor(rng() * nTeams) + 1;
    else slotThisDraft = userSlot;
    const userSlotIdx = slotThisDraft - 1;

    const globalTaken = new Uint8Array(n);
    let head = 0;

    const archs = new Array(nTeams);
    const rbTaste = new Array(nTeams);
    const wrTaste = new Array(nTeams);
    for (let s = 0; s < nTeams; s++) {
      archs[s] = weightedChoice(rng, archNames, archProbs);
      const z = gaussianSample(rng) * P.tasteSd;
      rbTaste[s] = Math.exp(z);
      wrTaste[s] = Math.exp(-z);
    }

    const counts = [];
    const qbTeams = [];
    const pcTeams = [];
    const stackOpp = [];
    for (let s = 0; s < nTeams; s++) {
      counts.push({ QB: 0, RB: 0, WR: 0, TE: 0 });
      qbTeams.push(new Set());
      pcTeams.push(new Set());
      stackOpp.push(new Set());
    }

    const ctx = { fieldOrder, adp, pos, teamAbbr, isPC, P, archs, archTeamMult, archGameMult, rbTaste, wrTaste, counts, qbTeams, pcTeams, stackOpp, opponents, globalTaken };

    for (let overall = 1; overall <= nPicks; overall++) {
      const rnd = Math.floor((overall - 1) / nTeams) + 1;
      const idx = (overall - 1) % nTeams;
      const slot = rnd % 2 === 1 ? idx : nTeams - 1 - idx;

      while (head < fieldOrder.length && globalTaken[fieldOrder[head]]) head++;

      let choice;
      if (slot === userSlotIdx) {
        const picksLeft = nRounds - (rnd - 1);
        choice = userPick(userOrderGlobal, globalTaken, pos, userPosMaxResolved, userPosMinResolved, counts[slot], picksLeft, allIndicesFallback);
      } else {
        choice = fieldPick(ctx, rng, head, slot, overall, rnd);
      }

      // Pool exhausted: silently skip this pick (leaves it undrafted for the
      // rest of the draft). Not reachable with real-sized pools; the Python
      // reference (sim.py) would instead raise IndexError in this case.
      if (choice == null || choice < 0) continue; // pool exhausted; nothing to draft

      globalTaken[choice] = 1;
      const p = pos[choice];
      counts[slot][p] = (counts[slot][p] || 0) + 1;
      const t = teamAbbr[choice];
      if (t) {
        if (p === "QB") {
          qbTeams[slot].add(t);
          if (pcTeams[slot].has(t)) {
            const opp = opponents.get(t);
            if (opp) for (const o of opp) stackOpp[slot].add(o);
          }
        } else if (p === "WR" || p === "TE") {
          pcTeams[slot].add(t);
          if (qbTeams[slot].has(t)) {
            const opp = opponents.get(t);
            if (opp) for (const o of opp) stackOpp[slot].add(o);
          }
        }
      }

      if (slot === userSlotIdx) recordExposure(choice, overall, rnd);
      if (trace) trace.push({ draft: d, overall, round: rnd, slot, id: ids[choice], isUser: slot === userSlotIdx });
    }

    draftsRun++;
    if (onDraftDone) {
      const ret = onDraftDone(draftsRun, iterations);
      if (ret === false) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }

  const exposures = [];
  for (const [gi, rec] of exposureMap) {
    exposures.push({
      id: ids[gi],
      count: rec.count,
      pct: draftsRun > 0 ? rec.count / draftsRun : 0,
      avgPick: rec.count > 0 ? rec.pickSum / rec.count : null,
      rounds: rec.rounds,
    });
  }
  exposures.sort((a, b) => b.pct - a.pct);

  return { exposures, drafts: draftsRun, userSlotUsed: userSlot };
}

// Frozen contract entry point (C-sim). See CONTRACTS.md.
export function runSimulation(opts) {
  return simulateCore(opts, null);
}

// Test-only helper (additive, not part of the frozen contract surface): same
// behavior as runSimulation, plus a full per-pick `picks` trace so self-checks
// can inspect field-seat behavior and per-draft user-slot assignment directly.
export function runSimulationWithTrace(opts) {
  const trace = [];
  const result = simulateCore(opts, trace);
  return { ...result, picks: trace };
}
