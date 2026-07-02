const express = require("express");
const http = require("http");
const cluster = require("cluster");
const os = require("os");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const { body, validationResult, query, param } = require("express-validator");
const xss = require("xss");
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");
require("dotenv").config();

const cache = require("./cache");

const db = require("./db");
const auth = require("./auth");
const {
  welcomeEmail,
  depositEmail,
  withdrawalEmail,
  orderEmail,
  passwordResetEmail,
} = require("./email-templates");

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const JWT_EXPIRY = process.env.JWT_EXPIRY || "7d";

db.initDb(process.env);
auth.initAuth({
  JWT_SECRET,
  JWT_EXPIRY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
});

(async () => {
  const connected = await db.testConnection();
  if (!connected) {
    console.warn(
      "Server will start, but database operations will fail until the connection is fixed.",
    );
  }
})();

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : false;
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

if (cache.isAvailable()) {
  const pubClient = cache.redis.duplicate();
  const subClient = cache.redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  console.log("[CLUSTER] Socket.IO Redis adapter enabled");
}

io.on("connection", (socket) => {
  const uid = socket.handshake.query.uid;
  if (uid) socket.join(uid);
  socket.on("join-room", (room) => socket.join(room));
});

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://accounts.google.com",
    "https://apis.google.com",
  ],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
    "https://paystack.com",
    "https://accounts.google.com",
  ],
  styleSrcElem: [
    "'self'",
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
    "https://paystack.com",
    "https://accounts.google.com",
  ],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: [
    "'self'",
    "data:",
    "https://*.googleusercontent.com",
    "https://www.gstatic.com",
  ],
  connectSrc: [
    "'self'",
    "https://www.gstatic.com",
    "https://accounts.google.com",
    "https://oauth2.googleapis.com",
    "https://api.paystack.co",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://js.paystack.co",
    "https://api.safaricom.co.ke",
    "https://sandbox.safaricom.co.ke",
  ],
  frameSrc: [
    "'self'",
    "https://accounts.google.com",
    "https://js.paystack.co",
    "https://paystack.com",
    "https://*.paystack.co",
    "https://*.paystack.com",
  ],
  formAction: ["'self'", "https://accounts.google.com"],
};

app.use(
  helmet({
    contentSecurityPolicy: { directives: CSP_DIRECTIVES },
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
  }),
);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(morgan("combined"));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  const start = Date.now();
  const logBody =
    req.body && typeof req.body === "object" ? { ...req.body } : req.body;
  if (logBody && logBody.idempotencyKey)
    logBody.idempotencyKey = logBody.idempotencyKey.slice(0, 8) + "...";
  const origJson = res.json.bind(res);
  res.json = function (body) {
    const ms = Date.now() - start;
    const logResBody = body && typeof body === "object" ? { ...body } : body;
    if (res.statusCode >= 400) {
      console.error(
        "[API ERROR] %s %s -> %d %s (%dms)",
        req.method,
        req.originalUrl,
        res.statusCode,
        JSON.stringify(logResBody),
        ms,
      );
      if (logBody && Object.keys(logBody).length)
        console.error("[API ERROR]   Request body:", JSON.stringify(logBody));
    } else {
      console.log(
        "[API] %s %s -> %d (%dms)",
        req.method,
        req.originalUrl,
        res.statusCode,
        ms,
      );
    }
    return origJson(body);
  };
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts, please try again later." },
});
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: "Too many webhook requests." },
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many OTP attempts, please try again later." },
});

const emailTransporter = (() => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log(
      "[EMAIL] SMTP configured: host=%s port=%s secure=%s user=%s",
      process.env.SMTP_HOST,
      process.env.SMTP_PORT || "587",
      process.env.SMTP_SECURE || "false",
      process.env.SMTP_USER,
    );
    transporter.verify((err) => {
      if (err) {
        console.error("[EMAIL] SMTP connection verify FAILED:", err.message);
      } else {
        console.log("[EMAIL] SMTP connection verified successfully");
      }
    });
    return transporter;
  }
  console.log(
    "[EMAIL] SMTP NOT configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to enable email",
  );
  return null;
})();

async function sendEmail(to, subject, html) {
  if (!emailTransporter) {
    console.log(
      "[EMAIL] Skipped (no SMTP configured) - would send to",
      to,
      "subject:",
      subject,
    );
    return;
  }
  await emailTransporter.sendMail({
    from:
      '"AgriConnect" <' +
      (process.env.SMTP_FROM || process.env.SMTP_USER) +
      ">",
    to,
    subject,
    html,
  });
  console.log("[EMAIL] Sent:", subject, "->", to);
}

// ---------------------------------------------------------------------------
// CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const WALLET_STATUS = Object.freeze({
  ACTIVE: "active",
  FROZEN: "frozen",
  SUSPENDED: "suspended",
});
const WALLET_TYPES = Object.freeze({
  ACTIVE: "active",
  ESCROW: "escrow",
  WITHDRAWABLE: "withdrawable",
});
const ORDER_STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  IN_ESCROW: "in_escrow",
  DISPATCHED: "dispatched",
  DELIVERED: "delivered",
  VERIFIED: "verified",
  COMPLETED: "completed",
  DISPUTED: "disputed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
});
const DISPUTE_STATUS = Object.freeze({
  OPEN: "open",
  UNDER_REVIEW: "under_review",
  RESOLVED: "resolved",
  DISMISSED: "dismissed",
});
const LEDGER_ENTRY_TYPE = Object.freeze({
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
  TRANSFER: "transfer",
  ESCROW_HOLD: "escrow_hold",
  ESCROW_RELEASE: "escrow_release",
  ESCROW_REFUND: "escrow_refund",
  FEE: "fee",
  FEE_REFUND: "fee_refund",
  RECONCILIATION_ADJ: "reconciliation_adjustment",
});

const DEPOSIT_FEE_RATE = parseFloat(process.env.DEPOSIT_FEE_RATE || "0.01");
const TRANSFER_FEE_RATE = parseFloat(process.env.TRANSFER_FEE_RATE || "0.01");
const ESCROW_TIMER_HOURS = parseInt(process.env.ESCROW_TIMER_HOURS || "72", 10);
const MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || "10");
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || "50");
const MIN_TRANSFER = parseFloat(process.env.MIN_TRANSFER || "1");

// ---------------------------------------------------------------------------
// TRANSACTION FEE TIERS
// ---------------------------------------------------------------------------

const TRANSACTION_FEES = require("./transaction-fee.json");

function getTransactionFee(amount) {
  const tiers = TRANSACTION_FEES.tiers;
  for (const t of tiers) {
    if (amount >= t.min && (t.max === null || amount <= t.max)) {
      return t.fee;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// M-PESA DARAJA CONFIG
// ---------------------------------------------------------------------------

const MPESA = {
  CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY || "",
  CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET || "",
  PASSKEY: process.env.MPESA_PASSKEY || "",
  BUSINESS_SHORTCODE: process.env.MPESA_BUSINESS_SHORTCODE || "174379",
  ENVIRONMENT: process.env.MPESA_ENV || "sandbox",
  CALLBACK_BASE:
    process.env.MPESA_CALLBACK_URL ||
    process.env.BASE_URL ||
    "https://your-domain.com",
  get BASE_URL() {
    return this.ENVIRONMENT === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";
  },
  get OAUTH_URL() {
    return this.BASE_URL + "/oauth/v1/generate?grant_type=client_credentials";
  },
  get STK_PUSH_URL() {
    return this.BASE_URL + "/mpesa/stkpush/v1/processrequest";
  },
  get STK_QUERY_URL() {
    return this.BASE_URL + "/mpesa/stkpushquery/v1/query";
  },
  get B2C_URL() {
    return this.BASE_URL + "/mpesa/b2c/v1/paymentrequest";
  },
  get REGISTER_C2B_URL() {
    return this.BASE_URL + "/mpesa/c2b/v1/registerurl";
  },
  get TRANSACTION_STATUS_URL() {
    return this.BASE_URL + "/mpesa/transactionstatus/v1/query";
  },
  get ACCOUNT_BALANCE_URL() {
    return this.BASE_URL + "/mpesa/accountbalance/v1/query";
  },
};

let mpesaAccessToken = null;
let mpesaTokenExpiry = 0;

async function getMpesaAccessToken(forceRefresh = false) {
  if (!forceRefresh && mpesaAccessToken && Date.now() < mpesaTokenExpiry)
    return mpesaAccessToken;
  if (!MPESA.CONSUMER_KEY || !MPESA.CONSUMER_SECRET) {
    throw new Error("M-Pesa consumer key or secret not configured in .env");
  }
  const authStr = Buffer.from(
    MPESA.CONSUMER_KEY + ":" + MPESA.CONSUMER_SECRET,
  ).toString("base64");
  try {
    const response = await axios.get(MPESA.OAUTH_URL, {
      headers: { Authorization: "Basic " + authStr },
      timeout: 10000,
    });
    if (!response.data || !response.data.access_token) {
      throw new Error(
        "OAuth response missing access_token: " + JSON.stringify(response.data),
      );
    }
    mpesaAccessToken = response.data.access_token;
    mpesaTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    console.log(
      "[MPESA] OAuth token obtained successfully, expires in",
      response.data.expires_in,
      "s",
    );
    return mpesaAccessToken;
  } catch (err) {
    console.error(
      "[MPESA] OAuth token fetch failed:",
      err.response?.data || err.message,
    );
    throw new Error(
      "Failed to get M-Pesa access token: " +
        (err.response?.data?.errorMessage || err.message),
    );
  }
}

function timestamp() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return "" + y + m + d + h + min + s;
}

function stkPassword() {
  return Buffer.from(
    MPESA.BUSINESS_SHORTCODE + MPESA.PASSKEY + timestamp(),
  ).toString("base64");
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateTxnId() {
  return (
    "AGR-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

// ---------------------------------------------------------------------------
// WALLET ID (8-digit unique)
// ---------------------------------------------------------------------------

async function generateWalletId(uid, displayName, email) {
  for (let attempts = 0; attempts < 20; attempts++) {
    const id = String(Math.floor(10000000 + Math.random() * 90000000));
    try {
      await db.query(
        "INSERT INTO wallet_ids (wallet_id, uid, display_name, email, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, uid, displayName || "", email || "", Date.now()],
      );
      return id;
    } catch (e) {
      if (e.code === "23505") continue;
      throw e;
    }
  }
  throw new Error("Failed to generate unique wallet ID after 20 attempts");
}

async function getOrCreateWalletId(uid, displayName, email) {
  const existing = await db.query(
    "SELECT wallet_id FROM wallet_ids WHERE uid = $1",
    [uid],
  );
  if (existing.rows.length > 0) return existing.rows[0].wallet_id;

  return await generateWalletId(uid, displayName, email);
}

async function lookupWalletId(walletId) {
  const result = await db.query(
    "SELECT w.wallet_id, w.uid, w.display_name, w.email, u.role FROM wallet_ids w LEFT JOIN users u ON w.uid = u.uid WHERE w.wallet_id = $1",
    [walletId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    uid: r.uid,
    walletId: r.wallet_id,
    displayName: r.display_name || "",
    email: r.email || "",
    role: r.role || "",
  };
}

// ---------------------------------------------------------------------------
// HELPER: SANITIZATION & VALIDATION
// ---------------------------------------------------------------------------

function sanitize(v) {
  if (typeof v === "string") return xss(v.trim());
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, sanitize(val)]),
    );
  return v;
}

function sanitizeInput(req, res, next) {
  if (req.body) req.body = sanitize(req.body);
  if (req.query) {
    Object.keys(req.query).forEach((k) => {
      if (typeof req.query[k] === "string")
        req.query[k] = xss(req.query[k].trim());
    });
  }
  next();
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors.array() });
  }
  next();
}

function parseAmount(val) {
  const n = parseFloat(val);
  if (isNaN(n) || n <= 0) return null;
  return parseFloat(n.toFixed(2));
}

// ---------------------------------------------------------------------------
// IDEMPOTENCY MIDDLEWARE
// ---------------------------------------------------------------------------

async function checkIdempotency(req, res, next) {
  const key = req.headers["idempotency-key"] || req.body.idempotencyKey;
  if (!key) return next();
  if (typeof key !== "string" || key.length < 8 || key.length > 128) {
    return res.status(400).json({ error: "Invalid idempotency key format" });
  }
  try {
    const result = await db.query(
      "SELECT result FROM idempotency WHERE key = $1",
      [key],
    );
    if (result.rows.length > 0) {
      return res.status(409).json({
        error: "Duplicate request",
        existingResult: result.rows[0].result,
      });
    }
    req.idempotencyKey = key;
    next();
  } catch (e) {
    console.error("Idempotency check error:", e);
    next();
  }
}

async function recordIdempotency(key, resultData) {
  if (!key) return;
  try {
    await db.query(
      "INSERT INTO idempotency (key, result, processed_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
      [key, JSON.stringify(resultData), Date.now()],
    );
  } catch (e) {
    console.error("Idempotency record error:", e);
  }
}

// ---------------------------------------------------------------------------
// DOUBLE-ENTRY LEDGER
// ---------------------------------------------------------------------------

async function createLedgerEntry({
  type,
  amount,
  fromWallet,
  toWallet,
  fromUid,
  toUid,
  reference,
  description,
  relatedId,
  metadata,
}) {
  if (!type || amount === undefined || amount === null)
    throw new Error("Ledger entry requires type and amount");
  const entryId = uuidv4();
  const entryAmt = parseFloat(amount.toFixed(2));
  const now = Date.now();
  await db.query(
    "INSERT INTO ledger (id, type, amount, from_wallet, to_wallet, from_uid, to_uid, reference, description, related_id, metadata, created_at) VALUES ($1, $2::ledger_entry_type, $3, $4::wallet_type, $5::wallet_type, $6, $7, $8, $9, $10, $11::jsonb, $12)",
    [
      entryId,
      type,
      entryAmt,
      fromWallet || null,
      toWallet || null,
      fromUid || null,
      toUid || null,
      reference || null,
      description || "",
      relatedId || null,
      metadata ? JSON.stringify(metadata) : null,
      now,
    ],
  );
  return {
    id: entryId,
    type,
    amount: entryAmt,
    fromWallet: fromWallet || null,
    toWallet: toWallet || null,
    fromUid: fromUid || null,
    toUid: toUid || null,
    reference: reference || null,
    description: description || "",
    relatedId: relatedId || null,
    metadata: metadata || null,
    createdAt: now,
  };
}

async function computeBalance(uid, walletType) {
  if (!walletType) walletType = WALLET_TYPES.ACTIVE;
  const result = await db.query(
    "SELECT COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = $2::wallet_type THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = $2::wallet_type THEN amount ELSE 0 END), 0) AS balance FROM ledger",
    [uid, walletType],
  );
  return parseFloat(parseFloat(result.rows[0].balance).toFixed(2));
}

// ---------------------------------------------------------------------------
// WALLET OPERATIONS
// ---------------------------------------------------------------------------

async function getWalletState(uid, walletType) {
  if (walletType === WALLET_TYPES.ESCROW) {
    return {
      uid,
      walletType,
      status: WALLET_STATUS.ACTIVE,
      balance: 0,
      frozenBalance: 0,
    };
  }
  const result = await db.query(
    "SELECT * FROM wallets WHERE uid = $1 AND wallet_type = $2::wallet_type",
    [uid, walletType],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  const storedBalance = parseFloat(r.balance || 0);
  const ledgerBalance = await computeBalance(uid, walletType);
  if (Math.abs(storedBalance - ledgerBalance) > 0.01) {
    if (storedBalance === 0 && ledgerBalance > 0) {
      console.log(
        "[WALLET] Auto-healing balance for " +
          uid +
          "/" +
          walletType +
          ": 0 → " +
          ledgerBalance,
      );
      await db.query(
        "UPDATE wallets SET balance = $1, status = $2, updated_at = $3 WHERE uid = $4 AND wallet_type = $5::wallet_type",
        [ledgerBalance, WALLET_STATUS.ACTIVE, Date.now(), uid, walletType],
      );
    } else if (Math.abs(storedBalance - ledgerBalance) > 1000) {
      console.error(
        "[WALLET] Large balance mismatch for " +
          uid +
          "/" +
          walletType +
          ": stored=" +
          storedBalance +
          " ledger=" +
          ledgerBalance +
          " — freezing",
      );
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
        [WALLET_STATUS.FROZEN, Date.now(), uid, walletType],
      );
    } else {
      console.log(
        "[WALLET] Correcting balance for " +
          uid +
          "/" +
          walletType +
          ": " +
          storedBalance +
          " → " +
          ledgerBalance,
      );
      await db.query(
        "UPDATE wallets SET balance = $1, status = $2, updated_at = $3 WHERE uid = $4 AND wallet_type = $5::wallet_type",
        [ledgerBalance, WALLET_STATUS.ACTIVE, Date.now(), uid, walletType],
      );
    }
    cache.invalidateWallet(uid); // fire-and-forget ok here — healing path only
    return {
      uid: r.uid,
      walletType: r.wallet_type,
      status: WALLET_STATUS.ACTIVE,
      balance: ledgerBalance,
      frozenBalance: parseFloat(r.frozen_balance || 0),
      createdAt: r.created_at,
      updatedAt: Date.now(),
    };
  }
  const state = {
    uid: r.uid,
    walletType: r.wallet_type,
    status: r.status,
    balance: ledgerBalance,
    frozenBalance: parseFloat(r.frozen_balance || 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return state;
}

async function ensureWallet(uid, walletType) {
  if (walletType === WALLET_TYPES.ESCROW) {
    return {
      uid,
      walletType,
      status: WALLET_STATUS.ACTIVE,
      balance: 0,
      frozenBalance: 0,
    };
  }
  const existing = await getWalletState(uid, walletType);
  if (existing) return existing;
  const now = Date.now();
  await db.query(
    "INSERT INTO wallets (uid, wallet_type, status, balance, frozen_balance, created_at, updated_at) VALUES ($1, $2::wallet_type, $3, 0, 0, $4, $5)",
    [uid, walletType, WALLET_STATUS.ACTIVE, now, now],
  );
  const ledgerBalance = await computeBalance(uid, walletType);
  if (ledgerBalance > 0) {
    await db.query(
      "UPDATE wallets SET balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
      [ledgerBalance, Date.now(), uid, walletType],
    );
  }
  if (walletType === WALLET_TYPES.ACTIVE) {
    const userResult = await db.query(
      "SELECT display_name, email FROM users WHERE uid = $1",
      [uid],
    );
    const user = userResult.rows[0] || {};
    await getOrCreateWalletId(uid, user.display_name || "", user.email || "");
  }
  return {
    uid,
    walletType,
    status: WALLET_STATUS.ACTIVE,
    balance: ledgerBalance,
    frozenBalance: 0,
  };
}

async function checkWalletNotRestricted(uid, walletType) {
  const wallet = await getWalletState(uid, walletType);
  if (!wallet) return true;
  if (
    wallet.status === WALLET_STATUS.FROZEN ||
    wallet.status === WALLET_STATUS.SUSPENDED
  ) {
    return false;
  }
  return true;
}

function walletRestrictionMiddleware(walletType) {
  return async (req, res, next) => {
    const uid = req.user.uid;
    const allowed = await checkWalletNotRestricted(uid, walletType);
    if (!allowed) {
      return res.status(403).json({
        error: "Your account is restricted. Outbound transactions are blocked.",
      });
    }
    next();
  };
}

async function creditWallet(
  uid,
  walletType,
  amount,
  reference,
  description,
  relatedId,
  metadata,
) {
  amount = parseFloat(amount.toFixed(2));
  await ensureWallet(uid, walletType);
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.DEPOSIT,
    amount,
    toWallet: walletType,
    toUid: uid,
    reference,
    description,
    relatedId,
    metadata,
  });
  if (walletType !== WALLET_TYPES.ESCROW) {
    const newBalance = await computeBalance(uid, walletType);
    await db.query(
      "UPDATE wallets SET balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
      [newBalance, Date.now(), uid, walletType],
    );
  }
  await cache.invalidateWallet(uid);
  return entry;
}

async function debitWallet(
  uid,
  walletType,
  amount,
  reference,
  description,
  relatedId,
  metadata,
) {
  amount = parseFloat(amount.toFixed(2));
  const balance = await computeBalance(uid, walletType);
  const walletInfo = await getWalletState(uid, walletType);
  const availableBalance = parseFloat(
    (balance - parseFloat(walletInfo?.frozenBalance || 0)).toFixed(2),
  );
  if (availableBalance < amount) {
    throw new Error(
      "Insufficient " +
        walletType +
        " wallet balance. Available: " +
        availableBalance +
        ", Required: " +
        amount,
    );
  }
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.WITHDRAWAL,
    amount,
    fromWallet: walletType,
    fromUid: uid,
    reference,
    description,
    relatedId,
    metadata,
  });
  if (walletType !== WALLET_TYPES.ESCROW) {
    const newBalance = await computeBalance(uid, walletType);
    await db.query(
      "UPDATE wallets SET balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
      [newBalance, Date.now(), uid, walletType],
    );
  }
  await cache.invalidateWallet(uid);
  return entry;
}

