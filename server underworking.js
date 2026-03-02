const { body, validationResult } = require("express-validator");
const fs = require("fs");
const csv = require("csv-parser");
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const pool = require("./db");

const app = express();

app.use(cors());
app.use("/images", express.static("uploads/images"));
app.use(express.json());

app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ message: "Server running", time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

const PORT = 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.post(
  "/api/products",
  [
    body("model_code").notEmpty(),
    body("sku").notEmpty(),
    body("name_en").notEmpty(),
    body("name_ar").notEmpty(),
    body("material_en").notEmpty(),
    body("material_ar").notEmpty(),
    body("description_en").notEmpty(),
    body("description_ar").notEmpty(),
    body("color_en").notEmpty(),
    body("color_ar").notEmpty(),
    body("weight").isNumeric(),
    body("height").isNumeric()
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

        await client.query(
          `INSERT INTO product_translations 
             (product_id, language_code, name, material, description)
             VALUES 
             ($1, 'en', $2, $3, $4),
             ($1, 'ar', $5, $6, $7)`,
          [
            productId,
            name_en,
            material_en,
            description_en,
            name_ar,
            material_ar,
            description_ar
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

  const { lang = "en", search = null, tags = null } = req.query;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const tagList = tags
    ? tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean)
    : null;

  // Shared WHERE + filter clause (reused by data query and count query)
  const filterClause = `
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

  try {
    // Run main query and filtered count in parallel
    const [result, countResult] = await Promise.all([
      pool.query(`
          SELECT
            p.id AS product_id,
            p.model_code AS model_sku,
            p.weight,
            p.height,
            t.name,
            t.material,
            t.description,
            v.id AS variant_id,
            v.sku,
            v.color_name_en,
            v.color_name_ar,
            i.image_name,
            tg.slug,
            tt.name AS tag_name,

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
          ${filterClause}
          ORDER BY rank DESC,
            p.model_code ASC,
            v.sku ASC,
            i.display_order ASC
        `, [lang, search, tagList]),

      pool.query(`
          SELECT COUNT(DISTINCT p.id) AS total
          FROM products p
          JOIN product_translations t
            ON p.id = t.product_id
          ${filterClause}
        `, [lang, search, tagList])
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    const rows = result.rows;
    const productsMap = {};

    for (const row of rows) {
      if (!productsMap[row.product_id]) {
        productsMap[row.product_id] = {
          product_id: row.product_id,
          model_sku: row.model_sku,
          weight: parseFloat(row.weight),
          height: parseFloat(row.height),
          name: row.name,
          material: row.material,
          description: row.description,
          rank: row.rank,
          variants: {},
          tags: {}
        };
      }

      if (row.slug) {
        productsMap[row.product_id].tags[row.slug] = {
          slug: row.slug,
          name: row.tag_name
        };
      }

      if (row.variant_id) {
        if (!productsMap[row.product_id].variants[row.variant_id]) {
          productsMap[row.product_id].variants[row.variant_id] = {
            variant_id: row.variant_id,
            sku: row.sku,
            color: lang === "ar"
              ? row.color_name_ar
              : row.color_name_en,
            images: []
          };
        }

        if (row.image_name) {
          const imageUrl = `${process.env.BASE_URL}/images/${row.image_name}`;
          const imagesArray = productsMap[row.product_id]
            .variants[row.variant_id]
            .images;

          if (!imagesArray.includes(imageUrl)) {
            imagesArray.push(imageUrl);
          }
        }
      }
    }

    // Convert maps to arrays
    const finalProducts = Object.values(productsMap).map(product => {
      product.variants = Object.values(product.variants);
      product.tags = Object.values(product.tags);
      return product;
    });

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      data: finalProducts
    });

  } catch (err) {
    console.error("ERROR IN /api/products:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/import", async (req, res) => {
  const filePath = "./uploads/test/products.csv";

  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ error: "CSV file not found in uploads folder" });
  }

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  fs.createReadStream(filePath)
    .pipe(csv())
    .on("data", async (row) => {
      results.push(row);
    })
    .on("end", async () => {
      for (let row of results) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

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
          } = row;
          if (
            !model_code ||
            !sku ||
            !name_en ||
            !name_ar ||
            !material_en ||
            !material_ar ||
            !description_en ||
            !description_ar ||
            !color_en ||
            !color_ar ||
            isNaN(weight) ||
            isNaN(height)
          ) {
            console.log("Skipping invalid row:", sku);
            errorCount++;
            continue;
          }

          // Check parent
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

            await client.query(
              `INSERT INTO product_translations 
                 (product_id, language_code, name, material, description)
                 VALUES 
                 ($1, 'en', $2, $3, $4),
                 ($1, 'ar', $5, $6, $7)`,
              [
                productId,
                name_en,
                material_en,
                description_en,
                name_ar,
                material_ar,
                description_ar
              ]
            );

          } else {
            productId = productResult.rows[0].id;
          }

          // Check SKU
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
          successCount++;

        } catch (err) {
          await client.query("ROLLBACK");
          console.error("Row failed:", row.sku, err.message);
          errorCount++;
        } finally {
          client.release();
        }
      }

      res.json({
        message: "Import completed",
        total: results.length,
        success: successCount,
        failed: errorCount
      });
    });
});
app.post("/api/variants/:variantId/images", async (req, res) => {
  const { variantId } = req.params;
  const { image_name, display_order = 1 } = req.body;

  try {
    await pool.query(
      `INSERT INTO variant_images (variant_id, image_name, display_order)
         VALUES ($1, $2, $3)`,
      [variantId, image_name, display_order]
    );

    res.json({ message: "Image added successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add image" });
  }
});