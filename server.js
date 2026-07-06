const express = require("express");
const http = require("http");
const cluster = require("cluster");
const os = require("os");
const fs = require("fs");
const path = require("path");
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
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
require("dotenv").config();

// ── Receipts / Invoices storage folder ──────────────────────────────────────
const RECEIPTS_DIR = path.join(__dirname, "receipts");
if (!fs.existsSync(RECEIPTS_DIR)) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  console.log("[RECEIPTS] Created storage folder:", RECEIPTS_DIR);
}

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
const { generateReceiptPDF, generateInvoicePDF } = require("./receipt-generator");
const { findReconciliationCulprits: _findCulpritsModule } = require("./reconciliation-engine");

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
    "https://*.googleusercontent.com",
    "https://lh3.googleusercontent.com",
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
// Increased limit for image uploads (base64 encoded images can be large)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

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

async function sendEmail(to, subject, html, attachments) {
  if (!emailTransporter) {
    console.log(
      "[EMAIL] Skipped (no SMTP configured) - would send to",
      to,
      "subject:",
      subject,
    );
    return;
  }
  const mailOptions = {
    from:
      '"AgriConnect" <' +
      (process.env.SMTP_FROM || process.env.SMTP_USER) +
      ">",
    to,
    subject,
    html,
  };
  // attachments: array of { filename, content (Buffer), contentType }
  if (attachments && attachments.length > 0) {
    mailOptions.attachments = attachments.map(a => ({
      filename:    a.filename,
      content:     a.content,
      contentType: a.contentType || "application/pdf",
      contentDisposition: "attachment",
    }));
  }
  await emailTransporter.sendMail(mailOptions);
  console.log("[EMAIL] Sent:", subject, "->", to, attachments ? `(${attachments.length} attachment(s))` : "");
}

// ---------------------------------------------------------------------------
// CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const WALLET_STATUS = Object.freeze({
  ACTIVE: "active",
  FROZEN: "frozen",
  SUSPENDED: "suspended",
});

// Risk restriction levels — ordered severity low → high
const WALLET_RESTRICTION = Object.freeze({
  NONE:                "none",
  MONITOR:             "monitor",
  RESTRICT_WITHDRAWALS:"restrict_withdrawals",
  FREEZE:              "freeze",
});

// Risk scoring thresholds
const RISK_THRESHOLDS = Object.freeze({
  MONITOR:              30,   // 30–59   → monitor only
  RESTRICT_WITHDRAWALS: 60,   // 60–99   → block outgoing
  FREEZE:               100,  // 100+    → full freeze
  AUTO_RESOLVE_MAX:     5,    // KES ≤ 5 and score < 30 → auto-resolve
});

