// src/core/cadence.js
// Pure algorithm module — no DOM, no imports of any kind. Ports the "cadence"
// positional-timing adjustment from the reference DraftKings rankings editor
// (see `anchorOf` / `cadenceAdjust` in "draftkings_rankings_editor (1).html").
//
// Math (frozen, see CONTRACTS.md § C-cadence):
//   anchor = w*adpSlot + (1-w)*refRank
//     — if one of adpSlot/refRank is null, anchor falls back to the other;
//     — if both are null, anchor is null and the player is untouched.
//   Only QB and TE participate. For each such player:
//     pull   = (anchor != null && anchor <= cap) ? lam * max(0, boardRank - anchor) : 0
//     target = boardRank - pull
//   (NOTE: the reference gates participation on `anchor <= cap`, not on
//   `boardRank <= cap` — this port matches that exactly.)
//
//   Reassignment (the invariant): per position, collect the participating
//   players' target values in board order, sort those values ascending, then
//   hand them back to the SAME board-ordered id list positionally. Because the
//   raw list is already board-ordered (boardRank strictly increasing) and the
//   sorted targets are handed back sequentially, the resulting per-player slot
//   values are non-decreasing along the original board order — so within-
//   position relative order can never change, even when target values tie.
//
//   The global order is then a single stable-by-construction sort of ALL
//   players by slot value: QB/TE use their reassigned target, everyone else
//   (RB/WR/etc.) uses their original boardRank untouched. Ties are broken by
//   "onesies win" (QB/TE sort before a same-valued non-QB/TE), then by
//   original boardRank — matching the reference's `[val, flag, r, id]` sort.

export const CADENCE_DEFAULTS = { lamQB: 0.65, lamTE: 0.65, w: 0.7 };

const CADENCE_POSITIONS = ["QB", "TE"];

function anchorOf(adpSlot, refRank, w) {
  if (adpSlot != null && refRank != null) return w * adpSlot + (1 - w) * refRank;
  if (adpSlot != null) return adpSlot;
  if (refRank != null) return refRank;
  return null;
}

function toPlayerMap(players) {
  if (players instanceof Map) return players;
  const map = new Map();
  for (const p of players) map.set(p.id, p);
  return map;
}

export function computeCadence({ order, players, params }) {
  const playerMap = toPlayerMap(players);
  const lamQB = params.lamQB ?? CADENCE_DEFAULTS.lamQB;
  const lamTE = params.lamTE ?? CADENCE_DEFAULTS.lamTE;
  const w = params.w ?? CADENCE_DEFAULTS.w;
  const cap = params.cap ?? order.length;
  const { adpSlotOf, refRankOf } = params;
  const lam = { QB: lamQB, TE: lamTE };

  const origRank = new Map();
  order.forEach((id, i) => origRank.set(id, i + 1));

  // newslot: id -> reassigned target value (float), QB/TE only.
  const newslot = new Map();
  const positionIds = {};

  for (const pos of CADENCE_POSITIONS) {
    const ids = order.filter((id) => playerMap.get(id)?.pos === pos);
    const raw = ids.map((id) => {
      const player = playerMap.get(id);
      const r = origRank.get(id);
      const adpSlot = adpSlotOf(player);
      const refRank = refRankOf(player);
      const anchor = anchorOf(adpSlot, refRank, w);
      let pull = 0;
      if (anchor != null && anchor <= cap) {
        pull = lam[pos] * Math.max(0, r - anchor);
      }
      return { id, target: r - pull };
    });
    const tvals = raw.map((x) => x.target).sort((a, b) => a - b);
    raw.forEach((x, i) => newslot.set(x.id, tvals[i]));
    positionIds[pos] = ids;
  }

  // Global reassignment: total order by [slot value, onesie-wins-ties flag, original rank].
  const keyed = order.map((id, i) => {
    const r = i + 1;
    return newslot.has(id) ? [newslot.get(id), 0, r, id] : [r, 1, r, id];
  });
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const newOrder = keyed.map((x) => x[3]);

  const finalRank = new Map();
  newOrder.forEach((id, i) => finalRank.set(id, i + 1));

  // perPosition: ALL QB/TE players (board order), reporting BOARD RANK
  // before/after (not the raw float target) — this is what the reference's
  // preview panel shows movers as.
  const perPosition = {};
  for (const pos of CADENCE_POSITIONS) {
    perPosition[pos] = positionIds[pos].map((id) => ({
      id,
      before: origRank.get(id),
      after: finalRank.get(id),
    }));
  }

  const moves = [];
  for (const id of order) {
    const from = origRank.get(id);
    const to = finalRank.get(id);
    if (from !== to) moves.push({ id, from, to });
  }

  return { newOrder, moves, perPosition };
}
