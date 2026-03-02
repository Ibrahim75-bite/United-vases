const { body, validationResult } = require("express-validator");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const sharp = require("sharp");
const morgan = require("morgan");
require("dotenv").config();

// =========================
// Environment Validation
// =========================
const REQUIRED_ENV = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "JWT_SECRET", "BASE_URL"];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`âŒ Missing required environment variables: ${missingEnv.join(", ")}`);
    console.error("   Please check your .env file.");
    process.exit(1);
}

const pool = require("./db");

// Normalize BASE_URL once (strip trailing slashes to prevent double-slash URLs)
const BASE_URL = process.env.BASE_URL.replace(/\/+$/, "");

const app = express();

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

// =========================
// CORS Configuration
// =========================
const corsOptions = {
    origin: process.env.NODE_ENV === "production"
        ? (process.env.FRONTEND_URL || "https://elmuttahida.com")
        : "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
};
app.use(cors(corsOptions));
app.use("/images", express.static("uploads/images"));
app.use("/images/thumbnails", express.static("uploads/images/thumbnails"));
app.use(express.json());

// =========================
// Logging (morgan)
// =========================
app.use(morgan(":method :url :status :res[content-length] - :response-time ms"));

// =========================
// Response Timing (logged, not header â€” headers can't be set after finish)
// Morgan already logs :response-time but this adds a queryable log per API call
// =========================
app.use((req, res, next) => {
    req._startTime = Date.now();
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const elapsed = Date.now() - req._startTime;
        res.set("X-Response-Time", `${elapsed}ms`);
        return originalJson(body);
    };
    next();
});

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

// =========================
// Global Input Sanitization
// =========================
app.use((req, res, next) => {
    if (req.body && typeof req.body === "object") {
        const trimStrings = (obj) => {
            for (const key of Object.keys(obj)) {
                if (typeof obj[key] === "string") {
                    obj[key] = obj[key].trim();
                } else if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
                    trimStrings(obj[key]);
                }
            }
        };
        trimStrings(req.body);
    }
    next();
});

