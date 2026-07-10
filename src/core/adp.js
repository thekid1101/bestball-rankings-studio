// adpProvider interface (contract C5). v1: the only provider derives ADP from the
// platform's own uploaded export — never scraped, never baked in. A v2 licensed
// feed (e.g. FantasyPros API behind a backend) implements this same interface.
import { platforms } from "../platforms/index.js";

export const uploadAdpProvider = {
  id: "upload",
  getAdp(platformId, players) {
    const config = platforms[platformId];
    const out = new Map();
    for (const p of players) {
      const slot = config ? config.normalizeAdpToSlot(p) : p.adp;
      if (slot != null && Number.isFinite(slot)) out.set(p.id, slot);
    }
    return out;
  },
};