// Points per anomaly category
const RISK_POINTS = Object.freeze({
  unmatched_deposit:       30,
  orphaned_ledger:         40,
  wallet_drift_medium:     50,   // drift KES 1,000–9,999
  wallet_drift_high:       80,   // drift ≥ KES 10,000
  duplicate_reference:     60,
  stuck_escrow:            20,
  recon_gap_large:        100,   // overall gap > 5% of expected
  repeat_anomaly:          20,   // bonus per recurring day
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

/**
 * Compute balance from ledger for a given uid and wallet type
 * Uses a single efficient SQL query with CASE statements
 */
async function computeBalance(uid, walletType) {
  if (!walletType) walletType = WALLET_TYPES.ACTIVE;
  const result = await db.query(
    "SELECT COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = $2::wallet_type THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = $2::wallet_type THEN amount ELSE 0 END), 0) AS balance FROM ledger",
    [uid, walletType],
  );
  return parseFloat(parseFloat(result.rows[0].balance).toFixed(2));
}

/**
 * Compute multiple balances in a single query
 * Eliminates the need for parallel computeBalance calls
 */
async function computeMultipleBalances(uid, walletTypes) {
  const result = await db.query(
    `SELECT
      COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'active' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'active' THEN amount ELSE 0 END), 0) AS active_balance,
      COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'escrow' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'escrow' THEN amount ELSE 0 END), 0) AS escrow_balance,
      COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'withdrawable' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'withdrawable' THEN amount ELSE 0 END), 0) AS withdrawable_balance
     FROM ledger`,
    [uid],
  );

  const row = result.rows[0];
  return {
    active: parseFloat(parseFloat(row.active_balance).toFixed(2)),
    escrow: parseFloat(parseFloat(row.escrow_balance).toFixed(2)),
    withdrawable: parseFloat(parseFloat(row.withdrawable_balance).toFixed(2)),
  };
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

function buildProfileObj(row) {
  if (!row) return {};
  const p = {
    businessName: row.business_name || "",
    category: row.category || "",
    manufacture: row.manufacture || "",
    produce: row.produce || "",
    location: row.location || "",
    imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
    bio: row.bio || "",
  };
  return p;
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
    const wallet = await getWalletState(uid, walletType);
    if (!wallet) return next();

    // Full freeze blocks everything outgoing
    if (wallet.status === WALLET_STATUS.FROZEN || wallet.status === WALLET_STATUS.SUSPENDED) {
      return res.status(403).json({
        error: "Your account has been frozen. Outbound transactions are blocked. Contact support.",
        code: "WALLET_FROZEN",
      });
    }

    // Risk-based restriction: block withdrawals and transfers, allow deposits
    const riskRes = await db.query(
      "SELECT restriction FROM wallet_risk_scores WHERE uid = $1 AND wallet_type = $2",
      [uid, walletType],
    ).catch(() => ({ rows: [] }));
    const restriction = riskRes.rows[0]?.restriction || WALLET_RESTRICTION.NONE;

    if (restriction === WALLET_RESTRICTION.RESTRICT_WITHDRAWALS || restriction === WALLET_RESTRICTION.FREEZE) {
      // Deposits are always allowed — only block outgoing
      const outboundTypes = [WALLET_TYPES.ACTIVE, WALLET_TYPES.WITHDRAWABLE];
      if (outboundTypes.includes(walletType)) {
        const path = req.path.toLowerCase();
        const isDeposit = path.includes("stkpush") || path.includes("deposit");
        if (!isDeposit) {
          const msg = restriction === WALLET_RESTRICTION.FREEZE
            ? "Your wallet is frozen due to a reconciliation anomaly. Withdrawals and transfers are blocked."
            : "Outgoing transactions are restricted pending reconciliation. Withdrawals temporarily blocked.";
          return res.status(403).json({ error: msg, code: "WALLET_RESTRICTED", restriction });
        }
      }
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

  // Consolidated balance computation - single query for both users
  const balancesResult = await db.query(
    `SELECT
      COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = $2::wallet_type THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = $2::wallet_type THEN amount ELSE 0 END), 0) AS from_balance,
      COALESCE(SUM(CASE WHEN to_uid = $3 AND to_wallet = $4::wallet_type THEN amount ELSE 0 END - CASE WHEN from_uid = $3 AND from_wallet = $4::wallet_type THEN amount ELSE 0 END), 0) AS to_balance
    FROM ledger`,
    [fromUid, fromWalletType, toUid, toWalletType],
  );

  const newFromBalance = parseFloat(
    parseFloat(balancesResult.rows[0].from_balance).toFixed(2),
  );
  const newToBalance = parseFloat(
    parseFloat(balancesResult.rows[0].to_balance).toFixed(2),
  );

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

/**
 * b2cPayment — Initiate a Safaricom B2C PaymentRequest.
 *
 * @param {string} phoneNumber - Recipient phone (any common format, normalised internally).
 * @param {number} amount      - Amount in KES (integer, min 10).
 * @param {string} remarks     - Short description echoed in the callback (≤100 chars).
 * @param {string} payoutId    - Our internal payout UUID — passed as Occasion so Safaricom
 *                               echoes it back in ReferenceData, letting the B2C result
 *                               callback match the payment to our payout record.
 * @returns {object}           - Raw Safaricom API response (contains ConversationID etc.)
 */
async function b2cPayment(phoneNumber, amount, remarks, payoutId) {
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
    Remarks: (remarks || "AgriConnect Payout").substring(0, 100),
    QueueTimeOutURL: MPESA.CALLBACK_BASE + "/api/mpesa/b2c/timeout",
    ResultURL: MPESA.CALLBACK_BASE + "/api/mpesa/b2c/result",
    // Occasion is echoed back verbatim in ReferenceData.ReferenceItem — we put our
    // internal payout UUID here so the B2C result callback can find the right record.
    Occasion: payoutId || "unknown",
  };
  const response = await axios.post(MPESA.B2C_URL, payload, {
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  if (!response.data || response.data.ResponseCode !== "0") {
    throw new Error(
      "B2C API rejected the request: " +
        (response.data?.ResponseDescription || JSON.stringify(response.data)),
    );
  }
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
  deliveryInstructions,
  quantityText,
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
    "INSERT INTO escrow_orders (id, buyer_uid, seller_uid, listing_id, quantity, amount, status, otp_hash, otp_expires_at, escrow_expires_at, reference, dispute_opened, dispute_resolved, delivery_instructions, quantity_text, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::order_status, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
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
      deliveryInstructions || null,
      quantityText || null,
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

  // Fetch listing title for the email
  let listingTitle = "Product";
  if (listingId) {
    try {
      const listingResult = await db.query(
        "SELECT title FROM listings WHERE id = $1",
        [listingId],
      );
      listingTitle = listingResult.rows[0]?.title || "Product";
    } catch (e) { /* non-fatal */ }
  }

  if (buyerData.email) {
    sendEmail(
      buyerData.email,
      "✅ Order Confirmed — Payment Secured in Escrow",
      orderEmail(
        buyerData.display_name || "Buyer",
        orderId,
        ORDER_STATUS.IN_ESCROW,
        listingTitle,
        amount,
        "buyer",
      ),
    );
  }
  if (sellerData.email) {
    sendEmail(
      sellerData.email,
      "🛒 New Order Received — Payment Secured in Escrow",
      orderEmail(
        sellerData.display_name || "Seller",
        orderId,
        ORDER_STATUS.IN_ESCROW,
        listingTitle,
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
      "Order must be dispatched before verification. Current status: " +
        order.status,
    );
  }

  if (Date.now() > order.otp_expires_at) {
    throw new Error(
      "OTP has expired. Please contact support or raise a dispute.",
    );
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

  // ── Fetch all parties for receipt/invoice ──────────────────────────────
  const sellerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [order.seller_uid],
  );
  const buyerResult = await db.query(
    "SELECT email, display_name FROM users WHERE uid = $1",
    [order.buyer_uid],
  );
  const sellerData = sellerResult.rows[0] || {};
  const buyerData  = buyerResult.rows[0]  || {};

  // Fetch listing for product title + image
  let productTitle = "Product";
  let productImage = null;
  if (order.listing_id) {
    try {
      const listingRes = await db.query(
        "SELECT title, images FROM listings WHERE id = $1",
        [order.listing_id],
      );
      const listing = listingRes.rows[0];
      if (listing) {
        productTitle = listing.title || "Product";
        // images may be a JSON array of base64 strings
        const imgs = Array.isArray(listing.images) ? listing.images : (listing.images ? JSON.parse(listing.images) : []);
        productImage = imgs[0] || null;
      }
    } catch (e) { /* non-fatal */ }
  }

  const pdfData = {
    orderId,
    reference:            order.reference || "—",
    completedAt:          now,
    createdAt:            Number(order.created_at) || now,
    buyerName:            buyerData.display_name  || "Buyer",
    buyerEmail:           buyerData.email         || "",
    sellerName:           sellerData.display_name || "Seller",
    sellerEmail:          sellerData.email        || "",
    productTitle,
    productImage,
    quantity:             parseInt(order.quantity) || 1,
    unitPrice:            parseFloat((amt / (parseInt(order.quantity) || 1)).toFixed(2)),
    totalAmount:          amt,
    fee,
    netAmount,
    deliveryInstructions: order.delivery_instructions || null,
  };

  // Generate PDFs — save to disk, record in DB, attach to emails
  try {
    const [receiptBuf, invoiceBuf] = await Promise.all([
      generateReceiptPDF(pdfData),
      generateInvoicePDF(pdfData),
    ]);
    const shortId = orderId.substring(0, 8).toUpperCase();
    const receiptFilename = `Receipt-${shortId}.pdf`;
    const invoiceFilename = `Invoice-${shortId}.pdf`;
    const receiptPath = path.join(RECEIPTS_DIR, receiptFilename);
    const invoicePath = path.join(RECEIPTS_DIR, invoiceFilename);

    // Write to disk
    await fs.promises.writeFile(receiptPath, receiptBuf);
    await fs.promises.writeFile(invoicePath, invoiceBuf);
    console.log(`[RECEIPTS] Saved ${receiptFilename} and ${invoiceFilename}`);

    // Upsert into order_documents table
    const now2 = Date.now();
    await db.query(
      `INSERT INTO order_documents (order_id, doc_type, filename, filepath, file_size, created_at)
       VALUES ($1, 'receipt', $2, $3, $4, $5)
       ON CONFLICT (order_id, doc_type) DO UPDATE
       SET filename = EXCLUDED.filename, filepath = EXCLUDED.filepath,
           file_size = EXCLUDED.file_size, created_at = EXCLUDED.created_at`,
      [orderId, receiptFilename, receiptPath, receiptBuf.length, now2],
    );
    await db.query(
      `INSERT INTO order_documents (order_id, doc_type, filename, filepath, file_size, created_at)
       VALUES ($1, 'invoice', $2, $3, $4, $5)
       ON CONFLICT (order_id, doc_type) DO UPDATE
       SET filename = EXCLUDED.filename, filepath = EXCLUDED.filepath,
           file_size = EXCLUDED.file_size, created_at = EXCLUDED.created_at`,
      [orderId, invoiceFilename, invoicePath, invoiceBuf.length, now2],
    );

    // Send receipt + invoice to BUYER
    if (buyerData.email) {
      sendEmail(
        buyerData.email,
        `✅ Order ${shortId} Complete — Your Receipt & Invoice`,
        orderEmail(buyerData.display_name || "Buyer", orderId, "completed", productTitle, amt, "buyer"),
        [
          { filename: receiptFilename, content: receiptBuf, contentType: "application/pdf" },
          { filename: invoiceFilename, content: invoiceBuf, contentType: "application/pdf" },
        ],
      );
    }

    // Send receipt + invoice to SELLER
    if (sellerData.email) {
      sendEmail(
        sellerData.email,
        `🎉 Order ${shortId} Complete — Payment Released`,
        orderEmail(sellerData.display_name || "Seller", orderId, "completed", productTitle, netAmount, "seller"),
        [
          { filename: receiptFilename, content: receiptBuf, contentType: "application/pdf" },
          { filename: invoiceFilename, content: invoiceBuf, contentType: "application/pdf" },
        ],
      );
    }
  } catch (pdfErr) {
    console.error("[RECEIPT] PDF generation/save failed for order", orderId, ":", pdfErr.message);
    // Fallback: send plain email without attachment — payment release is not blocked
    if (sellerData.email) {
      sendEmail(
        sellerData.email,
        "Payment Released - AgriConnect",
        orderEmail(sellerData.display_name || "Seller", orderId, "completed", productTitle, netAmount, "seller"),
      );
    }
    if (buyerData.email) {
      sendEmail(
        buyerData.email,
        "Order Complete - AgriConnect",
        orderEmail(buyerData.display_name || "Buyer", orderId, "completed", productTitle, amt, "buyer"),
      );
    }
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
  sendNotification(
    order.buyer_uid,
    "Order Complete",
    "Your order has been completed. Check your email for receipt and invoice.",
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
  } else if (resolutionType === "send_to_commission") {
    await walletTransfer(
      order.id,
      "platform",
      WALLET_TYPES.ESCROW,
      WALLET_TYPES.ACTIVE,
      amt,
      order.reference,
      "Dispute resolution: send to commission for order " + dispute.order_id,
    );
    releasedAmount = amt;
    await createLedgerEntry({
      type: LEDGER_ENTRY_TYPE.FEE,
      amount: amt,
      fromWallet: WALLET_TYPES.ESCROW,
      toWallet: WALLET_TYPES.ACTIVE,
      fromUid: order.seller_uid,
      toUid: "platform",
      reference: order.reference,
      description:
        "Commission settlement for disputed order " + dispute.order_id,
    });
    await db.query(
      "UPDATE escrow_orders SET status = 'refunded', refunded_at = $1 WHERE id = $2",
      [now, dispute.order_id],
    );
    await db.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [
      dispute.order_id,
    ]);
  } else {
    throw new Error(
      "Invalid resolution type. Must be release_to_seller, refund_buyer, or send_to_commission",
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
  console.log("[RECONCILIATION] Starting reconciliation...");
  try {
    // ── 1. Ledger totals ────────────────────────────────────────────────────
    const ledgerResult = await db.query("SELECT amount FROM ledger");
    let ledgerTotal = 0;
    ledgerResult.rows.forEach((e) => { ledgerTotal += parseFloat(e.amount || 0); });
    ledgerTotal = parseFloat(ledgerTotal.toFixed(2));

    // ── 2. Wallet sums ──────────────────────────────────────────────────────
    const usersResult = await db.query("SELECT uid FROM users");
    const allLedger   = (await db.query("SELECT * FROM ledger")).rows;

    function computeBalanceFromLedger(uid, walletType) {
      let b = 0;
      allLedger.forEach((e) => {
        if (e.to_uid === uid && e.to_wallet === walletType)   b += parseFloat(e.amount || 0);
        if (e.from_uid === uid && e.from_wallet === walletType) b -= parseFloat(e.amount || 0);
      });
      return parseFloat(b.toFixed(2));
    }

    let sumActiveWallets = 0, sumEscrowWallets = 0,
        sumWithdrawableWallets = 0, sumFrozenBalances = 0;
    for (const row of usersResult.rows) {
      const uid = row.uid;
      sumActiveWallets      += computeBalanceFromLedger(uid, WALLET_TYPES.ACTIVE);
      sumEscrowWallets      += computeBalanceFromLedger(uid, WALLET_TYPES.ESCROW);
      sumWithdrawableWallets += computeBalanceFromLedger(uid, WALLET_TYPES.WITHDRAWABLE);
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

    // ── 3. External reference = total M-Pesa deposits - total approved payouts
    //       (what should actually be in the system per external records)
    const mpesaInRes = await db.query(
      "SELECT COALESCE(SUM(net_amount),0) AS total FROM mpesa_stk_requests WHERE status='success'",
    );
    const payoutsOutRes = await db.query(
      "SELECT COALESCE(SUM(net_amount),0) AS total FROM payouts WHERE status='approved'",
    );
    const totalMpesaIn   = parseFloat(mpesaInRes.rows[0].total)   || 0;
    const totalPayoutsOut= parseFloat(payoutsOutRes.rows[0].total) || 0;
    const availableMpesaBalance = parseFloat((totalMpesaIn - totalPayoutsOut).toFixed(2));

    const discrepancy    = parseFloat((totalInSystem - availableMpesaBalance).toFixed(2));
    const absDiscrepancy = Math.abs(discrepancy);

    // ── 4. Root-cause analysis — find the exact culprit transactions ─────────
    const culprits = await findReconciliationCulprits();

    const result = {
      timestamp: Date.now(),
      ledgerTotal,
      totalInSystem,
      sumActiveWallets:       parseFloat(sumActiveWallets.toFixed(2)),
      sumEscrowWallets:       parseFloat(sumEscrowWallets.toFixed(2)),
      sumWithdrawableWallets: parseFloat(sumWithdrawableWallets.toFixed(2)),
      sumFrozenBalances:      parseFloat(sumFrozenBalances.toFixed(2)),
      availableMpesaBalance,
      totalMpesaIn,
      totalPayoutsOut,
      discrepancy,
      anomaly: absDiscrepancy > 1.0,
      culprits,
    };

    await db.query(
      `INSERT INTO reconciliation_log
       (timestamp, ledger_total, total_in_system, sum_active_wallets, sum_escrow_wallets,
        sum_withdrawable_wallets, sum_frozen_balances, available_mpesa_balance, discrepancy, anomaly)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        result.timestamp, result.ledgerTotal, result.totalInSystem,
        result.sumActiveWallets, result.sumEscrowWallets, result.sumWithdrawableWallets,
        result.sumFrozenBalances, result.availableMpesaBalance, result.discrepancy, result.anomaly,
      ],
    );

    if (result.anomaly) {
      console.error("[RECONCILIATION] ANOMALY! Discrepancy: KES " + discrepancy.toFixed(2));
      console.error("[RECONCILIATION] Culprits found:", culprits.length,
        "— unmatched deposits:", culprits.filter(c=>c.category==="unmatched_deposit").length,
        "| unmatched payouts:", culprits.filter(c=>c.category==="unmatched_payout").length,
        "| wallet drift:", culprits.filter(c=>c.category==="wallet_drift").length,
      );
      const adminResult = await db.query("SELECT uid FROM users WHERE role = 'admin'");
      const culpritSummary = culprits.length > 0
        ? ` ${culprits.length} suspicious transaction(s) identified. Open Reconciliation in admin to view details.`
        : " No specific transactions could be isolated automatically.";
      for (const row of adminResult.rows) {
        sendNotification(
          row.uid,
          "Reconciliation Anomaly",
          `Discrepancy of KES ${Math.abs(discrepancy).toFixed(2)} detected.${culpritSummary}`,
          "error",
        );
      }
    } else {
      console.log("[RECONCILIATION] OK — System: " + totalInSystem +
        ", External: " + availableMpesaBalance + ", Diff: " + discrepancy.toFixed(2));
    }
    return result;
  } catch (e) {
    console.error("[RECONCILIATION] Error:", e);
    throw e;
  }
}

/**
 * findReconciliationCulprits — delegates to reconciliation-engine.js.
 * The engine contains the full risk-scoring logic and is kept separate
 * for testability.
 */
async function findReconciliationCulprits() {
  return _findCulpritsModule({
    db,
    io,
    WALLET_TYPES,
    WALLET_STATUS,
    WALLET_RESTRICTION,
    RISK_POINTS,
    RISK_THRESHOLDS,
    sendNotification,
  });
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
      console.log(
        `[SECURITY] Role access denied: User ${req.user?.uid} with role '${req.user?.role}' tried to access endpoint requiring roles: ${roles.join(", ")}`,
      );
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
      const result = await db.query("SELECT role FROM users WHERE uid = $1", [
        uid,
      ]);
      const currentRole = result.rows[0]?.role;

      if (!currentRole) {
        console.log(`[SECURITY] User not found in database: ${uid}`);
        return res.status(401).json({ error: "User not found" });
      }

      if (currentRole !== requiredRole) {
        console.log(
          `[SECURITY] Role mismatch: User ${uid} has role '${currentRole}' but endpoint requires '${requiredRole}'`,
        );
        return res.status(403).json({
          error: "Access denied. Insufficient role privileges.",
          required: requiredRole,
          current: currentRole,
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
  console.log(
    `[SECURITY] Non-admin user ${uid} tried to access admin endpoint`,
  );
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
  if (
    req.path.endsWith(".html") ||
    req.path === "/" ||
    req.path.startsWith("/api/")
  ) {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
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
      // Check if 2FA is enabled
      if (user.two_factor_enabled) {
        return res.json({
          require2fa: true,
          uid: user.uid,
          email: user.email,
        });
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
        role: user.role,
        token: jwtToken,
        profile: buildProfileObj(user),
        isVerified: !!user.is_verified,
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
        const jwtToken = auth.generateJWT(existingUser.uid, existingUser.email);
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

// Health check endpoint with database pool stats
app.get("/api/health", async (req, res) => {
  const poolStats = db.getPoolStats();
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: {
      connected: !!poolStats,
      pool: poolStats || { total: 0, idle: 0, waiting: 0 },
    },
  };

  // Return 503 if pool is exhausted
  if (poolStats && (poolStats.waiting > 10 || poolStats.total >= 10)) {
    health.status = "degraded";
    health.warning = "Database connection pool under pressure";
    return res.status(503).json(health);
  }

  res.json(health);
});

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
    res.json({ ...data, profile: buildProfileObj(data) });
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
      isValid: true,
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
    const { displayName, phoneNumber, photoUrl } = req.body;
    try {
      const updates = {};
      // Reject display_name changes (name is set once and read-only)
      if (displayName !== undefined) {
        return res.status(400).json({ error: "Name cannot be changed" });
      }
      // Check phone number uniqueness
      if (phoneNumber !== undefined) {
        const existing = await db.query(
          "SELECT uid FROM users WHERE phone_number = $1 AND uid != $2",
          [phoneNumber, uid],
        );
        if (existing.rows.length > 0) {
          return res.status(409).json({ error: "Phone number already in use by another account" });
        }
        updates.phone_number = phoneNumber;
      }
      // Profile photo URL (base64 data URL or https URL)
      if (photoUrl !== undefined && typeof photoUrl === "string") {
        updates.photo_url = photoUrl;
      }
      // Accept both flat fields and nested profile object
      const flatBody = { ...req.body };
      if (req.body.profile && typeof req.body.profile === "object") {
        Object.assign(flatBody, req.body.profile);
      }
      const profileFieldMap = {
        businessName: "business_name",
        category: "category",
        manufacture: "manufacture",
        produce: "produce",
        location: "location",
        imageUrls: "image_urls",
        bio: "bio",
      };
      for (const [bodyField, dbCol] of Object.entries(profileFieldMap)) {
        if (flatBody[bodyField] !== undefined) {
          updates[dbCol] = flatBody[bodyField];
        }
      }
      if (Object.keys(updates).length > 0) {
        const setClauses = [];
        const params = [];
        let idx = 1;
        for (const [col, val] of Object.entries(updates)) {
          if (col === "image_urls") {
            setClauses.push(col + " = $" + idx + "::jsonb");
            params.push(JSON.stringify(val));
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
      const result = await db.query("SELECT * FROM users WHERE uid = $1", [uid]);
      res.json({ ...result.rows[0], profile: buildProfileObj(result.rows[0]) });
    } catch (e) {
      console.error("Profile update error:", e);
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

// ======================== 2FA Routes ========================
app.get("/api/auth/2fa/status", authenticateJWT, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT two_factor_enabled FROM users WHERE uid = $1",
      [req.user.uid],
    );
    res.json({ enabled: result.rows[0]?.two_factor_enabled || false });
  } catch (e) {
    res.status(500).json({ error: "Failed to get 2FA status" });
  }
});

app.post("/api/auth/2fa/setup", authenticateJWT, async (req, res) => {
  try {
    const existing = await db.query(
      "SELECT two_factor_enabled, two_factor_secret FROM users WHERE uid = $1",
      [req.user.uid],
    );
    if (existing.rows[0]?.two_factor_enabled) {
      return res.status(400).json({ error: "2FA is already enabled" });
    }
    const secret = speakeasy.generateSecret({
      length: 20,
      name: req.user.email,
      issuer: "AgriConnect",
    });
    await db.query("UPDATE users SET two_factor_secret = $1 WHERE uid = $2", [
      secret.base32,
      req.user.uid,
    ]);
    const otpauthUrl = speakeasy.otpauthURL({
      secret: secret.base32,
      label: "AgriConnect:" + req.user.email,
      issuer: "AgriConnect",
      encoding: "base32",
    });
    const qrCode = await QRCode.toDataURL(otpauthUrl);
    res.json({ secret: secret.base32, qrCode });
  } catch (e) {
    console.error("2FA setup error:", e);
    res.status(500).json({ error: "Failed to setup 2FA" });
  }
});

app.post("/api/auth/2fa/verify", authenticateJWT, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Verification code required" });
  try {
    const result = await db.query(
      "SELECT two_factor_secret FROM users WHERE uid = $1",
      [req.user.uid],
    );
    const secret = result.rows[0]?.two_factor_secret;
    if (!secret) return res.status(400).json({ error: "2FA not initialized" });
    const verified = speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token: code.replace(/\s/g, ""),
      window: 2,
    });
    if (!verified) return res.status(400).json({ error: "Invalid code. Make sure your device time is accurate." });
    await db.query(
      "UPDATE users SET two_factor_enabled = TRUE WHERE uid = $1",
      [req.user.uid],
    );
    res.json({ enabled: true });
  } catch (e) {
    console.error("2FA verify error:", e);
    res.status(500).json({ error: "Failed to verify code" });
  }
});

app.post("/api/auth/2fa/disable", authenticateJWT, sanitizeInput, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  try {
    const result = await db.query("SELECT password_hash FROM users WHERE uid = $1", [req.user.uid]);
    const valid = await auth.verifyPassword(password, result.rows[0]?.password_hash || "");
    if (!valid) return res.status(400).json({ error: "Incorrect password" });
    await db.query(
      "UPDATE users SET two_factor_secret = '', two_factor_enabled = FALSE WHERE uid = $1",
      [req.user.uid],
    );
    res.json({ enabled: false });
  } catch (e) {
    console.error("2FA disable error:", e);
    res.status(500).json({ error: "Failed to disable 2FA" });
  }
});

app.post("/api/auth/2fa/login-challenge", async (req, res) => {
  const { uid, code } = req.body;
  if (!uid || !code) return res.status(400).json({ error: "UID and code required" });
  try {
    const result = await db.query(
      "SELECT two_factor_secret, two_factor_enabled, email, display_name, phone_number, role FROM users WHERE uid = $1",
      [uid],
    );
    const user = result.rows[0];
    if (!user || !user.two_factor_enabled) {
      return res.status(400).json({ error: "2FA not enabled" });
    }
    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: "base32",
      token: code.replace(/\s/g, ""),
      window: 2,
    });
    if (!verified) return res.status(400).json({ error: "Invalid 2FA code. Make sure your device time is accurate." });
    const jwtToken = auth.generateJWT(uid, user.email);
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
      uid,
      email: user.email,
      displayName: user.display_name || "",
      phoneNumber: user.phone_number || "",
      role: user.role,
      token: jwtToken,
      profile: buildProfileObj(user),
      isVerified: !!user.is_verified,
      profileComplete: !!(user.display_name && user.display_name.trim() && user.phone_number && user.phone_number.trim()),
    });
  } catch (e) {
    console.error("2FA challenge error:", e);
    res.status(500).json({ error: "Failed to verify 2FA code" });
  }
});

// ======================== Profile Image Upload ========================
app.post("/api/users/profile/image", authenticateJWT, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "Image data required" });
  try {
    const result = await db.query("SELECT image_urls FROM users WHERE uid = $1", [req.user.uid]);
    let imageUrls = result.rows[0]?.image_urls || [];
    if (!Array.isArray(imageUrls)) imageUrls = [];
    imageUrls.push(image);
    await db.query("UPDATE users SET image_urls = $1::jsonb WHERE uid = $2", [
      JSON.stringify(imageUrls),
      req.user.uid,
    ]);
    res.json({ imageUrls });
  } catch (e) {
    console.error("Image upload error:", e);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

app.get("/api/users", authenticateJWT, async (req, res) => {
  const { role, email } = req.query;
  try {
    let query =
      "SELECT uid, email, display_name, role, photo_url, business_name, category, manufacture, produce, location, image_urls, bio FROM users";
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
      profile: buildProfileObj(r),
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

      // Consolidated query to get both wallet states
      const walletsResult = await db.query(
        `SELECT
          (SELECT row_to_json(w) FROM (
            SELECT uid, wallet_type, status, balance, frozen_balance, created_at, updated_at
            FROM wallets
            WHERE uid = $1 AND wallet_type = 'active'
          ) w) AS from_wallet,
          (SELECT row_to_json(w) FROM (
            SELECT uid, wallet_type, status, balance, frozen_balance, created_at, updated_at
            FROM wallets
            WHERE uid = $2 AND wallet_type = 'active'
          ) w) AS to_wallet`,
        [fromUid, recipient.uid],
      );

      const fromWalletAfter = walletsResult.rows[0].from_wallet || {
        balance: 0,
      };
      const toWalletAfter = walletsResult.rows[0].to_wallet || { balance: 0 };
      const newBalance = fromWalletAfter.balance || 0;
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
      // Consolidated query using UNION to check both tables
      const result = await db.query(
        `SELECT status, reference, account_reference, amount
         FROM mpesa_stk_requests
         WHERE checkout_request_id = $1
         UNION ALL
         SELECT status, reference, account_reference, amount
         FROM mpesa_deposits
         WHERE checkout_request_id = $1
         LIMIT 1`,
        [checkoutRequestId],
      );

      const depositRecord = result.rows[0] || null;
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
  // Always respond 200 immediately so Safaricom doesn't retry
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const body = req.body;
    const stkCallback = body.Body && body.Body.stkCallback;
    if (!stkCallback) {
      console.warn("[MPESA] STK callback: missing stkCallback body");
      return;
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = stkCallback;
    const resultCodeNum = parseInt(ResultCode, 10);

    // ── FAILED PAYMENT ────────────────────────────────────────────────────────
    // ResultCode !== 0 means the user cancelled, insufficient funds, wrong PIN, etc.
    // Update status and notify the user — do NOT credit anything.
    if (resultCodeNum !== 0) {
      console.warn(`[MPESA] STK failed CheckoutRequestID=${CheckoutRequestID} code=${ResultCode} desc="${ResultDesc}"`);
      await db.query(
        "UPDATE mpesa_stk_requests SET status='failed' WHERE checkout_request_id=$1",
        [CheckoutRequestID],
      ).catch(e => console.error("[MPESA] STK fail update error:", e.message));

      await db.query(
        "UPDATE mpesa_deposits SET status='failed' WHERE checkout_request_id=$1",
        [CheckoutRequestID],
      ).catch(() => {});

      await db.query(
        "INSERT INTO mpesa_failed_callbacks (checkout_request_id, result_code, result_desc, received_at) VALUES ($1, $2, $3, $4)",
        [CheckoutRequestID, String(ResultCode), ResultDesc || "", Date.now()],
      ).catch(e => console.error("[MPESA] Failed callback insert error:", e.message));

      // Notify the user that their deposit failed
      const stkRes = await db.query(
        "SELECT uid, amount FROM mpesa_stk_requests WHERE checkout_request_id=$1",
        [CheckoutRequestID],
      ).catch(() => ({ rows: [] }));
      const stkRow = stkRes.rows[0];
      if (stkRow?.uid) {
        const userMsg = resultCodeNum === 1032
          ? "Deposit cancelled by you."
          : resultCodeNum === 1037
            ? "Deposit request timed out — please try again."
            : `Deposit failed: ${ResultDesc || "payment unsuccessful"}.`;
        sendNotification(stkRow.uid, "Deposit Failed", userMsg, "error");
        io.to(stkRow.uid).emit("walletUpdate");
      }
      return;
    }

    // ── SUCCESSFUL PAYMENT ────────────────────────────────────────────────────
    const items = CallbackMetadata?.Item || [];
    let amount = 0, mpesaReceiptNumber = "", phoneNumber = "", transactionDate = "";
    items.forEach((item) => {
      if (item.Name === "Amount")             amount            = parseFloat(item.Value || 0);
      if (item.Name === "MpesaReceiptNumber") mpesaReceiptNumber = item.Value;
      if (item.Name === "PhoneNumber")        phoneNumber       = String(item.Value);
      if (item.Name === "TransactionDate")    transactionDate   = String(item.Value);
    });

    if (!mpesaReceiptNumber) {
      console.error("[MPESA] STK callback: no MpesaReceiptNumber in metadata for", CheckoutRequestID);
      return;
    }

    // ── Guard 1: Amount must be a positive number ─────────────────────────────
    if (!amount || amount <= 0) {
      console.error(`[MPESA] STK callback: invalid amount ${amount} for ${CheckoutRequestID}`);
      return;
    }

    // ── Guard 2: Deduplication — never credit the same receipt twice ──────────
    const alreadyProcessed = await db.query(
      "SELECT mpesa_receipt_number FROM mpesa_processed WHERE mpesa_receipt_number=$1",
      [mpesaReceiptNumber],
    );
    if (alreadyProcessed.rows.length > 0) {
      console.warn("[MPESA] Duplicate STK callback ignored for receipt:", mpesaReceiptNumber);
      return;
    }

    // ── Guard 3: Verify the CheckoutRequestID exists and is still pending ─────
    const stkResult = await db.query(
      "SELECT * FROM mpesa_stk_requests WHERE checkout_request_id=$1",
      [CheckoutRequestID],
    );
    const stkReq = stkResult.rows[0];
    if (!stkReq) {
      console.error("[MPESA] STK callback: unknown CheckoutRequestID", CheckoutRequestID);
      // Store as unlinked so admin can investigate
      await db.query(
        "INSERT INTO mpesa_unlinked_c2b (trans_id, trans_time, amount, sender_phone, bill_ref_number, received_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [mpesaReceiptNumber, transactionDate, amount, phoneNumber, CheckoutRequestID, Date.now()],
      ).catch(() => {});
      return;
    }
    if (stkReq.status === "success") {
      console.warn("[MPESA] STK already succeeded, ignoring duplicate:", CheckoutRequestID);
      return;
    }

    // ── Guard 4: Amount must match what was requested (±1 KES tolerance) ──────
    const requestedAmount = parseFloat(stkReq.amount || 0);
    if (requestedAmount > 0 && Math.abs(amount - requestedAmount) > 1) {
      console.error(
        `[MPESA] STK amount mismatch! Requested=${requestedAmount} Received=${amount} for ${CheckoutRequestID} — NOT crediting`,
      );
      await db.query(
        "UPDATE mpesa_stk_requests SET status='failed' WHERE checkout_request_id=$1",
        [CheckoutRequestID],
      );
      await db.query(
        "INSERT INTO mpesa_failed_callbacks (checkout_request_id, result_code, result_desc, received_at) VALUES ($1, $2, $3, $4)",
        [CheckoutRequestID, "AMOUNT_MISMATCH",
         `Requested ${requestedAmount} but received ${amount}`, Date.now()],
      ).catch(() => {});
      return;
    }

    // ── Guard 5: Lock the receipt number (prevents race-condition double-credit) ─
    await db.query(
      "INSERT INTO mpesa_processed (mpesa_receipt_number, processed_at, checkout_request_id, type) VALUES ($1, $2, $3, $4)",
      [mpesaReceiptNumber, Date.now(), CheckoutRequestID, "stk_callback"],
    );

    // ── Resolve user ──────────────────────────────────────────────────────────
    let uid = stkReq.uid || null;
    if (!uid) {
      const depResult = await db.query(
        "SELECT uid FROM mpesa_deposits WHERE checkout_request_id=$1",
        [CheckoutRequestID],
      );
      if (depResult.rows.length > 0) uid = depResult.rows[0].uid;
    }
    if (!uid) {
      console.error("[MPESA] STK callback: no uid for", CheckoutRequestID);
      return;
    }

    // ── Credit wallet ─────────────────────────────────────────────────────────
    const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
    const netAmount = parseFloat((amount - fee).toFixed(2));

    await creditWallet(
      uid, WALLET_TYPES.ACTIVE, netAmount, mpesaReceiptNumber,
      `M-Pesa deposit via ${mpesaReceiptNumber} (fee: KES ${fee.toFixed(2)})`,
      null,
      { mpesaReceiptNumber, checkoutRequestId: CheckoutRequestID, phoneNumber, grossAmount: amount, fee },
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
        description: `Deposit fee (${DEPOSIT_FEE_RATE * 100}%) on ${mpesaReceiptNumber}`,
      });
    }

    const newBalance = parseFloat((await getWalletState(uid, WALLET_TYPES.ACTIVE))?.balance || 0);

    await db.query(
      "UPDATE mpesa_stk_requests SET status='success', mpesa_receipt_number=$1, amount=$2, net_amount=$3, fee=$4, phone_number=$5, transaction_date=$6, processed_at=$7 WHERE checkout_request_id=$8",
      [mpesaReceiptNumber, amount, netAmount, fee, phoneNumber, transactionDate, Date.now(), CheckoutRequestID],
    );
    await db.query(
      "UPDATE mpesa_deposits SET status='success', net_amount=$1, fee=$2, mpesa_receipt_number=$3, processed_at=$4 WHERE checkout_request_id=$5 AND uid=$6",
      [netAmount, fee, mpesaReceiptNumber, Date.now(), CheckoutRequestID, uid],
    ).catch(() => {});

    await db.query(
      "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [uid, "deposit", netAmount, fee, newBalance, mpesaReceiptNumber,
       `M-Pesa deposit (fee: KES ${fee.toFixed(2)})`, Date.now()],
    );

    if (stkReq.idempotency_key) {
      await recordIdempotency(stkReq.idempotency_key, {
        status: "success", mpesaReceiptNumber, amount: netAmount,
      }).catch(() => {});
    }

    const userResult = await db.query("SELECT email, display_name FROM users WHERE uid=$1", [uid]);
    const userData = userResult.rows[0] || {};
    if (userData.email) {
      sendEmail(userData.email, "Deposit Confirmed - AgriConnect",
        depositEmail(userData.display_name || "User", netAmount, newBalance, mpesaReceiptNumber));
    }
    sendNotification(uid, "Deposit Received",
      `KES ${netAmount.toFixed(2)} has been credited to your active wallet. M-Pesa ref: ${mpesaReceiptNumber}.`,
      "success");
    io.to(uid).emit("walletUpdate");
    console.log(`[MPESA] STK deposit processed: uid=${uid} net=${netAmount} receipt=${mpesaReceiptNumber}`);

  } catch (e) {
    console.error("[MPESA] STK Callback error:", e);
  }
});

app.post("/api/mpesa/c2b/confirmation", webhookLimiter, async (req, res) => {
  console.log("[MPESA] C2B Confirmation received:", JSON.stringify(req.body));
  // Always respond 200 so Safaricom doesn't retry
  res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });

  try {
    const {
      TransactionType,
      TransID,
      TransTime,
      TransAmount,
      BusinessShortCode,
      BillRefNumber,
      MSISDN,
    } = req.body;

    // ── Guard 1: Must be our shortcode ────────────────────────────────────────
    if (BusinessShortCode && String(BusinessShortCode) !== String(MPESA.BUSINESS_SHORTCODE)) {
      console.error(`[MPESA] C2B confirmation for wrong shortcode ${BusinessShortCode}, expected ${MPESA.BUSINESS_SHORTCODE} — ignored`);
      return;
    }

    // ── Guard 2: Must be a pay-bill/till payment, not a reversal or other type ─
    const allowedTypes = ["Pay Bill", "CustomerPayBillOnline", "Buy Goods", "CustomerBuyGoodsOnline"];
    if (TransactionType && !allowedTypes.includes(TransactionType)) {
      console.warn(`[MPESA] C2B confirmation: unhandled transaction type "${TransactionType}" — stored as unlinked`);
      await db.query(
        "INSERT INTO mpesa_unlinked_c2b (trans_id, trans_time, amount, sender_phone, bill_ref_number, received_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [TransID, TransTime, parseFloat(TransAmount || 0), String(MSISDN || ""), BillRefNumber, Date.now()],
      ).catch(() => {});
      return;
    }

    const amount = parseFloat(TransAmount || 0);
    const senderPhone = String(MSISDN || "");

    // ── Guard 3: Amount must be positive ─────────────────────────────────────
    if (!amount || amount <= 0) {
      console.error(`[MPESA] C2B confirmation: invalid amount ${amount} for TransID ${TransID}`);
      return;
    }

    // ── Guard 4: Deduplication ────────────────────────────────────────────────
    const alreadyProcessed = await db.query(
      "SELECT mpesa_receipt_number FROM mpesa_processed WHERE mpesa_receipt_number=$1",
      [TransID],
    );
    if (alreadyProcessed.rows.length > 0) {
      console.warn("[MPESA] C2B duplicate ignored for TransID:", TransID);
      return;
    }

    // ── Lock the receipt ──────────────────────────────────────────────────────
    await db.query(
      "INSERT INTO mpesa_processed (mpesa_receipt_number, processed_at, type) VALUES ($1, $2, $3)",
      [TransID, Date.now(), "c2b_confirmation"],
    );

    // ── Resolve user from BillRefNumber ──────────────────────────────────────
    // Convention: BillRefNumber is either "uid_<userId>" or the wallet_id (8-char code)
    let uid = null;
    if (BillRefNumber) {
      if (BillRefNumber.startsWith("uid_")) {
        uid = BillRefNumber.replace("uid_", "");
      } else {
        // Try wallet_id lookup
        const widRes = await db.query(
          "SELECT uid FROM wallet_ids WHERE wallet_id=$1",
          [BillRefNumber.trim()],
        );
        if (widRes.rows.length > 0) uid = widRes.rows[0].uid;
      }
    }

    if (!uid) {
      // Can't match to a user — store for manual reconciliation
      console.warn(`[MPESA] C2B confirmation: no uid for BillRefNumber="${BillRefNumber}" — stored as unlinked`);
      await db.query(
        "INSERT INTO mpesa_unlinked_c2b (trans_id, trans_time, amount, sender_phone, bill_ref_number, received_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [TransID, TransTime, amount, senderPhone, BillRefNumber, Date.now()],
      ).catch(() => {});
      // Notify admins so they can manually credit the right account
      const admins = await db.query("SELECT uid FROM users WHERE role='admin'").catch(() => ({ rows: [] }));
      for (const row of admins.rows) {
        sendNotification(row.uid, "Unmatched C2B Deposit",
          `KES ${amount.toFixed(2)} received from ${senderPhone} (TransID: ${TransID}) could not be matched to any user account. BillRef: "${BillRefNumber}". Manual action required.`,
          "warning");
      }
      return;
    }

    // ── Verify the user account exists and is active ──────────────────────────
    const userCheck = await db.query("SELECT uid, status FROM users WHERE uid=$1", [uid]).catch(() => ({ rows: [] }));
    if (!userCheck.rows.length) {
      console.error(`[MPESA] C2B confirmation: uid "${uid}" not found in users table`);
      await db.query(
        "INSERT INTO mpesa_unlinked_c2b (trans_id, trans_time, amount, sender_phone, bill_ref_number, received_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [TransID, TransTime, amount, senderPhone, BillRefNumber, Date.now()],
      ).catch(() => {});
      return;
    }

    // ── Credit wallet ─────────────────────────────────────────────────────────
    const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
    const netAmount = parseFloat((amount - fee).toFixed(2));

    await creditWallet(uid, WALLET_TYPES.ACTIVE, netAmount, TransID,
      `M-Pesa C2B deposit via ${TransID} (fee: KES ${fee.toFixed(2)})`,
      null,
      { transId: TransID, senderPhone, grossAmount: amount, fee },
    );

    if (fee > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: fee,
        fromWallet: WALLET_TYPES.ACTIVE,
        toWallet: WALLET_TYPES.ACTIVE,
        fromUid: uid,
        toUid: "platform",
        reference: TransID,
        description: `Deposit fee (${DEPOSIT_FEE_RATE * 100}%) on C2B ${TransID}`,
      });
    }

    await db.query(
      "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [uid, "deposit", netAmount, fee,
       parseFloat((await getWalletState(uid, WALLET_TYPES.ACTIVE))?.balance || 0),
       TransID, `M-Pesa C2B deposit (fee: KES ${fee.toFixed(2)})`, Date.now()],
    ).catch(e => console.error("[MPESA] C2B transactions insert error:", e.message));

    sendNotification(uid, "M-Pesa Deposit Received",
      `KES ${netAmount.toFixed(2)} has been credited to your wallet. M-Pesa ref: ${TransID}.`,
      "success");
    io.to(uid).emit("walletUpdate");
    console.log(`[MPESA] C2B deposit processed: uid=${uid} net=${netAmount} TransID=${TransID}`);

  } catch (e) {
    console.error("[MPESA] C2B Confirmation error:", e);
  }
});

app.post("/api/mpesa/c2b/validation", webhookLimiter, async (req, res) => {
  console.log("[MPESA] C2B Validation received:", JSON.stringify(req.body));
  try {
    const {
      TransactionType,
      TransID,
      TransAmount,
      BusinessShortCode,
      BillRefNumber,
      MSISDN,
    } = req.body;

    // ── Check 1: Must be our shortcode ────────────────────────────────────────
    if (BusinessShortCode && String(BusinessShortCode) !== String(MPESA.BUSINESS_SHORTCODE)) {
      console.error(`[MPESA] C2B validation: wrong shortcode ${BusinessShortCode} — rejecting`);
      return res.status(200).json({ ResultCode: "C2B00011", ResultDesc: "Invalid business shortcode" });
    }

    // ── Check 2: Amount must be positive and above minimum ────────────────────
    const amount = parseFloat(TransAmount || 0);
    if (!amount || amount <= 0 || amount < MIN_DEPOSIT) {
      console.warn(`[MPESA] C2B validation: invalid amount ${amount} — rejecting`);
      return res.status(200).json({ ResultCode: "C2B00012", ResultDesc: "Invalid amount" });
    }

    // ── Check 3: BillRefNumber must resolve to a valid user ───────────────────
    let uid = null;
    if (BillRefNumber) {
      if (BillRefNumber.startsWith("uid_")) {
        uid = BillRefNumber.replace("uid_", "");
        const check = await db.query("SELECT uid FROM users WHERE uid=$1", [uid]).catch(() => ({ rows: [] }));
        if (!check.rows.length) uid = null;
      } else {
        const widRes = await db.query(
          "SELECT uid FROM wallet_ids WHERE wallet_id=$1",
          [BillRefNumber.trim()],
        ).catch(() => ({ rows: [] }));
        if (widRes.rows.length > 0) uid = widRes.rows[0].uid;
      }
    }

    if (!uid) {
      console.warn(`[MPESA] C2B validation: BillRefNumber "${BillRefNumber}" does not match any user — rejecting`);
      // ResultCode C2B00016 = invalid account number / account not found
      return res.status(200).json({ ResultCode: "C2B00016", ResultDesc: "Account not found" });
    }

    // ── Check 4: Must not be a duplicate TransID ──────────────────────────────
    if (TransID) {
      const dup = await db.query(
        "SELECT mpesa_receipt_number FROM mpesa_processed WHERE mpesa_receipt_number=$1",
        [TransID],
      ).catch(() => ({ rows: [] }));
      if (dup.rows.length > 0) {
        console.warn(`[MPESA] C2B validation: duplicate TransID ${TransID} — rejecting`);
        return res.status(200).json({ ResultCode: "C2B00012", ResultDesc: "Duplicate transaction" });
      }
    }

    // All checks passed — accept the transaction
    console.log(`[MPESA] C2B validation accepted: uid=${uid} amount=${amount} TransID=${TransID}`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (e) {
    console.error("[MPESA] C2B Validation error:", e);
    // On internal error, reject to be safe — better to ask user to retry than credit bad data
    return res.status(200).json({ ResultCode: "C2B00016", ResultDesc: "Internal validation error" });
  }
});

// ---- B2C RESULT (Payout callback) ----

app.post("/api/mpesa/b2c/result", webhookLimiter, async (req, res) => {
  console.log("[MPESA] B2C Result:", JSON.stringify(req.body));
  // Always respond 200 immediately so Safaricom doesn't retry
  res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });

  try {
    const { Result } = req.body;
    if (!Result) return;

    const { ResultType, ResultCode, ResultDesc, TransactionID, ReferenceData, OriginatorConversationID, ConversationID } = Result;
    const resultCodeNum = parseInt(ResultCode, 10);

    // ── 1. Persist raw result for audit ──────────────────────────────────────
    await db.query(
      "INSERT INTO mpesa_b2c_results (result_type, result_code, result_desc, transaction_id, reference_data, received_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [
        String(ResultType ?? ""),
        String(ResultCode ?? ""),
        ResultDesc || "",
        TransactionID || "",
        ReferenceData ? JSON.stringify(ReferenceData) : null,
        Date.now(),
      ],
    ).catch(e => console.error("[MPESA] B2C audit insert error:", e.message));

    // ── 2. Resolve payout ID from Occasion (echoed in ReferenceData) ─────────
    // Safaricom echoes the Occasion field back in ReferenceData.ReferenceItem.
    // The array can contain multiple items (QueueTimeoutURL, Occasion, etc.) —
    // we must find the one with Key === "Occasion" specifically.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let payoutId = null;
    if (ReferenceData) {
      const items = Array.isArray(ReferenceData.ReferenceItem)
        ? ReferenceData.ReferenceItem
        : ReferenceData.ReferenceItem
          ? [ReferenceData.ReferenceItem]
          : [];
      // Only accept the Occasion item — never fall back to an arbitrary first item
      const occasionItem = items.find(i => i.Key === "Occasion");
      const candidate = occasionItem?.Value || null;
      // Only use it if it looks like one of our UUIDs
      if (candidate && UUID_RE.test(candidate)) {
        payoutId = candidate;
      } else if (candidate) {
        console.warn(`[MPESA] B2C result: Occasion value "${candidate}" is not a UUID — skipping`);
      }
    }

    // Fallback: match by ConversationID stored in b2c_result when B2C was initiated
    if (!payoutId && ConversationID) {
      const convRes = await db.query(
        "SELECT id FROM payouts WHERE b2c_result::text ILIKE $1 LIMIT 1",
        [`%${ConversationID}%`],
      ).catch(() => ({ rows: [] }));
      const candidate = convRes.rows[0]?.id || null;
      if (candidate && UUID_RE.test(candidate)) {
        payoutId = candidate;
      }
    }

    // Last resort: match by OriginatorConversationID
    if (!payoutId && OriginatorConversationID) {
      const origRes = await db.query(
        "SELECT id FROM payouts WHERE b2c_result::text ILIKE $1 LIMIT 1",
        [`%${OriginatorConversationID}%`],
      ).catch(() => ({ rows: [] }));
      const candidate = origRes.rows[0]?.id || null;
      if (candidate && UUID_RE.test(candidate)) {
        payoutId = candidate;
      }
    }

    if (!payoutId) {
      console.error("[MPESA] B2C result: could not resolve a valid UUID payoutId.", {
        ReferenceData: JSON.stringify(ReferenceData),
        ConversationID,
        OriginatorConversationID,
      });
      return;
    }

    const payoutRes = await db.query("SELECT * FROM payouts WHERE id = $1", [payoutId]);
    const payout = payoutRes.rows[0];
    if (!payout) {
      console.error("[MPESA] B2C result: payout not found for id", payoutId);
      return;
    }

    // ── 3a. SUCCESS ───────────────────────────────────────────────────────────
    if (resultCodeNum === 0) {
      await db.query(
        "UPDATE payouts SET status='completed', mpesa_transaction_id=$1, completed_at=$2, approved_at=$3, b2c_result=$4 WHERE id=$5",
        [TransactionID, Date.now(), Date.now(), JSON.stringify(Result), payoutId],
      );
      sendNotification(
        payout.uid,
        "Withdrawal Successful ✅",
        `KES ${parseFloat(payout.net_amount || payout.amount).toFixed(2)} has been sent to your M-Pesa (${payout.phone_number}). M-Pesa ref: ${TransactionID}.`,
        "success",
      );
      io.to(payout.uid).emit("walletUpdate");
      console.log(`[MPESA] B2C SUCCESS payoutId=${payoutId} txn=${TransactionID} amount=${payout.net_amount}`);

    // ── 3b. FAILURE — refund the user ─────────────────────────────────────────
    } else {
      console.error(`[MPESA] B2C FAILED payoutId=${payoutId} code=${ResultCode} desc="${ResultDesc}"`);

      // Only refund if not already refunded (idempotency guard)
      if (payout.status !== "failed" && payout.status !== "refunded") {
        await db.query(
          "UPDATE payouts SET status='failed', b2c_error=$1, b2c_result=$2 WHERE id=$3",
          [ResultDesc || `B2C failed (code ${ResultCode})`, JSON.stringify(Result), payoutId],
        );

        // Re-credit the full deducted amount (gross amount + fee) back to withdrawable wallet
        const refundTotal = parseFloat(payout.amount) + parseFloat(payout.fee || 0);
        await creditWallet(
          payout.uid,
          WALLET_TYPES.WITHDRAWABLE,
          refundTotal,
          payout.reference,
          `B2C failed refund — ${ResultDesc || "transfer unsuccessful"} (ref: ${payout.reference})`,
        ).catch(e => console.error("[MPESA] B2C refund credit error:", e.message));

        // Reverse the fee ledger entry if fee was charged
        if (parseFloat(payout.fee || 0) > 0) {
          await createLedgerEntry({
            type: LEDGER_ENTRY_TYPE.FEE,
            amount: parseFloat(payout.fee),
            fromWallet: WALLET_TYPES.ACTIVE,
            toWallet: WALLET_TYPES.WITHDRAWABLE,
            fromUid: "platform",
            toUid: payout.uid,
            reference: payout.reference,
            description: `Fee reversal for failed B2C payout (ref: ${payout.reference})`,
          }).catch(e => console.error("[MPESA] Fee reversal ledger error:", e.message));
        }

        sendNotification(
          payout.uid,
          "Withdrawal Failed — Funds Returned",
          `Your withdrawal of KES ${parseFloat(payout.amount).toFixed(2)} could not be sent to M-Pesa. Reason: ${ResultDesc || "Transfer failed"}. KES ${refundTotal.toFixed(2)} has been returned to your wallet.`,
          "error",
        );
        io.to(payout.uid).emit("walletUpdate");

        // Notify admins about the failure
        const admins = await db.query("SELECT uid FROM users WHERE role='admin'").catch(() => ({ rows: [] }));
        for (const row of admins.rows) {
          sendNotification(
            row.uid,
            "B2C Payout Failed",
            `Payout ${payoutId} (KES ${parseFloat(payout.amount).toFixed(2)} to ${payout.phone_number}) failed — ${ResultDesc || `code ${ResultCode}`}. Funds auto-refunded to user.`,
            "warning",
          );
        }
      }
    }
  } catch (e) {
    console.error("[MPESA] B2C result processing error:", e);
  }
});

// ---- B2C TIMEOUT (Safaricom could not process within the timeout window) ----

app.post("/api/mpesa/b2c/timeout", webhookLimiter, async (req, res) => {
  console.log("[MPESA] B2C Timeout:", JSON.stringify(req.body));
  // Always respond 200 so Safaricom stops retrying
  res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });

  try {
    const { Result } = req.body;
    const ReferenceData = Result?.ReferenceData;
    const ConversationID = Result?.ConversationID;
    const OriginatorConversationID = Result?.OriginatorConversationID;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Resolve payout ID — same UUID-validated logic as the result callback
    let payoutId = null;
    if (ReferenceData) {
      const items = Array.isArray(ReferenceData.ReferenceItem)
        ? ReferenceData.ReferenceItem
        : ReferenceData.ReferenceItem ? [ReferenceData.ReferenceItem] : [];
      const occasionItem = items.find(i => i.Key === "Occasion");
      const candidate = occasionItem?.Value || null;
      if (candidate && UUID_RE.test(candidate)) payoutId = candidate;
    }
    if (!payoutId && ConversationID) {
      const convRes = await db.query(
        "SELECT id FROM payouts WHERE b2c_result::text ILIKE $1 LIMIT 1",
        [`%${ConversationID}%`],
      ).catch(() => ({ rows: [] }));
      const candidate = convRes.rows[0]?.id || null;
      if (candidate && UUID_RE.test(candidate)) payoutId = candidate;
    }
    if (!payoutId && OriginatorConversationID) {
      const origRes = await db.query(
        "SELECT id FROM payouts WHERE b2c_result::text ILIKE $1 LIMIT 1",
        [`%${OriginatorConversationID}%`],
      ).catch(() => ({ rows: [] }));
      const candidate = origRes.rows[0]?.id || null;
      if (candidate && UUID_RE.test(candidate)) payoutId = candidate;
    }

    if (!payoutId) {
      console.error("[MPESA] B2C timeout: could not resolve a valid UUID payoutId");
      return;
    }

    const payoutRes = await db.query("SELECT * FROM payouts WHERE id=$1", [payoutId]);
    const payout = payoutRes.rows[0];
    if (!payout || payout.status === "failed" || payout.status === "completed" || payout.status === "refunded") return;

    // Mark as failed and refund — same as a failure result
    await db.query(
      "UPDATE payouts SET status='failed', b2c_error='B2C request timed out — Safaricom did not process in time', queued_for_manual=true WHERE id=$1",
      [payoutId],
    );

    const refundTotal = parseFloat(payout.amount) + parseFloat(payout.fee || 0);
    await creditWallet(
      payout.uid,
      WALLET_TYPES.WITHDRAWABLE,
      refundTotal,
      payout.reference,
      `B2C timeout refund (ref: ${payout.reference})`,
    ).catch(e => console.error("[MPESA] B2C timeout refund error:", e.message));

    if (parseFloat(payout.fee || 0) > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: parseFloat(payout.fee),
        fromWallet: WALLET_TYPES.ACTIVE,
        toWallet: WALLET_TYPES.WITHDRAWABLE,
        fromUid: "platform",
        toUid: payout.uid,
        reference: payout.reference,
        description: `Fee reversal for B2C timeout (ref: ${payout.reference})`,
      }).catch(e => console.error("[MPESA] Timeout fee reversal error:", e.message));
    }

    sendNotification(
      payout.uid,
      "Withdrawal Timed Out — Funds Returned",
      `Your withdrawal of KES ${parseFloat(payout.amount).toFixed(2)} timed out before M-Pesa could process it. KES ${refundTotal.toFixed(2)} has been returned to your wallet. Please try again.`,
      "warning",
    );
    io.to(payout.uid).emit("walletUpdate");

    const admins = await db.query("SELECT uid FROM users WHERE role='admin'").catch(() => ({ rows: [] }));
    for (const row of admins.rows) {
      sendNotification(
        row.uid,
        "B2C Payout Timed Out",
        `Payout ${payoutId} (KES ${parseFloat(payout.amount).toFixed(2)} to ${payout.phone_number}) timed out. Funds auto-refunded.`,
        "warning",
      );
    }
    console.warn(`[MPESA] B2C TIMEOUT payoutId=${payoutId} — funds refunded`);
  } catch (e) {
    console.error("[MPESA] B2C timeout processing error:", e);
  }
});

// ---- WALLET ----

app.get("/api/wallet", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const cached = await cache.get(cache.walletCacheKey(uid));
    if (cached) return res.json(cached);

    // Ensure wallets exist (sequential to avoid race conditions)
    await ensureWallet(uid, WALLET_TYPES.ACTIVE);
    await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);

    // Consolidated query: Get wallet states AND balances AND transactions in one go
    const result = await db.query(
      `SELECT
        -- Wallet states
        (SELECT row_to_json(w) FROM (
          SELECT uid, wallet_type, status, balance, frozen_balance, created_at, updated_at
          FROM wallets
          WHERE uid = $1 AND wallet_type = 'active'
        ) w) AS active_wallet,
        (SELECT row_to_json(w) FROM (
          SELECT uid, wallet_type, status, balance, frozen_balance, created_at, updated_at
          FROM wallets
          WHERE uid = $1 AND wallet_type = 'withdrawable'
        ) w) AS withdrawable_wallet,
        -- Computed balances from ledger
        (SELECT COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'active' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'active' THEN amount ELSE 0 END), 0) FROM ledger) AS active_balance,
        (SELECT COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'escrow' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'escrow' THEN amount ELSE 0 END), 0) FROM ledger) AS escrow_balance,
        (SELECT COALESCE(SUM(CASE WHEN to_uid = $1 AND to_wallet = 'withdrawable' THEN amount ELSE 0 END - CASE WHEN from_uid = $1 AND from_wallet = 'withdrawable' THEN amount ELSE 0 END), 0) FROM ledger) AS withdrawable_balance,
        -- Recent transactions
        (SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM ledger
          WHERE from_uid = $1 OR to_uid = $1
          ORDER BY created_at DESC
          LIMIT 50
        ) t) AS transactions`,
      [uid],
    );

    const row = result.rows[0];
    const activeWallet = row.active_wallet || {
      balance: 0,
      frozen_balance: 0,
      status: WALLET_STATUS.ACTIVE,
    };
    const withdrawableWallet = row.withdrawable_wallet || {
      balance: 0,
      frozen_balance: 0,
      status: WALLET_STATUS.ACTIVE,
    };
    const activeBalance = parseFloat(parseFloat(row.active_balance).toFixed(2));
    const escrowBalance = parseFloat(parseFloat(row.escrow_balance).toFixed(2));
    const withdrawableBalance = parseFloat(
      parseFloat(row.withdrawable_balance).toFixed(2),
    );

    const body = {
      activeBalance: Math.max(
        activeBalance,
        parseFloat(activeWallet.balance || 0),
      ),
      escrowBalance,
      withdrawableBalance: Math.max(
        withdrawableBalance,
        parseFloat(withdrawableWallet.balance || 0),
      ),
      frozenBalance: parseFloat(activeWallet.frozen_balance || 0),
      status: activeWallet.status || WALLET_STATUS.ACTIVE,
      transactions: row.transactions || [],
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

      const withdrawableBalance = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
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
      const normalizedPhone = phoneNumber.replace(/^0+/, "254").replace(/^\+?254/, "254");

      // ── Step 1: Create payout record in PENDING state before touching the ledger ──
      await db.query(
        "INSERT INTO payouts (id, uid, amount, fee, net_amount, method, phone_number, status, reference, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [payoutId, uid, parsedAmount, fee, netAmount, "mpesa", normalizedPhone, "pending", txnRef, Date.now()],
      );

      // ── Step 2: Initiate B2C BEFORE debiting the wallet ──────────────────────
      // We debit only after Safaricom acknowledges the request. If B2C fails we
      // never touch the ledger, so the user's funds stay safe.
      let b2cAccepted = false;
      try {
        const b2cResult = await b2cPayment(
          normalizedPhone,
          netAmount,
          "AgriConnect payout " + txnRef,
          payoutId, // ← this becomes Occasion, echoed back in the B2C result callback
        );
        await db.query(
          "UPDATE payouts SET b2c_result=$1, initiated_at=$2 WHERE id=$3",
          [JSON.stringify(b2cResult), Date.now(), payoutId],
        );
        b2cAccepted = true;
        console.log(`[MPESA] B2C accepted for payoutId=${payoutId} ConversationID=${b2cResult.ConversationID}`);
      } catch (b2cErr) {
        // B2C initiation rejected outright — abort cleanly, no ledger debit
        await db.query(
          "UPDATE payouts SET status='failed', b2c_error=$1 WHERE id=$2",
          [b2cErr.message, payoutId],
        );
        console.error("[MPESA] B2C initiation failed:", b2cErr.message);
        return res.status(502).json({
          error: "M-Pesa transfer could not be initiated: " + b2cErr.message +
                 ". No funds have been deducted. Please try again.",
        });
      }

      // ── Step 3: Debit wallet only after B2C is accepted ───────────────────────
      if (b2cAccepted) {
        await debitWallet(
          uid,
          WALLET_TYPES.WITHDRAWABLE,
          parsedAmount,
          txnRef,
          "Withdrawal to M-Pesa " + normalizedPhone,
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
          "INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            uid, "withdrawal", -parsedAmount, fee,
            (await getWalletState(uid, WALLET_TYPES.WITHDRAWABLE))?.balance || 0,
            txnRef,
            "Withdrawal to M-Pesa " + normalizedPhone + " (fee: KES " + fee.toFixed(2) + ")",
            Date.now(),
          ],
        );
        // Mark payout as approved (B2C is processing; final status comes via callback)
        await db.query(
          "UPDATE payouts SET approved_at=$1 WHERE id=$2",
          [Date.now(), payoutId],
        );
      }

      if (idempotencyKey) {
        await recordIdempotency(idempotencyKey, { status: "pending", reference: txnRef, payoutId });
      }

      // ── Step 4: Notify ────────────────────────────────────────────────────────
      const adminResult = await db.query("SELECT uid FROM users WHERE role='admin'");
      for (const row of adminResult.rows) {
        sendNotification(row.uid, "New Withdrawal", "KES " + parsedAmount.toFixed(2) + " withdrawal initiated by " + uid, "info");
      }
      const userResult = await db.query("SELECT email, display_name FROM users WHERE uid=$1", [uid]);
      const userData = userResult.rows[0] || {};
      if (userData.email) {
        sendEmail(userData.email, "Withdrawal Initiated - AgriConnect",
          withdrawalEmail(userData.display_name || "User", parsedAmount, "Reference: " + txnRef));
      }
      sendNotification(uid, "Withdrawal Processing",
        `KES ${netAmount.toFixed(2)} is being sent to your M-Pesa (${normalizedPhone}). You will receive an M-Pesa confirmation shortly.`,
        "info");
      io.to(uid).emit("walletUpdate");

      res.json({
        message: "Withdrawal initiated — M-Pesa transfer is processing",
        reference: txnRef,
        payoutId,
        amount: parsedAmount,
        fee,
        netAmount,
      });
      io.emit("payoutUpdate", { action: "created", id: payoutId });
    } catch (e) {
      console.error("Withdrawal error:", e);
      res.status(400).json({ error: e.message || "Failed to process withdrawal" });
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
    res.json({
      id,
      title: title || "New chat",
      created_at: now,
      updated_at: now,
    });
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
    await db.query("DELETE FROM ai_chat_sessions WHERE id = $1 AND uid = $2", [
      sessionId,
      req.user.uid,
    ]);
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
      userParts.push({
        inline_data: { mime_type: imageMime, data: base64Data },
      });
      // If no text was sent with an image, add a prompt so Gemini analyses it
      if (!message || !message.trim()) {
        userParts.unshift({
          text: "Please analyse this image and give me agricultural advice based on what you see.",
        });
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
            parts.push({
              inline_data: {
                mime_type: row.image_mime || "image/jpeg",
                data: row.image_data,
              },
            });
          }
          if (parts.length > 0) {
            historyContents.push({
              role: row.role === "bot" ? "model" : "user",
              parts,
            });
          }
        }
      } catch (histErr) {
        console.warn(
          "[AI] Could not load history (non-fatal):",
          histErr.message,
        );
      }
    }

    // ---- Build Gemini payload with full conversation history ----
    const contents = [...historyContents, { role: "user", parts: userParts }];

    const payload = {
      contents,
      system_instruction: { parts: [{ text: AI_SYSTEM_INSTRUCTION }] },
      safety_settings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
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
          ? image.includes(",")
            ? image.split(",")[1]
            : image
          : null;
        // User message
        await db.query(
          "INSERT INTO ai_chat_messages (id, session_id, role, content, image_data, image_mime, has_image, created_at) VALUES (gen_random_uuid(), $1, 'user', $2, $3, $4, $5, $6)",
          [
            sessionId,
            message ? message.trim() : null,
            imageBase64,
            imageMime,
            !!image,
            now,
          ],
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
        console.warn(
          "[AI] Could not save message (non-fatal):",
          saveErr.message,
        );
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
    body("deliveryNotes").optional().isString().isLength({ max: 500 }),
    body("quantityText").optional().isString().isLength({ max: 100 }),
  ],
  validate,
  checkIdempotency,
  async (req, res) => {
    const { listingId, farmerUid, quantity, totalPrice, idempotencyKey, deliveryNotes } =
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
        (deliveryNotes || "").trim() || null,
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
          <p>Dear ${buyerData.display_name || "Customer"},</p>
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
        message:
          "Order marked as dispatched. OTP sent to buyer for verification.",
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
      .isIn(["processing", "delivering", "dispatched", "completed"]),
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
      const flow = ["processing", "delivering", "dispatched", "completed"];
      const currentIdx = flow.indexOf(order.status);
      const nextIdx = flow.indexOf(status);
      if (currentIdx === -1 || nextIdx === -1 || nextIdx !== currentIdx + 1) {
        return res.status(400).json({
          error:
            "Invalid status transition from " + order.status + " to " + status,
        });
      }
      const now = Date.now();
      if (status === "dispatched") {
        // Generate OTP for delivery verification
        const otp = generateOTP();
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
        const otpExpiry = now + 24 * 60 * 60 * 1000;

        await db.query(
          "UPDATE escrow_orders SET status = 'dispatched', dispatched_at = $1, updated_at = $1, otp_hash = $2, otp_expires_at = $3 WHERE id = $4",
          [now, otpHash, otpExpiry, id],
        );
        await db.query(
          "UPDATE orders SET status = 'dispatched', updated_at = $1 WHERE id = $2",
          [now, id],
        );

        const buyerResult = await db.query(
          "SELECT email, display_name FROM users WHERE uid = $1",
          [order.buyer_uid],
        );
        const buyerData = buyerResult.rows[0] || {};

        sendNotification(
          order.buyer_uid,
          "Order Dispatched - Verify Delivery",
          `Order #${id} has been dispatched. Use OTP: ${otp} to confirm delivery. You have 24 hours to verify or dispute.`,
          "info",
        );
        sendNotification(
          order.seller_uid,
          "Order Dispatched",
          "Order #" + id + " has been marked as dispatched. OTP sent to buyer.",
          "info",
        );

        if (buyerData.email) {
          sendEmail(
            buyerData.email,
            "Order Dispatched - Verify Delivery",
            `
            <h2>Order Dispatched</h2>
            <p>Dear ${buyerData.display_name || "Customer"},</p>
            <p>Your order #${id} has been marked as dispatched by the seller.</p>
            <p><strong>Verification OTP: ${otp}</strong></p>
            <p>Please verify delivery using this OTP within 24 hours, or raise a dispute if there are issues.</p>
            <p>Thank you for using AgriConnect!</p>
            `,
          );
        }
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
          error:
            "Can only reject dispatched orders. Current status: " +
            order.status,
        });

      if (order.dispute_opened)
        return res.status(400).json({
          error: "A dispute is already open for this order",
        });

      // Create dispute for the rejected delivery
      const disputeId = await raiseDispute(
        id,
        uid,
        `Delivery rejected: ${reason}`,
        evidenceUrls || [],
      );

      res.json({
        message:
          "Delivery rejected and dispute created. Funds are frozen pending review.",
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

// ── Receipt / Invoice download ────────────────────────────────────────────
app.get("/api/orders/:id/receipt", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const docType = req.query.type === "invoice" ? "invoice" : "receipt";
  try {
    // 1. Verify the order exists and the requester is a party to it
    const orderRes = await db.query(
      `SELECT id, buyer_uid, seller_uid, status, amount, quantity,
              listing_id, reference, created_at, completed_at, updated_at
       FROM escrow_orders WHERE id = $1`, [id]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.buyer_uid !== req.user.uid && order.seller_uid !== req.user.uid) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (order.status !== "completed") {
      return res.status(400).json({ error: "Documents only available for completed orders" });
    }

    // 2. Look up the stored document record in the database
    const docRes = await db.query(
      "SELECT filename, filepath, file_size FROM order_documents WHERE order_id = $1 AND doc_type = $2",
      [id, docType]
    );
    const doc = docRes.rows[0];

    if (doc && fs.existsSync(doc.filepath) && req.query.regen !== "1") {
      // 3a. File exists on disk — serve directly from filesystem
      console.log(`[RECEIPTS] Serving cached ${doc.filename} for order ${id}`);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${doc.filename}"`);
      if (doc.file_size > 0) res.setHeader("Content-Length", parseInt(doc.file_size));
      return fs.createReadStream(doc.filepath).pipe(res);
    }

    // 3b. Not on disk yet (e.g. older order) — regenerate, save, register, then serve
    console.log(`[RECEIPTS] Regenerating ${docType} for order ${id}`);
    const [sellerRes, buyerRes] = await Promise.all([
      db.query("SELECT email, display_name FROM users WHERE uid = $1", [order.seller_uid]),
      db.query("SELECT email, display_name FROM users WHERE uid = $1", [order.buyer_uid]),
    ]);
    const sellerData = sellerRes.rows[0] || {};
    const buyerData  = buyerRes.rows[0]  || {};

    let productTitle = "Product";
    let productImage = null;
    if (order.listing_id) {
      try {
        const listingRes = await db.query(
          "SELECT title, images FROM listings WHERE id = $1", [order.listing_id]
        );
        const listing = listingRes.rows[0];
        if (listing) {
          productTitle = listing.title || "Product";
          const imgs = Array.isArray(listing.images) ? listing.images
            : (listing.images ? JSON.parse(listing.images) : []);
          productImage = imgs[0] || null;
        }
      } catch (e) { /* non-fatal */ }
    }

    const amt = parseFloat(order.amount) || 0;
    const fee = getTransactionFee(amt);
    const netAmount = parseFloat((amt - fee).toFixed(2));
    const shortId = id.substring(0, 8).toUpperCase();

    const pdfData = {
      orderId: id,
      reference:            order.reference || "—",
      completedAt:          Number(order.completed_at || order.updated_at) || Date.now(),
      createdAt:            Number(order.created_at) || Date.now(),
      buyerName:            buyerData.display_name  || "Buyer",
      buyerEmail:           buyerData.email         || "",
      sellerName:           sellerData.display_name || "Seller",
      sellerEmail:          sellerData.email        || "",
      productTitle, productImage,
      quantity:             parseInt(order.quantity) || 1,
      unitPrice:            parseFloat((amt / (parseInt(order.quantity) || 1)).toFixed(2)),
      totalAmount: amt, fee, netAmount,
      deliveryInstructions: order.delivery_instructions || null,
    };

    const generator = docType === "invoice" ? generateInvoicePDF : generateReceiptPDF;
    const pdfBuf = await generator(pdfData);
    const filename = docType === "invoice" ? `Invoice-${shortId}.pdf` : `Receipt-${shortId}.pdf`;
    const filepath = path.join(RECEIPTS_DIR, filename);

    // Delete old stale file if it exists before writing fresh one
    if (fs.existsSync(filepath)) {
      await fs.promises.unlink(filepath).catch(() => {});
    }

    // Save to disk
    await fs.promises.writeFile(filepath, pdfBuf);

    // Register in DB (upsert)
    await db.query(
      `INSERT INTO order_documents (order_id, doc_type, filename, filepath, file_size, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id, doc_type) DO UPDATE
       SET filename = EXCLUDED.filename, filepath = EXCLUDED.filepath,
           file_size = EXCLUDED.file_size, created_at = EXCLUDED.created_at`,
      [id, docType, filename, filepath, pdfBuf.length, Date.now()],
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuf.length);
    res.send(pdfBuf);

  } catch (e) {
    console.error("[RECEIPT] Download error:", e);
    res.status(500).json({ error: "Failed to generate document" });
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

// ── Farmer performance stats ──────────────────────────────────────────────────
app.get("/api/farmer/stats", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const [ordersRes, listingsRes, agreementsRes, userRes, walletRes] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)                                                           AS total_orders,
           COUNT(*) FILTER (WHERE status = 'completed')                      AS completed_orders,
           COUNT(*) FILTER (WHERE status = 'in_escrow')                      AS pending_orders,
           COUNT(*) FILTER (WHERE status IN ('cancelled','refunded'))        AS cancelled_orders,
           COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)      AS total_revenue
         FROM escrow_orders WHERE seller_uid = $1`,
        [uid],
      ),
      db.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active
         FROM listings WHERE uid = $1`,
        [uid],
      ),
      db.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active
         FROM agreements WHERE farmer_uid = $1`,
        [uid],
      ),
      db.query(
        `SELECT display_name, phone_number, bio, location, produce, business_name,
                image_urls, photo_url, is_verified, created_at
         FROM users WHERE uid = $1`,
        [uid],
      ),
      db.query(
        `SELECT COALESCE(SUM(balance), 0) AS total_balance
         FROM wallets WHERE uid = $1`,
        [uid],
      ),
    ]);

    const o = ordersRes.rows[0];
    const l = listingsRes.rows[0];
    const a = agreementsRes.rows[0];
    const u = userRes.rows[0] || {};

    // Profile completion: each filled field = points out of 100
    const parseJsonSafe = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === 'object') return Object.values(val);
      try { return JSON.parse(val); } catch { return []; }
    };
    const profileFields = [
      u.display_name?.trim(),
      u.phone_number?.trim(),
      u.bio?.trim(),
      u.location?.trim(),
      u.produce?.trim(),
      u.business_name?.trim(),
      u.photo_url?.trim(),
      parseJsonSafe(u.image_urls).length > 0 ? 'yes' : null,
    ];
    const filledCount = profileFields.filter(Boolean).length;
    const profileCompletion = Math.round((filledCount / profileFields.length) * 100);

    // Engagement: (total orders received / max(active listings, 1)) × 25, capped at 100
    const totalOrders = parseInt(o.total_orders || 0);
    const activeListings = parseInt(l.active || 0);
    const engagementRaw = activeListings > 0
      ? Math.min(100, Math.round((totalOrders / Math.max(activeListings, 1)) * 25))
      : (totalOrders > 0 ? 40 : 0);

    // Trust: ratio of completed to non-pending orders, weighted by verification
    const completedOrders = parseInt(o.completed_orders || 0);
    const cancelledOrders = parseInt(o.cancelled_orders || 0);
    const settledOrders = completedOrders + cancelledOrders;
    let trustScore = 100;
    if (settledOrders > 0) {
      trustScore = Math.round((completedOrders / settledOrders) * 100);
    }
    if (u.is_verified) trustScore = Math.min(100, trustScore + 5);

    // Achievements
    const accountAgeMs = Date.now() - Number(u.created_at || 0);
    const achievements = {
      firstLogin:      true,
      profileComplete: profileCompletion >= 80,
      firstListing:    parseInt(l.total || 0) > 0,
      firstSale:       completedOrders > 0,
      firstConnection: parseInt(a.total || 0) > 0,
      tenSales:        completedOrders >= 10,
      verified:        !!u.is_verified,
      veteran:         accountAgeMs > 90 * 24 * 60 * 60 * 1000, // 90 days
    };

    res.json({
      totalSales:        completedOrders,
      totalRevenue:      parseFloat(o.total_revenue || 0),
      pendingOrders:     parseInt(o.pending_orders || 0),
      totalOrders,
      activeListings,
      totalListings:     parseInt(l.total || 0),
      activeAgreements:  parseInt(a.active || 0),
      totalAgreements:   parseInt(a.total || 0),
      profileCompletion,
      engagementScore:   engagementRaw,
      trustScore,
      achievements,
      isVerified:        !!u.is_verified,
    });
  } catch (e) {
    console.error("[FARMER STATS]", e);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── Farmer chart data — last 6 months bucketed by month ──────────────────────
app.get("/api/farmer/charts", authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    // Build last-6-month labels
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: d.toLocaleString("en-KE", { month: "short", year: "2-digit" }),
        year: d.getFullYear(),
        month: d.getMonth() + 1, // 1-based
      });
    }

    // Sales (completed orders) & earnings per month
    const salesRows = await db.query(
      `SELECT
         EXTRACT(YEAR  FROM TO_TIMESTAMP(created_at / 1000)) AS yr,
         EXTRACT(MONTH FROM TO_TIMESTAMP(created_at / 1000)) AS mo,
         COUNT(*)                        AS cnt,
         COALESCE(SUM(amount), 0)        AS revenue
       FROM escrow_orders
       WHERE seller_uid = $1
         AND status = 'completed'
         AND created_at >= $2
       GROUP BY yr, mo`,
      [uid, now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000],
    );

    // All orders per month (for volume chart)
    const ordersRows = await db.query(
      `SELECT
         EXTRACT(YEAR  FROM TO_TIMESTAMP(created_at / 1000)) AS yr,
         EXTRACT(MONTH FROM TO_TIMESTAMP(created_at / 1000)) AS mo,
         COUNT(*) AS cnt
       FROM escrow_orders
       WHERE seller_uid = $1
         AND created_at >= $2
       GROUP BY yr, mo`,
      [uid, now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000],
    );

    // Order status breakdown (all time)
    const statusRows = await db.query(
      `SELECT status, COUNT(*) AS cnt
       FROM escrow_orders
       WHERE seller_uid = $1
       GROUP BY status`,
      [uid],
    );

    // Map into per-month arrays aligned with labels
    const salesMap = {};
    const revenueMap = {};
    for (const r of salesRows.rows) {
      const key = `${parseInt(r.yr)}-${parseInt(r.mo)}`;
      salesMap[key] = parseInt(r.cnt);
      revenueMap[key] = parseFloat(r.revenue);
    }
    const ordersMap = {};
    for (const r of ordersRows.rows) {
      ordersMap[`${parseInt(r.yr)}-${parseInt(r.mo)}`] = parseInt(r.cnt);
    }

    const salesData    = months.map(m => salesMap[`${m.year}-${m.month}`]   || 0);
    const revenueData  = months.map(m => revenueMap[`${m.year}-${m.month}`] || 0);
    const ordersData   = months.map(m => ordersMap[`${m.year}-${m.month}`]  || 0);
    const labels       = months.map(m => m.label);

    // Status breakdown
    const statusData = {};
    for (const r of statusRows.rows) {
      statusData[r.status] = parseInt(r.cnt);
    }

    res.json({ labels, salesData, revenueData, ordersData, statusData });
  } catch (e) {
    console.error("[FARMER CHARTS]", e);
    res.status(500).json({ error: "Failed to fetch chart data" });
  }
});
app.put(
  "/api/listings/:id",
  authenticateJWT,
  sanitizeInput,
  [
    body("title").isString().notEmpty(),
    body("description").isString().notEmpty(),
    body("price").isFloat({ min: 0.01 }),
  ],
  validate,
  async (req, res) => {
    const { id } = req.params;
    const uid = req.user.uid;
    const {
      title,
      description,
      price,
      category,
      location,
      quantity,
      imageUrls,
      status,
    } = req.body;
    try {
      // Ensure the listing belongs to this farmer
      const existing = await db.query(
        "SELECT * FROM listings WHERE id = $1 AND uid = $2",
        [id, uid],
      );
      if (!existing.rows.length) {
        return res
          .status(404)
          .json({ error: "Listing not found or access denied" });
      }
      const now = Date.now();
      // Only update imageUrls if new ones were supplied
      const newImageUrls =
        Array.isArray(imageUrls) && imageUrls.length > 0
          ? imageUrls
          : existing.rows[0].image_urls;
      // Only update status if provided, otherwise keep existing
      const newStatus = status || existing.rows[0].status || "active";
      await db.query(
        `UPDATE listings
           SET title=$1, description=$2, price=$3, category=$4, location=$5,
               quantity=$6, image_urls=$7::jsonb, updated_at=$8, status=$9
         WHERE id=$10 AND uid=$11`,
        [
          title,
          description,
          parseFloat(price),
          category || "",
          location || "",
          quantity || "",
          JSON.stringify(newImageUrls || []),
          now,
          newStatus,
          id,
          uid,
        ],
      );
      // Bust listings cache
      try {
        await cache.del("listings:all");
      } catch (_) {}
      io.emit("productUpdate");
      res.json({ message: "Listing updated", id });
    } catch (e) {
      console.error("Listing update error:", e);
      res.status(500).json({ error: "Failed to update listing" });
    }
  },
);

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
        "INSERT INTO agreements (id, farmer_uid, org_uid, terms, status, initiated_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [agreementId, finalFarmerUid, finalOrgUid, terms || "", "pending", myUid, now],
      );
      res.status(201).json({
        id: agreementId,
        farmer_uid: finalFarmerUid,
        org_uid: finalOrgUid,
        initiated_by: myUid,
        terms: terms || "",
        status: "pending",
        created_at: now,
      });
    } catch (e) {
      console.error("[AGREEMENTS POST]", e);
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
    if (!["active", "rejected", "cancelled", "terminated"].includes(status))
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
      // Role-based status guards — the RECIPIENT (non-initiator) accepts/rejects; either party can cancel/terminate
      const initiatedBy = agreement.initiated_by || agreement.org_uid; // fallback for old rows
      const isRecipient = uid !== initiatedBy;
      if ((status === "active" || status === "rejected") && !isRecipient)
        return res.status(403).json({ error: "Only the agreement recipient can accept or reject" });
      await db.query(
        "UPDATE agreements SET status = $1, updated_at = $2 WHERE id = $3",
        [status, Date.now(), id],
      );
      // Notify the other party
      const otherUid = uid === agreement.farmer_uid ? agreement.org_uid : agreement.farmer_uid;
      const actionMap = { active: "accepted", rejected: "rejected", cancelled: "cancelled", terminated: "terminated" };
      sendNotification(otherUid, "Agreement " + (actionMap[status] || status),
        `Your partnership agreement has been ${actionMap[status] || status}.`, status === "active" ? "success" : "warning");
      res.json({ id, status, message: "Agreement " + status });
    } catch (e) {
      console.error("[AGREEMENTS PATCH]", e);
      res.status(500).json({ error: "Failed to update agreement" });
    }
  },
);

// ── Get single agreement ──────────────────────────────────────────────────────
app.get("/api/agreements/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const result = await db.query(
      `SELECT a.*,
        farmer.display_name AS farmer_name, farmer.email AS farmer_email,
        farmer.phone_number AS farmer_phone, farmer.location AS farmer_location,
        farmer.bio AS farmer_bio, farmer.produce AS farmer_produce,
        farmer.business_name AS farmer_business,
        org.display_name AS org_name, org.email AS org_email,
        org.phone_number AS org_phone, org.location AS org_location,
        org.business_name AS org_business
       FROM agreements a
       LEFT JOIN users farmer ON a.farmer_uid = farmer.uid
       LEFT JOIN users org ON a.org_uid = org.uid
       WHERE a.id = $1`,
      [id],
    );
    const agreement = result.rows[0];
    if (!agreement) return res.status(404).json({ error: "Agreement not found" });
    if (agreement.farmer_uid !== uid && agreement.org_uid !== uid)
      return res.status(403).json({ error: "Not authorized" });
    res.json(agreement);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch agreement" });
  }
});

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
        "SELECT display_name, business_name FROM users WHERE uid = $1",
        [uid],
      );
      const userData = userResult.rows[0] || {};
      const displayName =
        userData.display_name ||
        userData.business_name ||
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

// ======================== Forum Posts ========================

// One-time flag — tables created at most once per worker process
let _forumTablesReady = false;
async function ensureForumTables() {
  if (_forumTablesReady) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS forum_posts (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      banner_image TEXT DEFAULT '',
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS forum_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      parent_comment_id TEXT DEFAULT NULL,
      content TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS forum_likes (
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      UNIQUE (target_type, target_id, uid)
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS request_replies (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      message TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    )`);
    _forumTablesReady = true;
    console.log("[FORUM] Tables verified/created");
  } catch (e) {
    console.error("[FORUM] Table setup error:", e.message);
  }
}

app.get("/api/forum/posts", authenticateJWT, async (req, res) => {
  await ensureForumTables();
  const uid = req.user.uid;
  try {
    const result = await db.query(
      `SELECT fp.*, u.display_name, u.photo_url, u.is_verified,
              (SELECT COUNT(*) FROM forum_likes fl WHERE fl.target_type = 'post' AND fl.target_id::text = fp.id::text) AS like_count,
              EXISTS(SELECT 1 FROM forum_likes fl WHERE fl.target_type = 'post' AND fl.target_id::text = fp.id::text AND fl.uid::text = $1::text) AS user_liked,
              (SELECT COUNT(*) FROM forum_comments fc WHERE fc.post_id::text = fp.id::text) AS comment_count
       FROM forum_posts fp
       LEFT JOIN users u ON fp.uid::text = u.uid::text
       ORDER BY fp.created_at DESC`,
      [uid],
    );
    const list = result.rows.map((r) => ({
      id: r.id,
      uid: r.uid,
      title: r.title,
      content: r.content,
      bannerImage: r.banner_image || "",
      displayName: r.display_name || "Unknown",
      photoURL: r.photo_url || "",
      isVerified: !!r.is_verified,
      createdAt: r.created_at,
      likeCount: parseInt(r.like_count),
      userLiked: !!r.user_liked,
      commentCount: parseInt(r.comment_count),
    }));
    res.json(list);
  } catch (e) {
    console.error("Forum get error:", e);
    res.status(500).json({ error: "Failed to fetch forum posts" });
  }
});

app.post("/api/forum/posts", authenticateJWT, sanitizeInput, async (req, res) => {
  const { title, content, bannerImage } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Title is required" });
  }
  const uid = req.user.uid;
  const id = uuidv4();
  const now = Date.now();
  try {
    await db.query(
      "INSERT INTO forum_posts (id, uid, title, content, banner_image, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, uid, title.trim(), (content || "").trim(), bannerImage || "", now],
    );
    res.status(201).json({ id, message: "Post created" });
  } catch (e) {
    console.error("Forum post error:", e);
    res.status(500).json({ error: "Failed to create post" });
  }
});

app.delete("/api/forum/posts/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const result = await db.query("SELECT uid FROM forum_posts WHERE id = $1", [id]);
    const post = result.rows[0];
    if (!post) return res.status(404).json({ error: "Post not found" });
    // Allow author or admin to delete
    const userResult = await db.query("SELECT role FROM users WHERE uid = $1", [uid]);
    const isAdmin = userResult.rows[0]?.role === "admin";
    if (post.uid !== uid && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }
    await db.query("DELETE FROM forum_posts WHERE id = $1", [id]);
    res.json({ message: "Post deleted" });
  } catch (e) {
    console.error("Forum delete error:", e);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ======================== Forum Likes ========================
app.post("/api/forum/posts/:id/like", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const liked = await db.query(
      "INSERT INTO forum_likes (target_type, target_id, uid) VALUES ('post', $1, $2) ON CONFLICT DO NOTHING",
      [id, uid],
    );
    const count = await db.query(
      "SELECT COUNT(*) FROM forum_likes WHERE target_type = 'post' AND target_id = $1",
      [id],
    );
    res.json({ liked: true, likeCount: parseInt(count.rows[0].count) });
  } catch (e) {
    console.error("Like post error:", e);
    res.status(500).json({ error: "Failed to like post" });
  }
});

app.delete("/api/forum/posts/:id/like", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    await db.query(
      "DELETE FROM forum_likes WHERE target_type = 'post' AND target_id = $1 AND uid = $2",
      [id, uid],
    );
    const count = await db.query(
      "SELECT COUNT(*) FROM forum_likes WHERE target_type = 'post' AND target_id = $1",
      [id],
    );
    res.json({ liked: false, likeCount: parseInt(count.rows[0].count) });
  } catch (e) {
    console.error("Unlike post error:", e);
    res.status(500).json({ error: "Failed to unlike post" });
  }
});

