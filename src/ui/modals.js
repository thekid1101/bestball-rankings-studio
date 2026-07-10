// src/ui/modals.js — modal shell, toasts, and the import/export/reference/
// reset dialogs. Consumes: platform config (C1) for parseImport/serializeExport,
// the editor instance (C2), the C-storage wrapper, and the reference helpers
// (C4). Pure DOM wiring; only touches `document`/`window` inside function
// bodies so this module stays importable under plain Node.
import { parseReferenceText, buildReferenceSource } from "../core/references.js";
import { createStorage } from "../core/storage.js";
import { platformList } from "../platforms/index.js";
import { escapeHtml } from "./shell.js";

export { escapeHtml };

/* ================= toast ================= */
let toastTimer = null;
export function showToast(msg) {
  if (typeof document === "undefined") return;
  let el = document.querySelector("[data-global-toast]");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("data-global-toast", "");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ================= file download ================= */
// Shared Blob-download sequence: creates an object URL, clicks a throwaway
// anchor, then revokes the URL once the download has had time to start.
function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ================= generic modal ================= */
let current = null;

export function closeModal() {
  if (!current) return;
  const { scrim, keyHandler, onClose } = current;
  document.removeEventListener("keydown", keyHandler);
  scrim.remove();
  current = null;
  if (onClose) onClose();
}

function trapFocus(modalEl, e) {
  const nodes = modalEl.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Opens a `.scrim > .modal` dialog. Closes on Escape / backdrop click, traps
// Tab focus, calls onMount(modalEl) once inserted so callers can wire inputs.
export function openModal({ title, bodyHtml, footHtml = "", onClose, onMount }) {
  closeModal();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML =
    `<div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">` +
    `<h2>${escapeHtml(title)}</h2>` +
    `<div class="body">${bodyHtml}</div>` +
    (footHtml ? `<div class="foot2">${footHtml}</div>` : "") +
    "</div>";
  document.body.appendChild(scrim);
  const modalEl = scrim.querySelector(".modal");

  const keyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    } else if (e.key === "Tab") {
      trapFocus(modalEl, e);
    }
  };
  document.addEventListener("keydown", keyHandler);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) closeModal();
  });

  current = { scrim, modalEl, keyHandler, onClose };
  // Flush styles, then add .show synchronously so the entrance transition
  // runs. (rAF never fires in backgrounded tabs, which left modals invisible.)
  void scrim.offsetHeight;
  scrim.classList.add("show");
  if (onMount) onMount(modalEl);
  const firstFocusable = modalEl.querySelector("button, input, textarea, select, [tabindex]");
  if (firstFocusable) firstFocusable.focus();
  return { modalEl, close: closeModal };
}

