// src/workers/sim-worker.js
// Thin module worker around src/core/simulator.js. Kept import-safe under plain
// Node (verify.mjs's import sweep): every touch of `self`/`postMessage` is
// guarded by a typeof check or lives inside the message handler, so importing
// this module never throws outside a real worker global scope.
//
// Protocol:
//   in:  {cmd:"run", payload:{players, userOrder, userSlot, params, seed, schedule}}
//   out: {type:"progress", done, total}                         (throttled ~10/s)
//        {type:"result", exposures, drafts, userSlotUsed}
//        {type:"error", message}
//
// Cancellation is NOT a message in this protocol: the host page cancels a run
// by detaching this worker's onmessage/onerror handlers and calling
// terminate() (see stopWorker() in src/ui/sim-panel.js). There is no graceful
// in-flight stop — the worker (and any in-progress runSimulation call) is
// simply killed. Keep it that way; do not reintroduce a {cmd:"cancel"} path.

import { runSimulation } from "../core/simulator.js";

const PROGRESS_INTERVAL_MS = 100; // ~10/s

function post(msg) {
  if (typeof postMessage === "function") postMessage(msg);
}

async function handleRun(payload) {
  let lastPostAt = 0;

  try {
    const { players, userOrder, userSlot, params, seed, schedule } = payload || {};
    const result = runSimulation({
      players,
      userOrder,
      userSlot,
      params,
      seed,
      schedule,
      onDraftDone: (done, total) => {
        const now = Date.now();
        if (now - lastPostAt >= PROGRESS_INTERVAL_MS || done === total) {
          lastPostAt = now;
          post({ type: "progress", done, total });
        }
      },
    });

    post({
      type: "result",
      exposures: result.exposures,
      drafts: result.drafts,
      userSlotUsed: result.userSlotUsed,
    });
  } catch (err) {
    post({ type: "error", message: err && err.message ? err.message : String(err) });
  }
}

function handleMessage(event) {
  const data = (event && event.data) || {};
  if (data.cmd === "run") {
    handleRun(data.payload);
  }
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", handleMessage);
}
