---
name: verify
description: How to build, launch, and drive Bestball Rankings Studio for end-to-end verification.
---

# Verify: Bestball Rankings Studio

Static Vite SPA, no backend. Node 24+.

## Build & launch

```bash
npm run check                      # all module self-checks + no-proprietary-data policy scan
npx vite build                     # must succeed (~62 kB total)
npx vite preview --port 4173 --strictPort   # serve dist/ (run in background)
```

Dev server alternative: `npm run dev` (default port 5173).

## Drive (browser at http://localhost:4173)

1. App boots to the last-active platform (Underdog first run) with an empty state.
2. Import: header "Import" button → paste a synthetic CSV into the textarea → "Load players".
   Platform CSV formats: see CONTRACTS.md C1 / each `scripts/check-<platform>.mjs` fixture.
   Use INVENTED player names only.
3. Flows worth driving: click-a-rank-to-type (rank cell → numeric input → Enter; expect
   delta arrows + "Saved" footer), platform tab switching (state fully isolated per
   platform), hard reload (pool + order restore), Export modal (platform-specific
   options; Underdog = renumber/keep + keep-dash), Cadence modal (live preview),
   garbage paste into Import (expect "0 players parsed" + row warnings, no crash).

## Gotchas

- HTML5 drag-reorder does NOT respond to synthetic CDP mouse drags (left_click_drag);
  dragstart never fires. Drag order-math is covered by `scripts/check-editor.mjs`;
  verifying the DOM drag needs a human or a real input source.
- Screenshots right after a platform-switch click occasionally time out once
  (transient CDP "renderer frozen"); retry succeeds. The page also re-renders at a
  different zoom/scale after switches — re-locate elements via find/read_page instead
  of reusing coordinates.
- localStorage keys: `bbrs_underdog_v1`, `bbrs_draftkings_v1`, `bbrs_drafters_v1`,
  `bbrs_app_v1` (last-active platform). Clear these to reset to first-run state.
