# CONTRACTS — frozen integration seams (v1)

Everything below is FROZEN. Builders conform to these signatures exactly; do not invent
or rename fields. Plain ESM (browser-ready, no TypeScript, no bundler-specific syntax).
All modules must also run under plain Node (`node --input-type=module`) for self-checks —
so no top-level DOM access outside `src/ui/` and `src/core/editor.js`'s render functions.

## Canonical Player shape (used everywhere)

```js
// Produced by config.parseImport, consumed by editor/cadence/references/export.
const Player = {
  id: "",        // string — platform join key (UUID for UD, numeric string for DK/Drafters)
  name: "",      // display name, "First Last"
  nameKey: "",   // normalizeName(name) — precomputed by parseImport
  pos: "",       // "QB"|"RB"|"WR"|"TE"|"FB"|... uppercase as found
  team: "",      // team abbreviation/name as the platform provides it
  adp: null,     // number|null — parsed platform ADP (decimal ok); null = unranked ("-", blank)
  raw: {},       // ALL original fields as exact strings from the upload, keyed by
                 // platform-native column name. serializeExport reads from raw so the
                 // round-trip stays byte-faithful. Never mutate raw except documented
                 // ADP/positionRank rewrites at export time.
};
```

## C1 — platform config interface (`src/platforms/*.js`, default export)

```js
export default {
  id: "draftkings",                 // "underdog" | "draftkings" | "drafters"
  label: "DraftKings",
  accent: "#5fa0dd",                // per-platform accent color
  joinKey: "numericId",             // "uuid" | "numericId" | "name"
  adpMode: "rowOrder",              // "rowOrder" | "rewriteAdpColumn"
  keepDeepUnranked: false,          // true only for Underdog ("keep dash" behavior available)
  columns: [                        // board display columns beyond the standard rank/name/pos/team
    // { key: "adp", label: "DK ADP", kind: "gold" }, ...
  ],
  rosterShape: { positions: ["QB","RB","WR","TE"] },
  exportFilename: "draftkings_rankings.csv",

  // Parse the platform's own export upload. NEVER throws on bad rows — skips and warns.
  // Returns players in file order. Must handle RFC-4180 quoting where the platform uses it.
  parseImport(text) { /* -> { players: Player[], warnings: string[] } */ },

  // Byte-faithful serializer. orderedPlayers is the full board in board order.
  // opts: { adpWrite?: "renumber"|"keep", keepDash?: boolean } — only the modes the
  // platform supports; ignore others. Must reproduce the platform's exact header,
  // column order, quoting rules, line endings, and trailing columns/newline.
  serializeExport(orderedPlayers, opts) { /* -> string */ },

  // Map this platform's ADP into overall-slot units for cadence. null if unranked.
  normalizeAdpToSlot(player) { /* -> number|null */ },
};
```

Registry (`src/platforms/index.js`) is written by the orchestrator; adapters just default-export the config.

## C2 — editor-core public API (`src/core/editor.js`)

```js
// One instance per platform; the shell creates/destroys or shows/hides per platform.
export function createEditor({ config, mount, storage }) {
  // config: C1 object; mount: HTMLElement to render the board into;
  // storage: C-storage safe wrapper bound to this platform's key.
  return {
    loadPlayers(players),         // replace the pool (from parseImport); resets order to file order
    hasPlayers(),                 // -> boolean (false = show empty state)
    getPlayers(),                 // -> Player[] (pool, unordered map by id ok — stable array)
    getOrder(),                   // -> string[] of player ids, board order
    setOrder(ids, {label} = {}),  // pushes undo snapshot, re-renders, autosaves
    getTiers(), setTiers(t),      // tier config (banded breaks)
    applyReference(slot, source), // slot: 0|1; source: C4 ReferenceSource|null (null clears)
    getReferences(),              // -> [source0|null, source1|null]
    applyCadence(params),         // params: C-cadence; pushes ONE undo snapshot
    previewCadence(params),       // -> cadence preview object (see C-cadence); no mutation
    exportCsv(opts),              // -> { filename, text } via config.serializeExport
    undo(), redo(), canUndo(), canRedo(),
    onChange(cb),                 // cb() after any order/tier/reference/pool change
    destroy(),                    // remove listeners, detach from mount
  };
}
```

Editor owns: row rendering, drag-reorder w/ insertion indicator, click-rank-to-type,
Shift/Cmd multi-select + bulk move bar, undo/redo (≤120 snapshots of {order,tiers}),
tiers w/ banded breaks, search box + position tabs + pool-vs-all filter (these filter
the VIEW only, never the export), gold ADP + violet reference columns with ▲/▼ deltas,
edge highlighting, autosave via `storage`. Shell owns: header, platform switcher,
import/export/reference/cadence modals & panels (calling this API).

