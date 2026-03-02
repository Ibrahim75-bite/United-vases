const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const multer = require("multer");

// =========================
// Directory Setup
// =========================
const UPLOADS_DIR = path.join(__dirname, "..", "uploads", "images");
const THUMBS_DIR = path.join(__dirname, "..", "uploads", "images", "thumbnails");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

// =========================
// Multer Configuration (image uploads)
// =========================
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, uniqueName);
    }
});

const imageFilter = (req, file, cb) => {
    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    if (ALLOWED_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type: ${file.mimetype}. Only JPEG, PNG, and WebP are allowed.`), false);
    }
};

const imageUpload = multer({
    storage: imageStorage,
    fileFilter: imageFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// =========================
// Multer Configuration (CSV uploads)
// =========================
const csvUpload = multer({
    dest: path.join(__dirname, "..", "uploads", "temp"),
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
// Helpers for building image URLs
// =========================
function buildImageUrl(imageName) {
    return `${process.env.BASE_URL}/images/${imageName}`;
}

function buildThumbnailUrl(imageName) {
    const thumbName = `thumb_${path.parse(imageName).name}.webp`;
    if (fs.existsSync(path.join(THUMBS_DIR, thumbName))) {
        return `${process.env.BASE_URL}/images/thumbnails/${thumbName}`;
    }
    return null;
}

module.exports = {
    UPLOADS_DIR,
    THUMBS_DIR,
    imageUpload,
    csvUpload,
    processImage,
    buildImageUrl,
    buildThumbnailUrl,
    multer // re-export for MulterError checks
};
