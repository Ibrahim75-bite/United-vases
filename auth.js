const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        console.warn(`Unauthorized attempt: No token provided from IP ${req.ip}`); // Optional logging
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(" ")[1];

    if (!process.env.JWT_SECRET) {
        console.error("JWT_SECRET not set in environment");
        return res.status(500).json({ error: "Server configuration error" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // e.g., { id: adminId }
        next();
    } catch (err) {
        console.warn(`Invalid token attempt: ${err.message} from IP ${req.ip}`);
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(401).json({ error: "Invalid token" });
    }
};

module.exports = authMiddleware;