/* ================= import modal ================= */
// Drag-drop a file OR paste text; parses via config.parseImport, shows row
// count + warnings, then on confirm calls editor.loadPlayers + persists the
// parsed pool via storage.set("pool", players) so a reload restores it.
export function openImportModal({ config, editor, storage, onLoaded }) {
  let pending = null; // { players, warnings } from the last successful parse

  const bodyHtml =
    `<p>Upload your ${escapeHtml(config.label)} export CSV, or paste it below. You can also drag a file anywhere onto this dialog.</p>` +
    '<p><button type="button" class="btn primary" data-choose>Choose CSV file</button> ' +
    '<input type="file" accept=".csv,text/csv,text/plain" data-file hidden />' +
    "<span data-filename></span></p>" +
    '<textarea data-paste placeholder="…or paste CSV text here"></textarea>' +
    '<p class="msg" data-msg>No file selected yet.</p>';

  const footHtml =
    '<span></span>' +
    "<span>" +
    '<button type="button" class="btn ghost" data-cancel>Cancel</button> ' +
    '<button type="button" class="btn primary" data-load disabled>Load players</button>' +
    "</span>";

  openModal({
    title: `Current ADP — upload your ${config.label} export`,
    bodyHtml,
    footHtml,
    onMount(modalEl) {
      const fileInput = modalEl.querySelector("[data-file]");
      const chooseBtn = modalEl.querySelector("[data-choose]");
      const paste = modalEl.querySelector("[data-paste]");
      const msg = modalEl.querySelector("[data-msg]");
      const filenameEl = modalEl.querySelector("[data-filename]");
      const loadBtn = modalEl.querySelector("[data-load]");
      const cancelBtn = modalEl.querySelector("[data-cancel]");

      function setPending(text, label) {
        try {
          const result = config.parseImport(text);
          pending = result;
          const wCount = (result.warnings || []).length;
          let text2 = `${result.players.length} player${result.players.length === 1 ? "" : "s"} parsed`;
          if (wCount) {
            text2 += `, ${wCount} warning${wCount === 1 ? "" : "s"}: ` + result.warnings.slice(0, 3).join("; ") + (wCount > 3 ? "…" : "");
          }
          // Guard against the classic mix-up: feeding a ranking list (e.g. an
          // ETR export) into the pool import, wiping the platform pool.
          const currentPool = editor.hasPlayers() ? editor.getPlayers().length : 0;
          if (currentPool > 0 && result.players.length > 0) {
            text2 += ` — replaces your current ${currentPool}-player ${config.label} pool and board order`;
            if (result.players.length < currentPool * 0.4) {
              text2 += `. This file is much smaller than your pool — if it's a ranking list (ETR, FantasyPros, …), use Expert ADP instead`;
            }
          }
          msg.textContent = (label ? `${label} — ` : "") + text2;
          msg.classList.toggle("warn", wCount > 0 || (currentPool > 0 && result.players.length > 0 && result.players.length < currentPool * 0.4));
          msg.classList.toggle("ok", result.players.length > 0 && !wCount && !(currentPool > 0 && result.players.length < currentPool * 0.4));
          loadBtn.disabled = result.players.length === 0;
        } catch (err) {
          pending = null;
          msg.textContent = `Could not parse: ${err.message}`;
          msg.classList.remove("ok");
          msg.classList.add("warn");
          loadBtn.disabled = true;
        }
      }

      function readFile(file) {
        if (!file) return;
        filenameEl.textContent = ` ${file.name}`;
        const reader = new FileReader();
        reader.onload = () => setPending(String(reader.result || ""), file.name);
        reader.onerror = () => {
          pending = null;
          msg.textContent = "Could not read file.";
          msg.classList.remove("ok");
          msg.classList.add("warn");
          loadBtn.disabled = true;
        };
        reader.readAsText(file);
      }

      chooseBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => readFile(fileInput.files && fileInput.files[0]));
      modalEl.addEventListener("dragover", (e) => e.preventDefault());
      modalEl.addEventListener("drop", (e) => {
        e.preventDefault();
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) readFile(file);
      });

      let pasteDebounce = null;
      paste.addEventListener("input", () => {
        clearTimeout(pasteDebounce);
        pasteDebounce = setTimeout(() => {
          if (paste.value.trim()) setPending(paste.value, "Pasted text");
        }, 300);
      });

      cancelBtn.addEventListener("click", closeModal);
      loadBtn.addEventListener("click", () => {
        if (!pending || !pending.players.length) return;
        editor.loadPlayers(pending.players);
        const ok = storage.set("pool", pending.players);
        showToast(ok ? `Loaded ${pending.players.length} players` : "Not saved (storage off)");
        if (onLoaded) onLoaded(pending.players);
        closeModal();
      });
    },
  });
}

