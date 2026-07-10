// src/ui/solver-panel.js — Targets solver panel (reverse mode of Simulate):
// the user sets target exposure percentages for players they care about and
// the solver (src/core/solver.js, run in a module Worker) searches for a
// board order whose autodraft exposures approximate them under the same
// field model, seat mode, and fixed build as the Simulate panel. Equilibrium
// failure is reported plainly; a proposed board is only written to the real
// editor via editor.setOrder (one undo step) after an explicit Apply click.
// Pure DOM wiring; only touches `document`/`Worker` inside function bodies so
// this module stays importable under plain Node.
import { openModal, closeModal, showToast, escapeHtml } from "./modals.js";
import { buildReferenceSource } from "../core/references.js";
import { diffOrders } from "../core/solver.js";
import schedule from "../data/schedule-wk15-17.json" with { type: "json" };

const BATCH_OPTIONS = [250, 500, 1000];
const DEFAULT_BATCH = 500;
const TOL_OPTIONS = [2, 3, 5];
const DEFAULT_TOL = 3;
const DEFAULT_TEAMS = 12;
const DEFAULT_ROUNDS = 18;
const ROSTER_POS = ["QB", "RB", "WR", "TE"];
const FIXED_BUILD_DEFAULTS = { QB: 3, RB: 5, WR: 7, TE: 3 };
const DEFAULT_TARGET_PCT = 20;
const MAX_SUGGESTIONS = 8;

function slotLabel(userSlot) {
  if (userSlot === "rotate") return "rotate";
  if (userSlot === "random") return "random";
  return `1.${String(userSlot).padStart(2, "0")}`;
}

function nextSeed(storage) {
  const n = (Number(storage.get("simSeedCounter", 0)) || 0) + 1;
  storage.set("simSeedCounter", n);
  return n;
}

