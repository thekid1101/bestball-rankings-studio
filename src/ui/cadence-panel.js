// src/ui/cadence-panel.js — cadence controls + live preview. previewCadence
// is called on every control change and rendered WITHOUT mutating the board;
// Apply calls applyCadence (one undo step). refRankOf/adpSlotOf defaults are
// supplied by editor.js itself (slot 0 else slot 1 else null, config.normalizeAdpToSlot),
// so this panel only needs to send the tunable numeric params.
import { computeArrowDelta } from "../core/editor.js";
import { openModal, closeModal, showToast, escapeHtml } from "./modals.js";

const DEFAULTS = { lamQB: 0.65, lamTE: 0.65, w: 0.7, cap: 208 };
const MAX_ROWS_PER_POSITION = 40;
const DEBOUNCE_MS = 80;

function controlRow(field, label, def, id) {
  return (
    '<div class="cadence-field">' +
    '<div class="cadence-field-row">' +
    `<label for="${id}">${escapeHtml(label)}</label>` +
    `<span class="cadence-readout" data-readout="${field}">${def.toFixed(2)}</span>` +
    "</div>" +
    `<input type="range" id="${id}" min="0" max="1" step="0.05" value="${def}" data-field="${field}" />` +
    "</div>"
  );
}

function moverRow(m, players) {
  const p = players.get(m.id);
  const name = p ? p.name : m.id;
  const posLabel = p && p.pos ? p.pos : "";
  const posClass = posLabel.toLowerCase();
  const arrow = computeArrowDelta(m.from, m.to, { decimal: false });
  return (
    '<div class="cadence-mover-row">' +
    (posLabel ? `<span class="pos-badge ${escapeHtml(posClass)}">${escapeHtml(posLabel)}</span>` : "") +
    `<span class="cadence-mover-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
    `<span class="cadence-mover-nums">${m.from} → ${m.to}</span>` +
    `<span class="arrow ${arrow.cls}">${arrow.text}</span>` +
    "</div>"
  );
}

function positionSection(pos, entries, players) {
  const sorted = entries.slice().sort((a, b) => a.before - b.before);
  const shown = sorted.slice(0, MAX_ROWS_PER_POSITION);
  const rows = shown
    .map((m) => {
      const p = players.get(m.id);
      const name = p ? p.name : m.id;
      const moved = m.before !== m.after;
      const numsHtml = moved
        ? (() => {
            const arrow = computeArrowDelta(m.before, m.after, { decimal: false });
            return `${m.before} → ${m.after} <span class="arrow ${arrow.cls}">${arrow.text}</span>`;
          })()
        : `${m.before} → ${m.after}`;
      return (
        `<div class="cadence-pos-row${moved ? " moved" : ""}">` +
        `<span class="cadence-pos-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
        `<span class="cadence-pos-nums">${numsHtml}</span>` +
        "</div>"
      );
    })
    .join("");
  const extra =
    sorted.length > MAX_ROWS_PER_POSITION
      ? `<div class="cadence-pos-more">… +${sorted.length - MAX_ROWS_PER_POSITION} more</div>`
      : "";
  return (
    '<div class="cadence-pos-block">' +
    `<p class="cadence-eyebrow">${escapeHtml(pos)}</p>` +
    (rows || '<div class="cadence-pos-row">No change.</div>') +
    extra +
    "</div>"
  );
}

function renderPreview(result, players) {
  const n = result.moves.length;
  const moversHtml =
    n > 0
      ? '<div class="cadence-movers">' +
        '<p class="cadence-section-title">Top movers</p>' +
        result.moves
          .slice()
          .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
          .slice(0, 8)
          .map((m) => moverRow(m, players))
          .join("") +
        "</div>"
      : "";

  const qb = positionSection("QB", result.perPosition.QB || [], players);
  const te = positionSection("TE", result.perPosition.TE || [], players);

  return moversHtml + qb + te;
}

export function openCadencePanel({ config, editor }) {
  const players = new Map(editor.getPlayers().map((p) => [p.id, p]));
  const startCap = Math.min(DEFAULTS.cap, editor.getOrder().length || DEFAULTS.cap) || DEFAULTS.cap;

  const bodyHtml =
    '<p class="cadence-explainer">Pulls QB/TE up toward market timing. Your order within each position never changes.</p>' +
    '<div class="cadence-grid">' +
    '<div class="cadence-controls">' +
    controlRow("lamQB", "λ QB", DEFAULTS.lamQB, "cadence-lamqb") +
    controlRow("lamTE", "λ TE", DEFAULTS.lamTE, "cadence-lamte") +
    controlRow("w", "Blend (current ↔ expert ADP)", DEFAULTS.w, "cadence-w") +
    '<div class="cadence-field">' +
    '<div class="cadence-field-row"><label for="cadence-cap">Depth cap</label></div>' +
    `<input type="number" min="1" class="cadence-number" id="cadence-cap" data-cap value="${startCap}" />` +
    "</div>" +
    "</div>" +
    '<div class="cadence-preview">' +
    '<p class="cadence-summary" data-status>Adjust a control to preview.</p>' +
    '<div class="cadence-scroll" data-preview></div>' +
    "</div>" +
    "</div>";

  const footHtml =
    "<span></span>" +
    "<span>" +
    '<button type="button" class="btn ghost" data-close>Close</button> ' +
    '<button type="button" class="btn primary" data-apply>Apply cadence</button>' +
    "</span>";

  openModal({
    title: `Cadence — ${config.label}`,
    bodyHtml,
    footHtml,
    onMount(modalEl) {
      const statusEl = modalEl.querySelector("[data-status]");
      const previewEl = modalEl.querySelector("[data-preview]");
      let debounce = null;

      function readParams() {
        const capRaw = modalEl.querySelector("[data-cap]").value;
        const capNum = Number(capRaw);
        const cap = capRaw.trim() === "" || !Number.isFinite(capNum) ? editor.getOrder().length : capNum;
        return {
          lamQB: Number(modalEl.querySelector('[data-field="lamQB"]').value),
          lamTE: Number(modalEl.querySelector('[data-field="lamTE"]').value),
          w: Number(modalEl.querySelector('[data-field="w"]').value),
          cap,
        };
      }

      async function refreshPreview() {
        const params = readParams();
        statusEl.textContent = "Previewing…";
        statusEl.classList.remove("dim", "warn");
        try {
          const result = await editor.previewCadence(params);
          previewEl.innerHTML = renderPreview(result, players);
          const n = result.moves.length;
          if (n === 0) {
            statusEl.textContent = "Nothing moves at these settings.";
            statusEl.classList.add("dim");
          } else {
            statusEl.innerHTML = `<span class="cadence-count">${n}</span> player${n === 1 ? "" : "s"} would move`;
          }
        } catch (err) {
          statusEl.textContent = `Preview failed: ${err.message}`;
          statusEl.classList.add("warn");
        }
      }

      modalEl.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          const readout = modalEl.querySelector(`[data-readout="${input.getAttribute("data-field")}"]`);
          if (readout) readout.textContent = Number(input.value).toFixed(2);
          clearTimeout(debounce);
          debounce = setTimeout(refreshPreview, DEBOUNCE_MS);
        });
      });
      modalEl.querySelector("[data-cap]").addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(refreshPreview, DEBOUNCE_MS);
      });

      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);
      modalEl.querySelector("[data-apply]").addEventListener("click", async () => {
        const params = readParams();
        await editor.applyCadence(params);
        showToast("Cadence applied — press Undo to revert");
        closeModal();
      });

      refreshPreview();
    },
  });
}