/* ================= export modal ================= */
// Platform-appropriate options only, from config.adpMode/keepDeepUnranked.
export function openExportModal({ config, editor }) {
  const showAdpWrite = config.adpMode === "rewriteAdpColumn";
  const showKeepDash = !!config.keepDeepUnranked;

  let optsHtml = "";
  if (showAdpWrite) {
    optsHtml +=
      '<p><label><input type="radio" name="adpwrite" value="renumber" checked data-adpwrite /> Renumber ADP 1…N to match board order</label></p>' +
      '<p><label><input type="radio" name="adpwrite" value="keep" data-adpwrite /> Keep original ADP values</label></p>';
  }
  if (showKeepDash) {
    optsHtml += '<p><label><input type="checkbox" data-keepdash /> Keep "-" for deep unranked players</label></p>';
  }
  if (!showAdpWrite && !showKeepDash) {
    optsHtml = `<p>${escapeHtml(config.label)} exports use board order directly — no extra options.</p>`;
  }

  const bodyHtml =
    `<p>Export your board to <code>${escapeHtml(config.exportFilename)}</code>.</p>` + optsHtml + '<p class="msg" data-msg></p>';

  const footHtml =
    "<span></span>" +
    "<span>" +
    '<button type="button" class="btn" data-copy>Copy to clipboard</button> ' +
    '<button type="button" class="btn primary" data-download>Download CSV</button>' +
    "</span>";

  openModal({
    title: `Export ${config.label} rankings`,
    bodyHtml,
    footHtml,
    onMount(modalEl) {
      const msg = modalEl.querySelector("[data-msg]");

      function readOpts() {
        const opts = {};
        if (showAdpWrite) {
          const checked = modalEl.querySelector("[data-adpwrite]:checked");
          opts.adpWrite = checked ? checked.value : "renumber";
        }
        if (showKeepDash) {
          const cb = modalEl.querySelector("[data-keepdash]");
          opts.keepDash = !!(cb && cb.checked);
        }
        return opts;
      }

      modalEl.querySelector("[data-download]").addEventListener("click", () => {
        const { filename, text } = editor.exportCsv(readOpts());
        downloadBlob(text, filename, "text/csv;charset=utf-8");
        msg.textContent = `Downloaded ${filename}`;
        msg.classList.add("ok");
        msg.classList.remove("warn");
      });

      modalEl.querySelector("[data-copy]").addEventListener("click", async () => {
        const { text } = editor.exportCsv(readOpts());
        try {
          await navigator.clipboard.writeText(text);
          msg.textContent = "Copied to clipboard";
          msg.classList.add("ok");
          msg.classList.remove("warn");
        } catch (_) {
          msg.textContent = "Could not access clipboard — select & copy manually.";
          msg.classList.add("warn");
          msg.classList.remove("ok");
        }
      });
    },
  });
}

/* ================= reference modal ================= */
function slotHtml(slot, editor, storage) {
  const label = slot === 0 ? "A" : "B";
  const source = editor.getReferences()[slot];
  const saved = storage.get(slot === 0 ? "ref0" : "ref1", null);
  const currentText = source
    ? `Current: <strong>${escapeHtml(source.label)}</strong> (${source.byName.size} matched names)`
    : "— Import an expert ranking — ETR export, FantasyPros, your own sheet — matched by name.";
  const labelVal = escapeHtml((saved && saved.label) || (source && source.label) || "");

  return (
    `<div data-slot-block="${slot}">` +
    `<p><strong>Expert ADP ${label}</strong> — <span data-current>${currentText}</span></p>` +
    `<p><label>Label <input type="text" data-label placeholder="e.g. ETR" value="${labelVal}" /></label></p>` +
    '<p><button type="button" class="btn" data-choose>Choose file</button> ' +
    '<input type="file" accept=".csv,text/csv,text/plain" data-file hidden /> ' +
    '<button type="button" class="btn ghost" data-clear>Clear</button></p>' +
    `<textarea data-paste placeholder="Paste rankings text — CSV, numbered list, or one name per line"></textarea>` +
    '<p class="msg" data-report></p>' +
    `<p><button type="button" class="btn primary" data-apply disabled>Apply as Expert ADP ${label}</button></p>` +
    "</div>"
  );
}

