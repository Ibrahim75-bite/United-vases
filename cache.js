// =========================
// In-Memory Response Cache (TTL-based)
// =========================
const responseCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function getCached(key) {
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        responseCache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    responseCache.set(key, { data, timestamp: Date.now() });
}

function clearProductCache() {
    for (const key of responseCache.keys()) {
        if (key.startsWith("products:") || key.startsWith("slug:") || key.startsWith("tags:")) {
            responseCache.delete(key);
        }
    }
}

module.exports = { getCached, setCache, clearProductCache };
