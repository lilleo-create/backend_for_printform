"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const helmet_1 = __importDefault(require("helmet"));
const env_1 = require("./config/env");
const authRoutes_1 = require("./routes/authRoutes");
const productRoutes_1 = require("./routes/productRoutes");
const orderRoutes_1 = require("./routes/orderRoutes");
const customRequestRoutes_1 = require("./routes/customRequestRoutes");
const sellerRoutes_1 = require("./routes/sellerRoutes");
const filterRoutes_1 = require("./routes/filterRoutes");
const meRoutes_1 = require("./routes/meRoutes");
const adminRoutes_1 = require("./routes/adminRoutes");
const paymentRoutes_1 = require("./routes/paymentRoutes");
const returnRoutes_1 = require("./routes/returnRoutes");
const chatRoutes_1 = require("./routes/chatRoutes");
const adminChatRoutes_1 = require("./routes/adminChatRoutes");
const shopRoutes_1 = require("./routes/shopRoutes");
const favoritesRoutes_1 = require("./routes/favoritesRoutes");
const checkoutRoutes_1 = require("./routes/checkoutRoutes");
const internalRoutes_1 = require("./routes/internalRoutes");
const debugRoutes_1 = require("./routes/debugRoutes");
const cdekRoutes_1 = require("./routes/cdekRoutes");
const shipmentsRoutes_1 = require("./routes/shipmentsRoutes");
const errorHandler_1 = require("./middleware/errorHandler");
const rateLimiters_1 = require("./middleware/rateLimiters");
const app = (0, express_1.default)();
const uploadsDir = path_1.default.join(process.cwd(), "uploads");
if (!fs_1.default.existsSync(uploadsDir)) {
    fs_1.default.mkdirSync(uploadsDir, { recursive: true });
}
app.set("trust proxy", 1);
app.disable("x-powered-by");
const allowedOrigins = new Set([
    env_1.env.frontendUrl,
    "https://print-form.ru",
    "https://www.print-form.ru",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
].filter(Boolean));
/*
|--------------------------------------------------------------------------
| CORS HANDLER
|--------------------------------------------------------------------------
*/
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
/*
|--------------------------------------------------------------------------
| SECURITY
|--------------------------------------------------------------------------
*/
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
/*
|--------------------------------------------------------------------------
| LIMITERS
|--------------------------------------------------------------------------
*/
app.use(rateLimiters_1.globalLimiter);
/*
|--------------------------------------------------------------------------
| BODY
|--------------------------------------------------------------------------
*/
app.use(express_1.default.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
        req.rawBody =
            buffer.toString("utf8");
    },
}));
app.use(express_1.default.urlencoded({
    extended: true,
    limit: "1mb",
}));
app.use((0, cookie_parser_1.default)());
/*
|--------------------------------------------------------------------------
| STATIC
|--------------------------------------------------------------------------
*/
app.use("/uploads", express_1.default.static(uploadsDir));
/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        build: "server-2026-03-13",
    });
});
/*
|--------------------------------------------------------------------------
| ROUTES
|--------------------------------------------------------------------------
*/
const mountRoutes = (prefix = "") => {
    app.use(`${prefix}/auth`, authRoutes_1.authRoutes);
    app.use(`${prefix}/products`, productRoutes_1.productRoutes);
    app.use(`${prefix}/shops`, shopRoutes_1.shopRoutes);
    app.use(`${prefix}/orders`, orderRoutes_1.orderRoutes);
    app.use(`${prefix}/custom-requests`, customRequestRoutes_1.customRequestRoutes);
    app.use(`${prefix}/seller`, sellerRoutes_1.sellerRoutes);
    app.use(`${prefix}/filters`, filterRoutes_1.filterRoutes);
    app.use(`${prefix}/me`, meRoutes_1.meRoutes);
    app.use(`${prefix}/returns`, returnRoutes_1.returnRoutes);
    app.use(`${prefix}/chats`, chatRoutes_1.chatRoutes);
    app.use(`${prefix}/admin`, adminRoutes_1.adminRoutes);
    app.use(`${prefix}/admin/chats`, adminChatRoutes_1.adminChatRoutes);
    app.use(`${prefix}/payments`, paymentRoutes_1.paymentRoutes);
    app.use(`${prefix}/favorites`, favoritesRoutes_1.favoritesRoutes);
    app.use(`${prefix}/checkout`, checkoutRoutes_1.checkoutRoutes);
    app.use(`${prefix}/internal`, internalRoutes_1.internalRoutes);
    app.use(`${prefix}/cdek`, cdekRoutes_1.cdekRoutes);
    app.use(`${prefix}/shipments`, shipmentsRoutes_1.shipmentsRoutes);
    app.use(`${prefix}/debug`, debugRoutes_1.debugRoutes);
};
mountRoutes("/api");
/*
Legacy routes (старые без /api)
*/
mountRoutes();
/*
|--------------------------------------------------------------------------
| ERRORS
|--------------------------------------------------------------------------
*/
app.use(errorHandler_1.errorHandler);
/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/
const PORT = Number(process.env.PORT) || env_1.env.port || 4000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on ${PORT}`);
});
/*
|--------------------------------------------------------------------------
| GLOBAL ERRORS
|--------------------------------------------------------------------------
*/
process.on("unhandledRejection", (reason) => {
    console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});