async function walletTransfer(
  fromUid,
  toUid,
  fromWalletType,
  toWalletType,
  amount,
  reference,
  description,
) {
  amount = parseFloat(amount.toFixed(2));
  const fromBalance = await computeBalance(fromUid, fromWalletType);
  const fromWalletInfo = await getWalletState(fromUid, fromWalletType);
  const fromAvailable = parseFloat(
    (fromBalance - parseFloat(fromWalletInfo?.frozenBalance || 0)).toFixed(2),
  );
  if (fromAvailable < amount) {
    throw new Error(
      "Insufficient " +
        fromWalletType +
        " wallet balance. Available: " +
        fromAvailable +
        ", Required: " +
        amount,
    );
  }
  await ensureWallet(toUid, toWalletType);
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.TRANSFER,
    amount,
    fromWallet: fromWalletType,
    toWallet: toWalletType,
    fromUid,
    toUid,
    reference,
    description,
  });
  const [newFromBalance, newToBalance] = await Promise.all([
    computeBalance(fromUid, fromWalletType),
    computeBalance(toUid, toWalletType),
  ]);
  if (fromWalletType !== WALLET_TYPES.ESCROW) {
    await db.query(
      "UPDATE wallets SET balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
      [newFromBalance, Date.now(), fromUid, fromWalletType],
    );
  }
  if (toWalletType !== WALLET_TYPES.ESCROW) {
    await db.query(
      "UPDATE wallets SET balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
      [newToBalance, Date.now(), toUid, toWalletType],
    );
  }
  await cache.invalidateWallet(fromUid);
  await cache.invalidateWallet(toUid);
  return entry;
}

// ---------------------------------------------------------------------------
// M-PESA STK PUSH (LIPA NA M-PESA ONLINE) - C2B Deposit
// ---------------------------------------------------------------------------

async function stkPush(
  phoneNumber,
  amount,
  accountReference,
  transactionDesc,
  idempotencyKey,
) {
  const normalizedPhone = phoneNumber
    .replace(/^0+/, "254")
    .replace(/^\+?254/, "254");
  if (normalizedPhone.length !== 12 || !normalizedPhone.startsWith("254")) {
    throw new Error(
      "Invalid phone number format. Must be a valid Safaricom number.",
    );
  }
  const payload = {
    BusinessShortCode: MPESA.BUSINESS_SHORTCODE,
    Password: stkPassword(),
    Timestamp: timestamp(),
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: normalizedPhone,
    PartyB: MPESA.BUSINESS_SHORTCODE,
    PhoneNumber: normalizedPhone,
    CallBackURL: MPESA.CALLBACK_BASE + "/api/mpesa/c2b/callback",
    AccountReference: accountReference || "AgriConnect Deposit",
    TransactionDesc: transactionDesc || "Wallet Deposit",
  };
  async function doPush(token) {
    return await axios.post(MPESA.STK_PUSH_URL, payload, {
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
  }
  let token = await getMpesaAccessToken();
  let response;
  try {
    response = await doPush(token);
  } catch (err) {
    const errBody = err.response?.data;
    const isAuthError =
      err.response?.status === 404 && errBody?.errorCode === "404.001.03";
    if (isAuthError) {
      console.log("[MPESA] Token rejected by STK Push, refreshing...");
      token = await getMpesaAccessToken(true);
      response = await doPush(token);
    } else {
      throw err;
    }
  }
  const data = response.data;
  if (data.ResponseCode !== "0") {
    throw new Error(
      "STK Push failed: " + (data.ResponseDescription || "Unknown error"),
    );
  }
  await db.query(
    "INSERT INTO mpesa_stk_requests (checkout_request_id, merchant_request_id, phone_number, amount, account_reference, idempotency_key, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      data.CheckoutRequestID,
      data.MerchantRequestID,
      normalizedPhone,
      Math.round(amount),
      accountReference,
      idempotencyKey || null,
      "pending",
      Date.now(),
    ],
  );
  return data;
}

async function stkQuery(checkoutRequestId) {
  const token = await getMpesaAccessToken();
  const payload = {
    BusinessShortCode: MPESA.BUSINESS_SHORTCODE,
    Password: stkPassword(),
    Timestamp: timestamp(),
    CheckoutRequestID: checkoutRequestId,
  };
  const response = await axios.post(MPESA.STK_QUERY_URL, payload, {
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// M-PESA B2C - Payout to Farmer
// ---------------------------------------------------------------------------

async function b2cPayment(phoneNumber, amount, remarks, occasion) {
  const token = await getMpesaAccessToken();
  const normalizedPhone = phoneNumber
    .replace(/^0+/, "254")
    .replace(/^\+?254/, "254");
  if (normalizedPhone.length !== 12 || !normalizedPhone.startsWith("254")) {
    throw new Error("Invalid phone number format.");
  }
  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME || "testapi",
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL || "",
    CommandID: "BusinessPayment",
    Amount: Math.round(amount),
    PartyA: MPESA.BUSINESS_SHORTCODE,
    PartyB: normalizedPhone,
    Remarks: remarks || "AgriConnect Payout",
    QueueTimeOutURL: MPESA.CALLBACK_BASE + "/api/mpesa/b2c/timeout",
    ResultURL: MPESA.CALLBACK_BASE + "/api/mpesa/b2c/result",
    Occasion: occasion || "Payout",
  };
  const response = await axios.post(MPESA.B2C_URL, payload, {
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// M-PESA C2B CALLBACK REGISTRATION
// ---------------------------------------------------------------------------

async function registerC2BUrls() {
  try {
    const token = await getMpesaAccessToken();
    const payload = {
      ShortCode: MPESA.BUSINESS_SHORTCODE,
      ResponseType: "Completed",
      ConfirmationURL: MPESA.CALLBACK_BASE + "/api/mpesa/c2b/confirmation",
      ValidationURL: MPESA.CALLBACK_BASE + "/api/mpesa/c2b/validation",
    };
    const response = await axios.post(MPESA.REGISTER_C2B_URL, payload, {
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    console.log("[MPESA] C2B URLs registered:", response.data);
    return response.data;
  } catch (e) {
    console.error("[MPESA] C2B URL registration failed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// ORDER-ESCROW LIFECYCLE
// ---------------------------------------------------------------------------

async function createEscrowOrder(
  buyerUid,
  sellerUid,
  amount,
  listingId,
  quantity,
  reference,
) {
  amount = parseFloat(amount.toFixed(2));
  const buyerActiveBalance = await computeBalance(
    buyerUid,
    WALLET_TYPES.ACTIVE,
  );
  const buyerWalletInfo = await getWalletState(buyerUid, WALLET_TYPES.ACTIVE);
  const buyerAvailable = parseFloat(
    (
      buyerActiveBalance - parseFloat(buyerWalletInfo?.frozenBalance || 0)
    ).toFixed(2),
  );
  if (buyerAvailable < amount) {
    throw new Error(
      "Insufficient active wallet balance. Available: " +
        buyerAvailable +
        ", Required: " +
        amount,
    );
  }
  const orderId = uuidv4();
  const otp = generateOTP();
  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
  const now = Date.now();
  const escrowExpiry = now + ESCROW_TIMER_HOURS * 60 * 60 * 1000;
  const order = {
    id: orderId,
    buyerUid,
    sellerUid,
    listingId: listingId || null,
    quantity: parseInt(quantity) || 1,
    amount,
    status: ORDER_STATUS.IN_ESCROW,
    otpHash,
    otpExpiresAt: escrowExpiry,
    escrowExpiresAt: escrowExpiry,
    reference: reference || generateTxnId(),
    disputeOpened: false,
    disputeResolved: false,
    createdAt: now,
    updatedAt: now,
  };
  await walletTransfer(
    buyerUid,
    orderId,
    WALLET_TYPES.ACTIVE,
    WALLET_TYPES.ESCROW,
    amount,
    reference,
    "Escrow hold for order " + orderId,
  );
  await db.query(
    "INSERT INTO escrow_orders (id, buyer_uid, seller_uid, listing_id, quantity, amount, status, otp_hash, otp_expires_at, escrow_expires_at, reference, dispute_opened, dispute_resolved, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::order_status, $8, $9, $10, $11, $12, $13, $14, $15)",
    [
      orderId,
      buyerUid,
      sellerUid,
      listingId || null,
      parseInt(quantity) || 1,
      amount,
      ORDER_STATUS.IN_ESCROW,
      otpHash,
      escrowExpiry,
      escrowExpiry,
      order.reference,
      false,
      false,
      now,
      now,
    ],
  );
  await db.query(
    "INSERT INTO orders (id, listing_id, farmer_uid, org_uid, quantity, total_price, status, escrow_order_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::order_status, $8, $9)",
    [
      orderId,
      listingId || null,
      sellerUid,
      buyerUid,
      parseInt(quantity) || 1,
      amount,
      ORDER_STATUS.IN_ESCROW,
      orderId,
      now,
    ],
  );
  const buyerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [buyerUid],
  );
  const buyerData = buyerResult.rows[0] || {};
  const sellerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [sellerUid],
  );
  const sellerData = sellerResult.rows[0] || {};
  if (buyerData.email) {
    sendEmail(
      buyerData.email,
      "Order Confirmed - Funds in Escrow",
      orderEmail(
        buyerData.display_name || "Buyer",
        orderId,
        ORDER_STATUS.IN_ESCROW,
        listingId,
        amount,
        "buyer",
      ),
    );
  }
  if (sellerData.email) {
    sendEmail(
      sellerData.email,
      "New Order - Funds in Escrow",
      orderEmail(
        sellerData.display_name || "Seller",
        orderId,
        ORDER_STATUS.IN_ESCROW,
        listingId,
        amount,
        "seller",
      ),
    );
  }
  sendNotification(
    sellerUid,
    "New Order",
    "A buyer has placed an order for KES " +
      amount.toFixed(2) +
      ". Funds are held in escrow.",
    "success",
  );
  return { order, otp, otpHash };
}

async function verifyEscrowDelivery(orderId, otp) {
  const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    orderId,
  ]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  
  // Only allow verification of dispatched orders
  if (order.status !== ORDER_STATUS.DISPATCHED) {
    throw new Error(
      "Order must be dispatched before verification. Current status: " + order.status,
    );
  }
  
  if (Date.now() > order.otp_expires_at) {
    throw new Error("OTP has expired. Please contact support or raise a dispute.");
  }
  const hash = crypto.createHash("sha256").update(String(otp)).digest("hex");
  if (hash !== order.otp_hash) {
    throw new Error("Invalid OTP. Please try again.");
  }
  const now = Date.now();
  await db.query(
    "UPDATE escrow_orders SET status = $1, verified_at = $2, updated_at = $2 WHERE id = $3",
    ["verified", now, orderId],
  );
  await db.query(
    "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
    ["verified", now, orderId],
  );
  return order;
}

async function releaseEscrowToSeller(orderId) {
  const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    orderId,
  ]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  if (order.status !== "verified") {
    throw new Error("Order must be verified before releasing funds");
  }
  const amt = parseFloat(order.amount);
  const fee = getTransactionFee(amt);
  const netAmount = parseFloat((amt - fee).toFixed(2));
  await walletTransfer(
    orderId,
    order.seller_uid,
    WALLET_TYPES.ESCROW,
    WALLET_TYPES.WITHDRAWABLE,
    netAmount,
    order.reference,
    "Escrow release for order " + orderId + " to seller",
  );
  if (fee > 0) {
    await createLedgerEntry({
      type: LEDGER_ENTRY_TYPE.FEE,
      amount: fee,
      fromWallet: WALLET_TYPES.ESCROW,
      toWallet: WALLET_TYPES.ACTIVE,
      fromUid: order.seller_uid,
      toUid: "platform",
      reference: order.reference,
      description: "Platform fee on order " + orderId,
    });
  }
  const now = Date.now();
  await db.query(
    "UPDATE escrow_orders SET status = $1, completed_at = $2, updated_at = $2 WHERE id = $3",
    ["completed", now, orderId],
  );
  await db.query(
    "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
    ["completed", now, orderId],
  );
  const sellerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [order.seller_uid],
  );
  const sellerData = sellerResult.rows[0] || {};
  if (sellerData.email) {
    sendEmail(
      sellerData.email,
      "Payment Released - AgriConnect",
      withdrawalEmail(
        sellerData.display_name || "Seller",
        netAmount,
        "Order " + orderId + " completed",
      ),
    );
  }
  sendNotification(
    order.seller_uid,
    "Payment Released",
    "KES " +
      netAmount.toFixed(2) +
      " has been released to your withdrawable wallet for order " +
      orderId +
      ".",
    "success",
  );
  return netAmount;
}

async function cancelEscrow(orderId) {
  const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    orderId,
  ]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  if (order.status === "completed" || order.status === "refunded") {
    throw new Error("Order already completed or refunded");
  }
  if (order.dispute_opened && !order.dispute_resolved) {
    throw new Error(
      "Cannot cancel an active disputed order. Resolve dispute first.",
    );
  }
  const amt = parseFloat(order.amount);
  await walletTransfer(
    orderId,
    order.buyer_uid,
    WALLET_TYPES.ESCROW,
    WALLET_TYPES.ACTIVE,
    amt,
    order.reference,
    "Escrow refund for cancelled order " + orderId,
  );
  const now = Date.now();
  await db.query(
    "UPDATE escrow_orders SET status = $1, cancelled_at = $2, updated_at = $2 WHERE id = $3",
    ["cancelled", now, orderId],
  );
  await db.query(
    "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
    ["cancelled", now, orderId],
  );
  sendNotification(
    order.buyer_uid,
    "Order Cancelled",
    "KES " +
      amt.toFixed(2) +
      " has been returned to your active wallet for order " +
      orderId +
      ".",
    "info",
  );
  return amt;
}

async function refundEscrowToBuyer(orderId) {
  const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    orderId,
  ]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  const amt = parseFloat(order.amount);
  await walletTransfer(
    orderId,
    order.buyer_uid,
    WALLET_TYPES.ESCROW,
    WALLET_TYPES.ACTIVE,
    amt,
    order.reference,
    "Escrow refund for order " + orderId + " to buyer",
  );
  const now = Date.now();
  await db.query(
    "UPDATE escrow_orders SET status = $1, refunded_at = $2, updated_at = $2 WHERE id = $3",
    ["refunded", now, orderId],
  );
  await db.query(
    "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
    ["refunded", now, orderId],
  );
  const buyerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [order.buyer_uid],
  );
  const buyerData = buyerResult.rows[0] || {};
  if (buyerData.email) {
    sendEmail(
      buyerData.email,
      "Refund Processed - AgriConnect",
      depositEmail(
        buyerData.display_name || "Buyer",
        amt,
        "Order " + orderId + " refunded",
      ),
    );
  }
  return amt;
}

// ---------------------------------------------------------------------------
// DISPUTE RESOLUTION
// ---------------------------------------------------------------------------

async function raiseDispute(orderId, raisedByUid, reason, evidenceUrls) {
  const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    orderId,
  ]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  if (order.dispute_opened)
    throw new Error("A dispute is already open for this order");
  if (order.status === "completed" || order.status === "refunded") {
    throw new Error("Cannot dispute a completed or refunded order");
  }
  if (raisedByUid !== order.buyer_uid && raisedByUid !== order.seller_uid) {
    throw new Error("Only the buyer or seller can raise a dispute");
  }
  const disputeId = uuidv4();
  const now = Date.now();
  const dispute = {
    id: disputeId,
    orderId,
    raisedByUid,
    reason: reason || "No reason provided",
    evidenceUrls: evidenceUrls || [],
    status: DISPUTE_STATUS.OPEN,
    resolution: null,
    resolvedByUid: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const amt = parseFloat(order.amount);
  const buyerWallet = await getWalletState(
    order.buyer_uid,
    WALLET_TYPES.ACTIVE,
  );
  const currentFrozen = parseFloat(buyerWallet?.frozenBalance || 0);
  await db.query(
    "UPDATE wallets SET frozen_balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
    [
      parseFloat((currentFrozen + amt).toFixed(2)),
      now,
      order.buyer_uid,
      WALLET_TYPES.ACTIVE,
    ],
  );
  await db.query(
    "UPDATE escrow_orders SET dispute_opened = true, status = $1, dispute_id = $2, updated_at = $3 WHERE id = $4",
    ["disputed", disputeId, now, orderId],
  );
  await db.query(
    "INSERT INTO disputes (id, order_id, raised_by_uid, reason, evidence_urls, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
    [
      disputeId,
      orderId,
      raisedByUid,
      reason || "No reason provided",
      JSON.stringify(evidenceUrls || []),
      "open",
      now,
      now,
    ],
  );
  const adminResult = await db.query(
    "SELECT uid FROM users WHERE role = 'admin'",
  );
  for (const row of adminResult.rows) {
    sendNotification(
      row.uid,
      "New Dispute",
      "Dispute #" +
        disputeId +
        " raised on order " +
        orderId +
        " by " +
        raisedByUid +
        ". Reason: " +
        reason,
      "warning",
    );
  }
  sendNotification(
    order.buyer_uid,
    "Dispute Raised",
    "Your dispute on order " +
      orderId +
      " has been opened. An admin will review it shortly.",
    "info",
  );
  sendNotification(
    order.seller_uid,
    "Dispute Raised",
    "A dispute has been raised on order " +
      orderId +
      ". The funds are frozen pending review.",
    "warning",
  );
  return dispute;
}

async function resolveDispute(disputeId, adminUid, resolution, resolutionType) {
  const dResult = await db.query("SELECT * FROM disputes WHERE id = $1", [
    disputeId,
  ]);
  const dispute = dResult.rows[0];
  if (!dispute) throw new Error("Dispute not found");
  if (
    dispute.status !== DISPUTE_STATUS.OPEN &&
    dispute.status !== DISPUTE_STATUS.UNDER_REVIEW
  ) {
    throw new Error("Dispute is already resolved or dismissed");
  }
  const oResult = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
    dispute.order_id,
  ]);
  const order = oResult.rows[0];
  if (!order) throw new Error("Associated order not found");
  const amt = parseFloat(order.amount);
  const buyerWallet = await getWalletState(
    order.buyer_uid,
    WALLET_TYPES.ACTIVE,
  );
  const currentFrozen = parseFloat(buyerWallet?.frozenBalance || 0);
  const newFrozen = parseFloat(Math.max(0, currentFrozen - amt).toFixed(2));
  await db.query(
    "UPDATE wallets SET frozen_balance = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
    [newFrozen, Date.now(), order.buyer_uid, WALLET_TYPES.ACTIVE],
  );
  let releasedAmount = 0;
  const now = Date.now();
  if (resolutionType === "release_to_seller") {
    const fee = getTransactionFee(amt);
    const netAmount = parseFloat((amt - fee).toFixed(2));
    await walletTransfer(
      order.id,
      order.seller_uid,
      WALLET_TYPES.ESCROW,
      WALLET_TYPES.WITHDRAWABLE,
      netAmount,
      order.reference,
      "Dispute resolution: release to seller for order " + dispute.order_id,
    );
    releasedAmount = netAmount;
    await db.query(
      "UPDATE escrow_orders SET status = 'completed', completed_at = $1 WHERE id = $2",
      [now, dispute.order_id],
    );
    await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [
      dispute.order_id,
    ]);
  } else if (resolutionType === "refund_buyer") {
    await walletTransfer(
      order.id,
      order.buyer_uid,
      WALLET_TYPES.ESCROW,
      WALLET_TYPES.ACTIVE,
      amt,
      order.reference,
      "Dispute resolution: refund buyer for order " + dispute.order_id,
    );
    releasedAmount = amt;
    await db.query(
      "UPDATE escrow_orders SET status = 'refunded', refunded_at = $1 WHERE id = $2",
      [now, dispute.order_id],
    );
    await db.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [
      dispute.order_id,
    ]);
  } else {
    throw new Error(
      "Invalid resolution type. Must be release_to_seller or refund_buyer",
    );
  }
  await db.query(
    "UPDATE disputes SET status = 'resolved', resolution = $1, resolution_type = $2, resolved_by_uid = $3, resolved_at = $4, updated_at = $4 WHERE id = $5",
    [
      resolution || "Resolved by admin",
      resolutionType,
      adminUid,
      now,
      disputeId,
    ],
  );
  await db.query(
    "UPDATE escrow_orders SET dispute_resolved = true, updated_at = $1 WHERE id = $2",
    [now, dispute.order_id],
  );
  sendNotification(
    order.buyer_uid,
    "Dispute Resolved",
    "The dispute on order " + dispute.order_id + " has been resolved.",
    "info",
  );
  sendNotification(
    order.seller_uid,
    "Dispute Resolved",
    "The dispute on order " + dispute.order_id + " has been resolved.",
    "info",
  );
  return { releasedAmount, resolutionType };
}

// ---------------------------------------------------------------------------
// RECONCILIATION ENGINE
// ---------------------------------------------------------------------------

