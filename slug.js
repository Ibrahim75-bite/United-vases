const pool = require("../db");

// =========================
// Slug generator (supports English + Arabic)
// =========================
function generateSlug(name, langCode) {
    if (!name) return null;
    const trimmed = name.trim();
    if (langCode === "ar") {
        return trimmed
            .replace(/\s+/g, "-")
            .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\w-]/g, "")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
    }
    return trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

// Collision-safe slug: appends -2, -3, etc. if slug already exists in DB
async function generateUniqueSlug(client, name, langCode) {
    const baseSlug = generateSlug(name, langCode);
    if (!baseSlug) return null;

    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
        const existing = await client.query(
            `SELECT 1 FROM product_translations WHERE slug = $1 LIMIT 1`,
            [candidate]
        );
        if (existing.rows.length === 0) return candidate;
        candidate = `${baseSlug}-${suffix++}`;
    }
}

module.exports = { generateSlug, generateUniqueSlug };
