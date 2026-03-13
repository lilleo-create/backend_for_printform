import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import helmet from "helmet";
import { env } from "./config/env";

import { authRoutes } from "./routes/authRoutes";
import { productRoutes } from "./routes/productRoutes";
import { orderRoutes } from "./routes/orderRoutes";
import { customRequestRoutes } from "./routes/customRequestRoutes";
import { sellerRoutes } from "./routes/sellerRoutes";
import { filterRoutes } from "./routes/filterRoutes";
import { meRoutes } from "./routes/meRoutes";
import { adminRoutes } from "./routes/adminRoutes";
import { paymentRoutes } from "./routes/paymentRoutes";
import { returnRoutes } from "./routes/returnRoutes";
import { chatRoutes } from "./routes/chatRoutes";
import { adminChatRoutes } from "./routes/adminChatRoutes";
import { shopRoutes } from "./routes/shopRoutes";
import { favoritesRoutes } from "./routes/favoritesRoutes";
import { checkoutRoutes } from "./routes/checkoutRoutes";
import { internalRoutes } from "./routes/internalRoutes";
import { debugRoutes } from "./routes/debugRoutes";
import { cdekRoutes } from "./routes/cdekRoutes";
import { shipmentsRoutes } from "./routes/shipmentsRoutes";

import { errorHandler } from "./middleware/errorHandler";
import { globalLimiter } from "./middleware/rateLimiters";

const app = express();

const uploadsDir = path.join(process.cwd(), "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

const allowedOrigins = new Set(
  [
    env.frontendUrl,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].filter(Boolean)
);

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
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
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

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

/*
|--------------------------------------------------------------------------
| LIMITERS
|--------------------------------------------------------------------------
*/

app.use(globalLimiter);

/*
|--------------------------------------------------------------------------
| BODY
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: string }).rawBody =
        buffer.toString("utf8");
    },
  })
);

app.use(cookieParser());

/*
|--------------------------------------------------------------------------
| STATIC
|--------------------------------------------------------------------------
*/

app.use("/uploads", express.static(uploadsDir));

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
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/products`, productRoutes);
  app.use(`${prefix}/shops`, shopRoutes);
  app.use(`${prefix}/orders`, orderRoutes);
  app.use(`${prefix}/custom-requests`, customRequestRoutes);
  app.use(`${prefix}/seller`, sellerRoutes);
  app.use(`${prefix}/filters`, filterRoutes);
  app.use(`${prefix}/me`, meRoutes);
  app.use(`${prefix}/returns`, returnRoutes);
  app.use(`${prefix}/chats`, chatRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/admin/chats`, adminChatRoutes);
  app.use(`${prefix}/payments`, paymentRoutes);
  app.use(`${prefix}/favorites`, favoritesRoutes);
  app.use(`${prefix}/checkout`, checkoutRoutes);
  app.use(`${prefix}/internal`, internalRoutes);
  app.use(`${prefix}/cdek`, cdekRoutes);
  app.use(`${prefix}/shipments`, shipmentsRoutes);
  app.use(`${prefix}/debug`, debugRoutes);
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

app.use(errorHandler);

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

app.listen(env.port, () => {
  console.log(`API running on ${env.port}`);
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