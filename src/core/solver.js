// src/core/solver.js
// Reverse solver (contract C-solver): searches for a board order whose
// autodraft exposures — under the same field model, seat mode, and user
// roster rules as the Simulate panel — approximate a set of user-supplied
// target exposure percentages. Pure algorithm module: no DOM, importable in
// plain Node, and fully deterministic (every batch reuses the same seeded
// runSimulation; the solver itself draws no randomness at all).
//
// Approach: iterative proportional control. Each round runs a fixed-seed
// batch of drafts, compares achieved vs target exposure per targeted player,
// and nudges each targeted player up (below target) or down (above target)
// the board by a step proportional to the error, with a per-player adaptive
// gain (sign flip => halve, steady sign => grow) to damp oscillation.
// Untargeted players are free variables: they only shift to make room and
// their relative order is never changed.
//
// Equilibrium failure is a first-class outcome (status "failed"), never a
// silent bad board:
//   - provably-infeasible target sets (position capacity) fail before any
//     drafts run;
//   - a player pinned at a board boundary for capRounds rounds while still
//     outside tolerance is reported unreachable with its closest achieved
//     value;
//   - oscillation/no-improvement over stallRounds rounds, or the round
//     budget running out, stops the search and reports the best board found
//     with every still-unmet target listed.

import { runSimulation, SIM_DEFAULTS } from "./simulator.js";

export const SOLVER_DEFAULTS = {
  batchIterations: 500, // drafts per evaluation batch (fixed seed => comparable rounds)
  maxRounds: 40, // hard budget of solver rounds
  tolerance: 0.03, // fraction (0.03 = ±3 percentage points) per target
  stallRounds: 8, // stop after this many rounds without best-score improvement
  minImprovement: 0.002, // score must drop by this to count as improvement
  capRounds: 3, // consecutive at-boundary rounds outside tolerance => unreachable
  stepScale: 0.5, // rank shift = |err| * boardSize * stepScale * gain
  gainInit: 1,
  gainGrow: 1.25,
  gainShrink: 0.5,
  gainMin: 0.05,
  gainMax: 4,
  confirmSlack: 0.5, // confirm batch may exceed tolerance by this fraction of it
  confirmSeedOffset: 1000003, // confirm batch seed = seed + this (fresh stream)
};

// Rebuilds `order` with each id in `desiredIdx` moved to (approximately) its
// desired index. Non-moving players keep their exact relative order; movers
// are inserted lowest-desired-index first.
function applyMoves(order, desiredIdx) {
  const moving = new Set(desiredIdx.keys());
  const out = order.filter((id) => !moving.has(id));
  const inserts = [...desiredIdx.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id, idx] of inserts) {
    out.splice(Math.max(0, Math.min(idx, out.length)), 0, id);
  }
  return out;
}

// All players whose board index changed between two orders: [{id, from, to}],
// 1-indexed ranks, sorted by |to - from| descending. UI diff helper.
export function diffOrders(before, after) {
  const beforeIdx = new Map(before.map((id, i) => [id, i]));
  const moves = [];
  after.forEach((id, i) => {
    const b = beforeIdx.get(id);
    if (b != null && b !== i) moves.push({ id, from: b + 1, to: i + 1 });
  });
  moves.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return moves;
}

function fmtPct(frac) {
  return `${(frac * 100).toFixed(1)}%`;
}

