// src/ui/tour.js — first-time-user walkthrough. A single modal (via
// ./modals.js openModal) whose body is swapped per-step rather than
// reopened. Pure DOM wiring; only touches `document`/`window` inside
// function bodies so this module stays importable under plain Node.
import { openModal, closeModal } from "./modals.js";
import { createStorage } from "../core/storage.js";

const STEPS = [
  {
    eyebrow: "Step 1 of 6",
    heading: "Welcome to Bestball Rankings Studio",
    body:
      "A free rankings editor for Underdog, DraftKings, and Drafters best ball. " +
      "Everything runs and saves in your browser; nothing is uploaded anywhere. " +
      "Pick your platform with the tabs up top.",
    highlight: ["[data-platform-tabs]"],
  },
  {
    eyebrow: "Step 2 of 6",
    heading: "Load your Current ADP",
    body:
      "Upload the platform's own rankings export CSV. It builds your board and fills " +
      "the gold market-ADP column. Each platform keeps its own separate board.",
    highlight: ['[data-action="import"]'],
  },
  {
    eyebrow: "Step 3 of 6",
    heading: "Make the board yours",
    body:
      "Drag rows to reorder, click a rank number to type a new one, Shift/Ctrl-click for " +
      "multi-select block moves, add tier breaks with the + next to a rank. Ctrl+Z undoes anything.",
    highlight: [],
  },
  {
    eyebrow: "Step 4 of 6",
    heading: "Add Expert ADP",
    body:
      "Paste any expert ranking (ETR, FantasyPros, your own sheet) and name it. It appears as " +
      "the violet column, matched by player name, and powers the Edges filter — the spots where " +
      "market and expert disagree about your rank.",
    highlight: ['[data-action="reference"]'],
  },
  {
    eyebrow: "Step 5 of 6",
    heading: "Cadence & Simulate",
    body:
      "Cadence nudges your QB/TE timing toward a blend of market and expert ADP without ever " +
      "reordering players within a position. Simulate runs full 12-team autodrafts — your seat " +
      "drafts your board, 11 realistic drafters follow ADP — and shows your expected exposures.",
    highlight: ['[data-action="cadence"]', '[data-action="simulate"]'],
  },
  {
    eyebrow: "Step 6 of 6",
    heading: "Export & keep it safe",
    body:
      "Export writes a CSV in exactly the format your platform expects for re-upload. Backup saves " +
      "everything to a file you can restore on any machine. Reopen this guide anytime from the footer.",
    highlight: ['[data-action="export"]', '[data-action="backup"]'],
  },
];

let activeHighlightEls = [];
let tourKeyHandler = null;

function clearHighlights() {
  activeHighlightEls.forEach((el) => el.classList.remove("tour-glow"));
  activeHighlightEls = [];
}

function applyHighlight(selectors) {
  clearHighlights();
  (selectors || []).forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      el.classList.add("tour-glow");
      activeHighlightEls.push(el);
    });
  });
}

function stepBodyHtml(step) {
  return (
    `<p class="cadence-eyebrow">${step.eyebrow}</p>` +
    `<h3 class="tour-heading">${step.heading}</h3>` +
    `<p>${step.body}</p>`
  );
}

function dotsHtml(index) {
  return (
    '<span class="tour-dots">' +
    STEPS.map((_, i) => `<button type="button" class="tour-dot${i === index ? " on" : ""}" data-tour-dot="${i}" aria-label="Go to step ${i + 1}"></button>`).join("") +
    "</span>"
  );
}

function footHtml(index) {
  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;
  return (
    dotsHtml(index) +
    "<span>" +
    (isLast ? "" : '<button type="button" class="btn ghost" data-tour-skip>Skip</button> ') +
    `<button type="button" class="btn ghost" data-tour-back${isFirst ? " disabled" : ""}>Back</button> ` +
    `<button type="button" class="btn primary" data-tour-next>${isLast ? "Get started" : "Next"}</button>` +
    "</span>"
  );
}

// Opens the tour modal and drives step navigation. `onDone` fires once,
// on any close path (finish, skip, Escape, scrim click).
function runTour(onDone) {
  let index = 0;
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    clearHighlights();
    document.querySelector(".scrim")?.classList.remove("scrim-tour");
    if (tourKeyHandler) {
      document.removeEventListener("keydown", tourKeyHandler);
      tourKeyHandler = null;
    }
    if (onDone) onDone();
  }

  function render(modalEl) {
    const step = STEPS[index];
    modalEl.querySelector(".body").innerHTML = stepBodyHtml(step);
    modalEl.querySelector(".foot2").innerHTML = footHtml(index);
    applyHighlight(step.highlight);
    wireFoot(modalEl);
  }

  function goTo(modalEl, next) {
    index = Math.max(0, Math.min(STEPS.length - 1, next));
    render(modalEl);
  }

  function wireFoot(modalEl) {
    const backBtn = modalEl.querySelector("[data-tour-back]");
    const nextBtn = modalEl.querySelector("[data-tour-next]");
    const skipBtn = modalEl.querySelector("[data-tour-skip]");
    if (backBtn) backBtn.addEventListener("click", () => goTo(modalEl, index - 1));
    if (nextBtn)
      nextBtn.addEventListener("click", () => {
        if (index === STEPS.length - 1) closeModal();
        else goTo(modalEl, index + 1);
      });
    if (skipBtn) skipBtn.addEventListener("click", () => closeModal());
    modalEl.querySelectorAll("[data-tour-dot]").forEach((dot) => {
      dot.addEventListener("click", () => goTo(modalEl, Number(dot.getAttribute("data-tour-dot"))));
    });
  }

  const { modalEl } = openModal({
    title: "Guide",
    bodyHtml: stepBodyHtml(STEPS[0]),
    footHtml: footHtml(0),
    onClose: finish,
    onMount(el) {
      // The tour points at real UI — keep the backdrop nearly clear so the
      // highlighted elements stay visible (the default scrim buries them).
      document.querySelector(".scrim")?.classList.add("scrim-tour");
      applyHighlight(STEPS[0].highlight);
      wireFoot(el);
      tourKeyHandler = (e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          goTo(el, index + 1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          goTo(el, index - 1);
        }
      };
      document.addEventListener("keydown", tourKeyHandler);
    },
  });
  return modalEl;
}

// Always opens the tour (for the footer Guide button). Still marks
// `tourSeen` once closed, via its own app-scoped storage instance.
export function openTour() {
  if (typeof document === "undefined") return;
  const storage = createStorage("app");
  runTour(() => storage.set("tourSeen", true));
}

// Opens the tour automatically on first visit only (appStorage.get("tourSeen")
// falsy). Marks the flag seen when the tour closes, on any exit path
// (finish, skip, Escape, scrim click).
export function maybeShowTour(appStorage) {
  if (typeof document === "undefined") return;
  const storage = appStorage || createStorage("app");
  if (storage.get("tourSeen")) return;
  runTour(() => storage.set("tourSeen", true));
}
