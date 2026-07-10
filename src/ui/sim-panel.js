// src/ui/sim-panel.js — Simulate panel: runs the autodraft exposure
// simulator (C-sim contract) against the current board in a module Worker
// and renders expected roster exposures. Consumes editor.getPlayers()/
// getOrder() (C2), config.normalizeAdpToSlot (C1), and the injected
// C-storage wrapper for seed bookkeeping + last-run/draft-slot/roster-rule
// persistence (so Δ, and the user's control choices, survive across
// sessions). Pure DOM wiring; only touches `document`/`Worker` inside
// function bodies so this module stays importable under plain Node.
import { openModal, closeModal, showToast, escapeHtml } from "./modals.js";
import schedule from "../data/schedule-wk15-17.json" with { type: "json" };

const ITERATIONS_OPTIONS = [100, 250, 500, 1000, 2000, 5000];
const DEFAULT_ITERATIONS = 250;
const DEFAULT_TEAMS = 12;
const DEFAULT_ROUNDS = 18;
const POS_CHIPS = ["ALL", "QB", "RB", "WR", "TE"];
const ROSTER_POS = ["QB", "RB", "WR", "TE"];
// Defaults mirror SIM_DEFAULTS.posMin/posMax in src/core/simulator.js.
const POS_RULE_DEFAULTS = { QB: [2, 3], RB: [4, 8], WR: [5, 10], TE: [2, 3] };

// Per-editor-instance "board changed since last sim run" flag. Registered
// once per editor (editor.onChange has no unsubscribe, so we must not stack
// listeners across repeated panel opens) and survives across opens/closes —
// editor instances are recreated per platform switch, so WeakMap entries are
// naturally reclaimed when a platform is switched away from.
const boardChangedSince = new WeakMap();
const staleRegistered = new WeakSet();
let currentHintUpdater = null; // set while a sim modal with results is open

function registerStaleTracking(editor) {
  if (staleRegistered.has(editor)) return;
  staleRegistered.add(editor);
  boardChangedSince.set(editor, false);
  editor.onChange(() => {
    boardChangedSince.set(editor, true);
    if (currentHintUpdater) currentHintUpdater();
  });
}

function nextSeed(storage) {
  const n = (Number(storage.get("simSeedCounter", 0)) || 0) + 1;
  storage.set("simSeedCounter", n);
  return n;
}

function buildPctMap(saved) {
  if (!saved || !Array.isArray(saved.exposures) || !saved.exposures.length) return null;
  return new Map(saved.exposures.map((e) => [e.id, e.pct]));
}

function slotLabel(userSlot) {
  if (userSlot === "rotate") return "rotate";
  if (userSlot === "random") return "random";
  return `1.${String(userSlot).padStart(2, "0")}`;
}

// Grammar-correct "N field drafter(s)" phrase for the explainer text — nTeams
// can be as low as 2 (1 field drafter), so this can't be a bare plural.
function fieldDraftersText(n) {
  return `${n} field drafter${n === 1 ? "" : "s"}`;
}

function fmtAdp(adp) {
  if (adp == null) return "—";
  return Number.isInteger(adp) ? String(adp) : adp.toFixed(1);
}

function deltaHtml(pct, deltaBase, id) {
  // pct arrives as display percent (0-100); deltaBase stores raw fractions (0-1).
  if (!deltaBase) return '<span class="sim-row-delta even">·</span>';
  const basePct = (deltaBase.has(id) ? deltaBase.get(id) : 0) * 100;
  const d = Math.round(pct - basePct);
  if (d === 0) return '<span class="sim-row-delta even">·</span>';
  if (d > 0) return `<span class="sim-row-delta up">+${d}%</span>`;
  return `<span class="sim-row-delta down">−${Math.abs(d)}%</span>`;
}