async function runReconciliation() {
  console.log("[RECONCILIATION] Starting daily reconciliation...");
  try {
    const ledgerResult = await db.query("SELECT amount FROM ledger");
    let ledgerTotal = 0;
    ledgerResult.rows.forEach((e) => {
      ledgerTotal += parseFloat(e.amount || 0);
    });
    ledgerTotal = parseFloat(ledgerTotal.toFixed(2));
    const usersResult = await db.query("SELECT uid FROM users");
    const allLedger = (await db.query("SELECT * FROM ledger")).rows;
    function computeBalanceFromLedger(uid, walletType) {
      let b = 0;
      allLedger.forEach((e) => {
        if (e.to_uid === uid && e.to_wallet === walletType)
          b += parseFloat(e.amount || 0);
        if (e.from_uid === uid && e.from_wallet === walletType)
          b -= parseFloat(e.amount || 0);
      });
      return parseFloat(b.toFixed(2));
    }
    let sumActiveWallets = 0,
      sumEscrowWallets = 0,
      sumWithdrawableWallets = 0,
      sumFrozenBalances = 0;
    for (const row of usersResult.rows) {
      const uid = row.uid;
      sumActiveWallets += computeBalanceFromLedger(uid, WALLET_TYPES.ACTIVE);
      sumEscrowWallets += computeBalanceFromLedger(uid, WALLET_TYPES.ESCROW);
      sumWithdrawableWallets += computeBalanceFromLedger(
        uid,
        WALLET_TYPES.WITHDRAWABLE,
      );
      const wResult = await db.query(
        "SELECT frozen_balance FROM wallets WHERE uid = $1 AND wallet_type = $2::wallet_type",
        [uid, WALLET_TYPES.ACTIVE],
      );
      if (wResult.rows[0]?.frozen_balance)
        sumFrozenBalances += parseFloat(wResult.rows[0].frozen_balance);
    }
    const totalInSystem = parseFloat(
      (sumActiveWallets + sumEscrowWallets + sumWithdrawableWallets).toFixed(2),
    );
    const availableMpesaBalance = parseFloat(
      process.env.MPESA_EXPECTED_BALANCE || "0",
    );
    const discrepancy = parseFloat(
      (totalInSystem - availableMpesaBalance).toFixed(2),
    );
    const absDiscrepancy = Math.abs(discrepancy);
    const result = {
      timestamp: Date.now(),
      ledgerTotal,
      totalInSystem,
      sumActiveWallets,
      sumEscrowWallets,
      sumWithdrawableWallets,
      sumFrozenBalances,
      availableMpesaBalance,
      discrepancy,
      anomaly: absDiscrepancy > 1.0,
    };
    await db.query(
      "INSERT INTO reconciliation_log (timestamp, ledger_total, total_in_system, sum_active_wallets, sum_escrow_wallets, sum_withdrawable_wallets, sum_frozen_balances, available_mpesa_balance, discrepancy, anomaly) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        result.timestamp,
        result.ledgerTotal,
        result.totalInSystem,
        result.sumActiveWallets,
        result.sumEscrowWallets,
        result.sumWithdrawableWallets,
        result.sumFrozenBalances,
        result.availableMpesaBalance,
        result.discrepancy,
        result.anomaly,
      ],
    );
    if (result.anomaly) {
      console.error(
        "[RECONCILIATION] ANOMALY DETECTED! Discrepancy: KES " +
          discrepancy.toFixed(2),
      );
      const adminResult = await db.query(
        "SELECT uid FROM users WHERE role = 'admin'",
      );
      for (const row of adminResult.rows) {
        sendNotification(
          row.uid,
          "Reconciliation Anomaly",
          "Discrepancy of KES " +
            discrepancy.toFixed(2) +
            " detected between system balances and M-Pesa balance. Immediate attention required.",
          "error",
        );
      }
    } else {
      console.log(
        "[RECONCILIATION] OK. System: " +
          totalInSystem +
          ", M-Pesa: " +
          availableMpesaBalance +
          ", Diff: " +
          discrepancy.toFixed(2),
      );
    }
    return result;
  } catch (e) {
    console.error("[RECONCILIATION] Error:", e);
  }
}

// ---------------------------------------------------------------------------
// NOTIFICATION HELPER
// ---------------------------------------------------------------------------

async function sendNotification(uid, title, body, type) {
  try {
    await db.query(
      "INSERT INTO notifications (uid, title, body, type, read, created_at) VALUES ($1, $2, $3, $4, false, $5)",
      [uid, title, body, type || "info", Date.now()],
    );
    io.to(uid).emit("notification", { title, body, type: type || "info" });
  } catch (e) {
    console.error("Notification error:", e);
  }
}

// ---------------------------------------------------------------------------
// JWT AUTHENTICATION
// ---------------------------------------------------------------------------

async function authenticateJWT(req, res, next) {
  let token = req.cookies && req.cookies.authToken;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
  }
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = auth.verifyJWT(token);
    const result = await db.query("SELECT * FROM users WHERE uid = $1", [
      decoded.uid,
    ]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "User not found" });
    }
    const user = result.rows[0];
    
    // SECURITY FIX: Always use the current role from database, not from JWT token
    // This prevents role confusion when tokens are reused after role changes
    req.user = {
      uid: user.uid,
      role: user.role, // Always use database role, never JWT role
      email: user.email,
      displayName: user.display_name,
    };
    req.userRole = req.user.role;
    next();
  } catch (e) {
    if (e.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      console.log(`[SECURITY] Role access denied: User ${req.user?.uid} with role '${req.user?.role}' tried to access endpoint requiring roles: ${roles.join(', ')}`);
      return res
        .status(403)
        .json({ error: "Access denied. Required role: " + roles.join(" or ") });
    }
    next();
  };
}

// Enhanced role middleware with database validation
function requireStrictRole(requiredRole) {
  return async (req, res, next) => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      // Always check current role from database for security
      const result = await db.query("SELECT role FROM users WHERE uid = $1", [uid]);
      const currentRole = result.rows[0]?.role;
      
      if (!currentRole) {
        console.log(`[SECURITY] User not found in database: ${uid}`);
        return res.status(401).json({ error: "User not found" });
      }
      
      if (currentRole !== requiredRole) {
        console.log(`[SECURITY] Role mismatch: User ${uid} has role '${currentRole}' but endpoint requires '${requiredRole}'`);
        return res.status(403).json({ 
          error: "Access denied. Insufficient role privileges.",
          required: requiredRole,
          current: currentRole
        });
      }
      
      // Update req.user with current role
      req.user.role = currentRole;
      next();
    } catch (e) {
      console.error("[SECURITY] Role check error:", e);
      res.status(500).json({ error: "Role validation failed" });
    }
  };
}

async function requireAdmin(req, res, next) {
  const uid = req.user.uid;
  const result = await db.query("SELECT role FROM users WHERE uid = $1", [uid]);
  if (result.rows[0]?.role === "admin") return next();
  console.log(`[SECURITY] Non-admin user ${uid} tried to access admin endpoint`);
  res.status(403).json({ error: "Admin access required" });
}

// ---------------------------------------------------------------------------
// ROLE PAGE GUARD (for .html routing)
// ---------------------------------------------------------------------------

const rolePages = {
  "/farmer": "farmer",
  "/farmer.html": "farmer", 
  "/organisation": "organization",
  "/organisation.html": "organization",
  "/consumer": "consumer", 
  "/consumer.html": "consumer",
  "/admin": "admin",
  "/admin.html": "admin",
};

app.use(async (req, res, next) => {
  const path = req.path;
  const requiredRole = rolePages[path];
  if (!requiredRole) return next();
  let token = req.cookies && (req.cookies.authToken || req.cookies.idToken);
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
  }
  if (!token) return res.redirect("/login");
  try {
    const decoded = auth.verifyJWT(token);
    const result = await db.query("SELECT role FROM users WHERE uid = $1", [
      decoded.uid,
    ]);
    const userRole = result.rows[0]?.role || "consumer";
    if (userRole !== requiredRole) return res.redirect("/login");
    req.user = decoded;
    req.userRole = userRole;
    next();
  } catch (err) {
    console.error("Role guard error:", err.message);
    return res.redirect("/login");
  }
});

app.use((req, res, next) => {
  if (req.path.indexOf(".") === -1 && req.path !== "/") {
    const fs = require("fs");
    const pathModule = require("path");
    const sanitizedPath = req.path.replace(/\.\./g, "").replace(/^\//, "");
    const testPath = pathModule.resolve(__dirname, sanitizedPath + ".html");
    if (!testPath.startsWith(pathModule.resolve(__dirname))) return next();
    try {
      if (fs.existsSync(testPath)) return res.sendFile(testPath);
    } catch (_) {}
  }
  next();
});

// Force fresh HTML and API responses on every request — no caching
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});
app.use(
  express.static(__dirname, { maxAge: 0, etag: false, lastModified: false }),
);

app.get("/", (req, res) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.sendFile(__dirname + "/landing-page.html");
});

// ---------------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------------

// ---- AUTH ----

app.post(
  "/api/auth/signup",
  authLimiter,
  sanitizeInput,
  [
    body("email").isEmail(),
    body("password")
      .isString()
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("displayName").optional().isString(),
    body("role").isIn(["farmer", "organization", "consumer"]),
  ],
  validate,
  async (req, res) => {
    const { email, password, displayName, role } = req.body;
    try {
      const existing = await db.query(
        "SELECT uid FROM users WHERE email = $1",
        [email],
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "Email already registered" });
      }
      const uid = uuidv4();
      const passwordHash = await auth.hashPassword(password);
      const now = Date.now();
      await db.query(
        "INSERT INTO users (uid, email, display_name, password_hash, role, provider, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [uid, email, displayName || "", passwordHash, role, "email", now, now],
      );
      await ensureWallet(uid, WALLET_TYPES.ACTIVE);
      await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);
      const jwtToken = auth.generateJWT(uid, email);
      res.cookie("authToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.cookie("idToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.status(201).json({
        uid,
        email,
        displayName: displayName || "",
        role,
        token: jwtToken,
        message: "User created successfully",
      });
      if (email) {
        sendEmail(
          email,
          "Welcome to AgriConnect!",
          welcomeEmail(displayName || email.split("@")[0]),
        );
      }
    } catch (error) {
      console.error("Signup error:", error);
      res.status(500).json({ error: "Failed to create user profile" });
    }
  },
);

app.post(
  "/api/auth/login",
  authLimiter,
  sanitizeInput,
  [body("email").isEmail(), body("password").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await db.query("SELECT * FROM users WHERE email = $1", [
        email,
      ]);
      const user = result.rows[0];
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      const valid = await auth.verifyPassword(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      await db.query("UPDATE users SET last_login_at = $1 WHERE uid = $2", [
        Date.now(),
        user.uid,
      ]);
      const jwtToken = auth.generateJWT(user.uid, user.email);
      res.cookie("authToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.cookie("idToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({
        uid: user.uid,
        email: user.email,
        displayName: user.display_name || "",
        phoneNumber: user.phone_number || "",
        role: user.role || "user",
        token: jwtToken,
        profileComplete: !!(
          user.display_name &&
          user.display_name.trim() &&
          user.phone_number &&
          user.phone_number.trim()
        ),
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(401).json({ error: "Invalid email or password" });
    }
  },
);

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("authToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.clearCookie("idToken", {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
  res.json({ message: "Logged out successfully" });
});

app.post(
  "/api/auth/google",
  authLimiter,
  sanitizeInput,
  [body("idToken").isString().notEmpty(), body("role").optional().isString()],
  validate,
  async (req, res) => {
    let { idToken, role } = req.body;
    // Treat 'user' or other invalid signup roles as login (no role)
    if (role && !["farmer", "organization", "consumer"].includes(role)) {
      role = undefined;
    }
    try {
      const googleUser = await auth.verifyGoogleToken(idToken);
      const uid = googleUser.uid;
      const email = googleUser.email;

      // Look up by email — works for both email/password and Google accounts
      const result = await db.query("SELECT * FROM users WHERE email = $1", [
        email,
      ]);
      const existingUser = result.rows[0];

      // LOGIN flow — no role provided
      if (!role) {
        if (!existingUser) {
          return res
            .status(404)
            .json({ error: "User not found. Please sign up first." });
        }
        await db.query(
          "UPDATE users SET last_login_at = $1, display_name = COALESCE(NULLIF($2, ''), display_name), photo_url = COALESCE(NULLIF($3, ''), photo_url) WHERE uid = $4",
          [
            Date.now(),
            googleUser.name || "",
            googleUser.picture || "",
            existingUser.uid,
          ],
        );
        const jwtToken = auth.generateJWT(
          existingUser.uid,
          existingUser.email,
        );
        res.cookie("authToken", jwtToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.cookie("idToken", jwtToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        return res.json({
          uid: existingUser.uid,
          email: existingUser.email,
          displayName: existingUser.display_name || googleUser.name || "",
          phoneNumber: existingUser.phone_number || "",
          photoURL: existingUser.photo_url || googleUser.picture || "",
          role: existingUser.role,
          token: jwtToken,
          profileComplete: !!(
            existingUser.display_name &&
            existingUser.display_name.trim() &&
            existingUser.phone_number &&
            existingUser.phone_number.trim()
          ),
        });
      }

      // SIGNUP flow — role is required
      if (!["farmer", "organization", "consumer"].includes(role)) {
        return res.status(400).json({
          error: "Invalid role. Choose farmer, organisation, or consumer.",
        });
      }
      if (existingUser) {
        return res.status(409).json({
          error: "An account with this email already exists. Please log in.",
        });
      }
      const now = Date.now();
      await db.query(
        "INSERT INTO users (uid, email, display_name, photo_url, role, provider, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          uid,
          email,
          googleUser.name || "",
          googleUser.picture || "",
          role,
          "google",
          now,
          now,
        ],
      );
      await ensureWallet(uid, WALLET_TYPES.ACTIVE);
      await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);
      const jwtToken = auth.generateJWT(uid, email);
      res.cookie("authToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.cookie("idToken", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.status(201).json({
        uid,
        email,
        displayName: googleUser.name || "",
        phoneNumber: "",
        photoURL: googleUser.picture || "",
        role,
        token: jwtToken,
        profileComplete: false,
      });
    } catch (error) {
      console.error("Google auth error:", error);
      const message =
        error.message && error.message.includes("Google Auth not configured")
          ? "Google sign-in is not configured on the server."
          : error.message &&
              (error.message.includes("Invalid token") ||
                error.message.includes("Token used too late"))
            ? "Invalid or expired Google token"
            : "Google authentication failed. Please try again later.";
      res.status(401).json({ error: message });
    }
  },
);

app.post(
  "/api/auth/forgot-password",
  authLimiter,
  sanitizeInput,
  [body("email").isEmail()],
  validate,
  async (req, res) => {
    const { email } = req.body;
    try {
      const result = await db.query("SELECT uid FROM users WHERE email = $1", [
        email,
      ]);
      if (result.rows.length === 0) {
        return res.json({
          message: "If the email exists, a password reset link has been sent.",
        });
      }
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + 3600000;
      await db.query(
        "INSERT INTO password_reset_tokens (email, token, expires_at) VALUES ($1, $2, $3)",
        [email, token, expiresAt],
      );
      const resetLink =
        (process.env.BASE_URL || "http://localhost:3000") +
        "/reset-password?token=" +
        token;
      await sendEmail(
        email,
        "Password Reset - AgriConnect",
        passwordResetEmail(email, resetLink),
      );
      res.json({
        message: "If the email exists, a password reset link has been sent.",
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ error: "Failed to process request" });
    }
  },
);

app.post(
  "/api/auth/reset-password",
  authLimiter,
  sanitizeInput,
  [
    body("token").isString().notEmpty(),
    body("password").isString().isLength({ min: 6 }),
  ],
  validate,
  async (req, res) => {
    const { token, password } = req.body;
    try {
      const result = await db.query(
        "SELECT * FROM password_reset_tokens WHERE token = $1 AND used = false AND expires_at > $2",
        [token, Date.now()],
      );
      if (result.rows.length === 0) {
        return res
          .status(400)
          .json({ error: "Invalid or expired reset token" });
      }
      const resetRecord = result.rows[0];
      const passwordHash = await auth.hashPassword(password);
      await db.query("UPDATE users SET password_hash = $1 WHERE email = $2", [
        passwordHash,
        resetRecord.email,
      ]);
      await db.query(
        "UPDATE password_reset_tokens SET used = true WHERE id = $1",
        [resetRecord.id],
      );
      res.json({ message: "Password has been reset successfully." });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  },
);

// ---- USERS ----

app.get("/api/auth/google-client-id", (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || "" });
});

