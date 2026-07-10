// src/ui/shell.js — app chrome: header, platform tabs, toolbar actions,
// footer/save status, empty-state panel. Owns no business logic — main.js
// wires clicks to editor/storage/modals. Pure DOM, only touches `document`
// inside functions (never at module top level) so it stays Node-importable.

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Builds the static app shell into `appRoot` and returns handles to the
// mutable pieces callers need (tabs, mount points, action buttons, footer).
export function buildShell(appRoot, platformList) {
  appRoot.innerHTML =
    '<div class="app" data-app>' +
      '<div class="header">' +
        '<div class="brand">' +
          '<div class="brand-icon">BB</div>' +
          '<div class="titles">' +
            "<h1>Bestball Rankings Studio</h1>" +
            "<p>Platform-native draft rankings, offline-first</p>" +
          "</div>" +
        "</div>" +
        '<div class="tabs" data-platform-tabs></div>' +
        '<div class="spacer"></div>' +
        '<div class="actions">' +
          '<button type="button" class="btn gold" data-action="import">Current ADP</button>' +
          '<button type="button" class="btn violet" data-action="reference">Expert ADP</button>' +
          '<button type="button" class="btn steel" data-action="cadence">Cadence</button>' +
          '<button type="button" class="btn" data-action="simulate">Simulate</button>' +
          '<button type="button" class="btn gold" data-action="export">Export</button>' +
          '<button type="button" class="btn ghost" data-action="backup">Backup</button>' +
          '<button type="button" class="btn ghost" data-action="reset">Reset</button>' +
        "</div>" +
      "</div>" +
      '<div data-empty-state></div>' +
      '<div data-editor-mount></div>' +
      '<div class="foot">' +
        '<span data-save-status>Ready</span>' +
        '<span class="dot"></span>' +
        '<span data-platform-note></span>' +
        '<span class="foot-spacer"></span>' +
        '<button type="button" class="foot-link subtle" data-action="guide">Guide</button>' +
        '<button type="button" class="foot-link" data-action="support">♥ Support this tool</button>' +
      "</div>" +
    "</div>";

  const root = appRoot.querySelector("[data-app]");
  const tabsEl = appRoot.querySelector("[data-platform-tabs]");
  tabsEl.innerHTML = platformList
    .map((cfg) => `<button type="button" class="tab" data-platform="${escapeHtml(cfg.id)}">${escapeHtml(cfg.label)}</button>`)
    .join("");

  return {
    root,
    tabsEl,
    emptyStateEl: appRoot.querySelector("[data-empty-state]"),
    editorMountEl: appRoot.querySelector("[data-editor-mount]"),
    saveStatusEl: appRoot.querySelector("[data-save-status]"),
    platformNoteEl: appRoot.querySelector("[data-platform-note]"),
    actionButtons: {
      import: appRoot.querySelector('[data-action="import"]'),
      reference: appRoot.querySelector('[data-action="reference"]'),
      cadence: appRoot.querySelector('[data-action="cadence"]'),
      simulate: appRoot.querySelector('[data-action="simulate"]'),
      export: appRoot.querySelector('[data-action="export"]'),
      backup: appRoot.querySelector('[data-action="backup"]'),
      reset: appRoot.querySelector('[data-action="reset"]'),
      support: appRoot.querySelector('[data-action="support"]'),
      guide: appRoot.querySelector('[data-action="guide"]'),
    },
  };
}

export function setActiveTab(tabsEl, platformId) {
  tabsEl.querySelectorAll("[data-platform]").forEach((btn) => {
    btn.classList.toggle("on", btn.getAttribute("data-platform") === platformId);
  });
}

// Only inline style this shell ever sets — the per-platform accent token.
export function setAccent(root, color) {
  if (color) root.style.setProperty("--accent", color);
}

// Renders the "no pool loaded" panel. Never contains bundled/sample data —
// just a message + an upload CTA that reopens the import modal.
export function renderEmptyState(container, config, onUpload) {
  container.innerHTML =
    '<div class="empty-state">' +
      `<h2>No ${escapeHtml(config.label)} board yet</h2>` +
      `<p>Upload your ${escapeHtml(config.label)} export CSV to build your board.</p>` +
      '<button type="button" class="btn primary" data-empty-upload>Upload CSV</button>' +
    "</div>";
  const btn = container.querySelector("[data-empty-upload]");
  if (btn) btn.addEventListener("click", onUpload);
}
