// src/core/editor.js — canonical board-editor engine, ported to a config-driven,
// platform-agnostic ESM module (contract C2). Implements createEditor exactly as
// specified in CONTRACTS.md. Pure logic is exported as named helpers so it is
// node-testable without a DOM (see scripts/check-editor.mjs). All DOM access lives
// inside function bodies invoked from createEditor(); nothing touches `document`
// or `window` at module top level, so this file imports cleanly under plain Node.
//
// cadence.js (contract C-cadence) is loaded lazily via dynamic import inside
// applyCadence/previewCadence so this module — and its pure helpers — can be
// imported/tested even before/without that sibling module being present.

const MAX_HISTORY = 120;

// SortableJS is a DOM-only library (its UMD wrapper is safe to `require()`
// under plain Node, but there is no reason to pay the import cost — or risk
// future versions touching `window` at load — for a module whose pure
// helpers below are exercised by scripts/check-editor.mjs with no DOM at
// all). Loaded lazily, once, on first use from inside createEditor's
// DOM-rendering path; cached so multiple editor instances share one import.
let SortablePromise;
function getSortable() {
  return (SortablePromise ??= import("sortablejs").then((m) => m.default ?? m));
}

/* ============================================================
 * Pure helpers — exported, no DOM, node-testable
 * ============================================================ */

// 1-indexed rank of `id` within `order`, or -1 if not present.
export function rankOf(order, id) {
  const idx = order.indexOf(id);
  return idx === -1 ? -1 : idx + 1;
}

// Move `ids` (as a contiguous block, preserving their relative order) so the
// block sits immediately before `beforeId` (null = end of the list).
export function moveIdsBefore(order, ids, beforeId) {
  const set = new Set(ids);
  const moving = order.filter((id) => set.has(id));
  const rest = order.filter((id) => !set.has(id));
  if (beforeId == null) return rest.concat(moving);
  // beforeId is either inside the moving set itself or absent from the order
  // entirely (both show up as "not found" in `rest`) — either way there is
  // no valid anchor to insert before, so leave the order unchanged instead
  // of silently appending the block to the end.
  const idx = rest.indexOf(beforeId);
  if (idx < 0) return order.slice();
  return rest.slice(0, idx).concat(moving, rest.slice(idx));
}

// Move `ids` (as a contiguous block, preserving their relative order) so the
// block starts at 1-based rank `rank`.
export function moveIdsToRank(order, ids, rank) {
  const set = new Set(ids);
  const moving = order.filter((id) => set.has(id));
  const rest = order.filter((id) => !set.has(id));
  const idx = Math.max(0, Math.min(rest.length, rank - 1));
  return rest.slice(0, idx).concat(moving, rest.slice(idx));
}

// Validates a restored/stored order array against the freshly-parsed file
// order before trusting it as the initial board: same length, every id still
// present in the current file, and no duplicate ids (a duplicate silently
// drops a player from the board since a Set/Map-backed order can't hold two
// slots for the same id).
export function isValidStoredOrder(storedOrder, fileOrder) {
  if (!Array.isArray(storedOrder) || storedOrder.length !== fileOrder.length) return false;
  const idSet = new Set(fileOrder);
  if (!storedOrder.every((id) => idSet.has(id))) return false;
  return new Set(storedOrder).size === fileOrder.length;
}

// When the user clicks a rank cell / starts a drag on `id`, resolve which ids
// actually move: the whole multi-selection if `id` is part of a >1 selection,
// otherwise just `id` itself.
export function resolveMoveTargets(order, selection, id) {
  if (selection && selection.has(id) && selection.size > 1) {
    return order.filter((x) => selection.has(x));
  }
  return [id];
}

// File-order default board: not currently used for loadPlayers() (contract
// requires literal file order there), but exposed as a pure helper because
// several platforms' file order IS their ADP order and a "seed to ADP" shell
// action can reuse it without reimplementing the sort.
export function buildAdpOrder(players) {
  const withAdp = players
    .filter((p) => p.adp != null)
    .slice()
    .sort((a, b) => a.adp - b.adp)
    .map((p) => p.id);
  const noAdp = players.filter((p) => p.adp == null).map((p) => p.id);
  return withAdp.concat(noAdp);
}