app.get("/api/users/:uid", authenticateJWT, async (req, res) => {
  const { uid } = req.params;
  if (req.user.uid !== uid) return res.status(403).json({ error: "Forbidden" });
  try {
    const result = await db.query("SELECT * FROM users WHERE uid = $1", [uid]);
    const data = result.rows[0];
    if (!data) return res.status(404).json({ error: "User not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

app.get("/api/profile/status", authenticateJWT, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT display_name, phone_number FROM users WHERE uid = $1",
      [req.user.uid],
    );
    const u = result.rows[0] || {};
    const missing = [];
    if (!u.display_name || !u.display_name.trim()) missing.push("Full Name");
    if (!u.phone_number || !u.phone_number.trim()) missing.push("Phone Number");
    res.json({ complete: missing.length === 0, missingFields: missing });
  } catch (e) {
    res.status(500).json({ error: "Failed to check profile" });
  }
});

// SECURITY: Role validation endpoint for frontend
app.get("/api/auth/validate-role", authenticateJWT, async (req, res) => {
  try {
    // Re-fetch role from database to ensure it's current
    const result = await db.query("SELECT role FROM users WHERE uid = $1", [
      req.user.uid,
    ]);
    const currentRole = result.rows[0]?.role || "consumer";
    
    res.json({
      uid: req.user.uid,
      role: currentRole,
      email: req.user.email,
      isValid: true
    });
  } catch (e) {
    console.error("Role validation error:", e);
    res.status(500).json({ error: "Failed to validate role" });
  }
});

app.put(
  "/api/users/profile",
  authenticateJWT,
  sanitizeInput,
  async (req, res) => {
    const uid = req.user.uid;
    const { displayName, phoneNumber } = req.body;
    try {
      const updates = {};
      if (displayName !== undefined) updates.display_name = displayName;
      if (phoneNumber !== undefined) updates.phone_number = phoneNumber;
      const profileFields = [
        "businessName",
        "category",
        "manufacture",
        "produce",
        "location",
        "imageUrls",
        "bio",
      ];
      const profileUpdates = {};
      for (const field of profileFields) {
        if (req.body[field] !== undefined)
          profileUpdates[field] = req.body[field];
      }
      if (Object.keys(profileUpdates).length > 0) {
        updates.profile = JSON.stringify(profileUpdates);
      }
      if (Object.keys(updates).length > 0) {
        const setClauses = [];
        const params = [];
        let idx = 1;
        for (const [col, val] of Object.entries(updates)) {
          if (col === "profile") {
            setClauses.push("profile = $" + idx + "::jsonb");
            params.push(val);
          } else {
            setClauses.push(col + " = $" + idx);
            params.push(val);
          }
          idx++;
        }
        params.push(uid);
        await db.query(
          "UPDATE users SET " + setClauses.join(", ") + " WHERE uid = $" + idx,
          params,
        );
      }
      const result = await db.query("SELECT * FROM users WHERE uid = $1", [
        uid,
      ]);
      res.json(result.rows[0]);
    } catch (e) {
      console.error("Profile update error:", e);
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

app.get("/api/users", authenticateJWT, async (req, res) => {
  const { role, email } = req.query;
  try {
    let query =
      "SELECT uid, email, display_name, role, photo_url, profile FROM users";
    const conditions = [];
    const params = [];
    if (role) {
      conditions.push("role = $" + (params.length + 1));
      params.push(role);
    }
    if (email) {
      conditions.push("LOWER(email) = LOWER($" + (params.length + 1) + ")");
      params.push(email);
    }
    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    const result = await db.query(query, params);
    const list = result.rows.map((r) => ({
      uid: r.uid,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      photoURL: r.photo_url,
      profile: r.profile,
    }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ---- WALLET ID LOOKUP & TRANSFER ----

app.get("/api/wallet/id", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      "SELECT wallet_id FROM wallet_ids WHERE uid = $1",
      [uid],
    );
    if (result.rows.length === 0) {
      await getOrCreateWalletId(
        uid,
        req.user.email || "",
        req.user.email || "",
      );
      const retry = await db.query(
        "SELECT wallet_id FROM wallet_ids WHERE uid = $1",
        [uid],
      );
      if (retry.rows.length === 0)
        return res.status(500).json({ error: "Failed to create wallet ID" });
      return res.json({ walletId: retry.rows[0].wallet_id });
    }
    res.json({ walletId: result.rows[0].wallet_id });
  } catch (e) {
    console.error("Wallet ID fetch error:", e);
    res.status(500).json({ error: "Failed to fetch wallet ID" });
  }
});

app.get(
  "/api/wallet/lookup",
  authenticateJWT,
  sanitizeInput,
  [query("walletId").isString().isLength({ min: 8, max: 8 })],
  validate,
  async (req, res) => {
    const { walletId } = req.query;
    try {
      const recipient = await lookupWalletId(walletId);
      if (!recipient)
        return res.status(404).json({ error: "Wallet ID not found" });
      if (recipient.uid === req.user.uid)
        return res.status(400).json({ error: "Cannot transfer to yourself" });
      res.json(recipient);
    } catch (e) {
      console.error("Wallet lookup error:", e);
      res.status(500).json({ error: "Lookup failed" });
    }
  },
);

app.post(
  "/api/wallet/transfer",
  authenticateJWT,
  walletRestrictionMiddleware(WALLET_TYPES.ACTIVE),
  apiLimiter,
  sanitizeInput,
  [
    body("walletId").isString().isLength({ min: 8, max: 8 }),
    body("amount").isFloat({ min: MIN_TRANSFER }),
    body("description").optional().isString(),
    body("idempotencyKey").optional().isString().isLength({ min: 8, max: 128 }),
  ],
  validate,
  checkIdempotency,
  async (req, res) => {
    const { walletId, amount, description, idempotencyKey } = req.body;
    const fromUid = req.user.uid;
    try {
      const recipient = await lookupWalletId(walletId);
      if (!recipient)
        return res.status(404).json({ error: "Recipient wallet ID not found" });
      if (recipient.uid === fromUid)
        return res.status(400).json({ error: "Cannot transfer to yourself" });

      const allowed = await checkWalletNotRestricted(
        recipient.uid,
        WALLET_TYPES.ACTIVE,
      );
      if (!allowed)
        return res
          .status(400)
          .json({ error: "Recipient account is restricted" });

      const parsedAmount = parseAmount(amount);
      if (!parsedAmount || parsedAmount < MIN_TRANSFER)
        return res
          .status(400)
          .json({ error: "Minimum transfer is KES " + MIN_TRANSFER });

      const fromBalance = await computeBalance(fromUid, WALLET_TYPES.ACTIVE);
      const fromWalletInfo = await getWalletState(fromUid, WALLET_TYPES.ACTIVE);
      const fromAvailable = parseFloat(
        (fromBalance - parseFloat(fromWalletInfo?.frozenBalance || 0)).toFixed(
          2,
        ),
      );

      const fee = getTransactionFee(parsedAmount);
      const totalDeduction = parseFloat((parsedAmount + fee).toFixed(2));
      if (fromAvailable < totalDeduction) {
        return res.status(400).json({
          error:
            "Insufficient balance. Available: KES " +
            fromAvailable.toFixed(2) +
            ", needed: KES " +
            totalDeduction.toFixed(2) +
            " (incl. fee KES " +
            fee.toFixed(2) +
            ")",
        });
      }

      const txnRef = generateTxnId();
      const desc = description || "Wallet transfer to " + recipient.displayName;

      await debitWallet(
        fromUid,
        WALLET_TYPES.ACTIVE,
        totalDeduction,
        txnRef,
        desc,
        null,
        { fee, toUid: recipient.uid, walletId },
      );
      await creditWallet(
        recipient.uid,
        WALLET_TYPES.ACTIVE,
        parsedAmount,
        txnRef,
        "Transfer from " + (req.user.email || fromUid) + ": " + desc,
        null,
        { fee, fromUid },
      );

      if (fee > 0) {
        await createLedgerEntry({
          type: LEDGER_ENTRY_TYPE.FEE,
          amount: fee,
          toWallet: WALLET_TYPES.ACTIVE,
          toUid: "platform",
          reference: txnRef,
          description: "Transfer fee on " + txnRef,
        });
      }

      const [fromWalletAfter, toWalletAfter] = await Promise.all([
        getWalletState(fromUid, WALLET_TYPES.ACTIVE),
        getWalletState(recipient.uid, WALLET_TYPES.ACTIVE),
      ]);
      const newBalance = fromWalletAfter?.balance || 0;
      await db.query(
        "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          fromUid,
          "transfer",
          -totalDeduction,
          fee,
          newBalance,
          txnRef,
          "Transfer to " +
            recipient.displayName +
            " (" +
            recipient.walletId +
            "): " +
            desc,
          Date.now(),
        ],
      );
      await db.query(
        "INSERT INTO transactions (uid, type, amount, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          recipient.uid,
          "transfer",
          parsedAmount,
          toWalletAfter?.balance || 0,
          txnRef,
          "Transfer from " + (req.user.email || fromUid) + ": " + desc,
          Date.now(),
        ],
      );

      if (idempotencyKey) {
        await recordIdempotency(idempotencyKey, {
          status: "success",
          reference: txnRef,
          amount: parsedAmount,
          toUid: recipient.uid,
        });
      }

      sendNotification(
        recipient.uid,
        "Payment Received",
        (req.user.email || "A user") +
          " sent you KES " +
          parsedAmount.toFixed(2) +
          ".",
        "success",
      );
      io.to(fromUid).emit("walletUpdate");
      io.to(recipient.uid).emit("walletUpdate");
      res.json({
        balance: newBalance,
        fee,
        amount: parsedAmount,
        reference: txnRef,
        toWalletId: walletId,
        toName: recipient.displayName,
        message:
          "KES " +
          parsedAmount.toFixed(2) +
          " sent to " +
          recipient.displayName +
          " (fee: KES " +
          fee.toFixed(2) +
          ")",
      });
    } catch (e) {
      console.error("Transfer error:", e);
      res
        .status(400)
        .json({ error: e.message || "Failed to process transfer" });
    }
  },
);

// ---- M-PESA DEPOSIT (STK PUSH) ----

app.post(
  "/api/mpesa/stkpush",
  authenticateJWT,
  walletRestrictionMiddleware(WALLET_TYPES.ACTIVE),
  apiLimiter,
  sanitizeInput,
  [
    body("phoneNumber")
      .isString()
      .matches(/^(0|\+?254)\d{9}$/),
    body("amount")
      .isFloat({ min: MIN_DEPOSIT })
      .withMessage("Minimum deposit is KES " + MIN_DEPOSIT),
    body("idempotencyKey").optional().isString().isLength({ min: 8, max: 128 }),
  ],
  validate,
  checkIdempotency,
  async (req, res) => {
    const { phoneNumber, amount, idempotencyKey } = req.body;
    const uid = req.user.uid;
    try {
      const parsedAmount = Math.round(parseFloat(amount));
      if (parsedAmount < MIN_DEPOSIT)
        return res
          .status(400)
          .json({ error: "Minimum deposit is KES " + MIN_DEPOSIT });
      const reference = generateTxnId();
      const result = await stkPush(
        phoneNumber,
        parsedAmount,
        reference,
        "AgriConnect deposit for " + uid,
        idempotencyKey || null,
      );
      await db.query(
        "INSERT INTO mpesa_deposits (uid, checkout_request_id, merchant_request_id, amount, phone_number, reference, status, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          uid,
          result.CheckoutRequestID,
          result.MerchantRequestID,
          parsedAmount,
          phoneNumber,
          reference,
          "pending",
          idempotencyKey || null,
          Date.now(),
        ],
      );
      if (idempotencyKey) {
        await recordIdempotency(idempotencyKey, {
          checkoutRequestId: result.CheckoutRequestID,
          reference,
          status: "pending",
        });
      }
      res.json({
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        reference,
        message:
          "STK Push sent. Please check your phone and enter your M-Pesa PIN.",
      });
    } catch (e) {
      console.error("STK Push error:", e);
      res
        .status(400)
        .json({ error: e.message || "Failed to initiate STK Push" });
    }
  },
);

app.post(
  "/api/mpesa/stkquery",
  authenticateJWT,
  sanitizeInput,
  [body("checkoutRequestId").isString().notEmpty()],
  validate,
  async (req, res) => {
    try {
      const result = await stkQuery(req.body.checkoutRequestId);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message || "Query failed" });
    }
  },
);

app.post(
  "/api/mpesa/status",
  authenticateJWT,
  sanitizeInput,
  [body("checkoutRequestId").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { checkoutRequestId } = req.body;
    try {
      const [stkResult, depositResult] = await Promise.all([
        db.query(
          "SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1",
          [checkoutRequestId],
        ),
        db.query(
          "SELECT * FROM mpesa_deposits WHERE checkout_request_id = $1",
          [checkoutRequestId],
        ),
      ]);
      let depositRecord = stkResult.rows[0] || depositResult.rows[0] || null;
      if (!depositRecord)
        return res.status(404).json({ error: "Transaction not found" });
      res.json({
        status: depositRecord.status,
        reference: depositRecord.reference || depositRecord.account_reference,
        amount: depositRecord.amount,
      });
    } catch (e) {
      console.error("M-Pesa status fetch error:", e);
      res.status(500).json({ error: "Failed to fetch status" });
    }
  },
);

// ---- DEPOSIT STATUS POLL (GET, authenticated) ----
app.get(
  "/api/mpesa/deposit/status/:checkoutRequestId",
  authenticateJWT,
  async (req, res) => {
    const { checkoutRequestId } = req.params;
    const uid = req.user.uid;
    try {
      // Primary: mpesa_deposits (has uid for ownership check)
      const depResult = await db.query(
        "SELECT * FROM mpesa_deposits WHERE checkout_request_id = $1 AND uid = $2",
        [checkoutRequestId, uid],
      );
      if (!depResult.rows.length)
        return res.status(404).json({ error: "Transaction not found" });

      const dep = depResult.rows[0];
      // If already resolved, return immediately
      if (dep.status === "success" || dep.status === "failed") {
        return res.json({
          status: dep.status,
          mpesaReceiptNumber: dep.mpesa_receipt_number || null,
          amount: dep.amount,
          netAmount: dep.net_amount || dep.amount,
          fee: dep.fee || 0,
          phoneNumber: dep.phone_number,
        });
      }

      // Still pending — also check mpesa_stk_requests in case callback wrote there first
      const stkResult = await db.query(
        "SELECT status, mpesa_receipt_number, amount, net_amount, fee, phone_number FROM mpesa_stk_requests WHERE checkout_request_id = $1",
        [checkoutRequestId],
      );
      const stk = stkResult.rows[0];
      if (stk && (stk.status === "success" || stk.status === "failed")) {
        return res.json({
          status: stk.status,
          mpesaReceiptNumber: stk.mpesa_receipt_number || null,
          amount: stk.amount || dep.amount,
          netAmount: stk.net_amount || stk.amount || dep.amount,
          fee: stk.fee || 0,
          phoneNumber: stk.phone_number || dep.phone_number,
        });
      }

      // Still pending
      return res.json({ status: "pending" });
    } catch (e) {
      console.error("[MPESA] Deposit status poll error:", e);
      res.status(500).json({ error: "Failed to fetch status" });
    }
  },
);

// ---- C2B CALLBACK (M-Pesa sends result here) ----

app.post("/api/mpesa/c2b/callback", webhookLimiter, async (req, res) => {
  try {
    const body = req.body;
    const stkCallback = body.Body && body.Body.stkCallback;
    if (!stkCallback)
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } =
      stkCallback;
    if (ResultCode !== 0) {
      await db.query(
        "UPDATE mpesa_stk_requests SET status = 'failed' WHERE checkout_request_id = $1",
        [CheckoutRequestID],
      );
      await db.query(
        "INSERT INTO mpesa_failed_callbacks (checkout_request_id, result_code, result_desc, received_at) VALUES ($1, $2, $3, $4)",
        [CheckoutRequestID, String(ResultCode), ResultDesc || "", Date.now()],
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }
    const items =
      CallbackMetadata && CallbackMetadata.Item ? CallbackMetadata.Item : [];
    let amount = 0,
      mpesaReceiptNumber = "",
      phoneNumber = "",
      transactionDate = "";
    items.forEach((item) => {
      if (item.Name === "Amount") amount = parseFloat(item.Value || 0);
      if (item.Name === "MpesaReceiptNumber") mpesaReceiptNumber = item.Value;
      if (item.Name === "PhoneNumber") phoneNumber = String(item.Value);
      if (item.Name === "TransactionDate") transactionDate = String(item.Value);
    });
    if (!mpesaReceiptNumber)
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    const processedResult = await db.query(
      "SELECT * FROM mpesa_processed WHERE mpesa_receipt_number = $1",
      [mpesaReceiptNumber],
    );
    if (processedResult.rows.length > 0) {
      console.log(
        "[MPESA] Duplicate callback ignored for receipt: " + mpesaReceiptNumber,
      );
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }
    await db.query(
      "INSERT INTO mpesa_processed (mpesa_receipt_number, processed_at, checkout_request_id) VALUES ($1, $2, $3)",
      [mpesaReceiptNumber, Date.now(), CheckoutRequestID],
    );
    const stkResult = await db.query(
      "SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1",
      [CheckoutRequestID],
    );
    const stkReq = stkResult.rows[0] || {};
    let uid = stkReq.uid || null;
    if (!uid) {
      const depResult = await db.query(
        "SELECT uid FROM mpesa_deposits WHERE checkout_request_id = $1",
        [CheckoutRequestID],
      );
      if (depResult.rows.length > 0) uid = depResult.rows[0].uid;
    }
    if (!uid) {
      console.error("[MPESA] No user found for callback " + CheckoutRequestID);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }
    const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
    const netAmount = parseFloat((amount - fee).toFixed(2));
    await creditWallet(
      uid,
      WALLET_TYPES.ACTIVE,
      netAmount,
      mpesaReceiptNumber,
      "M-Pesa deposit via " +
        mpesaReceiptNumber +
        " (fee: KES " +
        fee.toFixed(2) +
        ")",
      null,
      {
        mpesaReceiptNumber,
        checkoutRequestId: CheckoutRequestID,
        phoneNumber,
        grossAmount: amount,
        fee,
      },
    );
    if (fee > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: fee,
        fromWallet: WALLET_TYPES.ACTIVE,
        toWallet: WALLET_TYPES.ACTIVE,
        fromUid: uid,
        toUid: "platform",
        reference: mpesaReceiptNumber,
        description:
          "Deposit fee (" +
          DEPOSIT_FEE_RATE * 100 +
          "%) on " +
          mpesaReceiptNumber,
      });
    }
    const newBalance = parseFloat(
      (await getWalletState(uid, WALLET_TYPES.ACTIVE))?.balance || 0,
    );
    await db.query(
      "UPDATE mpesa_stk_requests SET status = 'success', mpesa_receipt_number = $1, amount = $2, net_amount = $3, fee = $4, phone_number = $5, transaction_date = $6, processed_at = $7 WHERE checkout_request_id = $8",
      [
        mpesaReceiptNumber,
        amount,
        netAmount,
        fee,
        phoneNumber,
        transactionDate,
        Date.now(),
        CheckoutRequestID,
      ],
    );
    await db.query(
      "UPDATE mpesa_deposits SET status = 'success', net_amount = $1, fee = $2, mpesa_receipt_number = $3, processed_at = $4 WHERE checkout_request_id = $5 AND uid = $6",
      [netAmount, fee, mpesaReceiptNumber, Date.now(), CheckoutRequestID, uid],
    );
    await db.query(
      "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        uid,
        "deposit",
        netAmount,
        fee,
        newBalance,
        mpesaReceiptNumber,
        "M-Pesa deposit (fee: KES " + fee.toFixed(2) + ")",
        Date.now(),
      ],
    );
    if (stkReq.idempotency_key) {
      await recordIdempotency(stkReq.idempotency_key, {
        status: "success",
        mpesaReceiptNumber,
        amount: netAmount,
      });
    }
    const userResult = await db.query(
      "SELECT email, display_name FROM users WHERE uid = $1",
      [uid],
    );
    const userData = userResult.rows[0] || {};
    if (userData.email) {
      sendEmail(
        userData.email,
        "Deposit Confirmed - AgriConnect",
        depositEmail(
          userData.display_name || "User",
          netAmount,
          newBalance,
          mpesaReceiptNumber,
        ),
      );
    }
    sendNotification(
      uid,
      "Deposit Received",
      "KES " +
        netAmount.toFixed(2) +
        " has been credited to your active wallet. Receipt: " +
        mpesaReceiptNumber,
      "success",
    );
    io.to(uid).emit("walletUpdate");
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (e) {
    console.error("[MPESA] Callback error:", e);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

app.post("/api/mpesa/c2b/confirmation", webhookLimiter, async (req, res) => {
  console.log("[MPESA] C2B Confirmation received:", req.body);
  const {
    TransactionType,
    TransID,
    TransTime,
    TransAmount,
    BusinessShortCode,
    BillRefNumber,
    MSISDN,
  } = req.body;
  try {
    const processedResult = await db.query(
      "SELECT * FROM mpesa_processed WHERE mpesa_receipt_number = $1",
      [TransID],
    );
    if (processedResult.rows.length > 0)
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    await db.query(
      "INSERT INTO mpesa_processed (mpesa_receipt_number, processed_at) VALUES ($1, $2)",
      [TransID, Date.now()],
    );
    const amount = parseFloat(TransAmount || 0);
    const senderPhone = String(MSISDN || "");
    const uid =
      BillRefNumber && BillRefNumber.startsWith("uid_")
        ? BillRefNumber.replace("uid_", "")
        : null;
    if (uid) {
      const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
      const netAmount = parseFloat((amount - fee).toFixed(2));
      await creditWallet(
        uid,
        WALLET_TYPES.ACTIVE,
        netAmount,
        TransID,
        "M-Pesa C2B deposit via " + TransID,
        null,
        { transId: TransID, senderPhone, grossAmount: amount, fee },
      );
      sendNotification(
        uid,
        "M-Pesa Deposit",
        "KES " + netAmount.toFixed(2) + " received. Receipt: " + TransID,
        "success",
      );
    } else {
      await db.query(
        "INSERT INTO mpesa_unlinked_c2b (trans_id, trans_time, amount, sender_phone, bill_ref_number, received_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [TransID, TransTime, amount, senderPhone, BillRefNumber, Date.now()],
      );
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (e) {
    console.error("[MPESA] C2B Confirmation error:", e);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

app.post("/api/mpesa/c2b/validation", webhookLimiter, async (req, res) => {
  console.log("[MPESA] C2B Validation received:", req.body);
  res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
});

// ---- B2C RESULT (Payout callback) ----

app.post("/api/mpesa/b2c/result", webhookLimiter, async (req, res) => {
  console.log("[MPESA] B2C Result:", req.body);
  try {
    const { Result } = req.body;
    if (Result) {
      const {
        ResultType,
        ResultCode,
        ResultDesc,
        TransactionID,
        ReferenceData,
      } = Result;
      await db.query(
        "INSERT INTO mpesa_b2c_results (result_type, result_code, result_desc, transaction_id, reference_data, received_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
        [
          String(ResultType),
          String(ResultCode),
          ResultDesc || "",
          TransactionID || "",
          ReferenceData ? JSON.stringify(ReferenceData) : null,
          Date.now(),
        ],
      );
      if (ResultCode === 0 && ReferenceData && ReferenceData.ReferenceItem) {
        const payoutId = ReferenceData.ReferenceItem.Value;
        if (payoutId) {
          await db.query(
            "UPDATE payouts SET status = $1, mpesa_transaction_id = $2, completed_at = $3 WHERE id = $4",
            ["completed", TransactionID, Date.now(), payoutId],
          );
          const payoutResult = await db.query(
            "SELECT uid, amount FROM payouts WHERE id = $1",
            [payoutId],
          );
          const payout = payoutResult.rows[0];
          if (payout) {
            sendNotification(
              payout.uid,
              "Withdrawal Complete",
              "KES " +
                payout.amount +
                " sent to your M-Pesa. Transaction: " +
                TransactionID,
              "success",
            );
          }
        }
      }
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (e) {
    console.error("[MPESA] B2C result error:", e);
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

app.post("/api/mpesa/b2c/timeout", webhookLimiter, async (req, res) => {
  console.log("[MPESA] B2C Timeout:", req.body);
  res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
});

// ---- WALLET ----

app.get("/api/wallet", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const cached = await cache.get(cache.walletCacheKey(uid));
    if (cached) return res.json(cached);
    await Promise.all([
      ensureWallet(uid, WALLET_TYPES.ACTIVE),
      ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE),
    ]);
    const [
      activeWallet,
      activeBalance,
      escrowBalance,
      withdrawableWallet,
      withdrawableBalance,
      ledgerResult,
    ] = await Promise.all([
      getWalletState(uid, WALLET_TYPES.ACTIVE),
      computeBalance(uid, WALLET_TYPES.ACTIVE),
      computeBalance(uid, WALLET_TYPES.ESCROW),
      getWalletState(uid, WALLET_TYPES.WITHDRAWABLE),
      computeBalance(uid, WALLET_TYPES.WITHDRAWABLE),
      db.query(
        "SELECT * FROM ledger WHERE from_uid = $1 OR to_uid = $1 ORDER BY created_at DESC LIMIT 50",
        [uid],
      ),
    ]);
    const body = {
      activeBalance: Math.max(activeBalance, activeWallet?.balance || 0),
      escrowBalance,
      withdrawableBalance: Math.max(
        withdrawableBalance,
        withdrawableWallet?.balance || 0,
      ),
      frozenBalance: parseFloat(activeWallet?.frozenBalance || 0),
      status: activeWallet?.status || WALLET_STATUS.ACTIVE,
      transactions: ledgerResult.rows,
    };
    cache.set(cache.walletCacheKey(uid), body, cache.CACHE_TTL.WALLET);
    res.json(body);
  } catch (e) {
    console.error("Wallet fetch error:", e);
    res.status(500).json({ error: "Failed to fetch wallet" });
  }
});

app.get("/api/wallet/transactions", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      "SELECT * FROM ledger WHERE from_uid = $1 OR to_uid = $1 ORDER BY created_at DESC",
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.post(
  "/api/wallet/withdraw",
  authenticateJWT,
  walletRestrictionMiddleware(WALLET_TYPES.WITHDRAWABLE),
  sanitizeInput,
  [
    body("amount").isFloat({ min: MIN_WITHDRAWAL }),
    body("phoneNumber")
      .isString()
      .matches(/^(0|\+?254)\d{9}$/),
    body("idempotencyKey").optional().isString().isLength({ min: 8, max: 128 }),
  ],
  validate,
  checkIdempotency,
  async (req, res) => {
    const uid = req.user.uid;
    const { amount, phoneNumber, idempotencyKey } = req.body;
    try {
      const parsedAmount = parseAmount(amount);
      if (!parsedAmount || parsedAmount < MIN_WITHDRAWAL)
        return res
          .status(400)
          .json({ error: "Minimum withdrawal is KES " + MIN_WITHDRAWAL });
      const withdrawableBalance = await computeBalance(
        uid,
        WALLET_TYPES.WITHDRAWABLE,
      );
      if (withdrawableBalance < parsedAmount) {
        return res.status(400).json({
          error:
            "Insufficient withdrawable balance. Available: KES " +
            withdrawableBalance.toFixed(2),
        });
      }
      const feeRate = parseFloat(process.env.WITHDRAWAL_FEE_RATE || "0.01");
      const fee = parseFloat(Math.max(10, parsedAmount * feeRate).toFixed(2));
      const netAmount = parseFloat((parsedAmount - fee).toFixed(2));
      const txnRef = generateTxnId();
      const payoutId = uuidv4();
      await debitWallet(
        uid,
        WALLET_TYPES.WITHDRAWABLE,
        parsedAmount,
        txnRef,
        "Withdrawal to M-Pesa " + phoneNumber,
        null,
        { fee, netAmount },
      );
      if (fee > 0) {
        await createLedgerEntry({
          type: LEDGER_ENTRY_TYPE.FEE,
          amount: fee,
          fromWallet: WALLET_TYPES.WITHDRAWABLE,
          toWallet: WALLET_TYPES.ACTIVE,
          fromUid: uid,
          toUid: "platform",
          reference: txnRef,
          description: "Withdrawal fee on " + txnRef,
        });
      }
      await db.query(
        "INSERT INTO payouts (id, uid, amount, fee, net_amount, method, phone_number, status, reference, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          payoutId,
          uid,
          parsedAmount,
          fee,
          netAmount,
          "mpesa",
          phoneNumber.replace(/^0+/, "254").replace(/^\+?254/, "254"),
          "pending",
          txnRef,
          Date.now(),
        ],
      );
      await db.query(
        "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          uid,
          "withdrawal",
          -parsedAmount,
          fee,
          (await getWalletState(uid, WALLET_TYPES.WITHDRAWABLE))?.balance || 0,
          txnRef,
          "Withdrawal to M-Pesa " +
            phoneNumber +
            " (fee: KES " +
            fee.toFixed(2) +
            ")",
          Date.now(),
        ],
      );
      if (idempotencyKey) {
        await recordIdempotency(idempotencyKey, {
          status: "pending",
          reference: txnRef,
          payoutId,
        });
      }
      try {
        const b2cResult = await b2cPayment(
          phoneNumber,
          netAmount,
          "AgriConnect payout " + txnRef,
          "Payout",
        );
        await db.query(
          "UPDATE payouts SET b2c_result = $1, initiated_at = $2 WHERE id = $3",
          [JSON.stringify(b2cResult), Date.now(), payoutId],
        );
      } catch (b2cErr) {
        console.error(
          "[MPESA] B2C failed, payout queued for manual processing:",
          b2cErr.message,
        );
        await db.query(
          "UPDATE payouts SET b2c_error = $1, queued_for_manual = true WHERE id = $2",
          [b2cErr.message, payoutId],
        );
      }
      const adminResult = await db.query(
        "SELECT uid FROM users WHERE role = 'admin'",
      );
      for (const row of adminResult.rows) {
        sendNotification(
          row.uid,
          "New Withdrawal",
          "KES " + parsedAmount.toFixed(2) + " withdrawal by " + uid,
          "info",
        );
      }
      const userResult = await db.query(
        "SELECT email, display_name FROM users WHERE uid = $1",
        [uid],
      );
      const userData = userResult.rows[0] || {};
      if (userData.email) {
        sendEmail(
          userData.email,
          "Withdrawal Initiated - AgriConnect",
          withdrawalEmail(
            userData.display_name || "User",
            parsedAmount,
            "Reference: " + txnRef,
          ),
        );
      }
      sendNotification(
        uid,
        "Withdrawal Initiated",
        "KES " + netAmount.toFixed(2) + " will be sent to your M-Pesa.",
        "info",
      );
      io.to(uid).emit("walletUpdate");
      res.json({
        message: "Withdrawal initiated",
        reference: txnRef,
        payoutId,
        amount: parsedAmount,
        fee,
        netAmount,
      });
      io.emit("payoutUpdate", { action: "created", id: payoutId });
    } catch (e) {
      console.error("Withdrawal error:", e);
      res
        .status(400)
        .json({ error: e.message || "Failed to process withdrawal" });
    }
  },
);

// ---- AGRICONNECT AI (GEMINI) ----

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const AI_SYSTEM_INSTRUCTION =
  "You are AgriConnect AI, a helpful agricultural assistant for farmers in Kenya and East Africa. " +
  "You can analyse images of crops, soil, livestock, pests, and farm conditions — always describe what you see in detail before giving advice. " +
  "ONLY answer questions related to agriculture, farming, crop diseases, livestock, market prices, soil management, " +
  "irrigation, weather impacts on farming, agricultural best practices, farm inputs, pest control, and agricultural finance. " +
  "If the user asks about ANYTHING outside agriculture (e.g., general knowledge, coding, entertainment, politics, etc.), " +
  "politely decline and say you can only help with agriculture-related topics. " +
  "Respond in clear, simple language suitable for farmers. Use examples relevant to Kenya/East Africa where possible. " +
  "Keep responses concise but informative. Use markdown formatting with bullet points and short paragraphs for readability.";

// ---- AI: list sessions ----
app.get("/api/ai/chats", authenticateJWT, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, title, created_at, updated_at FROM ai_chat_sessions WHERE uid = $1 ORDER BY updated_at DESC LIMIT 100",
      [req.user.uid],
    );
    res.json(result.rows);
  } catch (e) {
    console.error("[AI] List chats error:", e.message);
    res.status(500).json({ error: "Failed to load chats" });
  }
});

// ---- AI: get single session with messages ----
app.get("/api/ai/chats/:sessionId", authenticateJWT, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const sess = await db.query(
      "SELECT * FROM ai_chat_sessions WHERE id = $1 AND uid = $2",
      [sessionId, req.user.uid],
    );
    if (!sess.rows.length) return res.status(404).json({ error: "Not found" });
    const msgs = await db.query(
      "SELECT id, role, content, image_mime, has_image, created_at FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId],
    );
    res.json({ session: sess.rows[0], messages: msgs.rows });
  } catch (e) {
    console.error("[AI] Get chat error:", e.message);
    res.status(500).json({ error: "Failed to load chat" });
  }
});

// ---- AI: create new session ----
app.post("/api/ai/chats", authenticateJWT, async (req, res) => {
  const { title } = req.body;
  try {
    const id = require("uuid").v4();
    const now = Date.now();
    await db.query(
      "INSERT INTO ai_chat_sessions (id, uid, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [id, req.user.uid, title || "New chat", now, now],
    );
    res.json({ id, title: title || "New chat", created_at: now, updated_at: now });
  } catch (e) {
    console.error("[AI] Create chat error:", e.message);
    res.status(500).json({ error: "Failed to create chat" });
  }
});

// ---- AI: rename session ----
app.patch("/api/ai/chats/:sessionId", authenticateJWT, async (req, res) => {
  const { sessionId } = req.params;
  const { title } = req.body;
  try {
    await db.query(
      "UPDATE ai_chat_sessions SET title = $1, updated_at = $2 WHERE id = $3 AND uid = $4",
      [title || "Chat", Date.now(), sessionId, req.user.uid],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to rename chat" });
  }
});

// ---- AI: delete session ----
app.delete("/api/ai/chats/:sessionId", authenticateJWT, async (req, res) => {
  const { sessionId } = req.params;
  try {
    await db.query(
      "DELETE FROM ai_chat_sessions WHERE id = $1 AND uid = $2",
      [sessionId, req.user.uid],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[AI] Delete chat error:", e.message);
    res.status(500).json({ error: "Failed to delete chat" });
  }
});

// ---- AI: send message ----
app.post("/api/ai/chat", authenticateJWT, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res
      .status(503)
      .json({ error: "AI service not configured (GEMINI_API_KEY missing)" });
  }
  const { message, image, sessionId } = req.body;
  const uid = req.user.uid;

  // Must have text OR image
  if ((!message || !message.trim()) && !image) {
    return res.status(400).json({ error: "Message or image is required" });
  }

  try {
    // ---- Build user parts for Gemini ----
    const userParts = [];
    if (message && message.trim()) userParts.push({ text: message.trim() });
    let imageMime = null;
    if (image) {
      const base64Data = image.includes(",") ? image.split(",")[1] : image;
      imageMime = image.includes("image/")
        ? image.match(/image\/[\w.+-]+/)[0]
        : "image/jpeg";
      userParts.push({ inline_data: { mime_type: imageMime, data: base64Data } });
      // If no text was sent with an image, add a prompt so Gemini analyses it
      if (!message || !message.trim()) {
        userParts.unshift({ text: "Please analyse this image and give me agricultural advice based on what you see." });
      }
    }

    // ---- Load conversation history from DB for multi-turn context ----
    let historyContents = [];
    if (sessionId) {
      try {
        const histRows = await db.query(
          "SELECT role, content, image_data, image_mime FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 40",
          [sessionId],
        );
        for (const row of histRows.rows) {
          const parts = [];
          if (row.content) parts.push({ text: row.content });
          if (row.image_data) {
            parts.push({ inline_data: { mime_type: row.image_mime || "image/jpeg", data: row.image_data } });
          }
          if (parts.length > 0) {
            historyContents.push({ role: row.role === "bot" ? "model" : "user", parts });
          }
        }
      } catch (histErr) {
        console.warn("[AI] Could not load history (non-fatal):", histErr.message);
      }
    }

    // ---- Build Gemini payload with full conversation history ----
    const contents = [
      ...historyContents,
      { role: "user", parts: userParts },
    ];

    const payload = {
      contents,
      system_instruction: { parts: [{ text: AI_SYSTEM_INSTRUCTION }] },
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ],
    };

    const geminiRes = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        GEMINI_API_KEY,
      payload,
      { headers: { "Content-Type": "application/json" }, timeout: 45000 },
    );

    const reply =
      geminiRes.data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .join("") || "Sorry, I could not generate a response.";

    // ---- Persist both the user message and bot reply to DB ----
    if (sessionId) {
      try {
        const now = Date.now();
        const imageBase64 = image
          ? (image.includes(",") ? image.split(",")[1] : image)
          : null;
        // User message
        await db.query(
          "INSERT INTO ai_chat_messages (id, session_id, role, content, image_data, image_mime, has_image, created_at) VALUES (gen_random_uuid(), $1, 'user', $2, $3, $4, $5, $6)",
          [sessionId, message ? message.trim() : null, imageBase64, imageMime, !!image, now],
        );
        // Bot reply
        await db.query(
          "INSERT INTO ai_chat_messages (id, session_id, role, content, has_image, created_at) VALUES (gen_random_uuid(), $1, 'bot', $2, false, $3)",
          [sessionId, reply, now + 1],
        );
        // Update session title from first user message if still default
        if (message && message.trim()) {
          await db.query(
            "UPDATE ai_chat_sessions SET updated_at = $1, title = CASE WHEN title = 'New chat' THEN $2 ELSE title END WHERE id = $3 AND uid = $4",
            [now, message.trim().slice(0, 60), sessionId, uid],
          );
        } else {
          await db.query(
            "UPDATE ai_chat_sessions SET updated_at = $1, title = CASE WHEN title = 'New chat' THEN $2 ELSE title END WHERE id = $3 AND uid = $4",
            [now, "Image analysis", sessionId, uid],
          );
        }
      } catch (saveErr) {
        console.warn("[AI] Could not save message (non-fatal):", saveErr.message);
      }
    }

    res.json({ reply });
  } catch (e) {
    console.error("[GEMINI] Error:", e.response?.data || e.message);
    res.status(500).json({ error: "AI service error. Please try again." });
  }
});

// ---- ORDERS & ESCROW ----

app.post(
  "/api/orders",
  authenticateJWT,
  walletRestrictionMiddleware(WALLET_TYPES.ACTIVE),
  sanitizeInput,
  [
    body("listingId").isString().notEmpty(),
    body("farmerUid").isString().notEmpty(),
    body("quantity").isInt({ min: 1 }),
    body("totalPrice").isFloat({ min: 1 }),
    body("idempotencyKey").optional().isString().isLength({ min: 8, max: 128 }),
  ],
  validate,
  checkIdempotency,
  async (req, res) => {
    const { listingId, farmerUid, quantity, totalPrice, idempotencyKey } =
      req.body;
    const buyerUid = req.user.uid;
    if (buyerUid === farmerUid)
      return res
        .status(400)
        .json({ error: "Cannot place order on your own listing" });
    try {
      const parsedAmount = parseAmount(totalPrice);
      if (!parsedAmount)
        return res.status(400).json({ error: "Invalid price" });
      const reference = generateTxnId();
      const { order, otp } = await createEscrowOrder(
        buyerUid,
        farmerUid,
        parsedAmount,
        listingId,
        quantity,
        reference,
      );
      if (idempotencyKey) {
        await recordIdempotency(idempotencyKey, {
          orderId: order.id,
          status: ORDER_STATUS.IN_ESCROW,
          reference,
        });
      }
      sendNotification(
        buyerUid,
        "Order Placed - Funds in Escrow",
        "Order #" +
          order.id +
          " placed. KES " +
          parsedAmount.toFixed(2) +
          " held in escrow.",
        "success",
      );
      io.to(buyerUid).emit("orderUpdate");
      io.to(farmerUid).emit("orderUpdate");
      res.status(201).json({
        orderId: order.id,
        reference,
        status: order.status,
        amount: parsedAmount,
        message: "Order placed. Funds are now in escrow.",
        qrData: JSON.stringify({ orderId: order.id, otp }),
        otp,
      });
    } catch (e) {
      console.error("Order creation error:", e);
      res.status(400).json({ error: e.message || "Failed to create order" });
    }
  },
);

app.get("/api/orders", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      `SELECT eo.*, l.title AS listing_title, l.category AS listing_category, l.price AS listing_price,
              buyer.display_name AS buyer_name, seller.display_name AS seller_name
       FROM escrow_orders eo
       LEFT JOIN listings l ON eo.listing_id = l.id
       LEFT JOIN users buyer ON eo.buyer_uid = buyer.uid
       LEFT JOIN users seller ON eo.seller_uid = seller.uid
       WHERE eo.buyer_uid = $1 OR eo.seller_uid = $1
       ORDER BY eo.created_at DESC`,
      [uid],
    );
    const list = result.rows.map((o) => {
      const { otp_hash, ...rest } = o;
      return rest;
    });
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.get("/api/orders/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT eo.*, l.title AS listing_title, l.category AS listing_category, l.price AS listing_price,
              buyer.display_name AS buyer_name, seller.display_name AS seller_name
       FROM escrow_orders eo
       LEFT JOIN listings l ON eo.listing_id = l.id
       LEFT JOIN users buyer ON eo.buyer_uid = buyer.uid
       LEFT JOIN users seller ON eo.seller_uid = seller.uid
       WHERE eo.id = $1`,
      [id],
    );
    const order = result.rows[0];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.buyer_uid !== req.user.uid && order.seller_uid !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { otp_hash, ...safe } = order;
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

app.patch(
  "/api/orders/:id/deliver",
  authenticateJWT,
  sanitizeInput,
  [param("id").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const uid = req.user.uid;
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.seller_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the seller can mark as dispatched" });
      if (order.status !== ORDER_STATUS.IN_ESCROW)
        return res.status(400).json({
          error: "Order cannot be dispatched in status: " + order.status,
        });

      // Generate new OTP for delivery verification
      const otp = generateOTP();
      const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
      const now = Date.now();
      const otpExpiry = now + 24 * 60 * 60 * 1000; // 24 hours for buyer to verify
      
      await db.query(
        "UPDATE escrow_orders SET status = 'dispatched', dispatched_at = $1, updated_at = $1, otp_hash = $2, otp_expires_at = $3 WHERE id = $4",
        [now, otpHash, otpExpiry, id],
      );
      await db.query(
        "UPDATE orders SET status = 'dispatched', updated_at = $1 WHERE id = $2",
        [now, id],
      );

      // Get buyer details for notification
      const buyerResult = await db.query(
        "SELECT email, display_name FROM users WHERE uid = $1",
        [order.buyer_uid],
      );
      const buyerData = buyerResult.rows[0] || {};

      // Send notification with OTP
      sendNotification(
        order.buyer_uid,
        "Order Dispatched - Verify Delivery",
        `Order #${id} has been dispatched. Use OTP: ${otp} to confirm delivery. You have 24 hours to verify or dispute.`,
        "info",
      );

      // Send email with OTP if available
      if (buyerData.email) {
        sendEmail(
          buyerData.email,
          "Order Dispatched - Verify Delivery",
          `
          <h2>Order Dispatched</h2>
          <p>Dear ${buyerData.display_name || 'Customer'},</p>
          <p>Your order #${id} has been marked as dispatched by the seller.</p>
          <p><strong>Verification OTP: ${otp}</strong></p>
          <p>Please verify delivery using this OTP within 24 hours, or raise a dispute if there are issues.</p>
          <p>Thank you for using AgriConnect!</p>
          `,
        );
      }

      io.to(order.buyer_uid).emit("orderUpdate");
      io.to(order.seller_uid).emit("orderUpdate");
      res.json({
        message: "Order marked as dispatched. OTP sent to buyer for verification.",
        status: ORDER_STATUS.DISPATCHED,
        otpSent: true,
      });
    } catch (e) {
      console.error("Dispatch order error:", e);
      res.status(500).json({ error: e.message || "Failed to update order" });
    }
  },
);