function rowHtml(e, playersById, rankById, deltaBase) {
  const p = playersById.get(e.id);
  const name = p ? p.name : e.id;
  const pos = p ? p.pos : "";
  const posClass = pos.toLowerCase();
  const rank = rankById.get(e.id);
  const pct = (Number(e.pct) || 0) * 100; // e.pct is a fraction (count/drafts)
  const barPct = Math.max(0, Math.min(100, pct));
  return (
    '<div class="sim-row">' +
    (pos ? `<span class="pos-badge ${escapeHtml(posClass)}">${escapeHtml(pos)}</span>` : '<span class="pos-badge"></span>') +
    `<span class="sim-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
    `<span class="sim-row-rank">Rank ${rank || "—"}</span>` +
    `<span class="sim-row-adp">ADP ${escapeHtml(fmtAdp(p ? p.adp : null))}</span>` +
    `<span class="sim-row-bar-wrap"><span class="sim-row-bar" style="width:${barPct}%"></span></span>` +
    `<span class="sim-row-pct">${pct.toFixed(1)}%</span>` +
    deltaHtml(pct, deltaBase, e.id) +
    "</div>"
  );
}

function buildEmptyHtml(config) {
  return (
    '<div class="empty-state sim-empty">' +
    `<h2>No ${escapeHtml(config.label)} board yet</h2>` +
    "<p>Load a player pool to run autodraft exposure simulations.</p>" +
    '<button type="button" class="btn primary" data-empty-import>Upload CSV</button>' +
    "</div>"
  );
}

function buildControlsHtml(config) {
  const slotField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="sim-slot">Draft slot</label></div>' +
    '<select id="sim-slot" class="sel" data-slot></select>' +
    "</div>";

  const iterField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="sim-iterations">Iterations</label></div>' +
    '<select id="sim-iterations" class="sel" data-iterations>' +
    ITERATIONS_OPTIONS.map((n) => `<option value="${n}"${n === DEFAULT_ITERATIONS ? " selected" : ""}>${n}</option>`).join("") +
    "</select>" +
    '<p class="sim-field-hint">±3% at 250 · ±1% at 1000</p>' +
    "</div>";

  const teamsRoundsField =
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="sim-teams">Teams &amp; rounds</label></div>' +
    '<div class="sim-inline-inputs">' +
    `<input type="number" min="2" max="24" class="cadence-number" id="sim-teams" data-teams value="${DEFAULT_TEAMS}" />` +
    `<input type="number" min="1" max="30" class="cadence-number" id="sim-rounds" data-rounds value="${DEFAULT_ROUNDS}" />` +
    "</div>" +
    "</div>";

  const posRuleRow = (pos) => {
    const [min, max] = POS_RULE_DEFAULTS[pos];
    return (
      '<div class="sim-pos-rule">' +
      `<span class="pos-badge ${pos.toLowerCase()}">${pos}</span>` +
      `<input type="number" min="0" max="30" class="cadence-number" data-pos-min="${pos}" value="${min}" aria-label="${pos} minimum" />` +
      '<span class="sim-pos-rule-sep">–</span>' +
      `<input type="number" min="0" max="30" class="cadence-number" data-pos-max="${pos}" value="${max}" aria-label="${pos} maximum" />` +
      "</div>"
    );
  };

  const posRulesField =
    '<div class="cadence-field">' +
    '<p class="cadence-eyebrow">Your roster rules</p>' +
    '<div class="sim-pos-rules" data-pos-rules>' +
    ROSTER_POS.map(posRuleRow).join("") +
    "</div>" +
    '<p class="sim-field-hint down" data-pos-hint hidden></p>' +
    "</div>";

  const chipsHtml = POS_CHIPS.map(
    (pos, i) => `<button type="button" class="sim-chip${i === 0 ? " on" : ""}" data-pos="${pos}">${pos}</button>`
  ).join("");

  return (
    '<p class="cadence-explainer">Your seat autodrafts your board; ' +
    `<span data-field-count>${escapeHtml(fieldDraftersText(DEFAULT_TEAMS - 1))}</span> follow ` +
    `${escapeHtml(config.label)} ADP with realistic noise and stacking. Exposures = share of sims a player lands on your roster.</p>` +
    '<div class="sim-grid">' +
    '<div class="sim-controls cadence-controls">' +
    slotField +
    iterField +
    teamsRoundsField +
    posRulesField +
    '<button type="button" class="btn primary sim-run-btn" data-run>Run simulation</button>' +
    '<div class="sim-progress" data-progress hidden>' +
    '<div class="sim-progress-track"><div class="sim-progress-fill" data-progress-fill></div></div>' +
    '<div class="sim-progress-label" data-progress-label>0 / 0 drafts</div>' +
    "</div>" +
    "</div>" +
    '<div class="sim-results cadence-preview">' +
    '<p class="cadence-summary dim" data-summary>Run a simulation to see exposures.</p>' +
    `<div class="sim-chips" data-chips>${chipsHtml}</div>` +
    '<div class="sim-scroll cadence-scroll" data-list></div>' +
    '<p class="sim-stale" data-stale hidden>Board changed since this run — re-run to refresh.</p>' +
    "</div>" +
    "</div>"
  );
}

export function openSimPanel({ config, editor, storage, onRequestImport }) {
  const hasPlayers = editor.hasPlayers();
  const bodyHtml = hasPlayers ? buildControlsHtml(config) : buildEmptyHtml(config);
  const footHtml = '<span></span><span><button type="button" class="btn ghost" data-close>Close</button></span>';

  let activeWorker = null;
  let running = false;

  function stopWorker() {
    if (!activeWorker) return;
    // Detach handlers BEFORE terminate() so a result/error message already
    // queued on the main thread's event loop cannot fire afterward and
    // persist/render a cancelled run (terminate() alone doesn't retract an
    // already-queued message dispatch).
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
    title: `Autodraft exposures — ${config.label}`,
    bodyHtml,
    footHtml,
    onClose() {
      stopWorker();
      running = false;
      currentHintUpdater = null;
    },
    onMount(modalEl) {
      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);

      if (!hasPlayers) {
        const btn = modalEl.querySelector("[data-empty-import]");
        if (btn) {
          btn.addEventListener("click", () => {
            closeModal();
            if (onRequestImport) onRequestImport();
          });
        }
        return;
      }

      registerStaleTracking(editor);

      const slotSel = modalEl.querySelector("[data-slot]");
      const iterSel = modalEl.querySelector("[data-iterations]");
      const teamsInput = modalEl.querySelector("[data-teams]");
      const roundsInput = modalEl.querySelector("[data-rounds]");
      const posMinInputs = new Map(ROSTER_POS.map((p) => [p, modalEl.querySelector(`[data-pos-min="${p}"]`)]));
      const posMaxInputs = new Map(ROSTER_POS.map((p) => [p, modalEl.querySelector(`[data-pos-max="${p}"]`)]));
      const posHintEl = modalEl.querySelector("[data-pos-hint]");
      const runBtn = modalEl.querySelector("[data-run]");
      const progressWrap = modalEl.querySelector("[data-progress]");
      const progressFill = modalEl.querySelector("[data-progress-fill]");
      const progressLabel = modalEl.querySelector("[data-progress-label]");
      const summaryEl = modalEl.querySelector("[data-summary]");
      const chipsEl = modalEl.querySelector("[data-chips]");
      const listEl = modalEl.querySelector("[data-list]");
      const staleEl = modalEl.querySelector("[data-stale]");
      const fieldCountEl = modalEl.querySelector("[data-field-count]");

      let playersById = new Map(editor.getPlayers().map((p) => [p.id, p]));
      let rankById = new Map(editor.getOrder().map((id, i) => [id, i + 1]));
      let posFilter = "ALL";
      let currentResult = null; // { exposures, drafts, userSlot, deltaBase }

      // Debounce-guard for the storage-off toast: only warn once per panel
      // open rather than on every keystroke/change if persistence keeps failing.
      let warnedStorage = false;
      function persistStorage(key, value) {
        const ok = storage.set(key, value);
        if (!ok && !warnedStorage) {
          warnedStorage = true;
          showToast("Not saved (storage off)");
        }
        return ok;
      }

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
        // The requested slot no longer exists after a teams-count change —
        // persist the fallback so a later reopen doesn't silently reuse a
        // now-invalid saved slot.
        if (fellBack) persistStorage("simUserSlot", slotSel.value);
      }
      function updateFieldCount() {
        const n = Math.max(2, Math.min(24, Number(teamsInput.value) || DEFAULT_TEAMS));
        if (fieldCountEl) fieldCountEl.textContent = fieldDraftersText(n - 1);
      }
      populateSlots(storage.get("simUserSlot", "random"));
      updateFieldCount();
      teamsInput.addEventListener("input", () => {
        populateSlots();
        updateFieldCount();
      });
      slotSel.addEventListener("change", () => {
        persistStorage("simUserSlot", slotSel.value);
      });

      // ---------------------------------------------------- roster-rules group
      const savedPosRules = storage.get("simPosRules", null);
      for (const p of ROSTER_POS) {
        const saved = savedPosRules && savedPosRules[p];
        if (saved && Number.isFinite(saved.min)) posMinInputs.get(p).value = String(saved.min);
        if (saved && Number.isFinite(saved.max)) posMaxInputs.get(p).value = String(saved.max);
      }

      let posRulesValid = true;

      function validatePosRules() {
        const rounds = Math.max(1, Number(roundsInput.value) || DEFAULT_ROUNDS);
        let sumMin = 0;
        let sumMax = 0;
        for (const p of ROSTER_POS) {
          const min = Number(posMinInputs.get(p).value);
          const max = Number(posMaxInputs.get(p).value);
          if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
            return { valid: false, message: `${p} min/max must be non-negative numbers.` };
          }
          if (min > max) {
            return { valid: false, message: `${p} minimum (${min}) is greater than its maximum (${max}).` };
          }
          sumMin += min;
          sumMax += max;
        }
        if (sumMin > rounds) {
          return { valid: false, message: `Position minimums add up to ${sumMin}, more than your ${rounds} rounds.` };
        }
        if (sumMax < rounds) {
          return { valid: false, message: `Position maximums add up to ${sumMax}, fewer than your ${rounds} rounds.` };
        }
        return { valid: true, message: "" };
      }

      function refreshPosRulesValidity() {
        const { valid, message } = validatePosRules();
        posRulesValid = valid;
        posHintEl.textContent = message;
        posHintEl.hidden = valid;
        if (!running) runBtn.disabled = !valid;
      }

      function persistPosRules() {
        const rules = {};
        for (const p of ROSTER_POS) {
          rules[p] = { min: Number(posMinInputs.get(p).value) || 0, max: Number(posMaxInputs.get(p).value) || 0 };
        }
        persistStorage("simPosRules", rules);
      }

      for (const p of ROSTER_POS) {
        [posMinInputs.get(p), posMaxInputs.get(p)].forEach((input) => {
          input.addEventListener("input", () => {
            refreshPosRulesValidity();
            persistPosRules();
          });
        });
      }
      roundsInput.addEventListener("input", refreshPosRulesValidity);
      refreshPosRulesValidity();

      function updateStaleVisibility() {
        const changed = boardChangedSince.get(editor) === true;
        staleEl.hidden = !(changed && !!currentResult);
      }
      currentHintUpdater = updateStaleVisibility;

      function renderResults() {
        if (!currentResult) return;
        const { exposures, drafts, userSlot, deltaBase } = currentResult;
        summaryEl.classList.remove("dim", "warn");
        summaryEl.innerHTML = `<span class="cadence-count">${drafts}</span> drafts · slot ${escapeHtml(slotLabel(userSlot))}`;
        const rows = exposures
          // Persisted runs store only {id, pct} — no count — so test whichever exists.
          .filter((e) => (Number(e.count) || Number(e.pct) || 0) > 0)
          .filter((e) => {
            if (posFilter === "ALL") return true;
            const p = playersById.get(e.id);
            return p && p.pos === posFilter;
          })
          .map((e) => rowHtml(e, playersById, rankById, deltaBase))
          .join("");
        listEl.innerHTML = rows || '<div class="sim-row sim-row-empty">No exposures at this position.</div>';
        updateStaleVisibility();
      }

      chipsEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-pos]");
        if (!btn) return;
        posFilter = btn.getAttribute("data-pos");
        chipsEl.querySelectorAll("[data-pos]").forEach((b) => b.classList.toggle("on", b === btn));
        renderResults();
      });

      // Restore the last persisted run for this platform so Δ has a
      // baseline across sessions. No older data exists to diff the
      // restored snapshot against, so its deltas render as "·".
      const savedRun = storage.get("simLastRun", null);
      if (savedRun && Array.isArray(savedRun.exposures) && savedRun.exposures.length) {
        currentResult = {
          exposures: savedRun.exposures,
          drafts: savedRun.drafts,
          userSlot: savedRun.userSlot,
          deltaBase: null,
        };
        renderResults();
      }
      updateStaleVisibility();

      function setRunning(isRunning) {
        running = isRunning;
        runBtn.textContent = isRunning ? "Cancel" : "Run simulation";
        runBtn.classList.toggle("primary", !isRunning);
        runBtn.classList.toggle("ghost", isRunning);
        progressWrap.hidden = !isRunning;
        const fields = [slotSel, iterSel, teamsInput, roundsInput, ...posMinInputs.values(), ...posMaxInputs.values()];
        fields.forEach((el) => {
          el.disabled = isRunning;
        });
        runBtn.disabled = isRunning ? false : !posRulesValid;
      }

      function startRun() {
        if (!editor.getOrder().length) {
          showToast("Load a player pool first");
          return;
        }
        if (!posRulesValid) {
          showToast("Fix your roster rules before running");
          return;
        }
        const nTeams = Math.max(2, Math.min(24, Number(teamsInput.value) || DEFAULT_TEAMS));
        const nRounds = Math.max(1, Number(roundsInput.value) || DEFAULT_ROUNDS);
        const iterations = Number(iterSel.value) || DEFAULT_ITERATIONS;
        const slotVal = slotSel.value;
        const userSlot = slotVal === "rotate" || slotVal === "random" ? slotVal : Number(slotVal);
        const userPosMin = {};
        const userPosMax = {};
        for (const p of ROSTER_POS) {
          userPosMin[p] = Number(posMinInputs.get(p).value) || 0;
          userPosMax[p] = Number(posMaxInputs.get(p).value) || 0;
        }

        // Snapshot the board fresh for this run so results line up with
        // whatever the payload actually simulated against.
        playersById = new Map(editor.getPlayers().map((p) => [p.id, p]));
        rankById = new Map(editor.getOrder().map((id, i) => [id, i + 1]));

        const payloadPlayers = editor
          .getPlayers()
          .map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team, adp: config.normalizeAdpToSlot(p) }));
        const userOrder = editor.getOrder();
        const seed = nextSeed(storage);
        const deltaBase = buildPctMap(storage.get("simLastRun", null));

        let worker;
        try {
          worker = new Worker(new URL("../workers/sim-worker.js", import.meta.url), { type: "module" });
        } catch (err) {
          showToast("Could not start the simulation worker");
          return;
        }
        activeWorker = worker;
        setRunning(true);
        summaryEl.classList.remove("dim", "warn");
        summaryEl.textContent = "Running…";
        progressFill.style.width = "0%";
        progressLabel.textContent = `0 / ${iterations} drafts`;

        worker.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.type === "progress") {
            const pct = msg.total ? Math.min(100, (msg.done / msg.total) * 100) : 0;
            progressFill.style.width = pct + "%";
            progressLabel.textContent = `${msg.done} / ${msg.total} drafts`;
          } else if (msg.type === "result") {
            stopWorker();
            setRunning(false);
            currentResult = { exposures: msg.exposures, drafts: msg.drafts, userSlot, deltaBase };
            boardChangedSince.set(editor, false);
            const ok = storage.set("simLastRun", {
              exposures: msg.exposures.map((e) => ({ id: e.id, pct: e.pct })),
              drafts: msg.drafts,
              userSlot,
              ts: Date.now(),
            });
            if (!ok) showToast("Not saved (storage off)");
            renderResults();
          } else if (msg.type === "error") {
            stopWorker();
            setRunning(false);
            summaryEl.textContent = `Simulation failed: ${msg.message || "unknown error"}`;
            summaryEl.classList.add("warn");
            showToast("Simulation failed");
          }
        };
        worker.onerror = (err) => {
          stopWorker();
          setRunning(false);
          summaryEl.textContent = "Simulation failed.";
          summaryEl.classList.add("warn");
          showToast(`Simulation failed: ${(err && err.message) || "worker error"}`);
        };

        worker.postMessage({
          cmd: "run",
          payload: {
            players: payloadPlayers,
            userOrder,
            userSlot,
            params: { nTeams, nRounds, iterations, userPosMin, userPosMax },
            seed,
            schedule,
          },
        });
      }

      function cancelRun() {
        stopWorker();
        setRunning(false);
        // A cancelled run is discarded (never persisted, never a Δ baseline);
        // restore the previous results view, or an idle summary if none.
        if (currentResult) {
          renderResults();
        } else {
          summaryEl.textContent = "Cancelled.";
          summaryEl.classList.add("dim");
        }
      }

      runBtn.addEventListener("click", () => {
        if (running) cancelRun();
        else startRun();
      });
    },
  });
}