export function openReferenceModal({ config, editor, storage }) {
  const bodyHtml = [0, 1].map((slot) => slotHtml(slot, editor, storage)).join("");
  const footHtml = "<span></span><span><button type=\"button\" class=\"btn ghost\" data-close>Close</button></span>";

  openModal({
    title: `Expert ADP — ${config.label}`,
    bodyHtml,
    footHtml,
    onMount(modalEl) {
      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);

      [0, 1].forEach((slot) => {
        const block = modalEl.querySelector(`[data-slot-block="${slot}"]`);
        const labelInput = block.querySelector("[data-label]");
        const fileInput = block.querySelector("[data-file]");
        const chooseBtn = block.querySelector("[data-choose]");
        const clearBtn = block.querySelector("[data-clear]");
        const paste = block.querySelector("[data-paste]");
        const reportEl = block.querySelector("[data-report]");
        const applyBtn = block.querySelector("[data-apply]");
        const currentEl = block.querySelector("[data-current]");

        // Seed the textarea from any previously-saved raw entries so the
        // user sees what's active without re-uploading.
        const saved = storage.get(slot === 0 ? "ref0" : "ref1", null);
        let pendingSource = null;
        let pendingEntries = null;

        function runMatch() {
          const text = paste.value;
          if (!text.trim()) {
            reportEl.textContent = "";
            applyBtn.disabled = true;
            pendingSource = null;
            return;
          }
          const { entries } = parseReferenceText(text);
          const label = labelInput.value.trim() || `Expert ADP ${slot === 0 ? "A" : "B"}`;
          const { source, report } = buildReferenceSource(label, entries, editor.getPlayers());
          pendingSource = source;
          pendingEntries = entries;
          const shown = report.unmatched.slice(0, 30).map((u) => `${escapeHtml(u.name)} (#${u.rank})`).join(", ");
          const extra = report.unmatched.length > 30 ? ` … +${report.unmatched.length - 30} more` : "";
          reportEl.innerHTML =
            `Matched <strong>${report.matched}/${report.total}</strong>.` +
            (report.unmatched.length ? `<br />Unmatched: ${shown}${extra}` : "");
          reportEl.classList.toggle("ok", report.total > 0 && report.matched === report.total);
          reportEl.classList.toggle("warn", report.matched < report.total);
          applyBtn.disabled = report.matched === 0;
        }

        function readFile(file) {
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            paste.value = String(reader.result || "");
            runMatch();
          };
          reader.onerror = () => {
            reportEl.textContent = "Could not read file.";
            reportEl.classList.remove("ok");
            reportEl.classList.add("warn");
            applyBtn.disabled = true;
            pendingSource = null;
          };
          reader.readAsText(file);
        }

        chooseBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => readFile(fileInput.files && fileInput.files[0]));

        let debounce = null;
        paste.addEventListener("input", () => {
          clearTimeout(debounce);
          debounce = setTimeout(runMatch, 300);
        });
        labelInput.addEventListener("input", () => {
          if (paste.value.trim()) runMatch();
        });

        applyBtn.addEventListener("click", () => {
          if (!pendingSource) return;
          editor.applyReference(slot, pendingSource);
          const ok = storage.set(slot === 0 ? "ref0" : "ref1", { label: pendingSource.label, entries: pendingEntries });
          showToast(ok ? `${pendingSource.label} applied as Expert ADP ${slot === 0 ? "A" : "B"}` : "Not saved (storage off)");
          currentEl.innerHTML = `Current: <strong>${escapeHtml(pendingSource.label)}</strong> (${pendingSource.byName.size} matched names)`;
        });

        clearBtn.addEventListener("click", () => {
          editor.applyReference(slot, null);
          const ok = storage.set(slot === 0 ? "ref0" : "ref1", null);
          if (!ok) showToast("Not saved (storage off)");
          paste.value = "";
          reportEl.textContent = "";
          applyBtn.disabled = true;
          pendingSource = null;
          currentEl.textContent = "— Import an expert ranking — ETR export, FantasyPros, your own sheet — matched by name.";
        });

        // If storage had a saved reference, rehydrate the textarea preview
        // (does not re-apply — it's already applied on boot by main.js).
        if (saved && Array.isArray(saved.entries) && saved.entries.length && !paste.value) {
          paste.value = saved.entries
            .map((e) => `${e.rank}. ${e.name}${e.pos ? " " + e.pos : ""}${e.team ? " " + e.team : ""}`)
            .join("\n");
        }
      });
    },
  });
}