// Farmer Accept Order
app.post(
  "/api/orders/:id/accept",
  authenticateJWT,
  sanitizeInput,
  [param("id").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const uid = req.user.uid;
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.seller_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the seller can accept the order" });
      if (order.status !== "in_escrow")
        return res.status(400).json({
          error: "Order cannot be accepted in status: " + order.status,
        });
      const now = Date.now();
      await db.query(
        "UPDATE escrow_orders SET status = 'processing', updated_at = $1 WHERE id = $2",
        [now, id],
      );
      await db.query(
        "UPDATE orders SET status = 'processing', updated_at = $1 WHERE id = $2",
        [now, id],
      );
      console.log("[ACCEPT] Order " + id + " accepted by farmer " + uid);
      sendNotification(
        order.buyer_uid,
        "Order Accepted",
        "Order #" + id + " has been accepted and is now being processed.",
        "info",
      );
      io.to(order.buyer_uid).emit("orderUpdate");
      io.to(order.seller_uid).emit("orderUpdate");
      res.json({ message: "Order accepted", status: "processing" });
    } catch (e) {
      console.error("[ACCEPT] Error accepting order " + id + ":", e.message);
      res.status(500).json({ error: e.message || "Failed to accept order" });
    }
  },
);

// Farmer Decline Order
app.post(
  "/api/orders/:id/decline",
  authenticateJWT,
  sanitizeInput,
  [param("id").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const uid = req.user.uid;
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.seller_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the seller can decline the order" });
      if (order.status !== "in_escrow")
        return res.status(400).json({
          error: "Order cannot be declined in status: " + order.status,
        });
      const now = Date.now();
      // Refund the buyer
      const amt = parseFloat(order.amount);
      await walletTransfer(
        id,
        order.buyer_uid,
        WALLET_TYPES.ESCROW,
        WALLET_TYPES.ACTIVE,
        amt,
        order.reference,
        "Refund for declined order " + id,
      );
      await db.query(
        "UPDATE escrow_orders SET status = 'cancelled', cancelled_at = $1, updated_at = $1 WHERE id = $2",
        [now, id],
      );
      await db.query(
        "UPDATE orders SET status = 'cancelled', updated_at = $1 WHERE id = $2",
        [now, id],
      );
      sendNotification(
        order.buyer_uid,
        "Order Declined",
        "Order #" + id + " has been declined. Funds have been refunded.",
        "warning",
      );
      io.to(order.buyer_uid).emit("orderUpdate");
      io.to(order.buyer_uid).emit("walletUpdate");
      io.to(order.seller_uid).emit("orderUpdate");
      res.json({ message: "Order declined and refunded" });
    } catch (e) {
      res.status(500).json({ error: e.message || "Failed to decline order" });
    }
  },
);