// Arrow/delta between a reference-ish number (adp or reference rank) and the
// player's current board rank. decimal:true rounds the delta (used for ADP,
// which can be fractional); decimal:false expects an already-integer rank.
export function computeArrowDelta(sourceValue, boardRank, { decimal = false } = {}) {
  if (sourceValue == null || boardRank == null) return { cls: "na", text: "—", magnitude: null };
  const d = sourceValue - boardRank;
  const mag = decimal ? Math.round(d) : d;
  if (mag > 0) return { cls: "up", text: "▲" + Math.abs(mag), magnitude: mag };
  if (mag < 0) return { cls: "down", text: "▼" + Math.abs(mag), magnitude: mag };
  return { cls: "even", text: "•", magnitude: 0 };
}

// Edge highlight: true when the market (adp) and a reference disagree about
// direction relative to the current board rank (one thinks the player should
// go earlier, the other later — the user is "sitting on an edge").
export function isEdge(adpValue, refValue, boardRank) {
  if (adpValue == null || refValue == null) return false;
  const da = adpValue - boardRank; // + => market thinks later than board
  const de = refValue - boardRank; // + => reference thinks later than board
  return (da > 0.5 && de < 0) || (da < -0.5 && de > 0);
}

// Look up a player's rank in a C4 ReferenceSource (or null if absent/unmatched).
export function refRankFor(player, source) {
  if (!player || !source || !source.byName) return null;
  const r = source.byName.get(player.nameKey);
  return typeof r === "number" ? r : null;
}

