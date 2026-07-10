// Safe per-platform persistence (contract C-storage). Every localStorage touch
// in the app goes through here; access can throw (private mode, quota, disabled)
// and must never crash the editor. set() round-trips the whole blob (one
// readBlob + one stringify/setItem) per field; setMany() does the same for
// several fields in a single round-trip — prefer it when writing more than
// one field at once (e.g. autosave's order+tiers) to halve the I/O.
export function createStorage(platformId) {
  const key = `bbrs_${platformId}_v1`;

  function readBlob() {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  let available = true;
  try {
    const probe = `${key}__probe`;
    globalThis.localStorage.setItem(probe, "1");
    globalThis.localStorage.removeItem(probe);
  } catch {
    available = false;
  }

  return {
    available,
    get(field, fallback = null) {
      const blob = readBlob();
      return field in blob ? blob[field] : fallback;
    },
    set(field, value) {
      try {
        const blob = readBlob();
        blob[field] = value;
        globalThis.localStorage.setItem(key, JSON.stringify(blob));
        return true;
      } catch {
        return false;
      }
    },
    // Write several fields in one readBlob -> Object.assign -> stringify+setItem
    // round-trip, instead of one round-trip per field (see set()).
    setMany(fields) {
      try {
        const blob = readBlob();
        Object.assign(blob, fields);
        globalThis.localStorage.setItem(key, JSON.stringify(blob));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        globalThis.localStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    // Whole-blob access for backup/restore. getAll returns a copy of this
    // platform's entire stored state; replaceAll overwrites it atomically.
    getAll() {
      return readBlob();
    },
    replaceAll(blob) {
      try {
        globalThis.localStorage.setItem(key, JSON.stringify(blob && typeof blob === "object" ? blob : {}));
        return true;
      } catch {
        return false;
      }
    },
  };
}
