// Platform registry (orchestrator-owned). Adapters conform to contract C1.
import underdog from "./underdog.js";
import draftkings from "./draftkings.js";
import drafters from "./drafters.js";

export const platforms = {
  [underdog.id]: underdog,
  [draftkings.id]: draftkings,
  [drafters.id]: drafters,
};

export const platformList = [underdog, draftkings, drafters];