export function matchesSearch(player, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${player.name || ""} ${player.team || ""}`.toLowerCase();
  return hay.includes(q);
}

// pool = has ADP or at least one active reference rank.
export function inPool(player, refRanks) {
  if (player.adp != null) return true;
  return (refRanks || []).some((r) => r != null);
}

// filt: {pos, q, pool: "pool"|"all", edges}. refRanks: [refRank0|null, refRank1|null]
// for THIS player (already resolved via refRankFor). Filters affect view only.
export function passesFilters(player, boardRank, filt, refRanks) {
  const ranks = refRanks || [];
  if (filt.pos && filt.pos !== "ALL" && player.pos !== filt.pos) return false;
  if (filt.pool === "pool" && !inPool(player, ranks)) return false;
  if (!matchesSearch(player, filt.q)) return false;
  if (filt.edges) {
    const primary = ranks.find((r) => r != null) ?? null;
    if (!isEdge(player.adp, primary, boardRank)) return false;
  }
  return true;
}

// Tier number (1-indexed) a given rank falls into, given sorted tier-break ranks.
export function tierNumberForRank(rank, sortedBreaks) {
  return sortedBreaks.filter((b) => b <= rank).length + 1;
}

// Banded-row parity (0/1) for a rank — alternates every tier.
export function tierBandForRank(rank, sortedBreaks) {
  return (tierNumberForRank(rank, sortedBreaks) - 1) % 2;
}

/* ---- pure undo/redo stack helpers (immutable-style; caller holds the ref) ---- */

export function createHistoryState() {
  return { undo: [], redo: [] };
}

// Push a snapshot of the state BEFORE a mutation. Clears the redo stack (new
// timeline branch), caps at MAX_HISTORY entries (oldest dropped first).
export function pushHistory(history, snapshot, max = MAX_HISTORY) {
  const cloned = { order: snapshot.order.slice(), tiers: snapshot.tiers.slice() };
  let undo = history.undo.concat([cloned]);
  if (undo.length > max) undo = undo.slice(undo.length - max);
  return { undo, redo: [] };
}

// Pop the most recent undo snapshot, pushing `current` onto redo.
// Returns null if there's nothing to undo.
export function popUndo(history, current) {
  if (!history.undo.length) return null;
  const undo = history.undo.slice();
  const snapshot = undo.pop();
  const redo = history.redo.concat([{ order: current.order.slice(), tiers: current.tiers.slice() }]);
  return { history: { undo, redo }, snapshot };
}

// Pop the most recent redo snapshot, pushing `current` onto undo.
// Returns null if there's nothing to redo.
export function popRedo(history, current) {
  if (!history.redo.length) return null;
  const redo = history.redo.slice();
  const snapshot = redo.pop();
  const undo = history.undo.concat([{ order: current.order.slice(), tiers: current.tiers.slice() }]);
  return { history: { undo, redo }, snapshot };
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function fmtAdp(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/* ============================================================
 * createEditor — DOM-owning factory (contract C2)
 * ============================================================ */

export function createEditor({ config, mount, storage }) {
  if (!config) throw new Error("createEditor: config is required");
  if (!mount) throw new Error("createEditor: mount is required");

  /* ---- state ---- */
  let players = new Map(); // id -> Player
  let fileOrder = []; // ids in the order parseImport produced them
  let order = []; // current board order (ids)
  let tiers = []; // sorted-on-write array of ranks (>=2) with a break above
  let sel = new Set(); // selected ids
  let anchor = null; // last clicked id, for shift-range selection
  let history = createHistoryState();
  let references = [null, null]; // [ReferenceSource|null, ReferenceSource|null]
  const positions = (config.rosterShape && config.rosterShape.positions) || ["QB", "RB", "WR", "TE"];
  let filt = { pos: "ALL", q: "", pool: "pool", edges: false, tiers: true };

  const changeCbs = [];
  const saveStatusCbs = [];
  let destroyed = false;
  let searchDebounce = null;
  let toastTimer = null;

  /* ---- one-time DOM scaffold ---- */
  mount.classList.add("editor-root");
  if (config.accent) mount.style.setProperty("--accent", config.accent);

  const tabsHtml = ["ALL", ...positions]
    .map((p) => `<button type="button" class="tab${p === "ALL" ? " on" : ""}" data-pos="${p}">${p} <span data-count="${p}">0</span></button>`)
    .join("");

  mount.innerHTML =
    '<div class="editor-toolbar">' +
    '<div class="tabs" data-tabs>' + tabsHtml + "</div>" +
    '<input type="search" class="search" data-search placeholder="Search name or team…" />' +
    '<select class="pool-select" data-pool>' +
    '<option value="pool">Pool</option><option value="all">All</option>' +
    "</select>" +
    '<button type="button" class="toggle" data-edges>Edges</button>' +
    '<button type="button" class="toggle on" data-tiers-toggle>Tiers</button>' +
    '<span class="sel-count" data-sel-count></span>' +
    '<button type="button" data-undo disabled>Undo</button>' +
    '<button type="button" data-redo disabled>Redo</button>' +
    "</div>" +
    '<div class="listwrap" data-listwrap style="position:relative;">' +
    '<div class="list" data-list></div>' +
    "</div>" +
    '<div class="bulk-bar" data-bulk>' +
    '<span data-bulk-count>0</span> selected &middot; move block to rank ' +
    '<input type="number" min="1" data-bulk-rank />' +
    '<button type="button" data-bulk-go>Go</button>' +
    '<button type="button" data-bulk-clear>Clear</button>' +
    "</div>" +
    '<div class="toast" data-toast></div>';

  const el = {
    list: mount.querySelector("[data-list]"),
    listwrap: mount.querySelector("[data-listwrap]"),
    tabs: mount.querySelector("[data-tabs]"),
    search: mount.querySelector("[data-search]"),
    pool: mount.querySelector("[data-pool]"),
    edges: mount.querySelector("[data-edges]"),
    tiersToggle: mount.querySelector("[data-tiers-toggle]"),
    selCount: mount.querySelector("[data-sel-count]"),
    undoBtn: mount.querySelector("[data-undo]"),
    redoBtn: mount.querySelector("[data-redo]"),
    bulk: mount.querySelector("[data-bulk]"),
    bulkCount: mount.querySelector("[data-bulk-count]"),
    bulkRank: mount.querySelector("[data-bulk-rank]"),
    bulkGo: mount.querySelector("[data-bulk-go]"),
    bulkClear: mount.querySelector("[data-bulk-clear]"),
    toast: mount.querySelector("[data-toast]"),
  };
  el.pool.value = filt.pool;

  /* ---- small utils bound to this instance ---- */
  function emitChange() {
    changeCbs.forEach((cb) => {
      try { cb(); } catch (_) { /* listener errors must not break the editor */ }
    });
  }

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  function autosave() {
    const okOrder = storage.set("order", order.slice());
    const okTiers = storage.set("tiers", tiers.slice());
    const ok = okOrder && okTiers;
    const status = ok ? { saved: true, message: "Saved" } : { saved: false, message: "Not saved (storage off)" };
    if (!ok) showToast("Not saved (storage off)");
    saveStatusCbs.forEach((cb) => {
      try { cb(status); } catch (_) { /* noop */ }
    });
    return ok;
  }

  function pushSnapshot() {
    history = pushHistory(history, { order, tiers });
    syncHistoryButtons();
  }

  function syncHistoryButtons() {
    if (el.undoBtn) el.undoBtn.disabled = !(history.undo.length > 0);
    if (el.redoBtn) el.redoBtn.disabled = !(history.redo.length > 0);
  }

  function persistAndRender() {
    autosave();
    render();
    emitChange();
  }

  /* ---- filter/view computation ---- */
  function refRanksFor(player) {
    return [refRankFor(player, references[0]), refRankFor(player, references[1])];
  }

  function visibleIds() {
    const rankMap = new Map();
    order.forEach((id, i) => rankMap.set(id, i + 1));
    return order.filter((id) => {
      const pl = players.get(id);
      if (!pl) return false;
      return passesFilters(pl, rankMap.get(id), filt, refRanksFor(pl));
    });
  }

  function tabCounts() {
    const counts = { ALL: 0 };
    positions.forEach((p) => (counts[p] = 0));
    order.forEach((id) => {
      const pl = players.get(id);
      if (!pl) return;
      if (!inPool(pl, refRanksFor(pl))) return;
      counts.ALL++;
      if (counts[pl.pos] != null) counts[pl.pos]++;
    });
    return counts;
  }

  /* ---- rendering ---- */
  function goldColumnLabel() {
    const col = (config.columns || []).find((c) => c.kind === "gold");
    return (col && col.label) || "ADP";
  }

  function refColumnHtml(pl, slot, boardRank) {
    const source = references[slot];
    if (!source) return "";
    const rank = refRankFor(pl, source);
    const arrow = computeArrowDelta(rank, boardRank, { decimal: false });
    return (
      `<div class="ref src" data-slot="${slot}">` +
      `<span class="rl">${escapeHtml(source.label || "Ref")}</span>` +
      `<span class="rv">${rank != null ? rank : "—"}</span>` +
      `<span class="arrow ${arrow.cls}">${arrow.text}</span>` +
      `</div>`
    );
  }

  function rowHtml(id, rank, band) {
    const pl = players.get(id);
    const adpArrow = computeArrowDelta(pl.adp, rank, { decimal: true });
    const refRanks = refRanksFor(pl);
    const primaryRef = refRanks.find((r) => r != null) ?? null;
    const edge = isEdge(pl.adp, primaryRef, rank);
    const selCls = sel.has(id) ? " selected" : "";
    const bandCls = band ? " band" : "";
    const posCls = String(pl.pos || "").toLowerCase();
    return (
      `<div class="row${selCls}${bandCls}" data-id="${id}">` +
      `<div class="handle" data-drag title="Drag to reorder">⠿</div>` +
      `<button type="button" class="rank" data-rank="${id}">${rank}</button>` +
      `<span class="tier-add" data-tier-add="${rank}" title="Add tier break above">+</span>` +
      `<span class="pos-badge ${posCls}">${escapeHtml(pl.pos)}</span>` +
      `<span class="name">${escapeHtml(pl.name)}</span>` +
      `<span class="team">${escapeHtml(pl.team)}</span>` +
      (edge ? '<span class="edge-dot" title="Market and reference disagree — your edge"></span>' : "") +
      '<div class="refs">' +
      `<div class="ref adp"><span class="rl">${escapeHtml(goldColumnLabel())}</span>` +
      `<span class="rv">${pl.adp != null ? fmtAdp(pl.adp) : "—"}</span>` +
      `<span class="arrow ${adpArrow.cls}">${adpArrow.text}</span></div>` +
      refColumnHtml(pl, 0, rank) +
      refColumnHtml(pl, 1, rank) +
      "</div>" +
      "</div>"
    );
  }

  function render() {
    const vis = visibleIds();
    const rankMap = new Map();
    order.forEach((id, i) => rankMap.set(id, i + 1));
    const sortedBreaks = tiers.slice().sort((a, b) => a - b);

    let html = "";
    if (!vis.length) {
      html = '<div class="empty">No players match these filters.</div>';
    } else if (!players.size) {
      html = '<div class="empty">Upload a file to build your board.</div>';
    }

    let renderedBreaks = 0;
    vis.forEach((id) => {
      const rank = rankMap.get(id);
      if (filt.tiers) {
        while (renderedBreaks < sortedBreaks.length && sortedBreaks[renderedBreaks] <= rank) {
          const tnum = renderedBreaks + 2;
          const brk = sortedBreaks[renderedBreaks];
          html += `<div class="tierbar"><span class="lbl">Tier ${tnum}</span><span class="ln"></span><span class="tier-remove" data-tier-remove="${brk}">remove</span></div>`;
          renderedBreaks++;
        }
      }
      const band = filt.tiers ? tierBandForRank(rank, sortedBreaks) === 1 : false;
      html += rowHtml(id, rank, band);
    });

    el.list.innerHTML = html;

    const counts = tabCounts();
    mount.querySelectorAll("[data-count]").forEach((elm) => {
      const key = elm.getAttribute("data-count");
      elm.textContent = counts[key] != null ? counts[key] : 0;
    });
    if (el.selCount) el.selCount.textContent = sel.size ? `${sel.size} selected` : "";
    if (el.bulk) el.bulk.classList.toggle("show", sel.size > 0);
    if (el.bulkCount) el.bulkCount.textContent = String(sel.size);
    syncHistoryButtons();
  }

  /* ---- selection / rank-edit / tier events ---- */
  function startRankEdit(btn) {
    const id = btn.getAttribute("data-rank");
    const cur = rankOf(order, id);
    btn.innerHTML = `<input type="number" min="1" max="${order.length}" value="${cur}">`;
    const inp = btn.querySelector("input");
    inp.focus();
    inp.select();
    const commit = () => {
      const v = parseInt(inp.value, 10);
      if (Number.isFinite(v) && v >= 1 && v <= order.length && v !== cur) {
        const ids = resolveMoveTargets(order, sel, id);
        pushSnapshot();
        order = moveIdsToRank(order, ids, v);
        persistAndRender();
      } else {
        render();
      }
    };
    inp.addEventListener("blur", commit, { once: true });
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
      if (ev.key === "Escape") { inp.value = String(cur); inp.blur(); }
    });
  }

  function onListClick(e) {
    const untier = e.target.closest("[data-tier-remove]");
    if (untier) {
      const r = +untier.getAttribute("data-tier-remove");
      pushSnapshot();
      tiers = tiers.filter((x) => x !== r);
      persistAndRender();
      return;
    }
    const addt = e.target.closest("[data-tier-add]");
    if (addt) {
      const r = +addt.getAttribute("data-tier-add");
      if (r >= 2 && !tiers.includes(r)) {
        pushSnapshot();
        tiers = tiers.concat([r]).sort((a, b) => a - b);
        persistAndRender();
      }
      return;
    }
    const rk = e.target.closest("[data-rank]");
    if (rk) { startRankEdit(rk); return; }
    const row = e.target.closest(".row");
    if (!row) return;
    if (e.target.closest("[data-drag]") || e.target.closest(".refs")) return;
    const id = row.getAttribute("data-id");
    if (e.shiftKey && anchor) {
      const vis = visibleIds();
      const a = vis.indexOf(anchor);
      const b = vis.indexOf(id);
      if (a > -1 && b > -1) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        sel = new Set();
        for (let i = lo; i <= hi; i++) sel.add(vis[i]);
      }
    } else if (e.metaKey || e.ctrlKey) {
      sel = new Set(sel);
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      anchor = id;
    } else {
      if (sel.size === 1 && sel.has(id)) sel = new Set();
      else sel = new Set([id]);
      anchor = id;
    }
    render();
  }

  /* ---- drag & drop (SortableJS) ----
   * Sortable owns all pointer/touch tracking and DOM animation during the
   * drag itself — we do nothing per-move. State is reconciled exactly once,
   * in onSortEnd, when the drag completes.
   */
  let sortableInstance = null;

  function reducedMotion() {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  // The visible list can be FILTERED, so Sortable's own indices only describe
  // position among the currently-rendered rows. We map that back onto the
  // full board order by anchoring on ids: find the id that now sits right
  // after the dragged block in the (already DOM-reordered) visible rows —
  // insert the block before that id in the full order — or, if the block
  // landed last in the view, insert it right after whichever full-order id
  // (visible or hidden/filtered-out) used to follow the preceding visible
  // row. Either way the anchor is always a real id from the full order, so
  // moveIdsBefore places the block correctly without disturbing hidden ids.
  function onSortEnd(evt) {
    const item = evt.item;
    const draggedId = item && item.getAttribute && item.getAttribute("data-id");
    if (!draggedId) return;

    const visibleNow = Array.from(el.list.querySelectorAll(".row"), (r) => r.getAttribute("data-id"));
    const dragIds = resolveMoveTargets(order, sel, draggedId);
    const dragSet = new Set(dragIds);
    const draggedPos = visibleNow.indexOf(draggedId);

    let beforeId = null;
    for (let i = draggedPos + 1; i < visibleNow.length; i++) {
      if (!dragSet.has(visibleNow[i])) { beforeId = visibleNow[i]; break; }
    }
    if (beforeId == null) {
      let afterId = null;
      for (let i = draggedPos - 1; i >= 0; i--) {
        if (!dragSet.has(visibleNow[i])) { afterId = visibleNow[i]; break; }
      }
      if (afterId != null) {
        const idx = order.indexOf(afterId);
        for (let i = idx + 1; i < order.length; i++) {
          if (!dragSet.has(order[i])) { beforeId = order[i]; break; }
        }
      }
    }

    pushSnapshot();
    order = moveIdsBefore(order, dragIds, beforeId);
    persistAndRender();
  }

  async function mountSortable() {
    try {
      const Sortable = await getSortable();
      if (destroyed) return;
      sortableInstance = Sortable.create(el.list, {
        handle: ".handle",
        draggable: ".row",
        animation: reducedMotion() ? 0 : 120,
        ghostClass: "row-ghost",
        chosenClass: "row-chosen",
        dragClass: "row-drag",
        onEnd: onSortEnd,
      });
    } catch (_) {
      // Sortable failed to load (offline/blocked import, etc). The board
      // still works fully via click-rank-to-type and the bulk-move bar.
    }
  }

  /* ---- toolbar wiring ---- */
  function onTabsClick(e) {
    const t = e.target.closest(".tab");
    if (!t) return;
    mount.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
    t.classList.add("on");
    filt.pos = t.getAttribute("data-pos");
    render();
  }

  function onSearchInput(e) {
    clearTimeout(searchDebounce);
    const v = e.target.value;
    searchDebounce = setTimeout(() => { filt.q = v; render(); }, 110);
  }

  function onPoolChange(e) { filt.pool = e.target.value; render(); }
  function onEdgesToggle(e) { filt.edges = !filt.edges; e.currentTarget.classList.toggle("on", filt.edges); render(); }
  function onTiersToggle(e) { filt.tiers = !filt.tiers; e.currentTarget.classList.toggle("on", filt.tiers); render(); }

  function onBulkClear() { sel = new Set(); render(); }
  function onBulkGo() {
    const v = parseInt(el.bulkRank.value, 10);
    if (!(v >= 1 && v <= order.length) || !sel.size) return;
    pushSnapshot();
    order = moveIdsToRank(order, order.filter((id) => sel.has(id)), v);
    persistAndRender();
  }
  function onBulkRankKeydown(e) { if (e.key === "Enter") onBulkGo(); }

  function onKeydown(e) {
    if (destroyed) return;
    // Only the visible/attached instance should react to global shortcuts.
    if (mount.offsetParent === null && mount !== document.body) return;
    const active = document.activeElement;
    const typing = active && /INPUT|TEXTAREA|SELECT/.test(active.tagName) && !(el.bulkRank && active === el.bulkRank);
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === "z" && !e.shiftKey) {
      if (typing) return;
      e.preventDefault();
      undo();
    } else if ((e.metaKey || e.ctrlKey) && (key === "y" || (key === "z" && e.shiftKey))) {
      if (typing) return;
      e.preventDefault();
      redo();
    } else if (e.key === "Escape") {
      if (sel.size) { sel = new Set(); render(); }
    }
  }

  el.list.addEventListener("click", onListClick);
  el.tabs.addEventListener("click", onTabsClick);
  el.search.addEventListener("input", onSearchInput);
  el.pool.addEventListener("change", onPoolChange);
  el.edges.addEventListener("click", onEdgesToggle);
  el.tiersToggle.addEventListener("click", onTiersToggle);
  el.bulkClear.addEventListener("click", onBulkClear);
  el.bulkGo.addEventListener("click", onBulkGo);
  el.bulkRank.addEventListener("keydown", onBulkRankKeydown);
  el.undoBtn.addEventListener("click", () => undo());
  el.redoBtn.addEventListener("click", () => redo());
  document.addEventListener("keydown", onKeydown);

  /* ---- public API (contract C2) ---- */

  function loadPlayers(list) {
    players = new Map();
    (list || []).forEach((p) => players.set(p.id, p));
    fileOrder = (list || []).map((p) => p.id);
    sel = new Set();
    anchor = null;
    history = createHistoryState();

    let storedOrder = null;
    let storedTiers = null;
    try {
      storedOrder = storage.get("order", null);
      storedTiers = storage.get("tiers", null);
    } catch (_) { /* storage is required to be try/catch-safe internally already */ }

    if (isValidStoredOrder(storedOrder, fileOrder)) {
      order = storedOrder.slice();
      tiers = Array.isArray(storedTiers) ? storedTiers.slice() : [];
    } else {
      order = fileOrder.slice();
      tiers = [];
    }
    render();
    emitChange();
  }

  function hasPlayers() { return players.size > 0; }
  function getPlayers() { return Array.from(players.values()); }
  function getOrder() { return order.slice(); }

  function setOrder(ids, opts = {}) {
    if (!Array.isArray(ids)) return;
    const cur = new Set(order);
    const next = ids.filter((id) => cur.has(id));
    const seen = new Set(next);
    order.forEach((id) => { if (!seen.has(id)) { next.push(id); seen.add(id); } });
    pushSnapshot();
    order = next;
    persistAndRender();
    void opts; // label is accepted for future debugging/telemetry use, not required by rendering
  }

  function getTiers() { return tiers.slice(); }
  function setTiers(t) {
    pushSnapshot();
    tiers = Array.isArray(t) ? t.filter((r) => Number.isFinite(r) && r >= 2).sort((a, b) => a - b) : [];
    persistAndRender();
  }

  function applyReference(slot, source) {
    if (slot !== 0 && slot !== 1) throw new Error("applyReference: slot must be 0 or 1");
    references[slot] = source || null;
    render();
    emitChange();
  }
  function getReferences() { return references.slice(); }

  async function applyCadence(params) {
    const { computeCadence, CADENCE_DEFAULTS } = await import("./cadence.js");
    const fullParams = {
      ...CADENCE_DEFAULTS,
      cap: order.length,
      adpSlotOf: (p) => config.normalizeAdpToSlot(p),
      refRankOf: (p) => refRankFor(p, references[0]) ?? refRankFor(p, references[1]),
      ...(params || {}),
    };
    const result = computeCadence({ order, players, params: fullParams });
    pushSnapshot();
    order = result.newOrder;
    persistAndRender();
    return result;
  }

  async function previewCadence(params) {
    const { computeCadence, CADENCE_DEFAULTS } = await import("./cadence.js");
    const fullParams = {
      ...CADENCE_DEFAULTS,
      cap: order.length,
      adpSlotOf: (p) => config.normalizeAdpToSlot(p),
      refRankOf: (p) => refRankFor(p, references[0]) ?? refRankFor(p, references[1]),
      ...(params || {}),
    };
    return computeCadence({ order, players, params: fullParams });
  }

  function exportCsv(opts) {
    const orderedPlayers = order.map((id) => players.get(id)).filter(Boolean);
    const text = config.serializeExport(orderedPlayers, opts || {});
    return { filename: config.exportFilename, text };
  }

  function undo() {
    const res = popUndo(history, { order, tiers });
    if (!res) return;
    history = res.history;
    order = res.snapshot.order;
    tiers = res.snapshot.tiers;
    persistAndRender();
  }
  function redo() {
    const res = popRedo(history, { order, tiers });
    if (!res) return;
    history = res.history;
    order = res.snapshot.order;
    tiers = res.snapshot.tiers;
    persistAndRender();
  }
  function canUndo() { return history.undo.length > 0; }
  function canRedo() { return history.redo.length > 0; }

  function onChange(cb) { if (typeof cb === "function") changeCbs.push(cb); }

  // Additive convenience hook (not part of the contract's required surface):
  // fires after every autosave attempt with { saved, message } so the shell
  // can surface "Not saved (storage off)". Safe to ignore.
  function onSaveStatus(cb) { if (typeof cb === "function") saveStatusCbs.push(cb); }

  function destroy() {
    destroyed = true;
    clearTimeout(searchDebounce);
    clearTimeout(toastTimer);
    document.removeEventListener("keydown", onKeydown);
    if (sortableInstance) { sortableInstance.destroy(); sortableInstance = null; }
    el.list.removeEventListener("click", onListClick);
    el.tabs.removeEventListener("click", onTabsClick);
    el.search.removeEventListener("input", onSearchInput);
    el.pool.removeEventListener("change", onPoolChange);
    el.edges.removeEventListener("click", onEdgesToggle);
    el.tiersToggle.removeEventListener("click", onTiersToggle);
    el.bulkClear.removeEventListener("click", onBulkClear);
    el.bulkGo.removeEventListener("click", onBulkGo);
    el.bulkRank.removeEventListener("keydown", onBulkRankKeydown);
    mount.innerHTML = "";
    mount.classList.remove("editor-root");
  }

  render();
  mountSortable();

  return {
    loadPlayers,
    hasPlayers,
    getPlayers,
    getOrder,
    setOrder,
    getTiers,
    setTiers,
    applyReference,
    getReferences,
    applyCadence,
    previewCadence,
    exportCsv,
    undo,
    redo,
    canUndo,
    canRedo,
    onChange,
    onSaveStatus,
    destroy,
  };
}
