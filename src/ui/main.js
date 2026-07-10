// src/ui/main.js — bootstrap: platform registry → switcher → editor lifecycle.
// Guards all DOM/bootstrap work behind `boot()`, only invoked when `document`
// exists, so this module imports cleanly under plain Node (self-check).
import { platformList, platforms } from "../platforms/index.js";
import { createStorage } from "../core/storage.js";
import { createEditor } from "../core/editor.js";
import { buildReferenceSource } from "../core/references.js";
import { buildShell, setActiveTab, setAccent, renderEmptyState } from "./shell.js";
import { openImportModal, openExportModal, openReferenceModal, openResetModal, openBackupModal, showToast } from "./modals.js";
import { openCadencePanel } from "./cadence-panel.js";
import { openSimPanel } from "./sim-panel.js";

function boot() {
  let appRoot = document.getElementById("app");
  if (!appRoot) {
    appRoot = document.createElement("div");
    appRoot.id = "app";
    document.body.appendChild(appRoot);
  }

  const shell = buildShell(appRoot, platformList);
  const appStorage = createStorage("app");

  // ctx holds the currently-active platform's config/storage/editor. Fully
  // isolated per platform: each switch gets its own createStorage(id) and a
  // fresh createEditor instance; the old one is destroy()ed first.
  let ctx = { id: null, config: null, storage: null, editor: null };

  function persistActivePlatform(id) {
    if (!appStorage.set("activePlatform", id)) showToast("Not saved (storage off)");
  }

  function refreshChrome() {
    const hasPlayers = !!(ctx.editor && ctx.editor.hasPlayers());
    shell.editorMountEl.hidden = !hasPlayers;
    shell.emptyStateEl.hidden = hasPlayers;
    if (!hasPlayers && ctx.config) {
      renderEmptyState(shell.emptyStateEl, ctx.config, openImport);
    }
    if (ctx.config) {
      const refs = ctx.editor ? ctx.editor.getReferences() : [null, null];
      const refLabels = refs.filter(Boolean).map((r) => r.label);
      shell.platformNoteEl.textContent = ctx.config.label + (refLabels.length ? ` · refs: ${refLabels.join(", ")}` : "");
    } else {
      shell.platformNoteEl.textContent = "";
    }
  }

  function openImport() {
    if (!ctx.editor) return;
    openImportModal({
      config: ctx.config,
      editor: ctx.editor,
      storage: ctx.storage,
      onLoaded: refreshChrome,
    });
  }

  function openExport() {
    if (!ctx.editor || !ctx.editor.hasPlayers()) {
      showToast("Load a player pool first");
      return;
    }
    openExportModal({ config: ctx.config, editor: ctx.editor });
  }

  function openReference() {
    if (!ctx.editor || !ctx.editor.hasPlayers()) {
      showToast("Load a player pool first");
      return;
    }
    openReferenceModal({ config: ctx.config, editor: ctx.editor, storage: ctx.storage });
  }

  function openCadence() {
    if (!ctx.editor || !ctx.editor.hasPlayers()) {
      showToast("Load a player pool first");
      return;
    }
    openCadencePanel({ config: ctx.config, editor: ctx.editor });
  }

  function openSim() {
    if (!ctx.editor) return;
    openSimPanel({ config: ctx.config, editor: ctx.editor, storage: ctx.storage, onRequestImport: openImport });
  }

  function openReset() {
    if (!ctx.editor) return;
    openResetModal({
      config: ctx.config,
      editor: ctx.editor,
      storage: ctx.storage,
      onReset: refreshChrome,
    });
  }

  function switchPlatform(id) {
    const config = platforms[id];
    if (!config) return;

    if (ctx.editor) ctx.editor.destroy();
    shell.editorMountEl.innerHTML = "";

    const storage = createStorage(id);
    const editor = createEditor({ config, mount: shell.editorMountEl, storage });

    // Restore a previously-imported pool (JSON-safe players) so a reload
    // doesn't require re-uploading. References are rebuilt from their saved
    // {label, entries} against the *current* pool, never baked in.
    const pool = storage.get("pool", null);
    if (Array.isArray(pool) && pool.length) {
      editor.loadPlayers(pool);
      [0, 1].forEach((slot) => {
        const saved = storage.get(slot === 0 ? "ref0" : "ref1", null);
        if (saved && Array.isArray(saved.entries) && saved.entries.length) {
          const { source } = buildReferenceSource(saved.label, saved.entries, editor.getPlayers());
          editor.applyReference(slot, source);
        }
      });
    }

    editor.onSaveStatus((status) => {
      shell.saveStatusEl.textContent = status.message;
    });
    editor.onChange(refreshChrome);

    ctx = { id, config, storage, editor };
    setActiveTab(shell.tabsEl, id);
    setAccent(shell.root, config.accent);
    persistActivePlatform(id);
    refreshChrome();
  }

  shell.actionButtons.import.addEventListener("click", openImport);
  shell.actionButtons.reference.addEventListener("click", openReference);
  shell.actionButtons.cadence.addEventListener("click", openCadence);
  shell.actionButtons.simulate.addEventListener("click", openSim);
  shell.actionButtons.export.addEventListener("click", openExport);
  shell.actionButtons.backup.addEventListener("click", () => openBackupModal());
  shell.actionButtons.reset.addEventListener("click", openReset);
  shell.tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-platform]");
    if (btn) switchPlatform(btn.getAttribute("data-platform"));
  });

  const savedActive = appStorage.get("activePlatform", null);
  const initialId = savedActive && platforms[savedActive] ? savedActive : platformList[0].id;
  switchPlatform(initialId);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

export { boot };