/* ================= reset modal ================= */
// Confirm step before wiping a platform's storage blob + editor state.
export function openResetModal({ config, editor, storage, onReset }) {
  openModal({
    title: `Reset ${config.label} board`,
    bodyHtml: `<p>This clears the ${escapeHtml(config.label)} player pool, references, tiers, and saved order on this device. This cannot be undone.</p>`,
    footHtml:
      "<span></span>" +
      "<span>" +
      '<button type="button" class="btn ghost" data-cancel>Cancel</button> ' +
      '<button type="button" class="btn primary" data-confirm>Reset</button>' +
      "</span>",
    onMount(modalEl) {
      modalEl.querySelector("[data-cancel]").addEventListener("click", closeModal);
      modalEl.querySelector("[data-confirm]").addEventListener("click", () => {
        storage.clear();
        editor.applyReference(0, null);
        editor.applyReference(1, null);
        editor.loadPlayers([]);
        showToast(`${config.label} board reset`);
        if (onReset) onReset();
        closeModal();
      });
    },
  });
}

/* ================= support / donations modal ================= */
// Donation destinations are hard-coded, user-owned, and display-only: a
// PayPal.me link and (optionally) crypto receiving addresses with copy
// buttons. No external scripts, no tracking — the site stays fully static.
const PAYPAL_URL = "https://paypal.me/JHDCARDS";
const CRYPTO_ADDRESSES = [
  { coin: "BTC", address: "3Baufb5UxmFmATy7K5bgXt7dTgKa8jPKm5" },
  { coin: "ETH", address: "0x068e3cc3E9f7C7867Dcf8004f4759a3D3b1EA0F2" },
  { coin: "SOL", address: "G6zZDJGNfTHYeGBQxD37NZ2YVaAwgQT2kn6V5btrcxyU" },
];

export function openSupportModal() {
  const cryptoHtml = CRYPTO_ADDRESSES.length
    ? "<hr />" +
      "<p><strong>Prefer crypto?</strong></p>" +
      CRYPTO_ADDRESSES.map(
        (c, i) =>
          `<p class="support-addr"><span class="support-coin">${escapeHtml(c.coin)}</span> ` +
          `<code data-addr="${i}">${escapeHtml(c.address)}</code> ` +
          `<button type="button" class="btn" data-copy-addr="${i}">Copy</button></p>`
      ).join("")
    : "";

  openModal({
    title: "Support this tool",
    bodyHtml:
      "<p>Bestball Rankings Studio is free, has no ads, and never sees your data. " +
      "If it helps your drafts and you feel like tossing something in the tip jar:</p>" +
      `<p><a class="btn primary" href="${PAYPAL_URL}" target="_blank" rel="noopener noreferrer">Donate with PayPal</a></p>` +
      cryptoHtml +
      '<p class="msg" data-msg></p>',
    footHtml: '<span></span><span><button type="button" class="btn ghost" data-close>Close</button></span>',
    onMount(modalEl) {
      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);
      modalEl.querySelectorAll("[data-copy-addr]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const i = btn.getAttribute("data-copy-addr");
          const addr = CRYPTO_ADDRESSES[Number(i)]?.address || "";
          const msg = modalEl.querySelector("[data-msg]");
          try {
            await navigator.clipboard.writeText(addr);
            msg.textContent = `${CRYPTO_ADDRESSES[Number(i)].coin} address copied — double-check the first and last characters after pasting.`;
            msg.classList.add("ok");
          } catch (_) {
            msg.textContent = "Could not access clipboard — select and copy the address manually.";
            msg.classList.add("warn");
          }
        });
      });
    },
  });
}

