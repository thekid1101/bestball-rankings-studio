# Bestball Rankings Studio

One static web app for editing and exporting best-ball draft rankings across three
platforms — **Underdog**, **DraftKings**, and **Drafters** — unified from three
standalone single-file editors into a single canonical engine with per-platform
adapters. Dark "war-room" UI, drag-to-reorder board, tiers, undo/redo, reference
comparison columns, and the Cadence adjuster on every platform.

## Run

```bash
npm install
npm run dev        # Vite dev server
npm run build      # production build -> dist/
npm run preview    # serve the production build locally
npm run check      # run every module self-check + policy verification
```

Deploy `dist/` to any static host (Vercel, Netlify, Cloudflare Pages). No backend,
no environment variables, no server config — it is a pure static SPA.

## How it works

1. **Pick a platform** (Underdog / DraftKings / Drafters). Each platform's board,
   references, and settings are fully independent (separate localStorage keys).
2. **Upload that platform's own rankings export CSV.** That file is the only data
   source: it provides the player pool *and* the market ADP (gold column).
3. **Edit**: drag rows (multi-select supported), click a rank number to type a new
   one, add tier breaks, search/filter by position or pool.
4. **Import up to two reference sources** (paste or upload — a header CSV, a
   numbered list, or a bare ranked list). You name each source; players are matched
   by normalized name with a match report. They render as violet comparison columns.
5. **Cadence** (QB/TE timing): pulls behind-market onesie positions toward a blended
   anchor `w·ADP + (1−w)·reference rank` with per-position λ — it never reorders
   players within a position and never touches RB/WR.
6. **Export** a CSV byte-compatible with what the platform expects
   (`underdog_rankings.csv`, `draftkings_rankings.csv`, `drafters_players.csv`),
   with platform-appropriate options (renumber vs keep ADP, Underdog's keep-dash).

## No proprietary data / no scraping — policy

- The app ships **empty**. There are no baked-in rankings, projections, or player
  pools of any kind (the legacy editors' embedded data, including third-party
  rankings, was removed during unification).
- Reference rankings are **user-supplied** and user-named. Any source you have the
  right to use works the same way — a paid service's export, FantasyPros, your own
  projections, a friend's sheet.
- Market ADP comes only from the platform's **own export that you upload**. The app
  never scrapes platform endpoints and never calls the network at all.
- `npm run check` enforces this: it greps the shipped tree for third-party ranking
  references and embedded data blobs and fails the build if any appear.

## Stack rationale

- **Vite + vanilla ESM + hand-written CSS.** The three source apps were framework-free
  single files; the unified app keeps that model, split into contract-bounded modules.
  No component framework or CSS framework to version-chase; the entire app is a few
  small ESM modules and three stylesheets. Vite provides dev server + minified build.
- **One canonical engine, three adapters.** The DraftKings editor (the most evolved:
  Cadence, edge detection, storage-safety) became `src/core/editor.js`; Underdog and
  Drafters differences are expressed entirely as config (`src/platforms/*.js`):
  join key, ADP semantics (row-order vs rewrite-ADP-column), export serialization.
- **localStorage per platform** (`bbrs_<platform>_v1`), always accessed through a
  safe wrapper that degrades to "Not saved (storage off)" instead of crashing.

## Architecture

```
src/
  core/
    editor.js      board engine (contract C2) — rendering, drag, undo, tiers, filters
    cadence.js     pure cadence math (order-preserving within position)
    references.js  reference import: CSV/numbered/bare parsing + name matching
    normalize.js   shared name normalizer (single source of truth)
    storage.js     safe per-platform localStorage wrapper
    adp.js         adpProvider interface (v1: upload-based)
  platforms/
    index.js       registry
    underdog.js    UUID join · rewrite-ADP export · keep-dash deep unranked
    draftkings.js  numeric-ID join · row-order export · ADP preserved verbatim
    drafters.js    numeric-ID join · renumber/keep ADP modes
  ui/              app shell: platform switcher, modals, cadence panel
  styles/          design tokens + war-room component styles
scripts/           per-module self-checks + verify.mjs (run via npm run check)
CONTRACTS.md       the frozen interfaces the modules are built against
AUDIT.md           the three-platform difference matrix and unification decisions
```

## v2: where a backend would slot in

The `adpProvider` interface (`src/core/adp.js`) is the seam. v1's only provider reads
ADP from the uploaded platform export. A v2 backend would add:

- **Licensed auto-ADP**: FantasyPros' consensus best-ball ADP (aggregating DK,
  Underdog, Drafters) offers a licensed API — a server-side provider implementing
  `getAdp(platformId)` keeps keys off the client and respects licensing. No platform
  has an official public ADP API; scraping unofficial endpoints stays off the table.
- **Accounts + cross-device sync**: replace the storage wrapper's localStorage
  backing with a synced store behind the same `get/set` interface.
