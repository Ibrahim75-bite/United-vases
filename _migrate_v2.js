require("dotenv").config();
const pool = require("./db");

(async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Create inquiries table
        await client.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id BIGSERIAL PRIMARY KEY,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50),
        customer_company VARCHAR(255),
        message TEXT,
        items JSONB NOT NULL DEFAULT '[]',
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
        console.log("✅ inquiries table created");

        // 2. Add stock and price fields to product_variants (if they don't exist)
        const variantCols = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'product_variants'
    `);
        const existingCols = variantCols.rows.map(r => r.column_name);

        if (!existingCols.includes("price")) {
            await client.query(`
        ALTER TABLE product_variants
        ADD COLUMN price DECIMAL(10, 2) DEFAULT NULL
      `);
            console.log("✅ price column added to product_variants");
        } else {
            console.log("⏭️  price column already exists");
        }

        if (!existingCols.includes("stock_status")) {
            await client.query(`
        ALTER TABLE product_variants
        ADD COLUMN stock_status VARCHAR(20) NOT NULL DEFAULT 'in_stock'
      `);
            console.log("✅ stock_status column added to product_variants");
        } else {
            console.log("⏭️  stock_status column already exists");
        }

        if (!existingCols.includes("min_order_qty")) {
            await client.query(`
        ALTER TABLE product_variants
        ADD COLUMN min_order_qty INTEGER NOT NULL DEFAULT 1
      `);
            console.log("✅ min_order_qty column added to product_variants");
        } else {
            console.log("⏭️  min_order_qty column already exists");
        }

        // 3. Create index on inquiries status + date
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inquiries_status
      ON inquiries (status, created_at DESC)
    `);
        console.log("✅ inquiries index created");

        await client.query("COMMIT");
        console.log("\n✅ Migration completed successfully!");

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Migration failed:", err.message);
    } finally {
        client.release();
        await pool.end();
    }
})();
