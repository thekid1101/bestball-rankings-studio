# AUDIT — Three-platform difference matrix

Source of truth: the three standalone HTML editors in this folder. Scouted 2026-07-09.

| Axis | Underdog (`underdog_rankings_editor (1).html`) | DraftKings (`draftkings_rankings_editor (1).html`) | Drafters (`draft_rankings_editor.html`) |
|---|---|---|---|
| **Import schema** | 11 cols: `id,firstName,lastName,adp,projectedPoints,salary,positionRank,slotName,teamName,lineupStatus,byeWeek` (flexible alias matching, RFC-4180 quoting) | `ID,Name,Position,ADP,Team,,Instructions` (2 trailing blank/Instructions cols) | 7 cols: `id,position,name,preferred,team abbr,ADP,AVG` (flexible alias matching, RFC-4180 quoting) |
| **Join key** | `id` — UUID (36-char). Fallback: normalized name + pos/team tiebreak | `ID` — numeric string (e.g. `1214154`) | `id` — numeric string; falls back to row number if column missing |
| **ADP semantics** | **rewriteAdpColumn**: export rewrites `adp` to integers 1..N in board order, recomputes `positionRank` = `POS`+counter. "keep dash" option: players beyond the last originally-ranked ADP get `adp="-"`, `positionRank=""` (preserves UD's ~380-rank limit) → `keepDeepUnranked` | **rowOrder**: physical row order sets the board; `ADP` column preserved verbatim as market reference, never rewritten | **rewriteAdpColumn** (default "renumber"): `ADP` → integers 1..N in board order; "keep" mode preserves originals. Row order also carries the ranking |
| **Export format** | 11 cols, `\n` line endings, quote-when-needed with `""` escaping, filename `underdog_rankings.csv` | 5 populated cols + 2 empty trailing cols, `\r\n` line endings incl. trailing, conditional quoting (only if `,` `"` or newline), filename `draftkings_rankings.csv` | 7 cols: first 6 **always quoted** (`""` escaping), `AVG` never quoted, `\r\n` line endings, filename `drafters_players.csv` |

## Canonical engine

**DraftKings** — confirmed by scout. It alone has: the Cadence adjuster (λ-pull of QB/TE toward a blended market anchor, provably order-preserving within position), edge detection (market-vs-reference disagreement highlighting), the gold (ADP) + violet (reference) comparison columns with delta arrows, and storage-safety (`try/catch` around localStorage with a "Not saved (storage off)" fallback). Underdog and Drafters are re-expressed as **config adapters** over this engine — no hand-merging.

Cadence math (from DK source): `anchor = w·adpSlot + (1−w)·refRank`; for QB/TE only, `pull = λ·max(0, boardRank − anchor)`, `target = boardRank − pull`; collect targets per position, sort them, reassign to that position's players **in board order** → within-position order can never change. Defaults: `λ_QB = λ_TE = 0.65`, `w = 0.7`, plus a depth cap.

## Proprietary data found (ALL stripped in the unified app)

- **Underdog**: `ETR_DEFAULT` (~line 419) — ~300 UUID→[rank, ownership] pairs labeled "ETR BBM"; plus `RAW` (~line 417), 1,448 embedded player seed rows.
- **DraftKings**: `RAW` array embeds an ETR rank (col 7) and an Underdog rank (col 8) per player; "Seed · ETR" / "Restore" UI paths.
- **Drafters**: `RAW` (~line 327), 2,133 embedded player rows incl. consensus `ADP`/`AVG` columns.

Unified app policy: **starts empty**; all player data comes from the user's uploaded platform export; all reference columns come from user-supplied, user-named uploads matched by normalized name. No scraping, no baked-in rankings of any kind.

## Name normalization (shared, C4)

Adopt the Underdog variant (strictest superset): lowercase → strip diacritics (NFD) → remove `.'’` ` → hyphen→space → strip suffixes `jr|sr|ii|iii|iv|v` (word-bounded) → keep `[a-z0-9 ]` only → collapse whitespace → trim. DK's variant is the same minus diacritics/digits handling; Drafters had none.

## Assumptions recorded (running unattended)

1. **Drafters adpMode = rewriteAdpColumn** (integer renumber, default), matching its source's default radio; row order is also preserved on export, so both consumption styles are satisfied. Its "keep" mode is preserved as an export option.
2. **Drafters export always emits all loaded players** in board order (source exports all 2,133; no pool filtering on export). Unified app exports all players from the uploaded file, deep-unranked included, in board order.
3. **Underdog `esc()` quoting** treated as quote-when-needed with `""` doubling; adapter builder verifies against the source file and replicates byte-exactly.
4. **DK "triangulation row"** named in the brief does not exist as a literal row in the source; triangulation = the three-way board/gold-ADP/violet-reference comparison per row. The unified app keeps that per-row triple + edge detection rather than inventing a new row.
5. **Underdog fractional ADP** on import (decimals allowed) is normalized to overall slot units by `normalizeAdpToSlot` = the raw ADP value (UD ADP is already in overall-pick units); DK and Drafters ADP likewise already overall-slot-scaled; each adapter owns this mapping.
6. **Per-platform state isolation** via distinct localStorage keys `bbrs_underdog_v1`, `bbrs_draftkings_v1`, `bbrs_drafters_v1` (fresh keys; no migration from the legacy single-file apps' keys).
7. **Stack**: Vite + vanilla ESM + hand-written CSS (node v24 present). Deployable to any static host.
