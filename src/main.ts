import "dotenv/config";
import express from "express";
import cors from "cors";
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
import { errorHandler } from "./middleware/errorHandler";
import { globalLimiter } from "./middleware/rateLimiters";
import { clientDisconnect } from "./middleware/clientDisconnect";
import { internalRoutes } from './routes/internalRoutes';
import { debugRoutes } from "./routes/debugRoutes";
import { cdekRoutes } from './routes/cdekRoutes';
import { shipmentsRoutes } from './routes/shipmentsRoutes';

const app = express();
const uploadsDir = path.join(process.cwd(), "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}


app.set("trust proxy", 1);
app.disable("x-powered-by");

const allowedOrigins = [env.frontendUrl];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // server-to-server / curl / same-origin can have no Origin
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) return callback(null, true);

    return callback(new Error("CORS_NOT_ALLOWED"));
  },
  credentials: true,
};

// ✅ 1) CORS должен быть ПЕРВЫМ (до helmet и до limiter)
app.use(cors(corsOptions));
// ✅ 2) Явно отвечаем на preflight до любых ограничителей
app.options("*", cors(corsOptions));

// ✅ 3) Теперь можно security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// ✅ 4) Теперь можно rate-limit (а OPTIONS мы уже обработали выше)
// (и в rateLimiters всё равно добавь skip OPTIONS, это полезно)
app.use(globalLimiter);

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
  }
}));
app.use(cookieParser());

// ✅ uploads
app.use("/uploads", express.static(uploadsDir));

app.get("/health", (_req, res) => res.json({ status: "ok", build: "server-2026-02-04-1" }));

const mountRoutes = (prefix = '') => {
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

mountRoutes('/api');
// Legacy non-prefixed routes kept for backward compatibility.
mountRoutes();
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`API running on ${env.port}`);
});

// startShipmentsSyncJob();


process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