// solveTargets({ players, initialOrder, targets, userSlot, params, seed,
//                schedule, solver, onProgress })
//   players/userSlot/params/seed/schedule: exactly as runSimulation (C-sim);
//     params.iterations is ignored — the solver sets it per batch.
//   initialOrder: string[] ids, the user's current board order (start point).
//   targets: [{ id, pct }] with pct a FRACTION in [0, 1]; unlisted players
//     are free variables.
//   solver: partial SOLVER_DEFAULTS override.
//   onProgress: ({ phase:"batch"|"round", round, rounds, done, total,
//     score? }) => void — batch ticks per draft, one "round" call per round.
// Returns {
//   status: "converged" | "failed",
//   reasons: string[],            // plain-language failure reasons ([] when converged)
//   order: string[],              // proposed board (best found; == initialOrder on precheck failure)
//   perTarget: [{ id, target, achieved, rankBefore, rankAfter, withinTol, reachable, note }],
//   tolerance, roundsUsed, draftsRun,
//   confirmed: boolean,           // achieved values re-verified on a fresh seed
// }
export function solveTargets({ players, initialOrder, targets, userSlot, params, seed, schedule, solver, onProgress }) {
  const P = { ...SOLVER_DEFAULTS, ...(solver || {}) };
  const tol = P.tolerance;
  const order0 = Array.isArray(initialOrder) ? initialOrder.slice() : [];
  const n = order0.length;
  const playerById = new Map((players || []).map((p) => [p.id, p]));
  const inOrder = new Set(order0);

  // ---- validate + dedupe targets (first occurrence of an id wins) ----------
  const tgts = [];
  const seen = new Set();
  const reasons = [];
  for (const t of targets || []) {
    if (!t || seen.has(t.id)) continue;
    const pct = Number(t.pct);
    if (!playerById.has(t.id) || !inOrder.has(t.id)) {
      reasons.push(`Target skipped: player ${t && t.id} is not on the board.`);
      continue;
    }
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
      reasons.push(`Target skipped: ${playerById.get(t.id).name} has an invalid percentage.`);
      continue;
    }
    seen.add(t.id);
    tgts.push({ id: t.id, pct });
  }

  const failNow = (why) => ({
    status: "failed",
    reasons: [...reasons, ...why],
    order: order0,
    perTarget: tgts.map((t) => ({
      id: t.id,
      target: t.pct,
      achieved: null,
      rankBefore: order0.indexOf(t.id) + 1,
      rankAfter: order0.indexOf(t.id) + 1,
      withinTol: false,
      reachable: false,
      note: "",
    })),
    tolerance: tol,
    roundsUsed: 0,
    draftsRun: 0,
    confirmed: false,
  });

  if (!tgts.length) return failNow(["No valid targets to solve for."]);

  // ---- provable-infeasibility prechecks (no drafts needed) -----------------
  // With the user's roster rules, every draft puts at most userPosMax[pos]
  // (exactly, for a fixed build) players of a position on the user's roster,
  // so exposure fractions at one position can never sum past that count.
  const nRounds = params && Number.isFinite(params.nRounds) ? params.nRounds : SIM_DEFAULTS.nRounds;
  const posCap = (pos) => {
    const um = params && params.userPosMax;
    if (um && Number.isFinite(um[pos])) return um[pos];
    return Number.isFinite(SIM_DEFAULTS.posMax[pos]) ? SIM_DEFAULTS.posMax[pos] : Infinity;
  };
  const rostered = new Set(Object.keys(SIM_DEFAULTS.posMin));
  const preFail = [];
  const sumByPos = {};
  let sumAll = 0;
  for (const t of tgts) {
    const pl = playerById.get(t.id);
    if (!rostered.has(pl.pos)) {
      preFail.push(`${pl.name} (${pl.pos}) plays a position the autodraft simulation never rosters — any target above 0% is unreachable.`);
      continue;
    }
    sumByPos[pl.pos] = (sumByPos[pl.pos] || 0) + t.pct;
    sumAll += t.pct;
  }
  for (const pos of Object.keys(sumByPos)) {
    const cap = posCap(pos);
    if (sumByPos[pos] > cap + 1e-9) {
      preFail.push(
        `${pos} targets add up to ${(sumByPos[pos] * 100).toFixed(0)}% of a roster, but your build only takes ${cap} ${pos}${cap === 1 ? "" : "s"} (${cap * 100}% total) — jointly impossible.`
      );
    }
  }
  if (sumAll > nRounds + 1e-9) {
    preFail.push(`All targets together add up to ${(sumAll * 100).toFixed(0)}% of a roster across ${nRounds} rounds (${nRounds * 100}% total) — jointly impossible.`);
  }
  if (preFail.length) return failNow(preFail);

  // ---- iterative search -----------------------------------------------------
  const report = (phase, round, done, total, extra) => {
    if (onProgress) onProgress({ phase, round, rounds: P.maxRounds, done, total, ...(extra || {}) });
  };
  const evaluate = (ord, seedUse, round) => {
    const res = runSimulation({
      players,
      userOrder: ord,
      userSlot,
      params: { ...(params || {}), iterations: P.batchIterations },
      seed: seedUse,
      schedule,
      onDraftDone: (done, total) => report("batch", round, done, total),
    });
    return new Map(res.exposures.map((e) => [e.id, e.pct]));
  };

  let order = order0.slice();
  const gain = new Map(tgts.map((t) => [t.id, P.gainInit]));
  const lastSign = new Map();
  const pinned = new Map(tgts.map((t) => [t.id, 0]));
  const unreachable = new Map(); // id -> note
  let best = { score: Infinity, order: order.slice(), expo: null, round: 0 };
  let stall = 0;
  let draftsRun = 0;
  let roundsUsed = 0;
  let converged = false;
  let confirmed = false;
  let finalExpo = null;
  let stopReason = null;

  for (let r = 1; r <= P.maxRounds; r++) {
    roundsUsed = r;
    const expo = evaluate(order, seed, r);
    draftsRun += P.batchIterations;
    const rankOf = new Map(order.map((id, i) => [id, i]));

    // errors for still-active targets
    const errs = new Map();
    let activeMax = 0;
    for (const t of tgts) {
      if (unreachable.has(t.id)) continue;
      const a = expo.get(t.id) || 0;
      const err = a - t.pct;
      errs.set(t.id, err);
      if (Math.abs(err) > activeMax) activeMax = Math.abs(err);
    }

    // boundary / unreachable detection: a player already pinned to an end of
    // the board and still outside tolerance can't be pushed any further.
    for (const t of tgts) {
      if (unreachable.has(t.id) || !errs.has(t.id)) continue;
      const err = errs.get(t.id);
      const idx = rankOf.get(t.id);
      const atTop = idx === 0 && err < -tol;
      const atBottom = idx === n - 1 && err > tol;
      if (atTop || atBottom) {
        const c = pinned.get(t.id) + 1;
        pinned.set(t.id, c);
        if (c >= P.capRounds) {
          const a = expo.get(t.id) || 0;
          const name = playerById.get(t.id).name;
          unreachable.set(
            t.id,
            atTop
              ? `${name} caps at ~${fmtPct(a)} even ranked #1 on your board — ${fmtPct(t.pct)} is unreachable from this seat and build.`
              : `${name} still lands at ~${fmtPct(a)} even ranked last on your board — can't get down to ${fmtPct(t.pct)}.`
          );
          errs.delete(t.id);
        }
      } else {
        pinned.set(t.id, 0);
      }
    }
    // recompute activeMax after any freezes this round
    activeMax = 0;
    for (const [, err] of errs) if (Math.abs(err) > activeMax) activeMax = Math.abs(err);

    report("round", r, P.batchIterations, P.batchIterations, { score: activeMax });

    // best-so-far + stall tracking (active targets only; unreachable gaps are
    // fixed and would otherwise mask real progress)
    if (activeMax < best.score - P.minImprovement) stall = 0;
    else stall++;
    if (activeMax < best.score) best = { score: activeMax, order: order.slice(), expo, round: r };

    if (errs.size === 0) {
      // every target is unreachable — nothing left to optimize
      stopReason = "unreachable";
      order = best.order;
      finalExpo = best.expo || expo;
      break;
    }

    if (activeMax <= tol) {
      // candidate convergence — re-verify on a fresh seed so we never report
      // a board that only fit this batch seed's noise
      const confirmExpo = evaluate(order, seed + P.confirmSeedOffset, r);
      draftsRun += P.batchIterations;
      let confirmMax = 0;
      for (const t of tgts) {
        if (unreachable.has(t.id)) continue;
        const err = Math.abs((confirmExpo.get(t.id) || 0) - t.pct);
        if (err > confirmMax) confirmMax = err;
      }
      if (confirmMax <= tol * (1 + P.confirmSlack)) {
        converged = unreachable.size === 0;
        confirmed = true;
        finalExpo = confirmExpo;
        stopReason = unreachable.size ? "unreachable" : "converged";
        break;
      }
      // fresh-seed check failed: keep iterating from where we are
      stall = 0; // the confirm miss is new information, not a stall
    }

    if (stall >= P.stallRounds) {
      stopReason = "stalled";
      order = best.order;
      finalExpo = best.expo;
      break;
    }

    // ---- movement: proportional step with per-player adaptive gain ----------
    const desired = new Map();
    for (const [id, err] of errs) {
      if (Math.abs(err) <= tol) continue; // inside tolerance — leave it alone
      const s = err > 0 ? 1 : -1;
      const prev = lastSign.get(id);
      let g = gain.get(id);
      if (prev != null) {
        g = prev !== s ? Math.max(P.gainMin, g * P.gainShrink) : Math.min(P.gainMax, g * P.gainGrow);
        gain.set(id, g);
      }
      lastSign.set(id, s);
      const shift = Math.max(1, Math.round(Math.abs(err) * n * P.stepScale * g));
      // achieved too high (err > 0) => move DOWN the board (bigger index)
      const idx = rankOf.get(id) + s * shift;
      desired.set(id, Math.max(0, Math.min(n - 1, idx)));
    }
    if (desired.size) order = applyMoves(order, desired);
  }

  if (!stopReason) {
    // round budget exhausted
    stopReason = "budget";
    order = best.order;
    finalExpo = best.expo;
  }

  // ---- report ---------------------------------------------------------------
  const rankAfter = new Map(order.map((id, i) => [id, i + 1]));
  const rankBefore = new Map(order0.map((id, i) => [id, i + 1]));
  const perTarget = tgts.map((t) => {
    const achieved = finalExpo ? finalExpo.get(t.id) || 0 : null;
    return {
      id: t.id,
      target: t.pct,
      achieved,
      rankBefore: rankBefore.get(t.id) || null,
      rankAfter: rankAfter.get(t.id) || null,
      withinTol: achieved != null && Math.abs(achieved - t.pct) <= tol * (1 + P.confirmSlack),
      reachable: !unreachable.has(t.id),
      note: unreachable.get(t.id) || "",
    };
  });

  if (!converged) {
    for (const note of unreachable.values()) reasons.push(note);
    if (stopReason === "stalled") {
      reasons.push(
        `No equilibrium: no improvement over the last ${P.stallRounds} rounds — the remaining targets appear jointly incompatible. Closest board found is shown.`
      );
    } else if (stopReason === "budget") {
      reasons.push(`Stopped after ${P.maxRounds} rounds without reaching every target within ±${(tol * 100).toFixed(0)}%. Closest board found is shown.`);
    }
    for (const pt of perTarget) {
      if (pt.reachable && !pt.withinTol) {
        const name = playerById.get(pt.id).name;
        reasons.push(`${name}: closest achieved ${pt.achieved == null ? "—" : fmtPct(pt.achieved)} vs target ${fmtPct(pt.target)}.`);
      }
    }
  }

  return {
    status: converged ? "converged" : "failed",
    reasons: converged ? [] : reasons,
    order,
    perTarget,
    tolerance: tol,
    roundsUsed,
    draftsRun,
    confirmed,
  };
}