// Farmer Update Delivery Status
app.patch(
  "/api/orders/:id/delivery-status",
  authenticateJWT,
  sanitizeInput,
  [
    param("id").isString().notEmpty(),
    body("status")
      .isString()
      .isIn(["processing", "delivering", "delivered", "completed"]),
  ],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const uid = req.user.uid;
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.seller_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the seller can update delivery status" });
      const flow = ["processing", "delivering", "delivered", "completed"];
      const currentIdx = flow.indexOf(order.status);
      const nextIdx = flow.indexOf(status);
      if (currentIdx === -1 || nextIdx === -1 || nextIdx !== currentIdx + 1) {
        return res.status(400).json({
          error:
            "Invalid status transition from " + order.status + " to " + status,
        });
      }
      const now = Date.now();
      if (status === "delivered") {
        // Release escrow funds to seller
        await db.query(
          "UPDATE escrow_orders SET status = 'delivered', delivered_at = $1, updated_at = $1 WHERE id = $2",
          [now, id],
        );
        await db.query(
          "UPDATE orders SET status = 'delivered', updated_at = $1 WHERE id = $2",
          [now, id],
        );
        const amt = parseFloat(order.amount);
        const fee = getTransactionFee(amt);
        const netAmount = parseFloat((amt - fee).toFixed(2));
        await walletTransfer(
          id,
          order.seller_uid,
          WALLET_TYPES.ESCROW,
          WALLET_TYPES.WITHDRAWABLE,
          netAmount,
          order.reference,
          "Escrow release for order " + id,
        );
        if (fee > 0) {
          await createLedgerEntry({
            type: LEDGER_ENTRY_TYPE.FEE,
            amount: fee,
            fromWallet: WALLET_TYPES.ESCROW,
            toWallet: WALLET_TYPES.ACTIVE,
            fromUid: order.seller_uid,
            toUid: "platform",
            reference: order.reference,
            description: "Platform fee on order " + id,
          });
        }
        sendNotification(
          order.buyer_uid,
          "Order Delivered",
          "Order #" + id + " has been marked as delivered.",
          "success",
        );
        sendNotification(
          order.seller_uid,
          "Payment Released",
          "KES " +
            netAmount.toFixed(2) +
            " released to your withdrawable wallet for order " +
            id +
            ".",
          "success",
        );
        io.to(order.buyer_uid).emit("walletUpdate");
        io.to(order.seller_uid).emit("walletUpdate");
      } else if (status === "completed") {
        await db.query(
          "UPDATE escrow_orders SET status = 'completed', completed_at = $1, updated_at = $1 WHERE id = $2",
          [now, id],
        );
        await db.query(
          "UPDATE orders SET status = 'completed', updated_at = $1 WHERE id = $2",
          [now, id],
        );
        sendNotification(
          order.buyer_uid,
          "Order Completed",
          "Order #" + id + " has been completed.",
          "info",
        );
      } else {
        await db.query(
          "UPDATE escrow_orders SET status = $1, updated_at = $2 WHERE id = $3",
          [status, now, id],
        );
        await db.query(
          "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
          [status, now, id],
        );
        sendNotification(
          order.buyer_uid,
          "Order Status Update",
          "Order #" + id + " is now: " + status,
          "info",
        );
      }
      io.to(order.buyer_uid).emit("orderUpdate");
      io.to(order.seller_uid).emit("orderUpdate");
      res.json({ message: "Delivery status updated", status });
    } catch (e) {
      res
        .status(500)
        .json({ error: e.message || "Failed to update delivery status" });
    }
  },
);

app.post(
  "/api/orders/:id/verify",
  authenticateJWT,
  otpLimiter,
  sanitizeInput,
  [
    param("id").isString().notEmpty(),
    body("otp").isString().isLength({ min: 6, max: 6 }),
  ],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const { otp } = req.body;
    const uid = req.user.uid;
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.buyer_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the buyer can verify delivery" });
      await verifyEscrowDelivery(id, otp);
      const netAmount = await releaseEscrowToSeller(id);
      sendNotification(
        order.seller_uid,
        "Payment Released",
        "KES " +
          netAmount.toFixed(2) +
          " has been released to your withdrawable wallet.",
        "success",
      );
      io.to(uid).emit("orderUpdate");
      io.to(order.seller_uid).emit("orderUpdate");
      io.to(uid).emit("walletUpdate");
      io.to(order.seller_uid).emit("walletUpdate");
      res.json({
        message: "Delivery verified and funds released to seller",
        status: ORDER_STATUS.COMPLETED,
        releasedAmount: netAmount,
      });
    } catch (e) {
      console.error("Verify delivery error:", e);
      res.status(400).json({ error: e.message || "Failed to verify delivery" });
    }
  },
);

// Buyer Reject Delivery (Create Dispute)
app.post(
  "/api/orders/:id/reject",
  authenticateJWT,
  sanitizeInput,
  [
    param("id").isString().notEmpty(),
    body("reason").isString().isLength({ min: 10, max: 500 }),
    body("evidenceUrls").optional().isArray(),
  ],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const { reason, evidenceUrls } = req.body;
    const uid = req.user.uid;
    
    try {
      const result = await db.query(
        "SELECT * FROM escrow_orders WHERE id = $1",
        [id],
      );
      const order = result.rows[0];
      if (!order) return res.status(404).json({ error: "Order not found" });
      
      if (order.buyer_uid !== uid)
        return res
          .status(403)
          .json({ error: "Only the buyer can reject delivery" });
          
      if (order.status !== ORDER_STATUS.DISPATCHED)
        return res.status(400).json({
          error: "Can only reject dispatched orders. Current status: " + order.status,
        });

      if (order.dispute_opened)
        return res.status(400).json({
          error: "A dispute is already open for this order"
        });

      // Create dispute for the rejected delivery
      const disputeId = await raiseDispute(
        id, 
        uid, 
        `Delivery rejected: ${reason}`, 
        evidenceUrls || []
      );

      res.json({
        message: "Delivery rejected and dispute created. Funds are frozen pending review.",
        status: "disputed",
        disputeId,
      });
      
    } catch (e) {
      console.error("Reject delivery error:", e);
      res.status(400).json({ error: e.message || "Failed to reject delivery" });
    }
  },
);

app.post("/api/orders/:id/cancel", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
      id,
    ]);
    const order = result.rows[0];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.buyer_uid !== uid && order.seller_uid !== uid)
      return res.status(403).json({ error: "Forbidden" });
    const refunded = await cancelEscrow(id);
    io.to(order.buyer_uid).emit("orderUpdate");
    io.to(order.seller_uid).emit("orderUpdate");
    io.to(order.buyer_uid).emit("walletUpdate");
    io.to(order.seller_uid).emit("walletUpdate");
    res.json({
      message: "Order cancelled, funds returned",
      refundedAmount: refunded,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed to cancel order" });
  }
});

// ---- QR CODE DATA ----

app.get("/api/orders/:id/qr", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query("SELECT * FROM escrow_orders WHERE id = $1", [
      id,
    ]);
    const order = result.rows[0];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.buyer_uid !== req.user.uid && order.seller_uid !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const qrData = JSON.stringify({
      orderId: id,
      otp: order.otp_hash ? "Use OTP directly" : "No OTP",
      amount: order.amount,
      status: order.status,
    });
    res.json({
      qrData,
      orderId: id,
      amount: order.amount,
      status: order.status,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate QR data" });
  }
});

// ---- DISPUTES ----

app.post(
  "/api/disputes",
  authenticateJWT,
  sanitizeInput,
  [
    body("orderId").isString().notEmpty(),
    body("reason").isString().isLength({ min: 10, max: 2000 }),
    body("evidenceUrls").optional().isArray(),
  ],
  validate,
  async (req, res) => {
    const { orderId, reason, evidenceUrls } = req.body;
    try {
      const dispute = await raiseDispute(
        orderId,
        req.user.uid,
        reason,
        evidenceUrls || [],
      );
      res.status(201).json({
        disputeId: dispute.id,
        status: dispute.status,
        message: "Dispute raised. An admin will review it shortly.",
      });
    } catch (e) {
      res.status(400).json({ error: e.message || "Failed to raise dispute" });
    }
  },
);

app.get("/api/disputes", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      "SELECT * FROM disputes WHERE raised_by_uid = $1 ORDER BY created_at DESC",
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch disputes" });
  }
});

app.get("/api/disputes/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const dResult = await db.query("SELECT * FROM disputes WHERE id = $1", [
      id,
    ]);
    const dispute = dResult.rows[0];
    if (!dispute) return res.status(404).json({ error: "Dispute not found" });
    const oResult = await db.query(
      "SELECT * FROM escrow_orders WHERE id = $1",
      [dispute.order_id],
    );
    const order = oResult.rows[0] || {};
    if (
      order.buyer_uid !== req.user.uid &&
      order.seller_uid !== req.user.uid &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ ...dispute, order });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch dispute" });
  }
});

// ---- LISTINGS ----

app.post(
  "/api/listings",
  authenticateJWT,
  sanitizeInput,
  [
    body("title").isString().notEmpty(),
    body("description").isString().notEmpty(),
    body("price").isFloat({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    const {
      title,
      description,
      price,
      category,
      location,
      quantity,
      imageUrls,
    } = req.body;
    const uid = req.user.uid;
    try {
      const listingId = uuidv4();
      const now = Date.now();
      await db.query(
        "INSERT INTO listings (id, uid, title, description, price, category, location, quantity, image_urls, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)",
        [
          listingId,
          uid,
          title,
          description,
          parseFloat(price),
          category || "",
          location || "",
          quantity || "",
          JSON.stringify(imageUrls || []),
          "active",
          now,
        ],
      );
      io.emit("productUpdate");
      const orgResult = await db.query(
        "SELECT uid FROM users WHERE role = 'organization'",
      );
      for (const row of orgResult.rows) {
        sendNotification(
          row.uid,
          "New Product",
          title + " listed at KES " + parseFloat(price).toFixed(2),
          "info",
        );
      }
      res.status(201).json({
        id: listingId,
        uid,
        title,
        description,
        price: parseFloat(price),
        category: category || "",
        location: location || "",
        quantity: quantity || "",
        imageUrls: imageUrls || [],
        status: "active",
        createdAt: now,
      });
    } catch (e) {
      console.error("Listing creation error:", e);
      res.status(500).json({ error: "Failed to create listing" });
    }
  },
);

app.get("/api/listings", authenticateJWT, async (req, res) => {
  try {
    const cached = await cache.get("listings:all");
    if (cached) return res.json(cached);
    const result = await db.query(
      "SELECT l.*, u.display_name FROM listings l JOIN users u ON l.uid = u.uid WHERE l.status = 'active'",
    );
    cache.set("listings:all", result.rows, cache.CACHE_TTL.LISTINGS);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

app.get("/api/listings/mine", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query("SELECT * FROM listings WHERE uid = $1", [
      uid,
    ]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch listings" });
  }
});

// ---- AGREEMENTS ----

app.post(
  "/api/agreements",
  authenticateJWT,
  sanitizeInput,
  [
    body("orgUid").optional().isString(),
    body("farmerUid").optional().isString(),
    body("terms").optional().isString(),
    body("orgUid").custom((val, { req }) => {
      if (!val && !req.body.farmerUid)
        throw new Error("Either orgUid or farmerUid is required");
      return true;
    }),
  ],
  validate,
  async (req, res) => {
    const { orgUid, farmerUid, terms } = req.body;
    const myUid = req.user.uid;
    const finalFarmerUid = farmerUid || myUid;
    const finalOrgUid = orgUid || myUid;
    try {
      const agreementId = uuidv4();
      const now = Date.now();
      await db.query(
        "INSERT INTO agreements (id, farmer_uid, org_uid, terms, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [agreementId, finalFarmerUid, finalOrgUid, terms || "", "pending", now],
      );
      res.status(201).json({
        id: agreementId,
        farmer_uid: finalFarmerUid,
        org_uid: finalOrgUid,
        terms: terms || "",
        status: "pending",
        created_at: now,
      });
    } catch (e) {
      res.status(500).json({ error: "Failed to create agreement" });
    }
  },
);

app.get("/api/agreements", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      `SELECT a.*,
        farmer.display_name AS farmer_name, farmer.email AS farmer_email,
        org.display_name AS org_name, org.email AS org_email
       FROM agreements a
       LEFT JOIN users farmer ON a.farmer_uid = farmer.uid
       LEFT JOIN users org ON a.org_uid = org.uid
       WHERE a.farmer_uid = $1 OR a.org_uid = $1`,
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch agreements" });
  }
});

app.patch(
  "/api/agreements/:id",
  authenticateJWT,
  sanitizeInput,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const uid = req.user.uid;
    if (!["active", "rejected", "cancelled"].includes(status))
      return res.status(400).json({ error: "Invalid status" });
    try {
      const result = await db.query("SELECT * FROM agreements WHERE id = $1", [
        id,
      ]);
      const agreement = result.rows[0];
      if (!agreement)
        return res.status(404).json({ error: "Agreement not found" });
      if (agreement.farmer_uid !== uid && agreement.org_uid !== uid)
        return res.status(403).json({ error: "Not authorized" });
      await db.query(
        "UPDATE agreements SET status = $1, updated_at = $2 WHERE id = $3",
        [status, Date.now(), id],
      );
      res.json({ id, status, message: "Agreement " + status });
    } catch (e) {
      res.status(500).json({ error: "Failed to update agreement" });
    }
  },
);

// ---- REQUESTS (Org posts needs) ----

app.post(
  "/api/requests",
  authenticateJWT,
  sanitizeInput,
  [
    body("title").isString().notEmpty(),
    body("description").isString().notEmpty(),
  ],
  validate,
  async (req, res) => {
    const { title, description, quantity, location } = req.body;
    const uid = req.user.uid;
    try {
      const userResult = await db.query(
        "SELECT display_name, profile FROM users WHERE uid = $1",
        [uid],
      );
      const userData = userResult.rows[0] || {};
      const displayName =
        userData.display_name ||
        (userData.profile ? userData.profile.businessName : "") ||
        "Unknown Organization";
      const requestId = uuidv4();
      const now = Date.now();
      await db.query(
        "INSERT INTO requests (id, uid, display_name, title, description, quantity, location, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          requestId,
          uid,
          displayName,
          title,
          description,
          quantity || "",
          location || "",
          "open",
          now,
        ],
      );
      const farmerResult = await db.query(
        "SELECT uid FROM users WHERE role = 'farmer'",
      );
      for (const row of farmerResult.rows) {
        sendNotification(
          row.uid,
          "New Request",
          displayName + ' posted: "' + title + '"',
          "info",
        );
      }
      res.status(201).json({
        id: requestId,
        uid,
        displayName,
        title,
        description,
        quantity: quantity || "",
        location: location || "",
        status: "open",
        createdAt: now,
      });
    } catch (e) {
      console.error("Request creation error:", e);
      res.status(500).json({ error: "Failed to create request" });
    }
  },
);