// "Name, 25" / "Name<TAB>25" / "Name 25%" — one target per line. Returns
// reference-style entries ({name, rank}) where rank carries the PERCENT so
// buildReferenceSource (C4) can do the name matching + report for us.
export function parseTargetLines(text) {
  const entries = [];
  const bad = [];
  for (const raw of String(text || "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[,;\t]\s*([\d.]+)\s*%?\s*$/) || line.match(/^(.*\S)\s+([\d.]+)\s*%?$/);
    if (!m || !/[A-Za-z]/.test(m[1])) {
      bad.push(line);
      continue;
    }
    const pct = Number(m[2]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      bad.push(line);
      continue;
    }
    const name = m[1].replace(/^["']+|["',]+$/g, "").trim();
    if (!name) {
      bad.push(line);
      continue;
    }
    entries.push({ name, rank: pct });
  }
  return { entries, bad };
}

function buildControlsHtml(config) {
  const simDefaults = config.simDefaults || {};
  const teams = Number.isFinite(simDefaults.teams) ? simDefaults.teams : DEFAULT_TEAMS;
  const rounds = Number.isFinite(simDefaults.rounds) ? simDefaults.rounds : DEFAULT_ROUNDS;
  const fixedBuild = simDefaults.fixedBuild || FIXED_BUILD_DEFAULTS;

  const slotField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="solver-slot">Draft slot</label></div>' +
    '<select id="solver-slot" class="sel" data-slot></select>' +
    "</div>";

  const teamsRoundsField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="solver-teams">Teams &amp; rounds</label></div>' +
    '<div class="sim-inline-inputs">' +
    `<input type="number" min="2" max="24" class="cadence-number" id="solver-teams" data-teams value="${teams}" />` +
    `<input type="number" min="1" max="30" class="cadence-number" id="solver-rounds" data-rounds value="${rounds}" />` +
    "</div>" +
    "</div>";

  const posFixedRow = (pos) => {
    const val = Number.isFinite(fixedBuild[pos]) ? fixedBuild[pos] : FIXED_BUILD_DEFAULTS[pos];
    return (
      '<div class="sim-pos-rule sim-pos-fixed">' +
      `<span class="pos-badge ${pos.toLowerCase()}">${pos}</span>` +
      `<input type="number" min="0" max="30" class="cadence-number" data-pos-fixed="${pos}" value="${val}" aria-label="${pos} roster spots" />` +
      "</div>"
    );
  };

  const buildField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><p class="cadence-eyebrow">Your fixed build</p></div>' +
    '<div class="sim-pos-rules" data-pos-rules-fixed>' +
    ROSTER_POS.map(posFixedRow).join("") +
    "</div>" +
    '<p class="sim-fixed-sum" data-fixed-sum></p>' +
    '<p class="sim-field-hint down" data-pos-hint hidden></p>' +
    "</div>";

  const effortField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="solver-batch">Drafts per round &amp; tolerance</label></div>' +
    '<div class="sim-inline-inputs">' +
    '<select id="solver-batch" class="sel" data-batch>' +
    BATCH_OPTIONS.map((n) => `<option value="${n}"${n === DEFAULT_BATCH ? " selected" : ""}>${n}</option>`).join("") +
    "</select>" +
    '<select class="sel" data-tol aria-label="Tolerance">' +
    TOL_OPTIONS.map((n) => `<option value="${n}"${n === DEFAULT_TOL ? " selected" : ""}>±${n}%</option>`).join("") +
    "</select>" +
    "</div>" +
    '<p class="sim-field-hint">A target counts as met within the tolerance.</p>' +
    "</div>";

  return (
    '<p class="cadence-explainer">Reverse mode: set target exposures for the players you care about; ' +
    "the solver searches for a board order whose autodraft exposures approach them — same field model " +
    "and build as Simulate. Players without a target are free to move. If the targets can't be reached " +
    "jointly, it stops and tells you which ones are out of reach.</p>" +
    '<div class="sim-grid">' +
    '<div class="sim-controls cadence-controls">' +
    slotField +
    teamsRoundsField +
    buildField +
    effortField +
    '<button type="button" class="btn primary sim-run-btn" data-run>Solve rankings</button>' +
    '<div class="sim-progress" data-progress hidden>' +
    '<div class="sim-progress-track"><div class="sim-progress-fill" data-progress-fill></div></div>' +
    '<div class="sim-progress-label" data-progress-label></div>' +
    "</div>" +
    "</div>" +
    '<div class="sim-results cadence-preview">' +
    '<p class="cadence-eyebrow">Target exposures</p>' +
    '<div class="solver-add">' +
    '<input type="text" class="search solver-search" data-search placeholder="Search a player to target…" autocomplete="off" />' +
    '<div class="solver-suggest" data-suggest hidden></div>' +
    "</div>" +
    '<div class="solver-target-list" data-target-list></div>' +
    '<button type="button" class="foot-link subtle solver-paste-toggle" data-paste-toggle>Paste a list (Name, %)…</button>' +
    '<div class="solver-paste" data-paste-wrap hidden>' +
    '<textarea data-paste placeholder="Ja&#39;Marr Chase, 35&#10;Bijan Robinson, 20"></textarea>' +
    '<p class="msg" data-paste-report></p>' +
    '<button type="button" class="btn" data-paste-add>Add pasted targets</button>' +
    "</div>" +
    '<p class="cadence-summary dim" data-summary>Add at least one target, then solve.</p>' +
    '<div class="solver-result" data-result hidden>' +
    '<p class="solver-banner" data-banner></p>' +
    '<div class="sim-scroll cadence-scroll solver-result-scroll" data-result-list></div>' +
    '<div class="solver-apply-row">' +
    '<button type="button" class="btn primary" data-apply>Apply to board</button>' +
    '<button type="button" class="btn ghost" data-discard>Discard</button>' +
    "</div>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

export function openSolverPanel({ config, editor, storage }) {
  if (!editor || !editor.hasPlayers()) {
    showToast("Load a player pool first");
    return;
  }

  let activeWorker = null;
  let running = false;

  function stopWorker() {
    if (!activeWorker) return;
    // Detach handlers BEFORE terminate() so an already-queued message can't
    // fire afterward and render a cancelled run (same rule as sim-panel).
    activeWorker.onmessage = null;
    activeWorker.onerror = null;
    try {
      activeWorker.terminate();
    } catch (_) {
      /* ignore */
    }
    activeWorker = null;
  }

  openModal({
    title: `Targets solver — ${config.label}`,
    bodyHtml: buildControlsHtml(config),
    footHtml: '<span></span><span><button type="button" class="btn ghost" data-close>Close</button></span>',
    onClose() {
      stopWorker();
      running = false;
    },
    onMount(modalEl) {
      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);

      const slotSel = modalEl.querySelector("[data-slot]");
      const teamsInput = modalEl.querySelector("[data-teams]");
      const roundsInput = modalEl.querySelector("[data-rounds]");
      const posFixedInputs = new Map(ROSTER_POS.map((p) => [p, modalEl.querySelector(`[data-pos-fixed="${p}"]`)]));
      const fixedSumEl = modalEl.querySelector("[data-fixed-sum]");
      const posHintEl = modalEl.querySelector("[data-pos-hint]");
      const batchSel = modalEl.querySelector("[data-batch]");
      const tolSel = modalEl.querySelector("[data-tol]");
      const runBtn = modalEl.querySelector("[data-run]");
      const progressWrap = modalEl.querySelector("[data-progress]");
      const progressFill = modalEl.querySelector("[data-progress-fill]");
      const progressLabel = modalEl.querySelector("[data-progress-label]");
      const searchInput = modalEl.querySelector("[data-search]");
      const suggestEl = modalEl.querySelector("[data-suggest]");
      const targetListEl = modalEl.querySelector("[data-target-list]");
      const pasteToggle = modalEl.querySelector("[data-paste-toggle]");
      const pasteWrap = modalEl.querySelector("[data-paste-wrap]");
      const pasteArea = modalEl.querySelector("[data-paste]");
      const pasteReport = modalEl.querySelector("[data-paste-report]");
      const pasteAddBtn = modalEl.querySelector("[data-paste-add]");
      const summaryEl = modalEl.querySelector("[data-summary]");
      const resultWrap = modalEl.querySelector("[data-result]");
      const bannerEl = modalEl.querySelector("[data-banner]");
      const resultListEl = modalEl.querySelector("[data-result-list]");
      const applyBtn = modalEl.querySelector("[data-apply]");
      const discardBtn = modalEl.querySelector("[data-discard]");

      const playersById = new Map(editor.getPlayers().map((p) => [p.id, p]));
      const targets = new Map(); // id -> pct (display units, 0-100)
      let currentResult = null; // solveTargets return value from the last finished run
      let runMeta = null; // { initialOrder, userSlot, tolPct } captured at run start

      let warnedStorage = false;
      function persistStorage(key, value) {
        const ok = storage.set(key, value);
        if (!ok && !warnedStorage) {
          warnedStorage = true;
          showToast("Not saved (storage off)");
        }
        return ok;
      }

      // ---------------------------------------------------------- controls
      function populateSlots(forceValue) {
        const n = Math.max(2, Math.min(24, Number(teamsInput.value) || DEFAULT_TEAMS));
        const prev = forceValue != null ? forceValue : slotSel.value;
        slotSel.innerHTML =
          '<option value="random">Random seat (new draw each draft)</option>' +
          `<option value="rotate">Rotate 1–${n}</option>` +
          Array.from({ length: n }, (_, i) => i + 1)
            .map((s) => `<option value="${s}">1.${String(s).padStart(2, "0")}</option>`)
            .join("");
        const opts = Array.from(slotSel.options).map((o) => o.value);
        const fellBack = !opts.includes(prev);
        slotSel.value = fellBack ? "random" : prev;
        if (fellBack) persistStorage("simUserSlot", slotSel.value);
      }
      populateSlots(storage.get("simUserSlot", "random"));
      teamsInput.addEventListener("input", () => {
        populateSlots();
        refreshValidity();
      });
      slotSel.addEventListener("change", () => persistStorage("simUserSlot", slotSel.value));

      // Fixed build shared with the Simulate panel (simPosRules.fixed) so the
      // two stay consistent; the solver always runs in fixed-build mode.
      const savedRules = storage.get("simPosRules", null);
      if (savedRules && typeof savedRules === "object" && savedRules.fixed) {
        for (const p of ROSTER_POS) {
          const v = savedRules.fixed[p];
          if (Number.isFinite(v)) posFixedInputs.get(p).value = String(v);
        }
      }
      function persistBuild() {
        const prev = storage.get("simPosRules", null);
        const fixed = {};
        for (const p of ROSTER_POS) fixed[p] = Number(posFixedInputs.get(p).value) || 0;
        const merged =
          prev && typeof prev === "object" && (prev.mode === "fixed" || prev.mode === "range")
            ? { ...prev, fixed }
            : { mode: "fixed", fixed, range: null };
        persistStorage("simPosRules", merged);
      }

      let buildValid = true;
      function validateBuild() {
        const rounds = Math.max(1, Number(roundsInput.value) || DEFAULT_ROUNDS);
        let sum = 0;
        for (const p of ROSTER_POS) {
          const v = Number(posFixedInputs.get(p).value);
          if (!Number.isFinite(v) || v < 0) return { valid: false, sum, rounds, message: `${p} roster spots must be a non-negative number.` };
          sum += v;
        }
        if (sum !== rounds) return { valid: false, sum, rounds, message: `Build adds up to ${sum}, but the draft is ${rounds} rounds.` };
        return { valid: true, sum, rounds, message: "" };
      }

      function refreshValidity() {
        const { valid, sum, rounds, message } = validateBuild();
        buildValid = valid;
        fixedSumEl.textContent = `${sum} / ${rounds}`;
        fixedSumEl.classList.toggle("down", sum !== rounds);
        posHintEl.textContent = message;
        posHintEl.hidden = valid;
        if (!running) runBtn.disabled = !valid || targets.size === 0;
      }

      for (const p of ROSTER_POS) {
        posFixedInputs.get(p).addEventListener("input", () => {
          refreshValidity();
          persistBuild();
        });
      }
      roundsInput.addEventListener("input", refreshValidity);

      // Batch / tolerance persistence.
      const savedSettings = storage.get("solverSettings", null);
      if (savedSettings && typeof savedSettings === "object") {
        if (BATCH_OPTIONS.includes(Number(savedSettings.batch))) batchSel.value = String(savedSettings.batch);
        if (TOL_OPTIONS.includes(Number(savedSettings.tolPct))) tolSel.value = String(savedSettings.tolPct);
      }
      function persistSettings() {
        persistStorage("solverSettings", { batch: Number(batchSel.value), tolPct: Number(tolSel.value) });
      }
      batchSel.addEventListener("change", persistSettings);
      tolSel.addEventListener("change", persistSettings);

      // ---------------------------------------------------------- targets
      function persistTargets() {
        persistStorage("solverTargets", [...targets.entries()].map(([id, pct]) => ({ id, pct })));
      }

      function targetRowHtml(id, pct) {
        const p = playersById.get(id);
        const rank = editor.getOrder().indexOf(id) + 1;
        const posClass = p ? p.pos.toLowerCase() : "";
        return (
          `<div class="solver-target-row" data-target-row="${escapeHtml(id)}">` +
          `<span class="pos-badge ${escapeHtml(posClass)}">${escapeHtml(p ? p.pos : "")}</span>` +
          `<span class="sim-row-name" title="${escapeHtml(p ? p.name : id)}">${escapeHtml(p ? p.name : id)}</span>` +
          `<span class="sim-row-rank">Rank ${rank || "—"}</span>` +
          `<input type="number" min="0" max="100" step="1" class="cadence-number" data-target-pct value="${pct}" aria-label="Target exposure %" />` +
          '<span class="solver-target-pctsign">%</span>' +
          '<button type="button" class="solver-target-remove" data-target-remove aria-label="Remove target">×</button>' +
          "</div>"
        );
      }

      function renderTargets() {
        if (!targets.size) {
          targetListEl.innerHTML = '<div class="sim-row sim-row-empty">No targets yet — search above or paste a list.</div>';
        } else {
          targetListEl.innerHTML = [...targets.entries()].map(([id, pct]) => targetRowHtml(id, pct)).join("");
        }
        refreshValidity();
      }

      targetListEl.addEventListener("input", (e) => {
        const input = e.target.closest("[data-target-pct]");
        if (!input) return;
        const row = e.target.closest("[data-target-row]");
        const id = row && row.getAttribute("data-target-row");
        if (!id || !targets.has(id)) return;
        const v = Math.max(0, Math.min(100, Number(input.value) || 0));
        targets.set(id, v);
        persistTargets();
        refreshValidity();
      });
      targetListEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-target-remove]");
        if (!btn || running) return;
        const row = e.target.closest("[data-target-row]");
        const id = row && row.getAttribute("data-target-row");
        if (!id) return;
        targets.delete(id);
        persistTargets();
        renderTargets();
      });

      function addTarget(id, pct) {
        if (!playersById.has(id) || targets.has(id)) return;
        targets.set(id, pct);
        persistTargets();
        renderTargets();
      }

      // Restore persisted targets (drop ids no longer in the pool).
      const savedTargets = storage.get("solverTargets", null);
      if (Array.isArray(savedTargets)) {
        for (const t of savedTargets) {
          if (t && playersById.has(t.id) && Number.isFinite(Number(t.pct))) {
            targets.set(t.id, Math.max(0, Math.min(100, Number(t.pct))));
          }
        }
      }

      // ---------------------------------------------------------- search/suggest
      function hideSuggest() {
        suggestEl.hidden = true;
        suggestEl.innerHTML = "";
      }
      function runSuggest() {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) {
          hideSuggest();
          return;
        }
        const hits = [];
        for (const id of editor.getOrder()) {
          if (hits.length >= MAX_SUGGESTIONS) break;
          if (targets.has(id)) continue;
          const p = playersById.get(id);
          if (p && p.name.toLowerCase().includes(q)) hits.push(p);
        }
        if (!hits.length) {
          suggestEl.innerHTML = '<span class="solver-suggest-empty">No matches.</span>';
          suggestEl.hidden = false;
          return;
        }
        suggestEl.innerHTML = hits
          .map(
            (p) =>
              `<button type="button" data-suggest-id="${escapeHtml(p.id)}">` +
              `<span class="pos-badge ${escapeHtml(p.pos.toLowerCase())}">${escapeHtml(p.pos)}</span>` +
              `<span>${escapeHtml(p.name)}</span>` +
              `<span class="solver-suggest-team">${escapeHtml(p.team || "")}</span>` +
              "</button>"
          )
          .join("");
        suggestEl.hidden = false;
      }
      searchInput.addEventListener("input", runSuggest);
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          searchInput.value = "";
          hideSuggest();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const first = suggestEl.querySelector("[data-suggest-id]");
          if (first) first.click();
        }
      });
      suggestEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-suggest-id]");
        if (!btn || running) return;
        addTarget(btn.getAttribute("data-suggest-id"), DEFAULT_TARGET_PCT);
        searchInput.value = "";
        hideSuggest();
        searchInput.focus();
      });
      modalEl.addEventListener("mousedown", (e) => {
        if (!e.target.closest(".solver-add")) hideSuggest();
      });

      // ---------------------------------------------------------- paste list
      pasteToggle.addEventListener("click", () => {
        pasteWrap.hidden = !pasteWrap.hidden;
      });
      pasteAddBtn.addEventListener("click", () => {
        const { entries, bad } = parseTargetLines(pasteArea.value);
        if (!entries.length) {
          pasteReport.textContent = 'No usable lines — expected "Name, 25" (one per line).';
          pasteReport.classList.add("warn");
          pasteReport.classList.remove("ok");
          return;
        }
        // buildReferenceSource does the C4 name matching; entry.rank carries the %.
        const { source, report } = buildReferenceSource("Targets", entries, editor.getPlayers());
        const idByNameKey = new Map();
        for (const id of editor.getOrder()) {
          const p = playersById.get(id);
          if (p && p.nameKey && !idByNameKey.has(p.nameKey)) idByNameKey.set(p.nameKey, id);
        }
        let added = 0;
        for (const [nameKey, pct] of source.byName) {
          const id = idByNameKey.get(nameKey);
          if (!id) continue;
          targets.set(id, Math.max(0, Math.min(100, Number(pct) || 0)));
          added++;
        }
        persistTargets();
        renderTargets();
        const shown = report.unmatched.slice(0, 15).map((u) => `${escapeHtml(u.name)} (${u.rank}%)`).join(", ");
        const extra = report.unmatched.length > 15 ? ` … +${report.unmatched.length - 15} more` : "";
        pasteReport.innerHTML =
          `Matched <strong>${report.matched}/${report.total}</strong> — ${added} target${added === 1 ? "" : "s"} set.` +
          (report.unmatched.length ? `<br />Unmatched: ${shown}${extra}` : "") +
          (bad.length ? `<br />${bad.length} line${bad.length === 1 ? "" : "s"} skipped (no name + % found).` : "");
        pasteReport.classList.toggle("ok", report.matched === report.total && !bad.length);
        pasteReport.classList.toggle("warn", report.matched < report.total || bad.length > 0);
      });

      // ---------------------------------------------------------- run/render
      function setRunning(isRunning) {
        running = isRunning;
        runBtn.textContent = isRunning ? "Cancel" : "Solve rankings";
        runBtn.classList.toggle("primary", !isRunning);
        runBtn.classList.toggle("ghost", isRunning);
        progressWrap.hidden = !isRunning;
        const fields = [
          slotSel,
          teamsInput,
          roundsInput,
          batchSel,
          tolSel,
          searchInput,
          pasteArea,
          pasteAddBtn,
          applyBtn,
          discardBtn,
          ...posFixedInputs.values(),
          ...targetListEl.querySelectorAll("input,button"),
        ];
        fields.forEach((el) => {
          el.disabled = isRunning;
        });
        runBtn.disabled = isRunning ? false : !buildValid || targets.size === 0;
      }

      function fmtPct(frac) {
        return `${(frac * 100).toFixed(1)}%`;
      }

      function renderResult() {
        if (!currentResult) return;
        const res = currentResult;
        const ok = res.status === "converged";
        resultWrap.hidden = false;
        summaryEl.classList.add("dim");
        summaryEl.textContent = `${res.draftsRun} drafts across ${res.roundsUsed} solver rounds · slot ${slotLabel(runMeta.userSlot)} · ±${runMeta.tolPct}% tolerance`;
        bannerEl.classList.toggle("ok", ok);
        bannerEl.classList.toggle("warn", !ok);
        if (ok) {
          bannerEl.innerHTML =
            `<strong>Converged.</strong> Every target within ±${runMeta.tolPct}%` +
            (res.confirmed ? " (re-verified on a fresh seed)." : ".");
        } else {
          bannerEl.innerHTML =
            "<strong>No equilibrium.</strong> " +
            res.reasons.map((r) => escapeHtml(r)).join("<br />") +
            "<br />The closest board found is shown below — you can still apply it.";
        }

        const rows = res.perTarget
          .map((pt) => {
            const p = playersById.get(pt.id);
            const name = p ? p.name : pt.id;
            const posClass = p ? p.pos.toLowerCase() : "";
            const met = pt.achieved != null && Math.abs(pt.achieved - pt.target) <= res.tolerance;
            const deltaCls = met ? "even" : pt.achieved > pt.target ? "up" : "down";
            const moveTxt =
              pt.rankBefore === pt.rankAfter
                ? `stays #${pt.rankBefore}`
                : `#${pt.rankBefore} → #${pt.rankAfter}`;
            return (
              '<div class="sim-row">' +
              `<span class="pos-badge ${escapeHtml(posClass)}">${escapeHtml(p ? p.pos : "")}</span>` +
              `<span class="sim-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
              `<span class="sim-row-rank">${escapeHtml(moveTxt)}</span>` +
              `<span class="sim-row-pct">${pt.achieved == null ? "—" : escapeHtml(fmtPct(pt.achieved))}</span>` +
              `<span class="sim-row-delta ${deltaCls}">target ${escapeHtml(fmtPct(pt.target))}</span>` +
              (pt.reachable ? "" : `<span class="solver-row-flag">unreachable</span>`) +
              "</div>" +
              (pt.note ? `<p class="solver-row-note">${escapeHtml(pt.note)}</p>` : "")
            );
          })
          .join("");

        const moves = diffOrders(runMeta.initialOrder, res.order);
        const targetedIds = new Set(res.perTarget.map((pt) => pt.id));
        const biggest = moves.filter((m) => !targetedIds.has(m.id)).slice(0, 10);
        const movesHtml = biggest.length
          ? '<p class="cadence-eyebrow solver-moves-head">Biggest knock-on moves</p>' +
            biggest
              .map((m) => {
                const p = playersById.get(m.id);
                const cls = m.to < m.from ? "up" : "down";
                return (
                  '<div class="sim-row">' +
                  `<span class="pos-badge ${escapeHtml(p ? p.pos.toLowerCase() : "")}">${escapeHtml(p ? p.pos : "")}</span>` +
                  `<span class="sim-row-name">${escapeHtml(p ? p.name : m.id)}</span>` +
                  `<span class="sim-row-rank">#${m.from} → #${m.to}</span>` +
                  `<span class="sim-row-delta ${cls}">${m.to < m.from ? "▲" : "▼"} ${Math.abs(m.to - m.from)}</span>` +
                  "</div>"
                );
              })
              .join("")
          : "";
        resultListEl.innerHTML =
          rows +
          movesHtml +
          `<p class="solver-row-note">${moves.length} player${moves.length === 1 ? "" : "s"} change rank vs your current board. ` +
          "Untargeted players only shift to make room — their relative order is unchanged.</p>";
      }

      function startRun() {
        if (!buildValid || !targets.size) {
          showToast(targets.size ? "Fix your build before solving" : "Add at least one target");
          return;
        }
        const nTeams = Math.max(2, Math.min(24, Number(teamsInput.value) || DEFAULT_TEAMS));
        const nRounds = Math.max(1, Number(roundsInput.value) || DEFAULT_ROUNDS);
        const slotVal = slotSel.value;
        const userSlot = slotVal === "rotate" || slotVal === "random" ? slotVal : Number(slotVal);
        const build = {};
        for (const p of ROSTER_POS) build[p] = Number(posFixedInputs.get(p).value) || 0;
        const batch = Number(batchSel.value) || DEFAULT_BATCH;
        const tolPct = Number(tolSel.value) || DEFAULT_TOL;

        const payloadPlayers = editor
          .getPlayers()
          .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, adp: config.normalizeAdpToSlot(p) }));
        const initialOrder = editor.getOrder();
        const targetList = [...targets.entries()].map(([id, pct]) => ({ id, pct: pct / 100 }));
        const seed = nextSeed(storage);

        let worker;
        try {
          worker = new Worker(new URL("../workers/solver-worker.js", import.meta.url), { type: "module" });
        } catch (err) {
          showToast("Could not start the solver worker");
          return;
        }
        activeWorker = worker;
        runMeta = { initialOrder, userSlot, tolPct };
        setRunning(true);
        resultWrap.hidden = true;
        summaryEl.classList.remove("dim");
        summaryEl.textContent = "Solving…";
        progressFill.style.width = "0%";
        progressLabel.textContent = "Round 1 — starting…";
        let lastScore = null;

        worker.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.type === "progress") {
            if (msg.phase === "round" && Number.isFinite(msg.score)) lastScore = msg.score;
            const pct = msg.total ? Math.min(100, (msg.done / msg.total) * 100) : 0;
            progressFill.style.width = pct + "%";
            progressLabel.textContent =
              `Round ${msg.round}/${msg.rounds} · ${msg.done}/${msg.total} drafts` +
              (lastScore != null ? ` · max error ${(lastScore * 100).toFixed(1)}%` : "");
          } else if (msg.type === "result") {
            stopWorker();
            setRunning(false);
            currentResult = msg.result;
            renderResult();
          } else if (msg.type === "error") {
            stopWorker();
            setRunning(false);
            summaryEl.textContent = `Solver failed: ${msg.message || "unknown error"}`;
            summaryEl.classList.add("warn");
            showToast("Solver failed");
          }
        };
        worker.onerror = (err) => {
          stopWorker();
          setRunning(false);
          summaryEl.textContent = "Solver failed.";
          summaryEl.classList.add("warn");
          showToast(`Solver failed: ${(err && err.message) || "worker error"}`);
        };

        worker.postMessage({
          cmd: "run",
          payload: {
            players: payloadPlayers,
            initialOrder,
            targets: targetList,
            userSlot,
            params: { nTeams, nRounds, userPosMin: build, userPosMax: build },
            seed,
            schedule,
            solver: { batchIterations: batch, tolerance: tolPct / 100 },
          },
        });
      }

      function cancelRun() {
        stopWorker();
        setRunning(false);
        if (currentResult) {
          renderResult();
        } else {
          summaryEl.textContent = "Cancelled.";
          summaryEl.classList.add("dim");
        }
      }

      runBtn.addEventListener("click", () => {
        if (running) cancelRun();
        else startRun();
      });

      applyBtn.addEventListener("click", () => {
        if (!currentResult || running) return;
        editor.setOrder(currentResult.order, { label: "Targets solver" });
        showToast("Solver board applied — Undo restores your previous order");
        closeModal();
      });
      discardBtn.addEventListener("click", () => {
        if (running) return;
        currentResult = null;
        resultWrap.hidden = true;
        summaryEl.classList.add("dim");
        summaryEl.textContent = "Result discarded. Adjust targets and solve again.";
      });

      renderTargets();
      refreshValidity();
    },
  });
}