/* ================= backup / restore modal ================= */
// One .json file covering ALL platforms (pools, orders, tiers, expert-ADP
// sources, sim settings) plus app state. Restore overwrites and reloads.
const BACKUP_APP_ID = "bestball-rankings-studio";

export function openBackupModal() {
  const bodyHtml =
    "<p>Back up everything on this device — all three platforms' pools, board orders, " +
    "tiers, expert ADP sources, and settings — to a single file you can restore here " +
    "or on another machine.</p>" +
    '<p><button type="button" class="btn primary" data-download-backup>Download backup (.json)</button></p>' +
    "<hr />" +
    "<p><strong>Restore</strong> — choose a backup file. Restoring replaces everything " +
    "currently saved on this device.</p>" +
    '<p><button type="button" class="btn" data-choose>Choose backup file</button>' +
    '<input type="file" accept=".json,application/json" data-file hidden /></p>' +
    '<p class="msg" data-msg></p>';

  const footHtml =
    "<span></span>" +
    "<span>" +
    '<button type="button" class="btn ghost" data-close>Close</button> ' +
    '<button type="button" class="btn primary" data-restore disabled>Restore backup</button>' +
    "</span>";

  openModal({
    title: "Backup & restore",
    bodyHtml,
    footHtml,
    onMount(modalEl) {
      const msg = modalEl.querySelector("[data-msg]");
      const restoreBtn = modalEl.querySelector("[data-restore]");
      const fileInput = modalEl.querySelector("[data-file]");
      let pendingBackup = null;

      modalEl.querySelector("[data-close]").addEventListener("click", closeModal);

      modalEl.querySelector("[data-download-backup]").addEventListener("click", () => {
        const platforms = {};
        for (const p of platformList) platforms[p.id] = createStorage(p.id).getAll();
        const payload = {
          app: BACKUP_APP_ID,
          version: 1,
          ts: Date.now(),
          platforms,
          appState: createStorage("app").getAll(),
        };
        const filename = `bestball-backup-${new Date().toISOString().slice(0, 10)}.json`;
        downloadBlob(JSON.stringify(payload, null, 2), filename, "application/json");
        msg.textContent = `Downloaded ${filename}`;
        msg.classList.add("ok");
        msg.classList.remove("warn");
      });

      modalEl.querySelector("[data-choose]").addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(String(reader.result || ""));
            if (!data || data.app !== BACKUP_APP_ID || typeof data.platforms !== "object") {
              throw new Error("not a Bestball Rankings Studio backup file");
            }
            pendingBackup = data;
            const parts = platformList
              .map((p) => {
                const blob = data.platforms[p.id];
                const n = blob && Array.isArray(blob.pool) ? blob.pool.length : 0;
                return `${p.label}: ${n} players`;
              })
              .join(" · ");
            const when = data.ts ? new Date(data.ts).toLocaleString() : "unknown date";
            msg.textContent = `${file.name} (${when}) — ${parts}. Restoring replaces everything saved on this device.`;
            msg.classList.remove("warn");
            msg.classList.add("ok");
            restoreBtn.disabled = false;
          } catch (err) {
            pendingBackup = null;
            restoreBtn.disabled = true;
            msg.textContent = `Could not read backup: ${err.message}`;
            msg.classList.add("warn");
            msg.classList.remove("ok");
          }
        };
        reader.readAsText(file);
      });

      restoreBtn.addEventListener("click", () => {
        if (!pendingBackup) return;
        let ok = true;
        for (const p of platformList) {
          if (pendingBackup.platforms[p.id]) {
            ok = createStorage(p.id).replaceAll(pendingBackup.platforms[p.id]) && ok;
          }
        }
        if (pendingBackup.appState) ok = createStorage("app").replaceAll(pendingBackup.appState) && ok;
        if (!ok) {
          msg.textContent = "Restore failed — storage is unavailable on this device.";
          msg.classList.add("warn");
          return;
        }
        showToast("Backup restored — reloading");
        setTimeout(() => globalThis.location.reload(), 400);
      });
    },
  });
}