app.get("/api/requests", authenticateJWT, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.display_name AS display_name,
              (SELECT COUNT(*) FROM request_replies rr WHERE rr.request_id = r.id) AS reply_count
       FROM requests r
       LEFT JOIN users u ON r.uid = u.uid
       WHERE r.status = 'open'
       ORDER BY r.created_at DESC`,
    );
    const list = result.rows.map((r) => ({
      ...r,
      displayName: r.display_name || "Unknown",
    }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

app.delete("/api/requests/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const result = await db.query("SELECT * FROM requests WHERE id = $1", [id]);
    const reqData = result.rows[0];
    if (!reqData) return res.status(404).json({ error: "Request not found" });
    if (reqData.uid !== uid)
      return res.status(403).json({ error: "Not authorized" });
    await db.query("UPDATE requests SET status = 'closed' WHERE id = $1", [id]);
    res.json({ message: "Request closed" });
  } catch (e) {
    res.status(500).json({ error: "Failed to close request" });
  }
});

app.post(
  "/api/requests/:id/reply",
  authenticateJWT,
  sanitizeInput,
  [param("id").isString().notEmpty(), body("message").isString().notEmpty()],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;
    const uid = req.user.uid;
    try {
      const reqResult = await db.query(
        "SELECT * FROM requests WHERE id = $1 AND status = 'open'",
        [id],
      );
      const reqData = reqResult.rows[0];
      if (!reqData)
        return res.status(404).json({ error: "Request not found or closed" });
      const userResult = await db.query(
        "SELECT display_name FROM users WHERE uid = $1",
        [uid],
      );
      const userData = userResult.rows[0] || {};
      const replyId = uuidv4();
      const now = Date.now();
      await db.query(
        "INSERT INTO request_replies (id, request_id, uid, display_name, message, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [replyId, id, uid, userData.display_name || "Unknown", message, now],
      );
      sendNotification(
        reqData.uid,
        "New Reply",
        (userData.display_name || "A farmer") +
          ' replied to your request: "' +
          reqData.title +
          '"',
        "success",
      );
      res.status(201).json({
        id: replyId,
        request_id: id,
        uid,
        display_name: userData.display_name || "Unknown",
        message,
        created_at: now,
      });
    } catch (e) {
      console.error("Reply error:", e);
      res.status(500).json({ error: "Failed to reply" });
    }
  },
);

// ---- NOTIFICATIONS ----

app.get("/api/notifications", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      "SELECT * FROM notifications WHERE uid = $1 ORDER BY created_at DESC LIMIT 50",
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.post("/api/notifications/read", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    await db.query("UPDATE notifications SET read = true WHERE uid = $1", [
      uid,
    ]);
    res.json({ message: "All marked read" });
  } catch (e) {
    res.status(500).json({ error: "Failed to mark read" });
  }
});

app.post("/api/notifications/read/:id", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  const { id } = req.params;
  try {
    await db.query(
      "UPDATE notifications SET read = true WHERE uid = $1 AND id = $2",
      [uid, id],
    );
    res.json({ message: "Marked as read" });
  } catch (e) {
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// ---- CONTACT / SUPPORT ----

app.post(
  "/api/contact",
  sanitizeInput,
  [
    body("name").isString().notEmpty(),
    body("email").isEmail(),
    body("subject").isString().notEmpty(),
    body("message").isString().notEmpty(),
  ],
  validate,
  async (req, res) => {
    const { name, email, subject, message } = req.body;
    try {
      await db.query(
        "INSERT INTO contact_queries (name, email, subject, message, replied, created_at) VALUES ($1, $2, $3, $4, false, $5)",
        [name, email, subject, message, Date.now()],
      );
      res.json({ message: "Query submitted successfully" });
    } catch (e) {
      res.status(500).json({ error: "Failed to submit query" });
    }
  },
);

// ---- ADMIN ROUTES ----

app.get("/api/admin/stats", authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const [
      usersResult,
      listingsResult,
      ordersResult,
      agreementsResult,
      requestsResult,
      ledgerResult,
      payoutsResult,
    ] = await Promise.all([
      db.query("SELECT * FROM users"),
      db.query("SELECT * FROM listings"),
      db.query("SELECT * FROM orders"),
      db.query("SELECT * FROM agreements"),
      db.query("SELECT * FROM requests"),
      db.query(
        "SELECT COALESCE(SUM(amount), 0) AS total_deposits FROM ledger WHERE type = 'deposit'",
      ),
      db.query(
        "SELECT COALESCE(SUM(net_amount), 0) AS total_payouts FROM payouts WHERE status = 'approved'",
      ),
    ]);
    const users = usersResult.rows;
    const listings = listingsResult.rows;
    const orders = ordersResult.rows;
    const agreements = agreementsResult.rows;
    const requests = requestsResult.rows;
    const totalDeposits = parseFloat(ledgerResult.rows[0].total_deposits) || 0;
    const totalPayouts = parseFloat(payoutsResult.rows[0].total_payouts) || 0;
    const roleCounts = {};
    users.forEach((u) => {
      const r = u.role || "unknown";
      roleCounts[r] = (roleCounts[r] || 0) + 1;
    });
    res.json({
      totalUsers: users.length,
      totalListings: listings.length,
      totalOrders: orders.length,
      totalAgreements: agreements.length,
      activeRequests: requests.filter((r) => r.status === "open").length,
      roleCounts,
      pendingOrders: orders.filter((o) => o.status === "pending").length,
      activeAgreements: agreements.filter((a) => a.status === "active").length,
      systemBalance: totalDeposits - totalPayouts,
      totalDeposits,
      totalPayouts,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get(
  "/api/admin/analytics",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const [ordersResult, usersResult, feeResult, payoutsResult] = await Promise.all([
        db.query("SELECT * FROM orders"),
        db.query("SELECT * FROM users"),
        db.query("SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE type = 'fee' AND to_uid = 'platform'"),
        db.query("SELECT COALESCE(SUM(net_amount),0) AS total FROM payouts WHERE status = 'approved'"),
      ]);
      const orders = ordersResult.rows;
      const users = usersResult.rows;
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const weekStart = now - 6 * dayMs;

      // Build actual day labels (last 7 days, e.g. "Mon", "Tue"...)
      const dayLabels = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * dayMs);
        dayLabels.push(d.toLocaleDateString("en-US", { weekday: "short" }));
      }

      const revenueByDay = Array(7).fill(0);
      const ordersByDay = Array(7).fill(0);
      const signupsByDay = Array(7).fill(0);

      orders.forEach((o) => {
        const created = Number(o.created_at || 0);
        if (created >= weekStart && created <= now) {
          const dayIndex = Math.floor((created - weekStart) / dayMs);
          if (dayIndex >= 0 && dayIndex < 7) {
            ordersByDay[dayIndex]++;
            revenueByDay[dayIndex] += parseFloat(o.total_price || 0);
          }
        }
      });
      users.forEach((u) => {
        const created = Number(u.created_at || 0);
        if (created >= weekStart && created <= now) {
          const dayIndex = Math.floor((created - weekStart) / dayMs);
          if (dayIndex >= 0 && dayIndex < 7) {
            signupsByDay[dayIndex]++;
          }
        }
      });

      const totalFees = parseFloat(feeResult.rows[0].total) || 0;
      const totalPaidOut = parseFloat(payoutsResult.rows[0].total) || 0;
      const commissionBreakdown = {
        earned: parseFloat(totalFees.toFixed(2)),
        pending: parseFloat(Math.max(0, totalFees - totalPaidOut).toFixed(2)),
        withdrawn: parseFloat(Math.min(totalFees, totalPaidOut).toFixed(2)),
      };

      res.json({ revenueByDay, ordersByDay, signupsByDay, dayLabels, commissionBreakdown });
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  },
);

app.get("/api/admin/users", authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM users ORDER BY created_at DESC",
    );
    const list = result.rows.map((u) => ({
      uid: u.uid,
      displayName: u.display_name || u.email,
      email: u.email,
      role: u.role,
      provider: u.provider,
      profile: u.profile,
      photoURL: u.photo_url,
      phoneNumber: u.phone_number || "",
      createdAt: u.created_at,
      lastLogin: u.last_login_at,
      active: true,
    }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.patch(
  "/api/admin/users/:uid",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  [body("role").optional().isString()],
  validate,
  async (req, res) => {
    const { uid } = req.params;
    const { role } = req.body;
    try {
      if (role) {
        await db.query(
          "UPDATE users SET role = $1, updated_at = $2 WHERE uid = $3",
          [role, Date.now(), uid],
        );
      }
      res.json({ message: "User updated" });
    } catch (e) {
      res.status(500).json({ error: "Failed to update user" });
    }
  },
);

app.delete(
  "/api/admin/users/:uid",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    const { uid } = req.params;
    try {
      await db.query("DELETE FROM users WHERE uid = $1", [uid]);
      res.json({ message: "User deleted" });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete user" });
    }
  },
);

app.get(
  "/api/admin/orders",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const [ordersResult, escrowResult] = await Promise.all([
        db.query(
          `SELECT o.*, org.display_name AS org_name, farmer.display_name AS farmer_name
         FROM orders o
         LEFT JOIN users org ON o.org_uid = org.uid
         LEFT JOIN users farmer ON o.farmer_uid = farmer.uid`,
        ),
        db.query("SELECT * FROM escrow_orders"),
      ]);
      const orders = ordersResult.rows;
      const escrow = {};
      escrowResult.rows.forEach((e) => {
        escrow[e.id] = e;
      });
      const enriched = orders.map((o) => ({
        ...o,
        escrowDetails: escrow[o.id] || null,
      }));
      res.json(enriched);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  },
);

app.patch(
  "/api/admin/orders/:id",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      const now = Date.now();
      await db.query(
        "UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3",
        [status, now, id],
      );
      if (status) {
        await db.query(
          "UPDATE escrow_orders SET status = $1, updated_at = $2 WHERE id = $3",
          [status, now, id],
        );
      }
      res.json({ message: "Order " + (status || "updated") });
    } catch (e) {
      res.status(500).json({ error: "Failed to update order" });
    }
  },
);

app.get(
  "/api/admin/listings",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query("SELECT * FROM listings");
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch listings" });
    }
  },
);

app.patch(
  "/api/admin/listings/:id",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      await db.query(
        "UPDATE listings SET status = $1, updated_at = $2 WHERE id = $3",
        [status, Date.now(), id],
      );
      res.json({ message: "Listing " + status });
    } catch (e) {
      res.status(500).json({ error: "Failed to update listing" });
    }
  },
);

app.get(
  "/api/admin/payouts",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const [payoutsResult, usersResult] = await Promise.all([
        db.query("SELECT * FROM payouts"),
        db.query("SELECT uid, display_name, email FROM users"),
      ]);
      const users = {};
      usersResult.rows.forEach((u) => {
        users[u.uid] = u;
      });
      const list = payoutsResult.rows.map((p) => ({
        ...p,
        displayName: users[p.uid]?.display_name || p.uid,
        email: users[p.uid]?.email || "",
      }));
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch payouts" });
    }
  },
);

app.post(
  "/api/admin/payouts/:id/approve",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query("SELECT * FROM payouts WHERE id = $1", [
        id,
      ]);
      const payout = result.rows[0];
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status !== "pending")
        return res.status(400).json({ error: "Payout already processed" });
      if (payout.queued_for_manual) {
        try {
          const b2cResult = await b2cPayment(
            payout.phone_number,
            payout.net_amount || payout.amount,
            "AgriConnect payout " + payout.reference,
            "Payout",
          );
          await db.query(
            "UPDATE payouts SET b2c_result = $1, initiated_at = $2, queued_for_manual = false WHERE id = $3",
            [JSON.stringify(b2cResult), Date.now(), id],
          );
        } catch (b2cErr) {
          return res.status(400).json({
            error:
              "B2C failed: " + b2cErr.message + ". Please process manually.",
          });
        }
      }
      await db.query(
        "UPDATE payouts SET status = $1, approved_at = $2, approved_by = $3 WHERE id = $4",
        ["approved", Date.now(), req.user.uid, id],
      );
      sendNotification(
        payout.uid,
        "Withdrawal Approved",
        "Your withdrawal of KES " +
          payout.amount.toFixed(2) +
          " has been approved.",
        "success",
      );
      res.json({ message: "Payout approved" });
      io.emit("payoutUpdate", { action: "approved", id });
    } catch (e) {
      res.status(500).json({ error: "Failed to approve payout" });
    }
  },
);

app.post(
  "/api/admin/payouts/:id/reject",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query("SELECT * FROM payouts WHERE id = $1", [
        id,
      ]);
      const payout = result.rows[0];
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status !== "pending")
        return res.status(400).json({ error: "Payout already processed" });
      const { uid, amount, fee = 0 } = payout;
      const refundTotal = parseFloat(amount) + parseFloat(fee);
      await creditWallet(
        uid,
        WALLET_TYPES.WITHDRAWABLE,
        refundTotal,
        payout.reference,
        "Refund for rejected payout " + id,
      );
      await db.query(
        "UPDATE payouts SET status = $1, rejected_at = $2, rejected_by = $3 WHERE id = $4",
        ["rejected", Date.now(), req.user.uid, id],
      );
      sendNotification(
        uid,
        "Withdrawal Rejected",
        "KES " +
          refundTotal.toFixed(2) +
          " returned to your withdrawable wallet.",
        "error",
      );
      res.json({ message: "Payout rejected, funds returned" });
      io.emit("payoutUpdate", { action: "rejected", id });
    } catch (e) {
      res.status(500).json({ error: "Failed to reject payout" });
    }
  },
);

app.get("/api/payout/history", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const result = await db.query(
      "SELECT * FROM payouts WHERE uid = $1 ORDER BY created_at DESC",
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch payout history" });
  }
});

// ---- ADMIN: DISPUTES ----

app.get(
  "/api/admin/disputes",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const dResult = await db.query("SELECT * FROM disputes");
      const enriched = await Promise.all(
        dResult.rows.map(async (d) => {
          const oResult = await db.query(
            "SELECT * FROM escrow_orders WHERE id = $1",
            [d.order_id],
          );
          return { ...d, order: oResult.rows[0] || null };
        }),
      );
      res.json(
        enriched.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
      );
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch disputes" });
    }
  },
);

app.post(
  "/api/admin/disputes/:id/resolve",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  [
    param("id").isString().notEmpty(),
    body("resolutionType").isIn(["release_to_seller", "refund_buyer"]),
    body("resolution").optional().isString(),
  ],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const { resolutionType, resolution } = req.body;
    try {
      const result = await resolveDispute(
        id,
        req.user.uid,
        resolution || resolutionType,
        resolutionType,
      );
      res.json({ message: "Dispute resolved", ...result });
    } catch (e) {
      res.status(400).json({ error: e.message || "Failed to resolve dispute" });
    }
  },
);

// ---- ADMIN: WALLET MANAGEMENT ----

app.get(
  "/api/admin/wallets",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const usersResult = await db.query(
        "SELECT uid, display_name, email FROM users",
      );
      const users = {};
      usersResult.rows.forEach((u) => {
        users[u.uid] = u;
      });
      const allLedger = (await db.query("SELECT * FROM ledger")).rows;
      function calcBalance(uid, walletType) {
        let b = 0;
        allLedger.forEach((e) => {
          if (e.to_uid === uid && e.to_wallet === walletType)
            b += parseFloat(e.amount || 0);
          if (e.from_uid === uid && e.from_wallet === walletType)
            b -= parseFloat(e.amount || 0);
        });
        return parseFloat(b.toFixed(2));
      }
      const result = {};
      for (const uid of Object.keys(users)) {
        const wResult = await db.query(
          "SELECT status, balance, frozen_balance FROM wallets WHERE uid = $1 AND wallet_type = $2::wallet_type",
          [uid, WALLET_TYPES.ACTIVE],
        );
        result[uid] = {
          displayName: users[uid]?.display_name || uid,
          email: users[uid]?.email || "",
          activeBalance: calcBalance(uid, WALLET_TYPES.ACTIVE),
          storedBalance: parseFloat(wResult.rows[0]?.balance || 0),
          escrowBalance: calcBalance(uid, WALLET_TYPES.ESCROW),
          withdrawableBalance: calcBalance(uid, WALLET_TYPES.WITHDRAWABLE),
          status: wResult.rows[0]?.status || "unknown",
          frozenBalance: parseFloat(wResult.rows[0]?.frozen_balance || 0),
        };
      }
      res.json(result);
    } catch (e) {
      console.error("Admin wallets error:", e);
      res.status(500).json({ error: "Failed to fetch wallets" });
    }
  },
);

app.post(
  "/api/admin/wallet/:uid/freeze",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    const { uid } = req.params;
    try {
      const now = Date.now();
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
        [WALLET_STATUS.FROZEN, now, uid, WALLET_TYPES.ACTIVE],
      );
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
        [WALLET_STATUS.FROZEN, now, uid, WALLET_TYPES.WITHDRAWABLE],
      );
      sendNotification(
        uid,
        "Account Frozen",
        "Your account has been frozen. Incoming deposits are still accepted but withdrawals and transfers are blocked.",
        "error",
      );
      const adminResult = await db.query(
        "SELECT uid FROM users WHERE role = 'admin'",
      );
      for (const row of adminResult.rows) {
        if (row.uid !== req.user.uid)
          sendNotification(
            row.uid,
            "Account Frozen",
            uid + " account frozen by admin",
            "warning",
          );
      }
      res.json({
        message:
          "Wallet frozen. Outbound transactions blocked, inbound deposits still accepted.",
      });
    } catch (e) {
      res.status(500).json({ error: "Failed to freeze wallet" });
    }
  },
);

app.post(
  "/api/admin/wallet/unfreeze/:uid",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    const { uid } = req.params;
    try {
      const now = Date.now();
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
        [WALLET_STATUS.ACTIVE, now, uid, WALLET_TYPES.ACTIVE],
      );
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2 WHERE uid = $3 AND wallet_type = $4::wallet_type",
        [WALLET_STATUS.ACTIVE, now, uid, WALLET_TYPES.WITHDRAWABLE],
      );
      sendNotification(
        uid,
        "Account Unfrozen",
        "Your account has been unfrozen. All features are now available.",
        "success",
      );
      res.json({ message: "Wallet unfrozen" });
    } catch (e) {
      res.status(500).json({ error: "Failed to unfreeze wallet" });
    }
  },
);

app.get(
  "/api/admin/company-wallet",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      // Company wallet = Total money in all user wallets (platform's liability)
      // Increases: M-Pesa deposits (money coming into platform)  
      // Decreases: Approved payouts (money leaving platform)
      // No effect: Internal transfers (money just moves between users)
      
      const [mpesaDepositSum, approvedPayoutSum, userWalletsSum, recentTxs] = await Promise.all([
        // Total successful M-Pesa deposits (gross amounts before fees)
        db.query(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM mpesa_stk_requests WHERE status = 'success'"
        ),
        // Total approved payouts (net amounts paid out to users)  
        db.query(
          "SELECT COALESCE(SUM(net_amount), 0) AS total FROM payouts WHERE status = 'approved'"
        ),
        // Current total in all user wallets for verification
        db.query(
          "SELECT COALESCE(SUM(balance), 0) AS total FROM wallets"
        ),
        // Recent transactions affecting company wallet (M-Pesa deposits and payouts)
        db.query(`
          SELECT 'deposit' as type, amount, created_at, 
                 CONCAT('M-Pesa deposit - ', mpesa_receipt_number) as description
          FROM mpesa_stk_requests 
          WHERE status = 'success'
          UNION ALL
          SELECT 'payout' as type, net_amount as amount, approved_at as created_at,
                 CONCAT('Payout to ', phone_number) as description  
          FROM payouts
          WHERE status = 'approved'
          ORDER BY created_at DESC 
          LIMIT 50
        `),
      ]);
      
      const totalMpesaDeposits = parseFloat(mpesaDepositSum.rows[0].total) || 0;
      const totalApprovedPayouts = parseFloat(approvedPayoutSum.rows[0].total) || 0;
      const currentUserWallets = parseFloat(userWalletsSum.rows[0].total) || 0;
      
      // Company wallet balance = Money in - Money out
      const companyWalletBalance = totalMpesaDeposits - totalApprovedPayouts;
      
      const transactions = recentTxs.rows.map((t) => ({
        createdAt: t.created_at,
        description: t.description || (t.type === "deposit" ? "M-Pesa Deposit" : "Payout"),
        amount: t.type === "deposit" ? parseFloat(t.amount) : -parseFloat(t.amount),
      }));
      
      res.json({
        balance: companyWalletBalance,
        totalDeposited: totalMpesaDeposits,
        totalPaidOut: totalApprovedPayouts,
        currentUserWallets: currentUserWallets, // For verification/reconciliation
        transactions,
      });
    } catch (e) {
      console.error("[ADMIN] Company wallet fetch error:", e);
      res.status(500).json({ error: "Failed to fetch company wallet" });
    }
  },
);

app.get(
  "/api/admin/commission-wallet",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const [feeSum, commissionWithdrawals, feeTxs] = await Promise.all([
        // Total fees collected (commissions earned)
        db.query(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type = 'fee'",
        ),
        // Total commission withdrawals by admin
        db.query(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%'",
        ),
        // Recent transactions (fees earned and withdrawals)
        db.query(`
          SELECT amount, created_at, description, type,
                 CASE WHEN type = 'fee' THEN amount ELSE -amount END as display_amount
          FROM ledger 
          WHERE type = 'fee' OR (type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%')
          ORDER BY created_at DESC LIMIT 50
        `),
      ]);
      
      const totalFees = parseFloat(feeSum.rows[0].total) || 0;
      const totalWithdrawals = parseFloat(commissionWithdrawals.rows[0].total) || 0;
      const availableBalance = totalFees - totalWithdrawals;
      
      res.json({
        balance: availableBalance,
        totalEarned: totalFees,
        totalWithdrawn: totalWithdrawals,
        transactions: feeTxs.rows.map((t) => ({
          createdAt: t.created_at,
          description: t.description || (t.type === "fee" ? "Platform fee" : "Commission withdrawal"),
          amount: parseFloat(t.display_amount),
        })),
      });
    } catch (e) {
      console.error("[ADMIN] Commission wallet fetch error:", e);
      res.status(500).json({ error: "Failed to fetch commission wallet" });
    }
  },
);

// Admin commission withdrawal endpoint
app.post(
  "/api/admin/commission/withdraw",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  [
    body("amount").isFloat({ min: 10 }),
    body("method").isIn(['mpesa', 'bank']),
    body("phoneNumber").optional().isString(),
    body("bankCode").optional().isString(),
    body("accountNumber").optional().isString(), 
    body("accountName").optional().isString(),
  ],
  validate,
  async (req, res) => {
    const { amount, method, phoneNumber, bankCode, accountNumber, accountName } = req.body;
    
    try {
      const parsedAmount = parseAmount(amount);
      if (!parsedAmount || parsedAmount < 10) {
        return res.status(400).json({ error: "Minimum withdrawal is KES 10.00" });
      }

      // Check available commission balance
      const [feeSum, commissionWithdrawals] = await Promise.all([
        db.query("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type = 'fee'"),
        db.query("SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%'"),
      ]);
      
      const totalFees = parseFloat(feeSum.rows[0].total) || 0;
      const totalWithdrawals = parseFloat(commissionWithdrawals.rows[0].total) || 0;
      const availableBalance = totalFees - totalWithdrawals;
      
      if (availableBalance < parsedAmount) {
        return res.status(400).json({
          error: `Insufficient commission balance. Available: KES ${availableBalance.toFixed(2)}`
        });
      }

      const withdrawalId = uuidv4();
      const reference = `ADMIN-${Date.now()}`;
      
      if (method === 'mpesa') {
        if (!phoneNumber) {
          return res.status(400).json({ error: "Phone number required for M-Pesa withdrawal" });
        }
        
        // Record the commission withdrawal in ledger
        await createLedgerEntry({
          type: LEDGER_ENTRY_TYPE.WITHDRAWAL,
          amount: parsedAmount,
          fromUid: "platform",
          toUid: req.user.uid,
          reference: reference,
          description: `Admin commission withdrawal via M-Pesa to ${phoneNumber}`,
          relatedId: withdrawalId,
          metadata: { method: 'mpesa', phoneNumber }
        });

        // For M-Pesa withdrawals, we could integrate with M-Pesa B2C here
        // For now, just record as pending manual processing
        res.json({
          message: "Commission withdrawal request submitted for M-Pesa processing",
          reference,
          amount: parsedAmount,
          method: 'mpesa'
        });
        
      } else if (method === 'bank') {
        if (!bankCode || !accountNumber || !accountName) {
          return res.status(400).json({ error: "Bank details required for bank withdrawal" });
        }
        
        // Record the commission withdrawal in ledger
        await createLedgerEntry({
          type: LEDGER_ENTRY_TYPE.WITHDRAWAL,
          amount: parsedAmount,
          fromUid: "platform", 
          toUid: req.user.uid,
          reference: reference,
          description: `Admin commission withdrawal via bank transfer to ${accountName} (${accountNumber})`,
          relatedId: withdrawalId,
          metadata: { method: 'bank', bankCode, accountNumber, accountName }
        });

        res.json({
          message: "Commission withdrawal request submitted for bank transfer processing", 
          reference,
          amount: parsedAmount,
          method: 'bank'
        });
      }

    } catch (e) {
      console.error("[ADMIN] Commission withdrawal error:", e);
      res.status(500).json({ error: "Failed to process commission withdrawal" });
    }
  },
);

app.get(
  "/api/admin/frozen-wallets",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(`
      SELECT w.uid, u.display_name, u.email, w.balance, w.frozen_balance, w.updated_at AS frozen_at
      FROM wallets w
      JOIN users u ON w.uid = u.uid
      WHERE w.status = 'frozen' AND w.wallet_type = 'active'
      ORDER BY w.updated_at DESC
    `);
      res.json(
        result.rows.map((r) => ({
          uid: r.uid,
          displayName: r.display_name || r.email || r.uid,
          email: r.email || "",
          balance: parseFloat(r.balance) || 0,
          frozenAt: r.frozen_at,
        })),
      );
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch frozen wallets" });
    }
  },
);

app.get(
  "/api/admin/reconciliation",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(
        "SELECT * FROM reconciliation_log ORDER BY timestamp DESC LIMIT 30",
      );
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch reconciliation logs" });
    }
  },
);

app.post(
  "/api/admin/reconciliation/run",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await runReconciliation();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Reconciliation failed" });
    }
  },
);

app.get(
  "/api/admin/ledger",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(
        "SELECT * FROM ledger ORDER BY created_at DESC LIMIT 200",
      );
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch ledger" });
    }
  },
);

app.get(
  "/api/admin/finance",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const usersResult = await db.query("SELECT uid FROM users");
      const allLedger = (await db.query("SELECT * FROM ledger")).rows;
      function calcBalance(uid, walletType) {
        let b = 0;
        allLedger.forEach((e) => {
          if (e.to_uid === uid && e.to_wallet === walletType)
            b += parseFloat(e.amount || 0);
          if (e.from_uid === uid && e.from_wallet === walletType)
            b -= parseFloat(e.amount || 0);
        });
        return parseFloat(b.toFixed(2));
      }
      let totalActive = 0,
        totalEscrow = 0,
        totalWithdrawable = 0,
        totalFrozen = 0,
        frozenCount = 0;
      for (const row of usersResult.rows) {
        const uid = row.uid;
        totalActive += calcBalance(uid, WALLET_TYPES.ACTIVE);
        totalEscrow += calcBalance(uid, WALLET_TYPES.ESCROW);
        totalWithdrawable += calcBalance(uid, WALLET_TYPES.WITHDRAWABLE);
        const wResult = await db.query(
          "SELECT status, frozen_balance FROM wallets WHERE uid = $1 AND wallet_type = $2::wallet_type",
          [uid, WALLET_TYPES.ACTIVE],
        );
        if (wResult.rows[0]) {
          if (wResult.rows[0].frozen_balance)
            totalFrozen += parseFloat(wResult.rows[0].frozen_balance);
          if (wResult.rows[0].status === WALLET_STATUS.FROZEN) frozenCount++;
        }
      }
      const totalLedger = allLedger.reduce(
        (s, e) => s + parseFloat(e.amount || 0),
        0,
      );
      const recentResult = await db.query(
        "SELECT * FROM reconciliation_log ORDER BY timestamp DESC LIMIT 1",
      );
      const recentRecon = recentResult.rows[0] || null;

      // Commission: compute total fees collected minus commission withdrawals
      let totalCommission = 0;
      let totalCommissionWithdrawals = 0;
      allLedger.forEach((e) => {
        if (e.type === "fee") {
          totalCommission += parseFloat(e.amount || 0);
        }
        if (e.type === "withdrawal" && e.from_uid === "platform" && e.description && e.description.includes("commission withdrawal")) {
          totalCommissionWithdrawals += parseFloat(e.amount || 0);
        }
      });
      const availableCommissionBalance = totalCommission - totalCommissionWithdrawals;
      // Company wallet balance
      const companyWalletResult = await db.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE to_uid = $1 AND to_wallet = $2::wallet_type",
        ["platform", WALLET_TYPES.ACTIVE],
      );
      const companyFromResult = await db.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE from_uid = $1 AND from_wallet = $2::wallet_type",
        ["platform", WALLET_TYPES.ACTIVE],
      );
      const companyWalletBalance =
        parseFloat(companyWalletResult.rows[0].total) -
        parseFloat(companyFromResult.rows[0].total);
      // Deposit/withdrawal counts
      const depCountRes = await db.query(
        "SELECT COUNT(*) AS c FROM ledger WHERE type = 'deposit'",
      );
      const wdCountRes = await db.query(
        "SELECT COUNT(*) AS c FROM ledger WHERE type = 'withdrawal'",
      );
      const depositCount = parseInt(depCountRes.rows[0].c) || 0;
      const withdrawalCount = parseInt(wdCountRes.rows[0].c) || 0;
      // Total deposited / withdrawn from ledger
      const depTotalRes = await db.query(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM ledger WHERE type = 'deposit'",
      );
      const wdTotalRes = await db.query(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM ledger WHERE type = 'withdrawal'",
      );
      const totalDeposited = parseFloat(depTotalRes.rows[0].t);
      const totalWithdrawn = parseFloat(wdTotalRes.rows[0].t);

      res.json({
        totalActive: parseFloat(totalActive.toFixed(2)),
        totalEscrow: parseFloat(totalEscrow.toFixed(2)),
        totalWithdrawable: parseFloat(totalWithdrawable.toFixed(2)),
        totalInSystem: parseFloat(
          (totalActive + totalEscrow + totalWithdrawable).toFixed(2),
        ),
        totalFrozen: parseFloat(totalFrozen.toFixed(2)),
        frozenAccounts: frozenCount,
        ledgerTotal: parseFloat(totalLedger.toFixed(2)),
        activeUsers: usersResult.rows.length,
        lastReconciliation: recentRecon,
        // Fields expected by admin.html finance section
        totalCommission: parseFloat(totalCommission.toFixed(2)),
        totalWithdrawn: totalCommissionWithdrawals,
        pendingClearance: 0,
        commissionBalance: parseFloat(availableCommissionBalance.toFixed(2)),
        depositCount,
        totalDeposited,
        withdrawalCount,
        companyWalletBalance: parseFloat(companyWalletBalance.toFixed(2)),
        frozenWallets: frozenCount,
      });
    } catch (e) {
      console.error("[FINANCE] error:", e);
      res.status(500).json({ error: "Failed to fetch finance data" });
    }
  },
);

app.get(
  "/api/admin/support",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(
        "SELECT * FROM contact_queries ORDER BY created_at DESC",
      );
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch queries" });
    }
  },
);

app.post(
  "/api/admin/support/:id/reply",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  async (req, res) => {
    const { id } = req.params;
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: "Reply is required" });
    try {
      const result = await db.query(
        "SELECT * FROM contact_queries WHERE id = $1",
        [id],
      );
      const query = result.rows[0];
      if (!query) return res.status(404).json({ error: "Query not found" });
      await db.query(
        "UPDATE contact_queries SET reply = $1, replied = true, replied_at = $2 WHERE id = $3",
        [reply, Date.now(), id],
      );
      try {
        await sendEmail(
          query.email,
          "Re: " + query.subject + " - AgriConnect Support",
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f9fafb;border-radius:8px;">' +
            '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #16a34a;"><h1 style="color:#16a34a;margin:0;font-size:24px;">AgriConnect</h1></div>' +
            '<div style="padding:20px 0;">' +
            '<p style="color:#374151;font-size:16px;line-height:1.6;">Hi <strong>' +
            query.name +
            "</strong>,</p>" +
            '<p style="color:#374151;font-size:16px;line-height:1.6;">We have received your query and our support team has responded:</p>' +
            '<div style="background:#ffffff;border-radius:8px;padding:20px;margin:16px 0;border:1px solid #e5e7eb;">' +
            '<p style="color:#374151;font-size:16px;line-height:1.6;">' +
            reply.replace(/\n/g, "<br>") +
            "</p></div>" +
            '<p style="color:#6b7280;font-size:14px;">Your original message:</p>' +
            '<blockquote style="border-left:3px solid #d1d5db;margin:8px 0;padding:8px 16px;color:#6b7280;font-size:14px;line-height:1.5;">' +
            "<strong>" +
            query.subject +
            "</strong><br>" +
            (query.message || "").replace(/\n/g, "<br>") +
            "</blockquote>" +
            '<p style="color:#374151;font-size:16px;line-height:1.6;">Best regards,<br><strong>AgriConnect Support Team</strong></p></div>' +
            '<div style="text-align:center;padding:16px 0;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">' +
            "<p>&copy; " +
            new Date().getFullYear() +
            " AgriConnect. All rights reserved.</p></div></div>",
        );
        res.json({ message: "Reply sent and emailed successfully" });
      } catch (emailErr) {
        res.json({
          message: "Reply saved but email failed to send",
          emailError: emailErr.message,
        });
      }
    } catch (e) {
      res.status(500).json({ error: "Failed to reply" });
    }
  },
);

app.post(
  "/api/admin/notifications",
  authenticateJWT,
  requireAdmin,
  sanitizeInput,
  async (req, res) => {
    const { title, body, type, targetRole } = req.body;
    if (!title || !body)
      return res.status(400).json({ error: "Title and body required" });
    try {
      let query = "SELECT uid, role FROM users";
      const params = [];
      if (targetRole) {
        query += " WHERE role = $1";
        params.push(targetRole);
      }
      const usersResult = await db.query(query, params);
      const now = Date.now();
      let count = 0;
      for (const row of usersResult.rows) {
        await db.query(
          "INSERT INTO notifications (uid, title, body, type, read, created_at) VALUES ($1, $2, $3, $4, false, $5)",
          [row.uid, title, body, type || "info", now],
        );
        io.to(row.uid).emit("notification", {
          title,
          body,
          type: type || "info",
        });
        count++;
      }
      res.json({ message: "Notification sent to " + count + " users" });
    } catch (e) {
      res.status(500).json({ error: "Failed to send notification" });
    }
  },
);

// ---- M-PESA ADMIN ----

app.post(
  "/api/admin/mpesa/register-urls",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await registerC2BUrls();
      res.json({ message: "C2B URLs registered", result });
    } catch (e) {
      res.status(500).json({ error: "Failed to register C2B URLs" });
    }
  },
);

app.get(
  "/api/admin/mpesa/stk-requests",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await db.query(
        "SELECT * FROM mpesa_stk_requests ORDER BY created_at DESC",
      );
      res.json(result.rows);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch STK requests" });
    }
  },
);

// ---------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// SCHEDULED JOBS
// ---------------------------------------------------------------------------

const CLUSTER_WORKERS = (() => {
  const v = process.env.CLUSTER_WORKERS;
  if (!v || v === "0") return 0;
  if (v === "auto") return os.cpus().length;
  const n = parseInt(v, 10);
  return n > 0 ? n : 0;
})();

const IS_CLUSTER_MASTER = cluster.isMaster && CLUSTER_WORKERS > 0;
const SHOULD_RUN_CRON =
  CLUSTER_WORKERS === 0 || (cluster.isWorker && cluster.worker.id === 1);
const SHOULD_RUN_SERVER = CLUSTER_WORKERS === 0 || cluster.isWorker;

if (IS_CLUSTER_MASTER) {
  console.log(
    "[CLUSTER] Master starting " +
      CLUSTER_WORKERS +
      " workers on " +
      os.cpus().length +
      " CPUs",
  );
  for (let i = 0; i < CLUSTER_WORKERS; i++) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    console.warn(
      "[CLUSTER] Worker " +
        worker.process.pid +
        " died (code=" +
        code +
        " signal=" +
        signal +
        "). Restarting...",
    );
    cluster.fork();
  });
} else {
  if (SHOULD_RUN_CRON) {
    cron.schedule("0 6 * * *", async () => {
      console.log("[CRON] Running daily reconciliation...");
      await runReconciliation();
    });

    cron.schedule("0 */6 * * *", async () => {
      console.log("[CRON] Checking expired escrow orders...");
      try {
        const result = await db.query("SELECT * FROM escrow_orders");
        const now = Date.now();
        for (const order of result.rows) {
          // Handle expired escrow orders (72 hours since creation)
          if (
            order.status === ORDER_STATUS.IN_ESCROW &&
            now > order.escrow_expires_at &&
            !order.dispute_opened
          ) {
            console.log(
              "[CRON] Escrow order " +
                order.id +
                " expired. Processing auto-refund...",
            );
            try {
              await cancelEscrow(order.id);
              sendNotification(
                order.buyer_uid,
                "Escrow Expired",
                "Order " +
                  order.id +
                  " escrow expired. KES " +
                  order.amount +
                  " returned to your active wallet.",
                "info",
              );
              sendNotification(
                order.seller_uid,
                "Escrow Expired",
                "Order " +
                  order.id +
                  " escrow expired. Funds returned to buyer.",
                "info",
              );
            } catch (e) {
              console.error(
                "[CRON] Failed to process expired escrow " + order.id + ":",
                e.message,
              );
            }
          }
          
          // Handle dispatched orders where buyer hasn't responded (24 hours since dispatch)
          if (
            order.status === ORDER_STATUS.DISPATCHED &&
            order.otp_expires_at &&
            now > order.otp_expires_at &&
            !order.dispute_opened
          ) {
            console.log(
              "[CRON] Dispatched order " +
                order.id +
                " buyer response expired. Creating auto-dispute for review...",
            );
            try {
              // Create dispute for admin review since buyer didn't respond
              await raiseDispute(
                order.id,
                order.buyer_uid,
                "Buyer did not respond within 24 hours of dispatch notification. Requires admin review.",
                []
              );
              
              sendNotification(
                order.buyer_uid,
                "Order Dispute - Response Timeout",
                "You did not verify or reject order " +
                  order.id +
                  " within 24 hours. A dispute has been created for admin review.",
                "warning",
              );
              sendNotification(
                order.seller_uid,
                "Order Dispute - Buyer Timeout",
                "Buyer did not respond to order " +
                  order.id +
                  " dispatch within 24 hours. A dispute has been created for review.",
                "info",
              );
            } catch (e) {
              console.error(
                "[CRON] Failed to create auto-dispute for order " + order.id + ":",
                e.message,
              );
            }
          }
        }
      } catch (e) {
        console.error("[CRON] Escrow expiry check error:", e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // STARTUP MIGRATION: AI chat persistence tables
  // ---------------------------------------------------------------------------

  async function migrateAiChatTables() {
    try {
      // Sessions table
      await db.query(`
        CREATE TABLE IF NOT EXISTS ai_chat_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
          title VARCHAR(255) DEFAULT 'New chat',
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_uid ON ai_chat_sessions(uid)
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated ON ai_chat_sessions(uid, updated_at DESC)
      `);

      // Messages table — image_data stores base64 for Gemini history replay
      await db.query(`
        CREATE TABLE IF NOT EXISTS ai_chat_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
          role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'bot')),
          content TEXT,
          image_data TEXT,
          image_mime VARCHAR(50),
          has_image BOOLEAN DEFAULT FALSE,
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_chat_messages(session_id, created_at ASC)
      `);

      console.log("[MIGRATION] AI chat tables ready");
    } catch (e) {
      console.error("[MIGRATION] AI chat tables error (non-fatal):", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // STARTUP MIGRATION: backfill wallet balance column from ledger
  // ---------------------------------------------------------------------------

  async function backfillWalletBalances() {
    try {
      const result = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='wallets' AND column_name='balance'",
      );
      if (result.rows.length === 0) return;
      const wallets = await db.query(
        "SELECT uid, wallet_type FROM wallets WHERE balance = 0",
      );
      if (wallets.rows.length === 0) return;
      const allLedger = (await db.query("SELECT * FROM ledger")).rows;
      let updated = 0;
      for (const w of wallets.rows) {
        let b = 0;
        for (const e of allLedger) {
          if (e.to_uid === w.uid && e.to_wallet === w.wallet_type)
            b += parseFloat(e.amount || 0);
          if (e.from_uid === w.uid && e.from_wallet === w.wallet_type)
            b -= parseFloat(e.amount || 0);
        }
        b = parseFloat(b.toFixed(2));
        if (b !== 0) {
          await db.query(
            "UPDATE wallets SET balance = $1 WHERE uid = $2 AND wallet_type = $3::wallet_type",
            [b, w.uid, w.wallet_type],
          );
          updated++;
        }
      }
      if (updated > 0)
        console.log(
          "[MIGRATION] Backfilled balance for " +
            updated +
            " wallets from ledger",
        );
    } catch (e) {
      console.error("[MIGRATION] Backfill error (non-fatal):", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // STARTUP MIGRATION: add delivery_instructions column and new status values
  // ---------------------------------------------------------------------------

  async function migrateFarmerDelivery() {
    try {
      const existing = await db.query(
        "SELECT unnest(enum_range(NULL::order_status))::text AS val",
      );
      const values = existing.rows.map((r) => r.val);
      if (!values.includes("processing")) {
        await db.query("ALTER TYPE order_status ADD VALUE 'processing'");
        console.log("[MIGRATION] Added order_status value: processing");
      }
      if (!values.includes("delivering")) {
        await db.query("ALTER TYPE order_status ADD VALUE 'delivering'");
        console.log("[MIGRATION] Added order_status value: delivering");
      }
      if (!values.includes("delivered")) {
        await db.query("ALTER TYPE order_status ADD VALUE 'delivered'");
        console.log("[MIGRATION] Added order_status value: delivered");
      }
    } catch (e) {
      console.error("[MIGRATION] Enum migration error:", e.message);
    }
    try {
      const colCheck = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='escrow_orders' AND column_name='delivery_instructions'",
      );
      if (colCheck.rows.length === 0) {
        await db.query(
          "ALTER TABLE escrow_orders ADD COLUMN delivery_instructions TEXT",
        );
        await db.query(
          "ALTER TABLE escrow_orders ADD COLUMN delivered_at BIGINT",
        );
        console.log(
          "[MIGRATION] Added delivery_instructions and delivered_at columns",
        );
      }
    } catch (e) {
      console.error("[MIGRATION] Column add error (non-fatal):", e.message);
    }
    try {
      const constraintCheck = await db.query(
        `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name='wallet_ids' AND constraint_type='UNIQUE' AND constraint_name='wallet_ids_uid_key'`,
      );
      if (constraintCheck.rows.length === 0) {
        await db.query(
          "DELETE FROM wallet_ids w1 USING wallet_ids w2 WHERE w1.ctid < w2.ctid AND w1.uid = w2.uid",
        );
        await db.query("ALTER TABLE wallet_ids ADD UNIQUE (uid)");
        console.log("[MIGRATION] Added UNIQUE constraint on wallet_ids.uid");
      }
    } catch (e) {
      console.error(
        "[MIGRATION] Wallet ID unique constraint error:",
        e.message,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // REAL-TIME POLLING ENGINE
  // ---------------------------------------------------------------------------

  let _pollTimestamps = {
    wallets: Date.now(),
    orders: Date.now(),
    transactions: Date.now(),
    listings: Date.now(),
    agreements: Date.now(),
  };

  let _pollStarted = false;

  function startRealtimePolling(ioInstance) {
    if (_pollStarted) return;
    _pollStarted = true;
    console.log("[POLL] Real-time polling engine started (1s interval)");
    setInterval(async () => {
      const now = Date.now();

      // 1. wallets - detect balance/status changes
      try {
        const result = await db.query(
          "SELECT DISTINCT uid FROM wallets WHERE updated_at >= $1 AND updated_at <= $2",
          [_pollTimestamps.wallets, now],
        );
        for (const row of result.rows) {
          ioInstance.to(row.uid).emit("walletUpdate");
        }
      } catch (e) {
        if (_pollTimestamps.wallets > 0)
          console.error("[POLL] wallets error:", e.message);
      }
      _pollTimestamps.wallets = now;

      // 2. escrow_orders - detect order/delivery status changes
      try {
        const result = await db.query(
          "SELECT DISTINCT buyer_uid, seller_uid FROM escrow_orders WHERE updated_at >= $1 AND updated_at <= $2",
          [_pollTimestamps.orders, now],
        );
        const notified = new Set();
        for (const row of result.rows) {
          if (!notified.has(row.buyer_uid)) {
            ioInstance.to(row.buyer_uid).emit("orderUpdate");
            notified.add(row.buyer_uid);
          }
          if (!notified.has(row.seller_uid)) {
            ioInstance.to(row.seller_uid).emit("orderUpdate");
            notified.add(row.seller_uid);
          }
        }
      } catch (e) {
        if (_pollTimestamps.orders > 0)
          console.error("[POLL] orders error:", e.message);
      }
      _pollTimestamps.orders = now;

      // 3. transactions - detect new transactions
      try {
        const result = await db.query(
          "SELECT DISTINCT uid FROM transactions WHERE created_at >= $1 AND created_at <= $2",
          [_pollTimestamps.transactions, now],
        );
        for (const row of result.rows) {
          ioInstance.to(row.uid).emit("walletUpdate");
        }
      } catch (e) {
        if (_pollTimestamps.transactions > 0)
          console.error("[POLL] transactions error:", e.message);
      }
      _pollTimestamps.transactions = now;

      // 4. listings - detect new/changed products
      try {
        const result = await db.query(
          "SELECT COUNT(*) AS cnt FROM listings WHERE (created_at >= $1 AND created_at <= $2) OR (updated_at IS NOT NULL AND updated_at >= $1 AND updated_at <= $2)",
          [_pollTimestamps.listings, now],
        );
        if (parseInt(result.rows[0].cnt) > 0) {
          ioInstance.emit("productUpdate");
        }
      } catch (e) {
        if (_pollTimestamps.listings > 0)
          console.error("[POLL] listings error:", e.message);
      }
      _pollTimestamps.listings = now;

      // 5. agreements - detect new/changed agreements
      try {
        const result = await db.query(
          "SELECT DISTINCT farmer_uid, org_uid FROM agreements WHERE updated_at >= $1 AND updated_at <= $2",
          [_pollTimestamps.agreements, now],
        );
        const notifiedAgreements = new Set();
        for (const row of result.rows) {
          if (!notifiedAgreements.has(row.farmer_uid)) {
            ioInstance.to(row.farmer_uid).emit("agreementUpdate");
            notifiedAgreements.add(row.farmer_uid);
          }
          if (!notifiedAgreements.has(row.org_uid)) {
            ioInstance.to(row.org_uid).emit("agreementUpdate");
            notifiedAgreements.add(row.org_uid);
          }
        }
      } catch (e) {
        if (_pollTimestamps.agreements > 0)
          console.error("[POLL] agreements error:", e.message);
      }
      _pollTimestamps.agreements = now;
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // START SERVER
  // ---------------------------------------------------------------------------

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, async () => {
    console.log(
      "Worker " +
        (cluster.isWorker ? cluster.worker.id : "single") +
        " running on port " +
        PORT,
    );
    console.log("Environment: " + (process.env.NODE_ENV || "development"));
    console.log("M-Pesa Environment: " + MPESA.ENVIRONMENT);
    try {
      await migrateFarmerDelivery();
    } catch (e) {
      console.error("[MIGRATION] Error:", e.message);
    }
    await backfillWalletBalances();
    try {
      await migrateAiChatTables();
    } catch (e) {
      console.error("[MIGRATION] AI tables error:", e.message);
    }
    if (!process.env.CORS_ORIGIN && process.env.NODE_ENV === "production") {
      console.warn(
        "[SECURITY] CORS_ORIGIN not set — cross-origin requests will be blocked. Set CORS_ORIGIN in .env to allow specific origins.",
      );
    }
    if (MPESA.ENVIRONMENT === "production" && MPESA.CONSUMER_KEY) {
      registerC2BUrls();
    }
    if (SHOULD_RUN_CRON) {
      startRealtimePolling(io);
    }
  });
}

module.exports = app;