## C3 — CSS design tokens (`src/styles/tokens.css`)

```css
:root {
  --bg:#0b0d12; --bg2:#0e1119; --panel:#12151d; --panel2:#161a24;
  --row:#141824; --row-h:#1a2030; --row-sel:#17263a;
  --edge:#283040; --edge2:#333c50;
  --ink:#e8ecf3; --ink2:#aab3c4; --ink3:#727d92;
  --steel:#5fa0dd; --steel-d:#2b4d6e;
  --gold-t:#f0c56d; --gold-b:#4a3a17;
  --violet:#b39dff; --violet-b:#332a5a;
  --up:#43c98a; --down:#f0655f; --even:#6b7488;
  --shadow:0 10px 30px rgba(0,0,0,.55);
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
/* Position badges: QB #3a1d2b/#ff9fbe/#5a2b3f · RB #123026/#63e3ad/#1e4a3a
   · WR #122a3a/#7cc4f5/#1d425a · TE #332a12/#f0c96d/#4d411d */
```

Component classes (implemented in `src/styles/*.css`): `.row`, `.row.band`, `.rank`,
`.handle`, `.pos-badge.{qb,rb,wr,te}`, `.ref`, `.ref.adp` (gold), `.ref.etr`→rename `.ref.src` (violet),
`.drop-ind`, `.bulk-bar`, `.tabs`, `.toast`, `.modal`, buttons/inputs. 14px base, visible
`:focus-visible` outlines, `@media (prefers-reduced-motion: reduce)` disables transitions,
responsive to ~360px wide.

## C4 — reference-source shape + normalizer (`src/core/references.js`, `src/core/normalize.js`)

```js
// src/core/normalize.js — WRITTEN BY ORCHESTRATOR, import it, don't reimplement.
export function normalizeName(s) { /* lowercase → strip diacritics → drop .'’` →
  hyphen→space → strip word-bounded jr|sr|ii|iii|iv|v → keep [a-z0-9 ] → collapse ws → trim */ }

// ReferenceSource — what applyReference(slot, source) receives:
const ReferenceSource = {
  label: "",                  // user-supplied name, e.g. "ETR", "My projections"
  byName: new Map(),          // Map<nameKey, rank:number> (1-indexed)
};

// src/core/references.js:
export function parseReferenceText(text)
// -> { entries: [{ name, rank, pos?, team? }], format: "csv"|"numbered"|"bare" }
// Accepts: header CSV (Rank,Player,Pos,Team — flexible aliases, RFC-4180),
// numbered lines "1. Name POS TEAM" / "1) Name", or a bare one-name-per-line list
// (line order = rank). Skips blank/junk lines.

export function buildReferenceSource(label, entries, players)
// -> { source: ReferenceSource, report: { matched: n, total: entries.length,
//      unmatched: [{name, rank}] } }
// Match by normalizeName; when two players share a nameKey, prefer pos match, then team.
```

## C5 — adpProvider interface (`src/core/adp.js`)

```js
export const uploadAdpProvider = {
  id: "upload",
  // v1: ADP comes from the platform's own uploaded export (already parsed into players).
  getAdp(platformId, players) { /* -> Map<playerId, adpSlot:number> using
    config.normalizeAdpToSlot; omit unranked */ },
};
// v2 (backend/licensed feed, e.g. FantasyPros API) implements the same interface.
```

## C-cadence — `src/core/cadence.js` (pure, no DOM)

```js
export function computeCadence({ order, players, params })
// order: string[] ids (board order); players: Map<id, Player> or Player[];
// params: { lamQB: 0..1 =0.65, lamTE: 0..1 =0.65, w: 0..1 =0.7, cap: number =order.length,
//           adpSlotOf: (player) => number|null,   // config.normalizeAdpToSlot
//           refRankOf: (player) => number|null }  // active violet source rank, or null
// -> { newOrder: string[], moves: [{ id, from, to }],
//      perPosition: { QB: [{id, before, after}], TE: [...] } }
// Math (FROZEN): anchor = w*adpSlot + (1-w)*refRank (if one input missing, use the other;
// if both missing, player is untouched). QB/TE whose ANCHOR <= cap only (per the DK
// reference implementation — not boardRank <= cap):
// pull = lam * max(0, boardRank - anchor); target = boardRank - pull.
// Collect that position's targets, sort ascending, reassign to the position's players
// IN BOARD ORDER → within-position order is invariant. RB/WR/others never move.
export const CADENCE_DEFAULTS = { lamQB: 0.65, lamTE: 0.65, w: 0.7 };
```

## C-storage — `src/core/storage.js` (WRITTEN BY ORCHESTRATOR)

```js
export function createStorage(platformId)
// -> { get(field, fallback), set(field, value) -> boolean, clear(), available: boolean }
// Backed by localStorage key `bbrs_${platformId}_v1`, JSON blob, every access try/catch;
// set() returns false when persistence failed (UI shows "Not saved (storage off)").
```

## C-sim — autodraft exposure simulator (`src/core/simulator.js`, `src/workers/sim-worker.js`)

Ported from the user's Python field simulator (BBM Draft simulator/sim.py + METHODOLOGY.md
— that folder is the algorithmic source of truth). Pure ESM, no DOM, seeded, importable in
plain Node.

```js
export const SIM_DEFAULTS = {
  nTeams: 12, nRounds: 18, iterations: 200,
  sigmaBase: 0.9, sigmaSlope: 0.065, poolSize: 35,
  maxReachEarly: 18, maxReachMid: 26, maxReachLate: 40,
  archetypes: [["hard",.5,5,1.8],["soft",.38,2.5,1.35],["none",.12,1,1]],
  tasteSd: 0.35, tasteRounds: 8, rbStackDiscount: 0.45, gameStackMinRound: 6,
  posMin: {QB:2,RB:3,WR:4,TE:2}, posMax: {QB:4,RB:8,WR:10,TE:4},
  countPenalty: { /* retuned 2026-07-10: field builds range QB/TE 2-4, RB 3-8,
    WR 4-10 with modes at 3/5/7/3; below-mode more likely than above-mode;
    extreme combos (4QB+4TE) self-suppress below independence */ },
  urgencyStartRound: 10, urgencyMult: 1.35,
};