app.post("/api/forum/comments/:id/like", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    await db.query(
      "INSERT INTO forum_likes (target_type, target_id, uid) VALUES ('comment', $1, $2) ON CONFLICT DO NOTHING",
      [id, uid],
    );
    const count = await db.query(
      "SELECT COUNT(*) FROM forum_likes WHERE target_type = 'comment' AND target_id = $1",
      [id],
    );
    res.json({ liked: true, likeCount: parseInt(count.rows[0].count) });
  } catch (e) {
    console.error("Like comment error:", e);
    res.status(500).json({ error: "Failed to like comment" });
  }
});

app.delete("/api/forum/comments/:id/like", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    await db.query(
      "DELETE FROM forum_likes WHERE target_type = 'comment' AND target_id = $1 AND uid = $2",
      [id, uid],
    );
    const count = await db.query(
      "SELECT COUNT(*) FROM forum_likes WHERE target_type = 'comment' AND target_id = $1",
      [id],
    );
    res.json({ liked: false, likeCount: parseInt(count.rows[0].count) });
  } catch (e) {
    console.error("Unlike comment error:", e);
    res.status(500).json({ error: "Failed to unlike comment" });
  }
});

// ======================== Forum Comments ========================
app.get("/api/forum/posts/:id/comments", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const comments = await db.query(
      `SELECT fc.*, u.display_name, u.photo_url, u.is_verified,
              (SELECT COUNT(*) FROM forum_likes fl WHERE fl.target_type = 'comment' AND fl.target_id = fc.id) AS like_count,
              EXISTS(SELECT 1 FROM forum_likes fl WHERE fl.target_type = 'comment' AND fl.target_id = fc.id AND fl.uid = $1::text) AS user_liked
       FROM forum_comments fc
       LEFT JOIN users u ON fc.uid = u.uid::text
       WHERE fc.post_id = $2 AND fc.parent_comment_id IS NULL
       ORDER BY fc.created_at ASC`,
      [uid, id],
    );

    // Fetch replies for each comment
    for (const c of comments.rows) {
      const replies = await db.query(
        `SELECT fc.*, u.display_name, u.photo_url, u.is_verified,
                (SELECT COUNT(*) FROM forum_likes fl WHERE fl.target_type = 'comment' AND fl.target_id = fc.id) AS like_count,
                EXISTS(SELECT 1 FROM forum_likes fl WHERE fl.target_type = 'comment' AND fl.target_id = fc.id AND fl.uid = $1::text) AS user_liked
         FROM forum_comments fc
         LEFT JOIN users u ON fc.uid = u.uid::text
         WHERE fc.parent_comment_id = $2
         ORDER BY fc.created_at ASC`,
        [uid, c.id],
      );
      c.replies = replies.rows;
    }

    res.json(comments.rows);
  } catch (e) {
    console.error("Get comments error:", e);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

app.post("/api/forum/posts/:id/comments", authenticateJWT, sanitizeInput, async (req, res) => {
  const { id } = req.params;
  const { content, parentCommentId } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Content required" });
  const uid = req.user.uid;
  const now = Date.now();
  try {
    const commentId = uuidv4();
    await db.query(
      "INSERT INTO forum_comments (id, post_id, uid, parent_comment_id, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [commentId, id, uid, parentCommentId || null, content.trim(), now],
    );
    const userResult = await db.query("SELECT display_name, photo_url, is_verified FROM users WHERE uid = $1", [uid]);
    const user = userResult.rows[0] || {};
    res.status(201).json({
      id: commentId,
      post_id: id,
      uid,
      parent_comment_id: parentCommentId || null,
      content: content.trim(),
      created_at: now,
      display_name: user.display_name || "Unknown",
      photo_url: user.photo_url || "",
      is_verified: !!user.is_verified,
      like_count: 0,
      user_liked: false,
      replies: [],
    });
  } catch (e) {
    console.error("Create comment error:", e);
    res.status(500).json({ error: "Failed to create comment" });
  }
});

app.delete("/api/forum/comments/:id", authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const result = await db.query("SELECT uid FROM forum_comments WHERE id = $1", [id]);
    const comment = result.rows[0];
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    const userResult = await db.query("SELECT role FROM users WHERE uid = $1", [uid]);
    const isAdmin = userResult.rows[0]?.role === "admin";
    if (comment.uid !== uid && !isAdmin) {
      return res.status(403).json({ error: "Not authorized" });
    }
    await db.query("DELETE FROM forum_comments WHERE id = $1", [id]);
    res.json({ message: "Comment deleted" });
  } catch (e) {
    console.error("Delete comment error:", e);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// ======================== User Profile (Public) ========================
app.get("/api/users/profile/:uid", async (req, res) => {
  const { uid } = req.params;
  try {
    const result = await db.query(
      `SELECT uid, display_name, photo_url, role, is_verified, business_name, location, bio, created_at
       FROM users WHERE uid = $1`,
      [uid],
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    // Get post count
    const postCount = await db.query("SELECT COUNT(*) FROM forum_posts WHERE uid = $1", [uid]);

    res.json({
      uid: user.uid,
      displayName: user.display_name || "Unknown",
      photoURL: user.photo_url || "",
      role: user.role,
      isVerified: !!user.is_verified,
      businessName: user.business_name || "",
      location: user.location || "",
      bio: user.bio || "",
      memberSince: user.created_at,
      postCount: parseInt(postCount.rows[0].count),
    });
  } catch (e) {
    console.error("Get user profile error:", e);
    res.status(500).json({ error: "Failed to fetch profile" });
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
    // Consolidated query - get all counts in a single query
    const result = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT json_agg(row_to_json(t)) FROM (SELECT role, COUNT(*) AS count FROM users GROUP BY role) t) AS role_counts,
        (SELECT COUNT(*) FROM listings) AS total_listings,
        (SELECT COUNT(*) FROM orders) AS total_orders,
        (SELECT COUNT(*) FROM agreements) AS total_agreements,
        (SELECT COUNT(*) FROM requests) AS total_requests,
        (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE type = 'deposit') AS total_deposits,
        (SELECT COALESCE(SUM(net_amount), 0) FROM payouts WHERE status = 'approved') AS total_payouts`,
    );

    const stats = result.rows[0];
    const totalDeposits = parseFloat(stats.total_deposits) || 0;
    const totalPayouts = parseFloat(stats.total_payouts) || 0;

    // Convert role_counts from array to object
    const roleCounts = {};
    if (stats.role_counts) {
      stats.role_counts.forEach((r) => {
        roleCounts[r.role || "unknown"] = parseInt(r.count);
      });
    }

    res.json({
      totalUsers: parseInt(stats.total_users),
      totalListings: parseInt(stats.total_listings),
      totalOrders: parseInt(stats.total_orders),
      totalAgreements: parseInt(stats.total_agreements),
      activeRequests: parseInt(stats.total_requests), // Note: Filtering by status would require additional query
      roleCounts,
      pendingOrders: parseInt(stats.total_orders), // Note: Filtering by status would require additional query
      activeAgreements: parseInt(stats.total_agreements), // Note: Filtering by status would require additional query
      systemBalance: totalDeposits - totalPayouts,
      totalDeposits,
      totalPayouts,
    });
  } catch (e) {
    console.error("Admin stats error:", e);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get(
  "/api/admin/analytics",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      // Consolidated query for analytics data
      const result = await db.query(
        `SELECT
          (SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM orders) t) AS orders,
          (SELECT json_agg(row_to_json(t)) FROM (SELECT uid, created_at FROM users) t) AS users,
          (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE type = 'fee' AND to_uid = 'platform') AS total_fees,
          (SELECT COALESCE(SUM(net_amount),0) FROM payouts WHERE status = 'approved') AS total_payouts`,
      );

      const data = result.rows[0];
      const orders = data.orders || [];
      const users = data.users || [];
      const totalFees = parseFloat(data.total_fees) || 0;
      const totalPaidOut = parseFloat(data.total_payouts) || 0;

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

      const commissionBreakdown = {
        earned: parseFloat(totalFees.toFixed(2)),
        pending: parseFloat(Math.max(0, totalFees - totalPaidOut).toFixed(2)),
        withdrawn: parseFloat(Math.min(totalFees, totalPaidOut).toFixed(2)),
      };

      res.json({
        revenueByDay,
        ordersByDay,
        signupsByDay,
        dayLabels,
        commissionBreakdown,
      });
    } catch (e) {
      console.error("Admin analytics error:", e);
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
      profile: buildProfileObj(u),
      photoURL: u.photo_url,
      phoneNumber: u.phone_number || "",
      isVerified: !!u.is_verified,
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
  [body("role").optional().isString(), body("verified").optional().isBoolean()],
  validate,
  async (req, res) => {
    const { uid } = req.params;
    const { role, verified } = req.body;
    try {
      const setClauses = [];
      const params = [];
      let idx = 1;
      if (role !== undefined) {
        setClauses.push("role = $" + idx);
        params.push(role);
        idx++;
      }
      if (verified !== undefined) {
        setClauses.push("is_verified = $" + idx);
        params.push(verified);
        idx++;
      }
      if (setClauses.length > 0) {
        setClauses.push("updated_at = $" + idx);
        params.push(Date.now());
        idx++;
        params.push(uid);
        await db.query(
          "UPDATE users SET " + setClauses.join(", ") + " WHERE uid = $" + idx,
          params,
        );
      }
      res.json({ message: "User updated" });
    } catch (e) {
      console.error("Admin update user error:", e);
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
      // Union query: get both org orders (orders table) and consumer orders (escrow_orders table)
      const result = await db.query(
        `SELECT
          o.id,
          o.listing_id,
          o.farmer_uid,
          o.org_uid,
          o.quantity,
          o.total_price,
          o.status,
          o.escrow_order_id,
          o.created_at,
          o.updated_at,
          org.display_name AS org_name,
          farmer.display_name AS farmer_name,
          e.status AS escrow_status,
          e.amount AS escrow_amount,
          e.created_at AS escrow_created_at,
          row_to_json(e.*) AS escrow_details,
          org.uid AS org_uid_dup,
          farmer.uid AS farmer_uid_dup
         FROM orders o
         LEFT JOIN users org ON o.org_uid = org.uid
         LEFT JOIN users farmer ON o.farmer_uid = farmer.uid
         LEFT JOIN escrow_orders e ON o.id = e.id

         UNION ALL

         SELECT
          eo.id,
          eo.listing_id,          -- Pulled directly from your escrow_orders schema now!
          eo.seller_uid AS farmer_uid,
          eo.buyer_uid AS org_uid,
          eo.quantity,
          eo.amount AS total_price,
          eo.status,
          eo.id AS escrow_order_id,
          eo.created_at,
          eo.updated_at,          -- Pulled directly from your escrow_orders schema now!
          NULL AS org_name,
          seller.display_name AS farmer_name,
          eo.status AS escrow_status,
          eo.amount AS escrow_amount,
          eo.created_at AS escrow_created_at,
          row_to_json(eo.*) AS escrow_details,
          eo.buyer_uid AS org_uid_dup,
          eo.seller_uid AS farmer_uid_dup
         FROM escrow_orders eo
         LEFT JOIN users seller ON eo.seller_uid = seller.uid
         LEFT JOIN orders o2 ON eo.id = o2.id
         WHERE o2.id IS NULL`,
      );

      const enriched = result.rows.map((o) => {
        const escrowDetails =
          o.escrow_details && o.escrow_details.id ? o.escrow_details : null;
        return {
          id: o.id,
          org_name: o.org_name || (o.org_uid ? "Consumer" : null),
          farmer_name: o.farmer_name || null,
          quantity: o.quantity || 0,
          total_price: o.total_price || o.escrow_amount || 0,
          status: o.status || "pending",
          created_at: o.created_at,
          org_uid: o.org_uid,
          farmer_uid: o.farmer_uid,
          escrowDetails,
        };
      });

      res.json(enriched);
    } catch (e) {
      console.error("Admin orders fetch error:", e);
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
      // Consolidated query using LEFT JOIN to get payouts with user info
      const result = await db.query(
        `SELECT p.*,
          u.display_name AS display_name,
          u.email AS email
         FROM payouts p
         LEFT JOIN users u ON p.uid = u.uid
         ORDER BY p.created_at DESC`,
      );

      res.json(result.rows);
    } catch (e) {
      console.error("Admin payouts fetch error:", e);
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
      const result = await db.query("SELECT * FROM payouts WHERE id = $1", [id]);
      const payout = result.rows[0];
      if (!payout) return res.status(404).json({ error: "Payout not found" });
      if (payout.status === "completed")
        return res.status(400).json({ error: "Payout already completed" });
      if (payout.status === "rejected")
        return res.status(400).json({ error: "Payout was rejected — cannot approve" });

      // Re-initiate B2C for any payout that hasn't successfully completed
      // (covers: queued_for_manual, failed, timed-out, or pending without a prior B2C attempt)
      if (payout.status !== "completed") {
        // If the wallet hasn't been debited yet (failed before debit), debit now
        const alreadyDebited = payout.initiated_at !== null;

        try {
          const b2cResult = await b2cPayment(
            payout.phone_number,
            parseFloat(payout.net_amount || payout.amount),
            "AgriConnect payout " + payout.reference,
            id, // ← payoutId as Occasion for callback matching
          );
          await db.query(
            "UPDATE payouts SET b2c_result=$1, initiated_at=$2, queued_for_manual=false, status='pending', b2c_error=null WHERE id=$3",
            [JSON.stringify(b2cResult), Date.now(), id],
          );

          // If this payout was previously failed+refunded, we need to re-debit
          if (!alreadyDebited || payout.status === "failed") {
            const currentBalance = await computeBalance(payout.uid, WALLET_TYPES.WITHDRAWABLE);
            if (currentBalance >= parseFloat(payout.amount)) {
              await debitWallet(
                payout.uid, WALLET_TYPES.WITHDRAWABLE,
                parseFloat(payout.amount),
                payout.reference + "-retry",
                "Withdrawal retry to M-Pesa " + payout.phone_number,
                null,
                { fee: parseFloat(payout.fee || 0), netAmount: parseFloat(payout.net_amount || payout.amount) },
              );
              if (parseFloat(payout.fee || 0) > 0) {
                await createLedgerEntry({
                  type: LEDGER_ENTRY_TYPE.FEE,
                  amount: parseFloat(payout.fee),
                  fromWallet: WALLET_TYPES.WITHDRAWABLE,
                  toWallet: WALLET_TYPES.ACTIVE,
                  fromUid: payout.uid,
                  toUid: "platform",
                  reference: payout.reference + "-retry",
                  description: "Withdrawal fee (retry) on " + payout.reference,
                });
              }
            } else {
              // Insufficient balance for retry
              await db.query("UPDATE payouts SET b2c_error='Insufficient balance for retry' WHERE id=$1", [id]);
              return res.status(400).json({ error: "User has insufficient withdrawable balance for retry" });
            }
          }
        } catch (b2cErr) {
          return res.status(502).json({
            error: "B2C initiation failed: " + b2cErr.message + ". Payout remains queued.",
          });
        }
      }

      await db.query(
        "UPDATE payouts SET approved_at=$1, approved_by=$2 WHERE id=$3",
        [Date.now(), req.user.uid, id],
      );
      sendNotification(
        payout.uid,
        "Withdrawal Approved — Processing",
        `Your withdrawal of KES ${parseFloat(payout.amount).toFixed(2)} has been approved and M-Pesa transfer is in progress.`,
        "success",
      );
      res.json({ message: "Payout approved and B2C transfer initiated" });
      io.emit("payoutUpdate", { action: "approved", id });
    } catch (e) {
      console.error("[ADMIN] approve payout error:", e);
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
      // Consolidated query using LEFT JOIN to get disputes with escrow order details
      const result = await db.query(
        `SELECT d.*,
          row_to_json(e.*) AS order
         FROM disputes d
         LEFT JOIN escrow_orders e ON d.order_id = e.id
         ORDER BY d.created_at DESC`,
      );

      res.json(result.rows);
    } catch (e) {
      console.error("Admin disputes fetch error:", e);
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
    body("resolutionType").isIn([
      "release_to_seller",
      "refund_buyer",
      "send_to_commission",
    ]),
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
    const { reason = "Frozen by admin — please contact support for details." } = req.body || {};
    try {
      const now = Date.now();
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2, freeze_reason = $3 WHERE uid = $4 AND wallet_type = $5::wallet_type",
        [WALLET_STATUS.FROZEN, now, reason, uid, WALLET_TYPES.ACTIVE],
      );
      await db.query(
        "UPDATE wallets SET status = $1, updated_at = $2, freeze_reason = $3 WHERE uid = $4 AND wallet_type = $5::wallet_type",
        [WALLET_STATUS.FROZEN, now, reason, uid, WALLET_TYPES.WITHDRAWABLE],
      );
      sendNotification(
        uid,
        "Account Frozen",
        `Your account has been frozen. Reason: ${reason} Incoming deposits are still accepted but withdrawals and transfers are blocked. Contact support to resolve.`,
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
            `${uid} account frozen by admin. Reason: ${reason}`,
            "warning",
          );
      }
      console.log(`[ADMIN] Wallet frozen: uid=${uid} reason="${reason}" by admin ${req.user.uid}`);
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
      // Company wallet = all money that has entered the platform minus what has left
      // IN:  M-Pesa STK deposits + any other deposits credited to user wallets
      // OUT: Approved payouts sent back to users

      const result = await db.query(
        `SELECT
          -- Total M-Pesa STK deposits (net amount credited)
          (SELECT COALESCE(SUM(net_amount), 0) FROM mpesa_stk_requests WHERE status = 'success') AS total_mpesa_deposits,
          -- Total deposits via C2B (fallback/alternative channel)
          (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit') AS total_txn_deposits,
          -- Total approved payouts (money leaving platform)
          (SELECT COALESCE(SUM(net_amount), 0) FROM payouts WHERE status = 'approved') AS total_approved_payouts,
          -- Current sum of all user wallet balances (sanity check)
          (SELECT COALESCE(SUM(balance), 0) FROM wallets) AS current_user_wallets,
          -- Recent combined transactions
          (SELECT json_agg(t ORDER BY t.created_at DESC) FROM (
            SELECT 'deposit' AS type, net_amount AS amount, created_at,
                   CONCAT('M-Pesa deposit (', mpesa_receipt_number, ')') AS description
            FROM mpesa_stk_requests WHERE status = 'success'
            UNION ALL
            SELECT 'payout' AS type, net_amount AS amount, approved_at AS created_at,
                   CONCAT('Payout to ', phone_number) AS description
            FROM payouts WHERE status = 'approved'
            ORDER BY created_at DESC LIMIT 50
          ) t) AS recent_txs`,
      );

      const data = result.rows[0];
      const totalMpesaDeposits  = parseFloat(data.total_mpesa_deposits)  || 0;
      const totalTxnDeposits    = parseFloat(data.total_txn_deposits)     || 0;
      const totalApprovedPayouts= parseFloat(data.total_approved_payouts) || 0;
      const currentUserWallets  = parseFloat(data.current_user_wallets)   || 0;

      // Company wallet = total money deposited (all channels) minus all payouts
      const totalDeposited       = Math.max(totalMpesaDeposits, totalTxnDeposits);
      const companyWalletBalance = totalDeposited - totalApprovedPayouts;

      const transactions = (data.recent_txs || []).map((t) => ({
        createdAt:   t.created_at,
        description: t.description || (t.type === "deposit" ? "Deposit" : "Payout"),
        amount:      t.type === "deposit" ? parseFloat(t.amount) : -parseFloat(t.amount),
      }));

      res.json({
        balance:            companyWalletBalance,
        totalDeposited,
        totalMpesaDeposits,
        totalPaidOut:       totalApprovedPayouts,
        currentUserWallets,
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
      // Consolidated query to get all commission wallet data
      const result = await db.query(
        `SELECT
          (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE type = 'fee') AS total_fees,
          (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%') AS total_withdrawals,
          (SELECT json_agg(t) FROM (
            SELECT amount, created_at, description, type,
                   CASE WHEN type = 'fee' THEN amount ELSE -amount END as display_amount
            FROM ledger
            WHERE type = 'fee' OR (type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%')
            ORDER BY created_at DESC LIMIT 50
          ) t) AS recent_txs`,
      );

      const data = result.rows[0];
      const totalFees = parseFloat(data.total_fees) || 0;
      const totalWithdrawals = parseFloat(data.total_withdrawals) || 0;
      const availableBalance = totalFees - totalWithdrawals;

      res.json({
        balance: availableBalance,
        totalEarned: totalFees,
        totalWithdrawn: totalWithdrawals,
        transactions: (data.recent_txs || []).map((t) => ({
          createdAt: t.created_at,
          description:
            t.description ||
            (t.type === "fee" ? "Platform fee" : "Commission withdrawal"),
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
    body("method").isIn(["mpesa", "bank"]),
    body("phoneNumber").optional().isString(),
    body("bankCode").optional().isString(),
    body("accountNumber").optional().isString(),
    body("accountName").optional().isString(),
  ],
  validate,
  async (req, res) => {
    const {
      amount,
      method,
      phoneNumber,
      bankCode,
      accountNumber,
      accountName,
    } = req.body;

    try {
      const parsedAmount = parseAmount(amount);
      if (!parsedAmount || parsedAmount < 10) {
        return res
          .status(400)
          .json({ error: "Minimum withdrawal is KES 10.00" });
      }

      // Check available commission balance - consolidated query
      const result = await db.query(
        `SELECT
          (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE type = 'fee') AS total_fees,
          (SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE type = 'withdrawal' AND from_uid = 'platform' AND description LIKE '%commission withdrawal%') AS total_withdrawals`,
      );

      const totalFees = parseFloat(result.rows[0].total_fees) || 0;
      const totalWithdrawals =
        parseFloat(result.rows[0].total_withdrawals) || 0;
      const availableBalance = totalFees - totalWithdrawals;

      if (availableBalance < parsedAmount) {
        return res.status(400).json({
          error: `Insufficient commission balance. Available: KES ${availableBalance.toFixed(2)}`,
        });
      }

      const withdrawalId = uuidv4();
      const reference = `ADMIN-${Date.now()}`;

      if (method === "mpesa") {
        if (!phoneNumber) {
          return res
            .status(400)
            .json({ error: "Phone number required for M-Pesa withdrawal" });
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
          metadata: { method: "mpesa", phoneNumber },
        });

        // For M-Pesa withdrawals, we could integrate with M-Pesa B2C here
        // For now, just record as pending manual processing
        res.json({
          message:
            "Commission withdrawal request submitted for M-Pesa processing",
          reference,
          amount: parsedAmount,
          method: "mpesa",
        });
      } else if (method === "bank") {
        if (!bankCode || !accountNumber || !accountName) {
          return res
            .status(400)
            .json({ error: "Bank details required for bank withdrawal" });
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
          metadata: { method: "bank", bankCode, accountNumber, accountName },
        });

        res.json({
          message:
            "Commission withdrawal request submitted for bank transfer processing",
          reference,
          amount: parsedAmount,
          method: "bank",
        });
      }
    } catch (e) {
      console.error("[ADMIN] Commission withdrawal error:", e);
      res
        .status(500)
        .json({ error: "Failed to process commission withdrawal" });
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
      SELECT w.uid, u.display_name, u.email, w.balance, w.frozen_balance,
             w.updated_at AS frozen_at, w.freeze_reason
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
          freezeReason: r.freeze_reason || null,
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

// ── GET culprit transactions for the current discrepancy ─────────────────────
app.get(
  "/api/admin/reconciliation/discrepancies",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const culprits = await findReconciliationCulprits();
      // Also return current totals for context
      const mpesaInRes = await db.query(
        "SELECT COALESCE(SUM(net_amount),0) AS total FROM mpesa_stk_requests WHERE status='success'",
      );
      const payoutsOutRes = await db.query(
        "SELECT COALESCE(SUM(net_amount),0) AS total FROM payouts WHERE status='approved'",
      );
      const walletsRes = await db.query(
        "SELECT COALESCE(SUM(balance),0) AS total FROM wallets",
      );
      const totalMpesaIn    = parseFloat(mpesaInRes.rows[0].total)    || 0;
      const totalPayoutsOut = parseFloat(payoutsOutRes.rows[0].total)  || 0;
      const totalWallets    = parseFloat(walletsRes.rows[0].total)     || 0;
      const expected        = parseFloat((totalMpesaIn - totalPayoutsOut).toFixed(2));
      const discrepancy     = parseFloat((totalWallets - expected).toFixed(2));
      res.json({
        summary: {
          totalMpesaDeposits: totalMpesaIn,
          totalPayoutsOut,
          expectedBalance: expected,
          actualWalletSum: totalWallets,
          discrepancy,
          anomaly: Math.abs(discrepancy) > 1.0,
          culpritCount: culprits.length,
          culpritAmount: parseFloat(culprits.reduce((s, c) => s + Math.abs(c.amount), 0).toFixed(2)),
        },
        culprits,
      });
    } catch (e) {
      console.error("[RECONCILIATION] Discrepancy endpoint error:", e);
      res.status(500).json({ error: "Failed to analyse discrepancies" });
    }
  },
);

// ── GET wallet risk scores overview ──────────────────────────────────────────
app.get("/api/admin/wallet-risks", authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT wrs.uid, wrs.wallet_type, wrs.risk_score, wrs.restriction,
              wrs.anomaly_flags, wrs.last_updated,
              u.display_name, u.email, u.role,
              w.balance, w.status AS wallet_status
       FROM wallet_risk_scores wrs
       LEFT JOIN users u ON wrs.uid = u.uid
       LEFT JOIN wallets w ON w.uid = wrs.uid AND w.wallet_type = wrs.wallet_type::wallet_type
       WHERE wrs.restriction != 'none'
       ORDER BY wrs.risk_score DESC, wrs.last_updated DESC
       LIMIT 200`,
    );
    res.json(result.rows);
  } catch (e) {
    console.error("[ADMIN] wallet-risks error:", e);
    res.status(500).json({ error: "Failed to fetch wallet risks" });
  }
});

// ── Resolve a wallet anomaly — clear risk score and restore wallet ─────────────
app.post("/api/admin/wallet-risks/:uid/resolve", authenticateJWT, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { walletType = "active", reason = "Manually resolved by admin" } = req.body;
  try {
    const now = Date.now();
    // Clear risk score
    await db.query(
      `UPDATE wallet_risk_scores SET risk_score=0, restriction='none', anomaly_flags='[]', last_updated=$1
       WHERE uid=$2 AND wallet_type=$3`,
      [now, uid, walletType],
    );
    // Unfreeze/unrestrict wallet
    await db.query(
      `UPDATE wallets SET status='active', updated_at=$1 WHERE uid=$2 AND wallet_type=$3::wallet_type`,
      [now, uid, walletType],
    );
    // Mark anomaly history as resolved
    await db.query(
      `UPDATE wallet_anomaly_history SET resolved=true WHERE uid=$1 AND wallet_type=$2 AND resolved=false`,
      [uid, walletType],
    );
    // Notify user
    sendNotification(uid,
      "Wallet Restriction Lifted",
      `Your ${walletType} wallet restriction has been resolved by admin. All operations are now available.`,
      "success",
    );
    // Log admin action
    console.log(`[ADMIN] Resolved wallet risk: uid=${uid} wallet=${walletType} reason="${reason}" by admin ${req.user.uid}`);
    res.json({ message: `Wallet ${walletType} for ${uid} restored successfully` });
  } catch (e) {
    console.error("[ADMIN] wallet-risk resolve error:", e);
    res.status(500).json({ error: "Failed to resolve wallet risk" });
  }
});

// ── GET anomaly history for a specific wallet ─────────────────────────────────
app.get("/api/admin/wallet-risks/:uid/history", authenticateJWT, requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM wallet_anomaly_history WHERE uid=$1 ORDER BY created_at DESC LIMIT 50`,
      [uid],
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch anomaly history" });
  }
});

// ── GET all platform transactions (unified across all sources) ────────────────
app.get(
  "/api/admin/all-transactions",
  authenticateJWT,
  requireAdmin,
  async (req, res) => {
    try {
      const { source, status, type, search, limit = 200, offset = 0 } = req.query;
      const lim = Math.min(parseInt(limit) || 200, 500);
      const off = parseInt(offset) || 0;

      // ── Source 1: Ledger — internal double-entry records (deposits, withdrawals, transfers, fees, escrow)
      const ledgerRows = await db.query(
        `SELECT
           l.id,
           'ledger'                            AS source,
           l.type,
           l.amount,
           NULL                                AS fee,
           l.reference,
           l.description,
           l.from_uid,
           l.to_uid,
           l.from_wallet,
           l.to_wallet,
           COALESCE(u.display_name, u.email, l.from_uid) AS user_name,
           u.email                             AS user_email,
           u.role                              AS user_role,
           'completed'                         AS status,
           l.created_at
         FROM ledger l
         LEFT JOIN users u ON l.from_uid = u.uid
         ORDER BY l.created_at DESC
         LIMIT $1 OFFSET $2`,
        [lim, off],
      );

      // ── Source 2: M-Pesa STK requests — all states including pending/failed
      const mpesaRows = await db.query(
        `SELECT
           m.checkout_request_id              AS id,
           'mpesa_stk'                        AS source,
           'deposit'                          AS type,
           m.amount,
           m.fee,
           COALESCE(m.mpesa_receipt_number, m.checkout_request_id) AS reference,
           CONCAT('M-Pesa STK — ', m.phone_number) AS description,
           m.uid                              AS from_uid,
           m.uid                              AS to_uid,
           'external'                         AS from_wallet,
           'active'                           AS to_wallet,
           COALESCE(u.display_name, u.email, m.phone_number) AS user_name,
           u.email                            AS user_email,
           u.role                             AS user_role,
           m.status,
           m.created_at
         FROM mpesa_stk_requests m
         LEFT JOIN users u ON m.uid = u.uid
         ORDER BY m.created_at DESC
         LIMIT $1 OFFSET $2`,
        [lim, off],
      );

      // ── Source 3: Payouts — withdrawals sent to users via M-Pesa
      const payoutRows = await db.query(
        `SELECT
           p.id,
           'payout'                           AS source,
           'withdrawal'                       AS type,
           p.amount,
           p.fee,
           COALESCE(p.reference, p.mpesa_transaction_id, p.id::text) AS reference,
           CONCAT('Payout to ', p.phone_number) AS description,
           p.uid                              AS from_uid,
           p.uid                              AS to_uid,
           'withdrawable'                     AS from_wallet,
           'external'                         AS to_wallet,
           COALESCE(u.display_name, u.email, p.phone_number) AS user_name,
           u.email                            AS user_email,
           u.role                             AS user_role,
           p.status,
           p.created_at
         FROM payouts p
         LEFT JOIN users u ON p.uid = u.uid
         ORDER BY p.created_at DESC
         LIMIT $1 OFFSET $2`,
        [lim, off],
      );

      // ── Source 4: Escrow orders — marketplace transactions
      const escrowRows = await db.query(
        `SELECT
           eo.id,
           'escrow'                           AS source,
           'escrow_hold'                      AS type,
           eo.amount,
           NULL                               AS fee,
           COALESCE(eo.reference, eo.id::text) AS reference,
           CONCAT('Escrow order — ', COALESCE(l.title,'Product')) AS description,
           eo.buyer_uid                       AS from_uid,
           eo.seller_uid                      AS to_uid,
           'active'                           AS from_wallet,
           'escrow'                           AS to_wallet,
           COALESCE(bu.display_name, bu.email) AS user_name,
           bu.email                            AS user_email,
           bu.role                             AS user_role,
           eo.status::text                    AS status,
           eo.created_at
         FROM escrow_orders eo
         LEFT JOIN users bu ON eo.buyer_uid = bu.uid
         LEFT JOIN listings l ON eo.listing_id = l.id
         ORDER BY eo.created_at DESC
         LIMIT $1 OFFSET $2`,
        [lim, off],
      );

      // Merge all sources into one unified list and sort by date desc
      const allRows = [
        ...ledgerRows.rows.map(r => ({ ...r, source: "ledger" })),
        ...mpesaRows.rows.map(r => ({ ...r, source: "mpesa_stk" })),
        ...payoutRows.rows.map(r => ({ ...r, source: "payout" })),
        ...escrowRows.rows.map(r => ({ ...r, source: "escrow" })),
      ];

      // Sort merged list by created_at descending
      allRows.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      // Apply optional client-side filters (source, status, type, search)
      let filtered = allRows;
      if (source)  filtered = filtered.filter(r => r.source === source);
      if (status)  filtered = filtered.filter(r => (r.status || "").toLowerCase() === status.toLowerCase());
      if (type)    filtered = filtered.filter(r => (r.type   || "").toLowerCase() === type.toLowerCase());
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(r =>
          (r.reference   || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q) ||
          (r.user_name   || "").toLowerCase().includes(q) ||
          (r.user_email  || "").toLowerCase().includes(q) ||
          (r.from_uid    || "").toLowerCase().includes(q) ||
          (r.to_uid      || "").toLowerCase().includes(q),
        );
      }

      res.json({
        total:        filtered.length,
        transactions: filtered.slice(0, lim),
        sources: {
          ledger:    ledgerRows.rows.length,
          mpesa_stk: mpesaRows.rows.length,
          payout:    payoutRows.rows.length,
          escrow:    escrowRows.rows.length,
        },
      });
    } catch (e) {
      console.error("[ADMIN] all-transactions error:", e);
      res.status(500).json({ error: "Failed to fetch transactions" });
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
        if (
          e.type === "withdrawal" &&
          e.from_uid === "platform" &&
          e.description &&
          e.description.includes("commission withdrawal")
        ) {
          totalCommissionWithdrawals += parseFloat(e.amount || 0);
        }
      });
      const availableCommissionBalance =
        totalCommission - totalCommissionWithdrawals;
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

// ── GET broadcast history (unique broadcasts, one row per send event) ─────
app.get("/api/admin/broadcasts", authenticateJWT, requireAdmin, async (req, res) => {
  try {
    // Return one representative row per broadcast batch (same title+body+created_at second)
    const result = await db.query(
      `SELECT id, title, body, type,
              COUNT(*) OVER (PARTITION BY title, body, (created_at / 1000)) AS recipient_count,
              MIN(created_at) OVER (PARTITION BY title, body, (created_at / 1000)) AS sent_at,
              created_at
       FROM notifications
       WHERE title IS NOT NULL AND body IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    // Deduplicate: keep one row per (title, body, second-bucket)
    const seen = new Set();
    const broadcasts = [];
    for (const row of result.rows) {
      const key = `${row.title}::${row.body}::${Math.floor(Number(row.created_at) / 1000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        broadcasts.push({
          id:            row.id,
          title:         row.title,
          body:          row.body,
          type:          row.type || "info",
          recipientCount: parseInt(row.recipient_count) || 1,
          sentAt:        Number(row.sent_at || row.created_at),
        });
      }
    }
    res.json(broadcasts);
  } catch (e) {
    console.error("[ADMIN] Broadcasts fetch error:", e);
    res.status(500).json({ error: "Failed to fetch broadcasts" });
  }
});

// ── DELETE a broadcast (deletes all matching notification rows) ───────────
app.delete("/api/admin/broadcasts/:id", authenticateJWT, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Get the original notification to find its title+body bucket
    const orig = await db.query("SELECT title, body, created_at FROM notifications WHERE id = $1", [id]);
    if (!orig.rows.length) return res.status(404).json({ error: "Broadcast not found" });
    const { title, body, created_at } = orig.rows[0];
    const bucket = Math.floor(Number(created_at) / 1000);
    // Delete all notifications in this broadcast batch (same title, body, same second)
    const del = await db.query(
      `DELETE FROM notifications
       WHERE title = $1 AND body = $2
         AND (created_at / 1000) = $3`,
      [title, body, bucket],
    );
    res.json({ message: `Deleted broadcast (${del.rowCount} notifications removed)` });
  } catch (e) {
    console.error("[ADMIN] Broadcast delete error:", e);
    res.status(500).json({ error: "Failed to delete broadcast" });
  }
});

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
  // Handle payload too large errors with specific message
  if (err.type === "entity.too.large" || err.status === 413) {
    console.error("Payload too large:", req.method, req.url);
    return res.status(413).json({
      error:
        "Request payload too large. Please reduce image size or number of images.",
    });
  }

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

    // Auto-reconciliation every 30 minutes
    cron.schedule("*/30 * * * *", async () => {
      console.log("[CRON] Running 30-minute auto-reconciliation...");
      try {
        await runReconciliation();
      } catch (e) {
        console.error("[CRON] 30-min reconciliation failed:", e.message);
      }
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
                [],
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
                "[CRON] Failed to create auto-dispute for order " +
                  order.id +
                  ":",
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
  // STARTUP MIGRATION: Forum tables (posts, comments, likes)
  // ---------------------------------------------------------------------------

  async function migrateForumTables() {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS forum_posts (
          id TEXT PRIMARY KEY,
          uid TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT DEFAULT '',
          banner_image TEXT DEFAULT '',
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_forum_posts_uid ON forum_posts(uid)
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_forum_posts_created ON forum_posts(created_at DESC)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS forum_comments (
          id TEXT PRIMARY KEY,
          post_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          parent_comment_id TEXT DEFAULT NULL,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_forum_comments_post ON forum_comments(post_id)
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_forum_comments_parent ON forum_comments(parent_comment_id)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS forum_likes (
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          UNIQUE (target_type, target_id, uid)
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_forum_likes_target ON forum_likes(target_type, target_id)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS request_replies (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          display_name TEXT DEFAULT '',
          message TEXT NOT NULL,
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_request_replies_req ON request_replies(request_id)
      `);

      // order_documents — stores filenames & paths for generated receipts/invoices
      await db.query(`
        CREATE TABLE IF NOT EXISTS order_documents (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          order_id    TEXT NOT NULL,
          doc_type    TEXT NOT NULL CHECK (doc_type IN ('receipt', 'invoice')),
          filename    TEXT NOT NULL,
          filepath    TEXT NOT NULL,
          file_size   BIGINT DEFAULT 0,
          created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          UNIQUE (order_id, doc_type)
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_order_docs_order ON order_documents(order_id)
      `);

      // wallet_risk_scores — persists per-wallet risk scores across reconciliation runs
      await db.query(`
        CREATE TABLE IF NOT EXISTS wallet_risk_scores (
          uid           TEXT NOT NULL,
          wallet_type   TEXT NOT NULL DEFAULT 'active',
          risk_score    INTEGER NOT NULL DEFAULT 0,
          restriction   TEXT NOT NULL DEFAULT 'none',
          anomaly_flags JSONB DEFAULT '[]'::jsonb,
          last_updated  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          PRIMARY KEY (uid, wallet_type)
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_wallet_risk_uid ON wallet_risk_scores(uid)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_wallet_risk_restriction ON wallet_risk_scores(restriction)`);

      // wallet_anomaly_history — tracks anomalies per wallet over time for escalation
      await db.query(`
        CREATE TABLE IF NOT EXISTS wallet_anomaly_history (
          id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          uid           TEXT NOT NULL,
          wallet_type   TEXT NOT NULL DEFAULT 'active',
          category      TEXT NOT NULL,
          risk_points   INTEGER NOT NULL DEFAULT 0,
          amount        DECIMAL(20,2),
          description   TEXT,
          reference     TEXT,
          resolved      BOOLEAN DEFAULT FALSE,
          created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_anomaly_hist_uid ON wallet_anomaly_history(uid)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_anomaly_hist_resolved ON wallet_anomaly_history(resolved)`);

      console.log("[MIGRATION] Forum + order_documents + risk scoring tables ready");
    } catch (e) {
      console.error("[MIGRATION] Forum tables error:", e.message);
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
    // Add quantity_text column to store the buyer's free-text quantity (e.g. "2 kg, 1 crate")
    try {
      const qtColCheck = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='escrow_orders' AND column_name='quantity_text'",
      );
      if (qtColCheck.rows.length === 0) {
        await db.query(
          "ALTER TABLE escrow_orders ADD COLUMN quantity_text TEXT",
        );
        console.log("[MIGRATION] Added quantity_text column to escrow_orders");
      }
    } catch (e) {
      console.error("[MIGRATION] quantity_text column add error (non-fatal):", e.message);
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
    // Add freeze_reason column to wallets table so every freeze has an auditable reason
    try {
      const frCheck = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='wallets' AND column_name='freeze_reason'",
      );
      if (frCheck.rows.length === 0) {
        await db.query("ALTER TABLE wallets ADD COLUMN freeze_reason TEXT");
        console.log("[MIGRATION] Added freeze_reason column to wallets");
      }
    } catch (e) {
      console.error("[MIGRATION] freeze_reason column add error (non-fatal):", e.message);
    }
    // Add initiated_by column to agreements so we know who sent the request
    try {
      const ibCheck = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='agreements' AND column_name='initiated_by'",
      );
      if (ibCheck.rows.length === 0) {
        await db.query("ALTER TABLE agreements ADD COLUMN initiated_by TEXT");
        // Backfill: assume org initiated for old rows (most common case)
        await db.query("UPDATE agreements SET initiated_by = org_uid WHERE initiated_by IS NULL");
        console.log("[MIGRATION] Added initiated_by column to agreements");
      }
    } catch (e) {
      console.error("[MIGRATION] initiated_by column add error (non-fatal):", e.message);
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
    try {
      await migrateForumTables();
    } catch (e) {
      console.error("[MIGRATION] Forum tables error:", e.message);
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

    // Monitor database connection pool health
    setInterval(() => {
      const stats = db.getPoolStats();
      if (stats) {
        console.log(
          `[DB Pool] Total: ${stats.total} | Idle: ${stats.idle} | Waiting: ${stats.waiting}`,
        );

        // Alert if pool is getting exhausted
        if (stats.waiting > 5) {
          console.warn(
            `[DB Pool WARNING] ${stats.waiting} queries waiting for connections! Pool may be exhausted.`,
          );
        }
      }
    }, 60000); // Log every 60 seconds
  });
}

module.exports = app;
