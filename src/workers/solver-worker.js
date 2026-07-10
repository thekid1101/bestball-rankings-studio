// src/workers/solver-worker.js
// Thin module worker around src/core/solver.js, mirroring sim-worker.js.
// Import-safe under plain Node (verify.mjs's import sweep): every touch of
// `self`/`postMessage` is guarded, so importing this module never throws
// outside a real worker global scope.
//
// Protocol:
//   in:  {cmd:"run", payload:{players, initialOrder, targets, userSlot,
//         params, seed, schedule, solver}}
//   out: {type:"progress", phase:"batch"|"round", round, rounds, done, total,
//         score?}                                  (batch ticks throttled ~10/s;
//                                                   round summaries always sent)
//        {type:"result", result}                   (solveTargets return value)
//        {type:"error", message}
//
// Cancellation is NOT a message in this protocol (same as C-sim): the host
// cancels by detaching onmessage/onerror and calling terminate(). Do not
// reintroduce a {cmd:"cancel"} path.

import { solveTargets } from "../core/solver.js";

const PROGRESS_INTERVAL_MS = 100; // ~10/s

function post(msg) {
  if (typeof postMessage === "function") postMessage(msg);
}

function handleRun(payload) {
  let lastPostAt = 0;

  try {
    const result = solveTargets({
      ...(payload || {}),
      onProgress: (info) => {
        const now = Date.now();
        // Round summaries always go out (the UI's round counter depends on
        // them); per-draft batch ticks are throttled.
        if (info.phase === "round" || now - lastPostAt >= PROGRESS_INTERVAL_MS || info.done === info.total) {
          lastPostAt = now;
          post({ type: "progress", ...info });
        }
      },
    });
    post({ type: "result", result });
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
