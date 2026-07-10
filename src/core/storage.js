// Safe per-platform persistence (contract C-storage). Every localStorage touch
// in the app goes through here; access can throw (private mode, quota, disabled)
// and must never crash the editor.
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