export function runSimulation({ players, userOrder, userSlot, params, seed, onDraftDone })
// players: [{id, name, pos, team, adp}] — adp null allowed (excluded from the FIELD's
//   candidate pool; still draftable by the user's autodrafter via userOrder).
// userOrder: string[] player ids, the user's full board order.
// userSlot: 1..nTeams, "rotate" (iteration i drafts from slot (i % nTeams)+1), or
//   "random" (seeded uniform random slot per draft — the "randomly seated" mode).
// params.userPosMin / params.userPosMax (optional, COMPLETE {QB,RB,WR,TE} objects):
//   positional constraints for the USER seat only; the field always keeps the
//   calibrated posMin/posMax. Defaults: the field values.
// USER SEAT: deterministic autodraft — highest available player in userOrder subject to
//   posMax caps and forced-fill minimums. No noise. (Forced-fill scans the user's ENTIRE
//   remaining board for a deficit position — broader than the field's window-limited
//   forced fill, by design: a deterministic autodrafter has no candidate window.)
// FIELD SEATS: faithful port of sim.py — softmax/Gumbel pick over top poolSize available
//   by ADP, sigma = base + slope*overall, hard reach caps by round band, archetype stack
//   multipliers (team stack incl. double-stack ^0.65 + RB discount, QB-onto-PC), playoff
//   bring-backs from round gameStackMinRound using the wk15-17 schedule, per-drafter
//   RB/WR taste through tasteRounds, count penalties, urgency, forced fill.
// seed: number — deterministic via a seeded PRNG (mulberry32 or splitmix; Gumbel via
//   -ln(-ln(u))). Same seed + inputs => identical output.
// onDraftDone?: (i, total) => void — progress callback (used by the worker).
// Returns: { exposures: [{ id, count, pct, avgPick, rounds: {r: n} }] (every player the
//   user EVER drafted; sorted by pct desc), drafts, userSlotUsed, elapsedMs? }

// src/workers/sim-worker.js — module worker. postMessage in: {cmd:"run", payload}.
// Messages out: {type:"progress", done, total} (throttled ~10/s),
// {type:"result", exposures, drafts}, {type:"error", message}.
// Cancellation = handler detach + terminate(); no cancel message. The host
// (sim-panel.js) cancels an in-flight run by nulling the worker's
// onmessage/onerror handlers and calling terminate() — there is no graceful
// {cmd:"cancel"} round trip.
// Schedule data: src/data/schedule-wk15-17.json (full team names; factual NFL schedule,
// not proprietary). simulator.js accepts it as an injected param ({schedule}) so the
// core stays pure; a static full-name<->abbr team map inside simulator.js normalizes
// platform team strings (DK abbrs vs UD full names). Game-stack behavior silently
// disables for teams that don't resolve.
```

## Hard invariants (reviewer checks every module against these)

1. No baked-in third-party/paid rankings or player data anywhere. Grep-clean for
   `ETR`, `Establish`, `fantasypros`, and any multi-row inline player arrays.
2. Cadence never reorders players within a position; RB/WR never move.
3. Each adapter's export round-trips byte-identically: parseImport(sample) →
   serializeExport(same order, "keep"-style opts) === sample (modulo documented rewrites).
4. All localStorage access goes through C-storage; nothing else touches storage.
5. File ownership is disjoint; import only from frozen contract modules.
```
