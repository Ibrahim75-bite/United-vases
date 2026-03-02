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
  console.error(`❌ Missing required environment variables: ${missingEnv.join(", ")}`);
  console.error("   Please check your .env file.");
  process.exit(1);
}

const pool = require("./db");

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
// Response Timing (logged, not header — headers can't be set after finish)
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
// Protected Admin Routes
// =========================
app.post(
  "/api/products",
  authMiddleware,
  [
    body("model_code").notEmpty().withMessage("Model code is required").trim(),
    body("sku")
      .notEmpty().withMessage("SKU is required")
      .matches(/^[a-zA-Z0-9-]+$/).withMessage("SKU must be alphanumeric with hyphens only")
      .trim(),
    body("name_en").notEmpty().withMessage("English name is required").trim().escape(),
    body("name_ar").notEmpty().withMessage("Arabic name is required").trim(),
    body("material_en").notEmpty().withMessage("English material is required").trim().escape(),
    body("material_ar").notEmpty().withMessage("Arabic material is required").trim(),
    body("description_en").notEmpty().withMessage("English description is required").trim(),
    body("description_ar").notEmpty().withMessage("Arabic description is required").trim(),
    body("color_en").notEmpty().withMessage("English color is required").trim().escape(),
    body("color_ar").notEmpty().withMessage("Arabic color is required").trim(),
    body("weight")
      .isFloat({ min: 0.01 }).withMessage("Weight must be a positive number")
      .toFloat(),
    body("height")
      .isFloat({ min: 0.01 }).withMessage("Height must be a positive number")
      .toFloat()
  ],
  async (req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors.array()
      });
    }

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
      color_ar
    } = req.body;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      let productResult = await client.query(
        `SELECT id FROM products WHERE model_code = $1`,
        [model_code]
      );

      let productId;

      if (productResult.rows.length === 0) {
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

      const variantCheck = await client.query(
        `SELECT id FROM product_variants WHERE sku = $1`,
        [sku]
      );

      if (variantCheck.rows.length === 0) {
        await client.query(
          `INSERT INTO product_variants
             (product_id, sku, color_name_en, color_name_ar)
             VALUES ($1, $2, $3, $4)`,
          [productId, sku, color_en, color_ar]
        );
      }

      await client.query("COMMIT");

      clearProductCache();
      res.json({ message: "Product/Variant processed successfully" });

    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Product creation failed" });
    } finally {
      client.release();
    }
  }
);
app.get("/api/products", async (req, res) => {
  try {
    const {
      lang = "en",
      search = null,
      tags = null
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const tagList = tags ? tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : null;

    // Check cache
    const cacheKey = `products:${lang}:${search}:${tags}:${page}:${limit}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // =========================
    // Shared WHERE clause builder
    // =========================
    const whereClause = `
      WHERE t.language_code = $1
        AND (
          $2::text IS NULL OR
          t.search_vector @@
            CASE
              WHEN t.language_code = 'en'
                THEN plainto_tsquery('english', $2)
              WHEN t.language_code = 'ar'
                THEN plainto_tsquery('arabic', $2)
              ELSE plainto_tsquery('simple', $2)
            END
        )
        AND (
          $3::text[] IS NULL OR
          EXISTS (
            SELECT 1
            FROM product_tags pt2
            JOIN tags tg2 ON pt2.tag_id = tg2.id
            WHERE pt2.product_id = p.id
              AND tg2.slug = ANY($3)
          )
        )
    `;

    // =========================
    // STEP 1: Get paginated product IDs (ranked + filtered)
    //         AND total count in parallel
    // =========================
    const baseParams = [lang, search, tagList];

    const [idResult, countResult] = await Promise.all([
      pool.query(`
        SELECT DISTINCT p.id, p.model_code,
          CASE
            WHEN $2::text IS NULL THEN 0
            WHEN t.language_code = 'en'
              THEN ts_rank_cd(
                     t.search_vector,
                     plainto_tsquery('english', $2)
                   )
            WHEN t.language_code = 'ar'
              THEN ts_rank_cd(
                     t.search_vector,
                     plainto_tsquery('arabic', $2)
                   )
            ELSE
              ts_rank_cd(
                t.search_vector,
                plainto_tsquery('simple', $2)
              )
          END AS rank
        FROM products p
        JOIN product_translations t
          ON p.id = t.product_id
        ${whereClause}
        ORDER BY rank DESC, p.model_code ASC
        LIMIT $4 OFFSET $5
      `, [...baseParams, limit, offset]),

      pool.query(`
        SELECT COUNT(DISTINCT p.id) AS total
        FROM products p
        JOIN product_translations t
          ON p.id = t.product_id
        ${whereClause}
      `, baseParams)
    ]);

    let productIds = idResult.rows.map(r => r.id);
    const total = parseInt(countResult.rows[0].total, 10);

    // =========================
    // Fuzzy search fallback (pg_trgm)
    // If full-text search returns empty, try trigram similarity
    // =========================
    if (productIds.length === 0 && search) {
      const fuzzyResult = await pool.query(`
        SELECT DISTINCT p.id, p.model_code,
          similarity(t.name, $2) AS sim
        FROM products p
        JOIN product_translations t
          ON p.id = t.product_id
        WHERE t.language_code = $1
          AND similarity(t.name, $2) > 0.2
        ORDER BY sim DESC, p.model_code ASC
        LIMIT $3 OFFSET $4
      `, [lang, search, limit, offset]);

      productIds = fuzzyResult.rows.map(r => r.id);
    }

    if (productIds.length === 0) {
      const emptyResponse = {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        data: []
      };
      setCache(cacheKey, emptyResponse);
      return res.json(emptyResponse);
    }

    // Preserve the ranked order from Step 1
    const idOrderMap = {};
    productIds.forEach((id, idx) => { idOrderMap[id] = idx; });

    // =========================
    // STEP 2: Fetch full product data for the page
    // =========================
    const result = await pool.query(`
      SELECT
        p.id AS product_id,
        p.model_code AS model_sku,
        p.weight,
        p.height,
        t.name,
        t.slug AS product_slug,
        t.material,
        t.description,
        t.meta_title,
        t.meta_description,
        v.id AS variant_id,
        v.sku,
        v.color_code,
        v.color_name_en,
        v.color_name_ar,
        i.image_name,
        tg.slug AS tag_slug,
        tt.name AS tag_name
      FROM products p
      JOIN product_translations t
        ON p.id = t.product_id AND t.language_code = $1
      LEFT JOIN product_variants v
        ON p.id = v.product_id
      LEFT JOIN variant_images i
        ON v.id = i.variant_id
      LEFT JOIN product_tags pt
        ON p.id = pt.product_id
      LEFT JOIN tags tg
        ON pt.tag_id = tg.id
      LEFT JOIN tag_translations tt
        ON tg.id = tt.tag_id AND tt.language_code = $1
      WHERE p.id = ANY($2)
      ORDER BY p.model_code ASC, v.sku ASC, i.display_order ASC
    `, [lang, productIds]);

    // =========================
    // STEP 3: Group rows into structured products
    // =========================
    const rows = result.rows;
    const productsMap = {};

    for (const row of rows) {
      if (!productsMap[row.product_id]) {
        productsMap[row.product_id] = {
          product_id: row.product_id,
          model_sku: row.model_sku,
          slug: row.product_slug,
          weight: parseFloat(row.weight),
          height: parseFloat(row.height),
          name: row.name,
          material: row.material,
          description: row.description,
          meta_title: row.meta_title || null,
          meta_description: row.meta_description || null,
          variants: {},
          tags: {}
        };
      }

      // Deduplicated tags (keyed by tag_slug)
      if (row.tag_slug) {
        productsMap[row.product_id].tags[row.tag_slug] = {
          slug: row.tag_slug,
          name: row.tag_name
        };
      }

      // Variants with deduplicated images
      if (row.variant_id) {
        if (!productsMap[row.product_id].variants[row.variant_id]) {
          productsMap[row.product_id].variants[row.variant_id] = {
            variant_id: row.variant_id,
            sku: row.sku,
            color_code: row.color_code || null,
            color: lang === "ar" ? row.color_name_ar : row.color_name_en,
            images: []
          };
        }

        if (row.image_name) {
          const imageUrl = `${process.env.BASE_URL}/images/${row.image_name}`;
          const thumbName = `thumb_${path.parse(row.image_name).name}.webp`;
          const thumbnailUrl = `${process.env.BASE_URL}/images/thumbnails/${thumbName}`;
          const imagesArray =
            productsMap[row.product_id].variants[row.variant_id].images;

          if (!imagesArray.some(img => img.url === imageUrl)) {
            imagesArray.push({
              url: imageUrl,
              thumbnail: fs.existsSync(path.join(THUMBS_DIR, thumbName))
                ? thumbnailUrl
                : null
            });
          }
        }
      }
    }

    // Convert maps to arrays and sort by original ranked order
    const finalProducts = Object.values(productsMap)
      .map(product => ({
        ...product,
        variants: Object.values(product.variants),
        tags: Object.values(product.tags)
      }))
      .sort((a, b) => idOrderMap[a.product_id] - idOrderMap[b.product_id]);

    const response = {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: finalProducts
    };
    setCache(cacheKey, response);
    res.json(response);

  } catch (err) {
    console.error("ERROR IN /api/products:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/products/slug/:slug", async (req, res) => {
  try {
    const slug = (req.params.slug || "").trim();
    const { lang = "en" } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "Slug parameter is required" });
    }

    // Check cache
    const cacheKey = `slug:${slug}:${lang}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const result = await pool.query(`
      SELECT
        p.id AS product_id,
        p.model_code AS model_sku,
        p.weight,
        p.height,
        t.name,
        t.slug AS product_slug,
        t.material,
        t.description,
        t.meta_title,
        t.meta_description,
        v.id AS variant_id,
        v.sku,
        v.color_code,
        v.color_name_en,
        v.color_name_ar,
        i.image_name,
        tg.slug AS tag_slug,
        tt.name AS tag_name
      FROM product_translations t
      JOIN products p ON t.product_id = p.id
      LEFT JOIN product_variants v ON p.id = v.product_id
      LEFT JOIN variant_images i ON v.id = i.variant_id
      LEFT JOIN product_tags pt ON p.id = pt.product_id
      LEFT JOIN tags tg ON pt.tag_id = tg.id
      LEFT JOIN tag_translations tt
        ON tg.id = tt.tag_id AND tt.language_code = $2
      WHERE t.slug = $1
        AND t.language_code = $2
      ORDER BY v.sku ASC, i.display_order ASC
    `, [slug, lang]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Product with slug "${slug}" not found` });
    }

    const rows = result.rows;
    const first = rows[0];

    const product = {
      product_id: first.product_id,
      model_sku: first.model_sku,
      slug: first.product_slug,
      weight: parseFloat(first.weight),
      height: parseFloat(first.height),
      name: first.name,
      material: first.material,
      description: first.description,
      meta_title: first.meta_title || null,
      meta_description: first.meta_description || null,
      variants: {},
      tags: {}
    };

    // Track image URLs per variant with a Set for O(1) dedup
    const imagesSeen = {};

    for (const row of rows) {
      // Deduplicated tags (keyed by tag_slug)
      if (row.tag_slug) {
        product.tags[row.tag_slug] = {
          slug: row.tag_slug,
          name: row.tag_name
        };
      }

      // Variants with deduplicated images
      if (row.variant_id) {
        if (!product.variants[row.variant_id]) {
          product.variants[row.variant_id] = {
            variant_id: row.variant_id,
            sku: row.sku,
            color_code: row.color_code || null,
            color: lang === "ar" ? row.color_name_ar : row.color_name_en,
            images: []
          };
          imagesSeen[row.variant_id] = new Set();
        }

        if (row.image_name) {
          const imageUrl = `${process.env.BASE_URL}/images/${row.image_name}`;
          const thumbName = `thumb_${path.parse(row.image_name).name}.webp`;
          const thumbnailUrl = `${process.env.BASE_URL}/images/thumbnails/${thumbName}`;

          if (!imagesSeen[row.variant_id].has(imageUrl)) {
            imagesSeen[row.variant_id].add(imageUrl);
            product.variants[row.variant_id].images.push({
              url: imageUrl,
              thumbnail: fs.existsSync(path.join(THUMBS_DIR, thumbName))
                ? thumbnailUrl
                : null
            });
          }
        }
      }
    }

    const slugResponse = {
      ...product,
      variants: Object.values(product.variants),
      tags: Object.values(product.tags)
    };
    setCache(cacheKey, slugResponse);
    res.json(slugResponse);

  } catch (err) {
    console.error("ERROR IN /api/products/slug:", err);
    res.status(500).json({ error: err.message });
  }
});

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
      image_url: `${process.env.BASE_URL}/images/${image_name}`,
      thumbnail_url: thumbnailName
        ? `${process.env.BASE_URL}/images/thumbnails/${thumbnailName}`
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
      image_url: `${process.env.BASE_URL}/images/${imageName}`,
      thumbnail_url: thumbnailName
        ? `${process.env.BASE_URL}/images/thumbnails/${thumbnailName}`
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
// CRUD: Products — UPDATE & DELETE
// =============================================================================

// PUT /api/products/:id — Update product (supports partial bilingual updates)
app.put("/api/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

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
    meta_title_en,
    meta_title_ar,
    meta_description_en,
    meta_description_ar
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check product exists
    const existing = await client.query(
      `SELECT id FROM products WHERE id = $1`, [id]
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: `Product ${id} not found` });
    }

    // Update products table (if any fields provided)
    const productUpdates = [];
    const productValues = [];
    let paramIdx = 1;

    if (model_code !== undefined) {
      productUpdates.push(`model_code = $${paramIdx++}`);
      productValues.push(model_code);
    }
    if (weight !== undefined) {
      productUpdates.push(`weight = $${paramIdx++}`);
      productValues.push(weight);
    }
    if (height !== undefined) {
      productUpdates.push(`height = $${paramIdx++}`);
      productValues.push(height);
    }

    if (productUpdates.length > 0) {
      productValues.push(id);
      await client.query(
        `UPDATE products SET ${productUpdates.join(", ")} WHERE id = $${paramIdx}`,
        productValues
      );
    }

    // Update English translation (if any EN fields provided)
    const enFields = { name_en, material_en, description_en, meta_title_en, meta_description_en };
    const enUpdates = [];
    const enValues = [];
    let enIdx = 1;

    if (name_en !== undefined) { enUpdates.push(`name = $${enIdx++}`); enValues.push(name_en); }
    if (material_en !== undefined) { enUpdates.push(`material = $${enIdx++}`); enValues.push(material_en); }
    if (description_en !== undefined) { enUpdates.push(`description = $${enIdx++}`); enValues.push(description_en); }
    if (meta_title_en !== undefined) { enUpdates.push(`meta_title = $${enIdx++}`); enValues.push(meta_title_en); }
    if (meta_description_en !== undefined) { enUpdates.push(`meta_description = $${enIdx++}`); enValues.push(meta_description_en); }

    if (name_en !== undefined) {
      enUpdates.push(`slug = $${enIdx++}`);
      enValues.push(await generateUniqueSlug(client, name_en, "en"));
    }

    if (enUpdates.length > 0) {
      enValues.push(id);
      await client.query(
        `UPDATE product_translations SET ${enUpdates.join(", ")}
         WHERE product_id = $${enIdx} AND language_code = 'en'`,
        enValues
      );
    }

    // Update Arabic translation (if any AR fields provided)
    const arUpdates = [];
    const arValues = [];
    let arIdx = 1;

    if (name_ar !== undefined) { arUpdates.push(`name = $${arIdx++}`); arValues.push(name_ar); }
    if (material_ar !== undefined) { arUpdates.push(`material = $${arIdx++}`); arValues.push(material_ar); }
    if (description_ar !== undefined) { arUpdates.push(`description = $${arIdx++}`); arValues.push(description_ar); }
    if (meta_title_ar !== undefined) { arUpdates.push(`meta_title = $${arIdx++}`); arValues.push(meta_title_ar); }
    if (meta_description_ar !== undefined) { arUpdates.push(`meta_description = $${arIdx++}`); arValues.push(meta_description_ar); }

    if (name_ar !== undefined) {
      arUpdates.push(`slug = $${arIdx++}`);
      arValues.push(await generateUniqueSlug(client, name_ar, "ar"));
    }

    if (arUpdates.length > 0) {
      arValues.push(id);
      await client.query(
        `UPDATE product_translations SET ${arUpdates.join(", ")}
         WHERE product_id = $${arIdx} AND language_code = 'ar'`,
        arValues
      );
    }

    await client.query("COMMIT");
    clearProductCache();
    res.json({ message: `Product ${id} updated successfully` });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERROR IN PUT /api/products:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/products/:id — Delete product (cascades to translations, variants, images, tags)
app.delete("/api/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    // Gather image files to delete from disk before DB cascade removes the references
    const images = await pool.query(`
      SELECT i.image_name
      FROM variant_images i
      JOIN product_variants v ON i.variant_id = v.id
      WHERE v.product_id = $1
    `, [id]);

    const result = await pool.query(
      `DELETE FROM products WHERE id = $1 RETURNING id, model_code`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Product ${id} not found` });
    }

    // Clean up image files from disk
    for (const img of images.rows) {
      const imgPath = path.join(UPLOADS_DIR, img.image_name);
      const thumbName = `thumb_${path.parse(img.image_name).name}.webp`;
      const thumbPath = path.join(THUMBS_DIR, thumbName);

      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }

    clearProductCache();
    res.json({
      message: `Product ${result.rows[0].model_code} and all related data deleted`,
      deleted_images: images.rows.length
    });

  } catch (err) {
    console.error("ERROR IN DELETE /api/products:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// CRUD: Variants — UPDATE & DELETE
// =============================================================================

// PUT /api/variants/:id — Update variant
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

// DELETE /api/variants/:id — Delete variant + clean up image files
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
// CRUD: Images — DELETE
// =============================================================================

// DELETE /api/images/:id — Delete a single variant image
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
// CRUD: Tags — Full Management
// =============================================================================

// GET /api/tags — List all tags (with translations)
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

// POST /api/tags — Create a new tag (bilingual)
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

// PUT /api/tags/:id — Update tag (partial updates supported)
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

// DELETE /api/tags/:id — Delete tag (cascades to tag_translations and product_tags)
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

// POST /api/products/:id/tags — Link tags to a product
app.post("/api/products/:id/tags", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { tag_slugs } = req.body; // array of tag slugs, e.g. ["modern", "ceramic"]

  if (!tag_slugs || !Array.isArray(tag_slugs) || tag_slugs.length === 0) {
    return res.status(400).json({ error: "tag_slugs must be a non-empty array" });
  }

  try {
    // Verify product exists
    const productCheck = await pool.query(
      `SELECT id FROM products WHERE id = $1`, [id]
    );
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: `Product ${id} not found` });
    }

    const linked = [];
    const notFound = [];

    for (const slug of tag_slugs) {
      const tagResult = await pool.query(
        `SELECT id FROM tags WHERE slug = $1`,
        [slug.trim().toLowerCase()]
      );

      if (tagResult.rows.length === 0) {
        notFound.push(slug);
        continue;
      }

      const tagId = tagResult.rows[0].id;

      // Avoid duplicate
      const existing = await pool.query(
        `SELECT 1 FROM product_tags WHERE product_id = $1 AND tag_id = $2`,
        [id, tagId]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO product_tags (product_id, tag_id) VALUES ($1, $2)`,
          [id, tagId]
        );
        linked.push(slug);
      }
    }

    clearProductCache();
    res.json({
      message: "Tags linked",
      linked,
      not_found: notFound.length > 0 ? notFound : undefined
    });

  } catch (err) {
    console.error("ERROR IN POST /api/products/:id/tags:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id/tags/:tagId — Unlink a tag from a product
app.delete("/api/products/:id/tags/:tagId", authMiddleware, async (req, res) => {
  const { id, tagId } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM product_tags WHERE product_id = $1 AND tag_id = $2 RETURNING *`,
      [id, tagId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Tag link not found for this product" });
    }

    clearProductCache();
    res.json({ message: `Tag ${tagId} unlinked from product ${id}` });

  } catch (err) {
    console.error("ERROR IN DELETE /api/products/:id/tags:", err);
    res.status(500).json({ error: err.message });
  }
});