// =========================
// Multer Configuration
// =========================
const UPLOADS_DIR = path.join(__dirname, "uploads", "images");
const THUMBS_DIR = path.join(__dirname, "uploads", "images", "thumbnails");

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    if (ALLOWED_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, and WebP are allowed.`), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// =========================
// Thumbnail Generator (sharp)
// =========================
async function processImage(imageName) {
    const inputPath = path.join(UPLOADS_DIR, imageName);
    const thumbName = `thumb_${path.parse(imageName).name}.webp`;
    const thumbPath = path.join(THUMBS_DIR, thumbName);

    try {
        await sharp(inputPath)
            .resize(300, 300, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(thumbPath);
        return thumbName;
    } catch (err) {
        console.error(`Thumbnail generation failed for ${imageName}:`, err.message);
        return null;
    }
}

// =========================
// Rate Limiting
// =========================

// Global rate limit: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" }
});
app.use("/api/", globalLimiter);

// Strict rate limit for auth: 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts, please try again later" }
});

// =========================
// Auth Middleware (JWT)
// =========================
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(401).json({ error: "Invalid token" });
    }
};

app.get("/", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.json({ message: "Server running", time: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database connection failed" });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
});
// =========================
// Auth Routes
// =========================
app.post("/api/auth/login", authLimiter, [
    body("username").notEmpty().trim(),
    body("password").notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            error: "Validation failed",
            details: errors.array()
        });
    }

    const { username, password } = req.body;

    try {
        const result = await pool.query(
            `SELECT id, username, password_hash, role FROM admins WHERE username = $1`,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        const token = jwt.sign(
            {
                id: admin.id,
                username: admin.username,
                role: admin.role
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
        );

        res.json({
            message: "Login successful",
            token,
            user: {
                id: admin.id,
                username: admin.username,
                role: admin.role
            }
        });

    } catch (err) {
        console.error("ERROR IN /api/auth/login:", err);
        res.status(500).json({ error: "Login failed" });
    }
});

// =========================
// Product Routes (Router)
// =========================
const productRoutes = require("./routes/products");
productRoutes.init({
    generateUniqueSlug,
    getCached,
    setCache,
    clearProductCache
});
app.use("/api/products", productRoutes.router);

// =========================
// CSV Import (dynamic file upload)
// =========================

const csvUpload = multer({
    dest: path.join(__dirname, "uploads", "temp"),
    fileFilter: (req, file, cb) => {
        const allowed = ["text/csv", "application/vnd.ms-excel", "text/plain"];
        if (allowed.includes(file.mimetype) || file.originalname.endsWith(".csv")) {
            cb(null, true);
        } else {
            cb(new Error("Only CSV files are allowed"), false);
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max CSV
});

app.post("/api/import", authMiddleware, (req, res, next) => {
    csvUpload.single("csvFile")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ error: "CSV file too large. Maximum size is 10MB" });
            }
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No CSV file provided. Upload with field name 'csvFile'" });
    }

    const filePath = req.file.path;
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // Required fields and their display names
    const REQUIRED_FIELDS = {
        model_code: "Model Code",
        sku: "SKU",
        name_en: "Name (EN)",
        name_ar: "Name (AR)",
        material_en: "Material (EN)",
        material_ar: "Material (AR)",
        description_en: "Description (EN)",
        description_ar: "Description (AR)",
        color_en: "Color (EN)",
        color_ar: "Color (AR)"
    };

    const NUMERIC_FIELDS = {
        weight: "Weight",
        height: "Height"
    };

    try {
        // Parse CSV into memory
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(csv())
                .on("data", (row) => results.push(row))
                .on("end", resolve)
                .on("error", reject);
        });

        if (results.length === 0) {
            return res.status(400).json({ error: "CSV file is empty or has no valid rows" });
        }

        // Process each row
        for (let i = 0; i < results.length; i++) {
            const row = results[i];
            const rowNum = i + 2; // +2 for header row + 0-index

            const {
                model_code,
                weight,
                height,
                name_en,
                name_ar,
                material_en,
                material_ar,
                description_en,
                description_ar,
                sku,
                color_en,
                color_ar,
                color_code,
                image_url,
                tags
            } = row;

            // =========================
            // Detailed field validation
            // =========================
            const missingFields = [];
            for (const [field, label] of Object.entries(REQUIRED_FIELDS)) {
                if (!row[field] || !row[field].trim()) {
                    missingFields.push(label);
                }
            }
            for (const [field, label] of Object.entries(NUMERIC_FIELDS)) {
                if (row[field] === undefined || row[field] === "" || isNaN(row[field])) {
                    missingFields.push(`${label} (must be numeric)`);
                }
            }

            if (missingFields.length > 0) {
                const reason = `Missing/invalid: ${missingFields.join(", ")}`;
                console.log(`Row ${rowNum} (${sku || "no SKU"}): ${reason}`);
                errors.push({ row: rowNum, sku: sku || null, reason });
                errorCount++;
                continue;
            }

            const client = await pool.connect();
            try {
                await client.query("BEGIN");

                // =========================
                // STEP 1: Product (upsert by model_code)
                // =========================
                let productResult = await client.query(
                    `SELECT id FROM products WHERE model_code = $1`,
                    [model_code]
                );

                let productId;
                let isNewProduct = false;

                if (productResult.rows.length === 0) {
                    isNewProduct = true;
                    const insertResult = await client.query(
                        `INSERT INTO products (model_code, weight, height)
               VALUES ($1, $2, $3)
               RETURNING id`,
                        [model_code, weight, height]
                    );

                    productId = insertResult.rows[0].id;

                    const slugEn = await generateUniqueSlug(client, name_en, "en");
                    const slugAr = await generateUniqueSlug(client, name_ar, "ar");

                    await client.query(
                        `INSERT INTO product_translations 
               (product_id, language_code, name, material, description, slug)
               VALUES 
               ($1, 'en', $2, $3, $4, $8),
               ($1, 'ar', $5, $6, $7, $9)`,
                        [
                            productId,
                            name_en,
                            material_en,
                            description_en,
                            name_ar,
                            material_ar,
                            description_ar,
                            slugEn,
                            slugAr
                        ]
                    );

                } else {
                    productId = productResult.rows[0].id;
                }

                // =========================
                // STEP 2: Tags (link by slug, only for new products)
                // =========================
                if (tags && tags.trim() && isNewProduct) {
                    const tagSlugs = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);

                    for (const tagSlug of tagSlugs) {
                        // Find existing tag by slug
                        const tagResult = await client.query(
                            `SELECT id FROM tags WHERE slug = $1`,
                            [tagSlug]
                        );

                        if (tagResult.rows.length > 0) {
                            const tagId = tagResult.rows[0].id;

                            // Avoid duplicate product_tag link
                            const existingLink = await client.query(
                                `SELECT 1 FROM product_tags WHERE product_id = $1 AND tag_id = $2`,
                                [productId, tagId]
                            );

                            if (existingLink.rows.length === 0) {
                                await client.query(
                                    `INSERT INTO product_tags (product_id, tag_id) VALUES ($1, $2)`,
                                    [productId, tagId]
                                );
                            }
                        } else {
                            console.log(`Row ${rowNum}: Tag "${tagSlug}" not found in tags table, skipping`);
                        }
                    }
                }

                // =========================
                // STEP 3: Variant (skip if SKU already exists)
                // =========================
                const variantCheck = await client.query(
                    `SELECT id FROM product_variants WHERE sku = $1`,
                    [sku]
                );

                if (variantCheck.rows.length === 0) {
                    const variantInsert = await client.query(
                        `INSERT INTO product_variants
               (product_id, sku, color_name_en, color_name_ar, color_code)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id`,
                        [productId, sku, color_en, color_ar, color_code || null]
                    );

                    // =========================
                    // STEP 4: Images from URL (pipe-separated)
                    // =========================
                    if (image_url && image_url.trim()) {
                        const variantId = variantInsert.rows[0].id;
                        try {
                            const imageUrls = image_url.split("|").map(u => u.trim()).filter(Boolean);
                            let displayOrder = 1;

                            for (const url of imageUrls) {
                                const response = await fetch(url);
                                if (!response.ok) {
                                    console.error(`Row ${rowNum}: Failed to download image: ${url} (${response.status})`);
                                    continue;
                                }

                                const contentType = response.headers.get("content-type") || "";
                                let ext = ".jpg";
                                if (contentType.includes("png")) ext = ".png";
                                else if (contentType.includes("webp")) ext = ".webp";

                                const imageName = `${sku}-${displayOrder}-${Date.now()}${ext}`;
                                const imagePath = path.join(UPLOADS_DIR, imageName);

                                const buffer = Buffer.from(await response.arrayBuffer());
                                fs.writeFileSync(imagePath, buffer);

                                // Generate thumbnail
                                await processImage(imageName);

                                await client.query(
                                    `INSERT INTO variant_images (variant_id, image_name, display_order)
                   VALUES ($1, $2, $3)`,
                                    [variantId, imageName, displayOrder]
                                );
                                displayOrder++;
                            }
                        } catch (imgErr) {
                            console.error(`Row ${rowNum}: Image processing failed for ${sku}:`, imgErr.message);
                        }
                    }
                }

                await client.query("COMMIT");
                successCount++;

            } catch (err) {
                await client.query("ROLLBACK");
                const reason = err.message;
                console.error(`Row ${rowNum} failed (${sku}):`, reason);
                errors.push({ row: rowNum, sku, reason });
                errorCount++;
            } finally {
                client.release();
            }
        }

        clearProductCache();
        res.json({
            message: "Import completed",
            total: results.length,
            success: successCount,
            failed: errorCount,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (err) {
        console.error("ERROR IN /api/import:", err);
        res.status(500).json({ error: err.message });
    } finally {
        // Clean up temp CSV file
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (cleanupErr) {
            console.error("Failed to clean up temp CSV:", cleanupErr.message);
        }
    }
});
// Manual image name entry (for pre-uploaded images)
app.post("/api/variants/:variantId/images", authMiddleware, async (req, res) => {
    const { variantId } = req.params;
    const { image_name, display_order = 1 } = req.body;

    if (!image_name) {
        return res.status(400).json({ error: "image_name is required" });
    }

    try {
        // Generate thumbnail if file exists on disk
        let thumbnailName = null;
        const fullPath = path.join(UPLOADS_DIR, image_name);
        if (fs.existsSync(fullPath)) {
            thumbnailName = await processImage(image_name);
        }

        await pool.query(
            `INSERT INTO variant_images (variant_id, image_name, display_order)
         VALUES ($1, $2, $3)`,
            [variantId, image_name, display_order]
        );

        res.json({
            message: "Image added successfully",
            image_url: `${BASE_URL}/images/${image_name}`,
            thumbnail_url: thumbnailName
                ? `${BASE_URL}/images/thumbnails/${thumbnailName}`
                : null
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add image" });
    }
});

// =========================
// Image Upload Route (with file upload + thumbnail)
// =========================
app.post("/api/variants/:variantId/images/upload", authMiddleware, (req, res, next) => {
    upload.single("image")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ error: "File too large. Maximum size is 5MB" });
            }
            return res.status(400).json({ error: err.message });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    const { variantId } = req.params;
    const displayOrder = parseInt(req.body.display_order, 10) || 1;

    if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
    }

    const imageName = req.file.filename;

    try {
        // Verify variant exists
        const variantCheck = await pool.query(
            `SELECT id FROM product_variants WHERE id = $1`,
            [variantId]
        );
        if (variantCheck.rows.length === 0) {
            // Clean up uploaded file
            fs.unlinkSync(path.join(UPLOADS_DIR, imageName));
            return res.status(404).json({ error: `Variant ${variantId} not found` });
        }

        // Generate thumbnail
        const thumbnailName = await processImage(imageName);

        // Save to DB
        await pool.query(
            `INSERT INTO variant_images (variant_id, image_name, display_order)
       VALUES ($1, $2, $3)`,
            [variantId, imageName, displayOrder]
        );

        res.json({
            message: "Image uploaded successfully",
            image_name: imageName,
            image_url: `${BASE_URL}/images/${imageName}`,
            thumbnail_url: thumbnailName
                ? `${BASE_URL}/images/thumbnails/${thumbnailName}`
                : null,
            display_order: displayOrder
        });

    } catch (err) {
        // Clean up on error
        const filePath = path.join(UPLOADS_DIR, imageName);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        console.error("ERROR IN image upload:", err);
        res.status(500).json({ error: "Image upload failed" });
    }
});


// =============================================================================
// CRUD: Variants â€” UPDATE & DELETE
// =============================================================================

// PUT /api/variants/:id â€” Update variant
app.put("/api/variants/:id", authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { sku, color_name_en, color_name_ar, color_code } = req.body;

    try {
        const existing = await pool.query(
            `SELECT id FROM product_variants WHERE id = $1`, [id]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: `Variant ${id} not found` });
        }

        const updates = [];
        const values = [];
        let idx = 1;

        if (sku !== undefined) { updates.push(`sku = $${idx++}`); values.push(sku); }
        if (color_name_en !== undefined) { updates.push(`color_name_en = $${idx++}`); values.push(color_name_en); }
        if (color_name_ar !== undefined) { updates.push(`color_name_ar = $${idx++}`); values.push(color_name_ar); }
        if (color_code !== undefined) { updates.push(`color_code = $${idx++}`); values.push(color_code); }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        values.push(id);
        await pool.query(
            `UPDATE product_variants SET ${updates.join(", ")} WHERE id = $${idx}`,
            values
        );

        clearProductCache();
        res.json({ message: `Variant ${id} updated successfully` });

    } catch (err) {
        console.error("ERROR IN PUT /api/variants:", err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/variants/:id â€” Delete variant + clean up image files
app.delete("/api/variants/:id", authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        // Gather image files before cascade deletes references
        const images = await pool.query(
            `SELECT image_name FROM variant_images WHERE variant_id = $1`, [id]
        );

        const result = await pool.query(
            `DELETE FROM product_variants WHERE id = $1 RETURNING id, sku`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `Variant ${id} not found` });
        }

        // Clean up image files
        for (const img of images.rows) {
            const imgPath = path.join(UPLOADS_DIR, img.image_name);
            const thumbName = `thumb_${path.parse(img.image_name).name}.webp`;
            const thumbPath = path.join(THUMBS_DIR, thumbName);

            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }

        clearProductCache();
        res.json({
            message: `Variant ${result.rows[0].sku} deleted`,
            deleted_images: images.rows.length
        });

    } catch (err) {
        console.error("ERROR IN DELETE /api/variants:", err);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// CRUD: Images â€” DELETE
// =============================================================================

// DELETE /api/images/:id â€” Delete a single variant image
app.delete("/api/images/:id", authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM variant_images WHERE id = $1 RETURNING image_name`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `Image ${id} not found` });
        }

        const imageName = result.rows[0].image_name;
        const imgPath = path.join(UPLOADS_DIR, imageName);
        const thumbName = `thumb_${path.parse(imageName).name}.webp`;
        const thumbPath = path.join(THUMBS_DIR, thumbName);

        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

        clearProductCache();
        res.json({ message: `Image "${imageName}" deleted` });

    } catch (err) {
        console.error("ERROR IN DELETE /api/images:", err);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// CRUD: Tags â€” Full Management
// =============================================================================

// GET /api/tags â€” List all tags (with translations)
app.get("/api/tags", async (req, res) => {
    const { lang = "en" } = req.query;

    try {
        const result = await pool.query(`
      SELECT
        tg.id,
        tg.slug,
        tt.name,
        tt.language_code
      FROM tags tg
      LEFT JOIN tag_translations tt
        ON tg.id = tt.tag_id AND tt.language_code = $1
      ORDER BY tg.slug ASC
    `, [lang]);

        const tags = result.rows.map(row => ({
            id: row.id,
            slug: row.slug,
            name: row.name || null
        }));

        res.json({ data: tags });

    } catch (err) {
        console.error("ERROR IN GET /api/tags:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tags â€” Create a new tag (bilingual)
app.post("/api/tags", authMiddleware, [
    body("slug").notEmpty().trim(),
    body("name_en").notEmpty().trim(),
    body("name_ar").notEmpty().trim()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { slug, name_en, name_ar } = req.body;
    const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Check if slug already exists
        const existing = await client.query(
            `SELECT id FROM tags WHERE slug = $1`, [normalizedSlug]
        );
        if (existing.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: `Tag with slug "${normalizedSlug}" already exists` });
        }

        const tagResult = await client.query(
            `INSERT INTO tags (slug) VALUES ($1) RETURNING id`,
            [normalizedSlug]
        );
        const tagId = tagResult.rows[0].id;

        await client.query(
            `INSERT INTO tag_translations (tag_id, language_code, name)
       VALUES ($1, 'en', $2), ($1, 'ar', $3)`,
            [tagId, name_en, name_ar]
        );

        await client.query("COMMIT");
        clearProductCache();
        res.status(201).json({
            message: "Tag created",
            tag: { id: tagId, slug: normalizedSlug, name_en, name_ar }
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("ERROR IN POST /api/tags:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT /api/tags/:id â€” Update tag (partial updates supported)
app.put("/api/tags/:id", authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { slug, name_en, name_ar } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const existing = await client.query(
            `SELECT id FROM tags WHERE id = $1`, [id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: `Tag ${id} not found` });
        }

        // Update slug if provided
        if (slug !== undefined) {
            const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
            await client.query(
                `UPDATE tags SET slug = $1 WHERE id = $2`,
                [normalizedSlug, id]
            );
        }

        // Update EN name
        if (name_en !== undefined) {
            await client.query(
                `UPDATE tag_translations SET name = $1
         WHERE tag_id = $2 AND language_code = 'en'`,
                [name_en, id]
            );
        }

        // Update AR name
        if (name_ar !== undefined) {
            await client.query(
                `UPDATE tag_translations SET name = $1
         WHERE tag_id = $2 AND language_code = 'ar'`,
                [name_ar, id]
            );
        }

        await client.query("COMMIT");
        clearProductCache();
        res.json({ message: `Tag ${id} updated successfully` });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("ERROR IN PUT /api/tags:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// DELETE /api/tags/:id â€” Delete tag (cascades to tag_translations and product_tags)
app.delete("/api/tags/:id", authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM tags WHERE id = $1 RETURNING id, slug`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `Tag ${id} not found` });
        }

        clearProductCache();
        res.json({ message: `Tag "${result.rows[0].slug}" deleted` });

    } catch (err) {
        console.error("ERROR IN DELETE /api/tags:", err);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// Product-Tag Linking
// =============================================================================

// =============================================================================
// Inquiries (B2B Cart/Quote Requests)
// =============================================================================

// POST /api/inquiries â€” Submit an inquiry/quote request (public)
app.post("/api/inquiries", [
    body("customer_name").notEmpty().withMessage("Name is required").trim(),
    body("customer_email").isEmail().withMessage("Valid email is required").normalizeEmail(),
    body("customer_phone").optional().trim(),
    body("customer_company").optional().trim(),
    body("message").optional().trim(),
    body("items").isArray({ min: 1 }).withMessage("At least one item is required"),
    body("items.*.sku").notEmpty().withMessage("Each item must have a SKU"),
    body("items.*.quantity").isInt({ min: 1 }).withMessage("Quantity must be at least 1")
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { customer_name, customer_email, customer_phone, customer_company, message, items } = req.body;

    try {
        // Validate all SKUs exist
        const skus = items.map(i => i.sku);
        const skuCheck = await pool.query(
            `SELECT sku FROM product_variants WHERE sku = ANY($1)`,
            [skus]
        );
        const validSkus = new Set(skuCheck.rows.map(r => r.sku));
        const invalidSkus = skus.filter(s => !validSkus.has(s));

        if (invalidSkus.length > 0) {
            return res.status(400).json({
                error: "Invalid SKUs",
                invalid_skus: invalidSkus
            });
        }

        const result = await pool.query(
            `INSERT INTO inquiries (customer_name, customer_email, customer_phone, customer_company, message, items)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [customer_name, customer_email, customer_phone || null, customer_company || null, message || null, JSON.stringify(items)]
        );

        res.status(201).json({
            message: "Inquiry submitted successfully. We will get back to you soon.",
            inquiry_id: result.rows[0].id,
            created_at: result.rows[0].created_at
        });

    } catch (err) {
        console.error("ERROR IN POST /api/inquiries:", err);
        res.status(500).json({ error: "Failed to submit inquiry" });
    }
});

// GET /api/inquiries â€” List inquiries (admin only)
app.get("/api/inquiries", authMiddleware, async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * Math.min(100, parseInt(limit, 10) || 20);
    const actualLimit = Math.min(100, parseInt(limit, 10) || 20);

    try {
        let query = `SELECT * FROM inquiries`;
        let countQuery = `SELECT COUNT(*) as total FROM inquiries`;
        const params = [];
        const countParams = [];

        if (status) {
            query += ` WHERE status = $1`;
            countQuery += ` WHERE status = $1`;
            params.push(status);
            countParams.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(actualLimit, offset);

        const [result, countResult] = await Promise.all([
            pool.query(query, params),
            pool.query(countQuery, countParams)
        ]);

        const total = parseInt(countResult.rows[0].total, 10);

        res.json({
            page: parseInt(page, 10) || 1,
            limit: actualLimit,
            total,
            totalPages: Math.ceil(total / actualLimit),
            data: result.rows
        });

    } catch (err) {
        console.error("ERROR IN GET /api/inquiries:", err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/inquiries/:id/status â€” Update inquiry status (admin only)
app.put("/api/inquiries/:id/status", authMiddleware, [
    body("status").isIn(["new", "contacted", "quoted", "closed"]).withMessage("Status must be: new, contacted, quoted, or closed")
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { id } = req.params;
    const { status } = req.body;

    try {
        const result = await pool.query(
            `UPDATE inquiries SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status, updated_at`,
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `Inquiry ${id} not found` });
        }

        res.json({
            message: `Inquiry ${id} status updated to "${status}"`,
            inquiry: result.rows[0]
        });

    } catch (err) {
        console.error("ERROR IN PUT /api/inquiries/:id/status:", err);
        res.status(500).json({ error: err.message });
    }
});

