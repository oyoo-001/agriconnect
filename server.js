const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const { body, validationResult, query, param } = require('express-validator');
const xss = require('xss');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
const { welcomeEmail, depositEmail, withdrawalEmail, orderEmail, passwordResetEmail } = require('./email-templates');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    credentials: true
  }
});

io.on('connection', (socket) => {
  const uid = socket.handshake.query.uid;
  if (uid) socket.join(uid);
  socket.on('join-room', (room) => socket.join(room));
});

const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://www.gstatic.com", "https://apis.google.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://paystack.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:", "https://*.googleusercontent.com", "https://www.gstatic.com"],
  connectSrc: ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://agri-bab5b-default-rtdb.firebaseio.com", "https://firestore.googleapis.com", "https://www.gstatic.com", "https://accounts.google.com", "https://oauth2.googleapis.com", "https://api.paystack.co", "https://fonts.googleapis.com", "https://js.paystack.co", "https://api.safaricom.co.ke", "https://sandbox.safaricom.co.ke"],
  frameSrc: ["'self'", "https://agri-bab5b.firebaseapp.com", "https://accounts.google.com", "https://js.paystack.co", "https://paystack.com", "https://*.paystack.co", "https://*.paystack.com"],
  formAction: ["'self'", "https://accounts.google.com"],
};

app.use(helmet({ contentSecurityPolicy: { directives: CSP_DIRECTIVES }, crossOriginOpenerPolicy: { policy: 'unsafe-none' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*', credentials: true }));
app.use(morgan('combined'));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// ---- API Request/Response Logger ----
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const start = Date.now();
  const logBody = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
  if (logBody && logBody.idempotencyKey) logBody.idempotencyKey = logBody.idempotencyKey.slice(0, 8) + '...';
  const origJson = res.json.bind(res);
  res.json = function (body) {
    const ms = Date.now() - start;
    const logResBody = body && typeof body === 'object' ? { ...body } : body;
    if (res.statusCode >= 400) {
      console.error('[API ERROR] %s %s -> %d %s (%dms)', req.method, req.originalUrl, res.statusCode, JSON.stringify(logResBody), ms);
      if (logBody && Object.keys(logBody).length) console.error('[API ERROR]   Request body:', JSON.stringify(logBody));
    } else {
      console.log('[API] %s %s -> %d (%dms)', req.method, req.originalUrl, res.statusCode, ms);
    }
    return origJson(body);
  };
  next();
});

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests, please try again later.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many auth attempts, please try again later.' } });
const webhookLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 60, message: { error: 'Too many webhook requests.' } });

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://agri-bab5b-default-rtdb.firebaseio.com'
  });
  console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

const emailTransporter = (() => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return null;
})();

async function sendEmail(to, subject, html) {
  if (!emailTransporter) {
    console.log('[EMAIL] Skipped (no SMTP configured) — would send to', to, 'subject:', subject);
    return;
  }
  await emailTransporter.sendMail({
    from: `"AgriConnect" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to, subject, html,
  });
  console.log('[EMAIL] Sent:', subject, '->', to);
}

// ---------------------------------------------------------------------------
// CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const WALLET_STATUS = Object.freeze({ ACTIVE: 'active', FROZEN: 'frozen', SUSPENDED: 'suspended' });
const WALLET_TYPES = Object.freeze({ ACTIVE: 'active', ESCROW: 'escrow', WITHDRAWABLE: 'withdrawable' });
const ORDER_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  IN_ESCROW: 'in_escrow',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  VERIFIED: 'verified',
  COMPLETED: 'completed',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded'
});
const DISPUTE_STATUS = Object.freeze({ OPEN: 'open', UNDER_REVIEW: 'under_review', RESOLVED: 'resolved', DISMISSED: 'dismissed' });
const LEDGER_ENTRY_TYPE = Object.freeze({
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  TRANSFER: 'transfer',
  ESCROW_HOLD: 'escrow_hold',
  ESCROW_RELEASE: 'escrow_release',
  ESCROW_REFUND: 'escrow_refund',
  FEE: 'fee',
  FEE_REFUND: 'fee_refund',
  RECONCILIATION_ADJ: 'reconciliation_adjustment'
});

const DEPOSIT_FEE_RATE = parseFloat(process.env.DEPOSIT_FEE_RATE || '0.01');
const TRANSFER_FEE_RATE = parseFloat(process.env.TRANSFER_FEE_RATE || '0.01');
const ESCROW_TIMER_HOURS = parseInt(process.env.ESCROW_TIMER_HOURS || '72', 10);
const MIN_DEPOSIT = parseFloat(process.env.MIN_DEPOSIT || '10');
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '50');
const MIN_TRANSFER = parseFloat(process.env.MIN_TRANSFER || '1');

const db = () => admin.database();

// ---------------------------------------------------------------------------
// M-PESA DARAJA CONFIG
// ---------------------------------------------------------------------------

const MPESA = {
  CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY || '',
  CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET || '',
  PASSKEY: process.env.MPESA_PASSKEY || '',
  BUSINESS_SHORTCODE: process.env.MPESA_BUSINESS_SHORTCODE || '174379',
  ENVIRONMENT: process.env.MPESA_ENV || 'sandbox',
  CALLBACK_BASE: process.env.BASE_URL || 'https://your-domain.com',
  get BASE_URL() {
    return this.ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  },
  get OAUTH_URL() {
    return `${this.BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
  },
  get STK_PUSH_URL() {
    return `${this.BASE_URL}/mpesa/stkpush/v1/processrequest`;
  },
  get STK_QUERY_URL() {
    return `${this.BASE_URL}/mpesa/stkpushquery/v1/query`;
  },
  get B2C_URL() {
    return `${this.BASE_URL}/mpesa/b2c/v1/paymentrequest`;
  },
  get REGISTER_C2B_URL() {
    return `${this.BASE_URL}/mpesa/c2b/v1/registerurl`;
  },
  get TRANSACTION_STATUS_URL() {
    return `${this.BASE_URL}/mpesa/transactionstatus/v1/query`;
  },
  get ACCOUNT_BALANCE_URL() {
    return `${this.BASE_URL}/mpesa/accountbalance/v1/query`;
  }
};

let mpesaAccessToken = null;
let mpesaTokenExpiry = 0;

async function getMpesaAccessToken(forceRefresh = false) {
  if (!forceRefresh && mpesaAccessToken && Date.now() < mpesaTokenExpiry) return mpesaAccessToken;
  if (!MPESA.CONSUMER_KEY || !MPESA.CONSUMER_SECRET) {
    throw new Error('M-Pesa consumer key or secret not configured in .env');
  }
  const auth = Buffer.from(`${MPESA.CONSUMER_KEY}:${MPESA.CONSUMER_SECRET}`).toString('base64');
  try {
    const response = await axios.get(MPESA.OAUTH_URL, { headers: { Authorization: `Basic ${auth}` }, timeout: 10000 });
    if (!response.data || !response.data.access_token) {
      throw new Error(`OAuth response missing access_token: ${JSON.stringify(response.data)}`);
    }
    mpesaAccessToken = response.data.access_token;
    mpesaTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    console.log('[MPESA] OAuth token obtained successfully, expires in', response.data.expires_in, 's');
    return mpesaAccessToken;
  } catch (err) {
    console.error('[MPESA] OAuth token fetch failed:', err.response?.data || err.message);
    throw new Error(`Failed to get M-Pesa access token: ${err.response?.data?.errorMessage || err.message}`);
  }
}

function timestamp() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}${h}${min}${s}`;
}

function stkPassword() {
  return Buffer.from(`${MPESA.BUSINESS_SHORTCODE}${MPESA.PASSKEY}${timestamp()}`).toString('base64');
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateTxnId() {
  return `AGR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// WALLET ID (8-digit unique)
// ---------------------------------------------------------------------------

async function generateWalletId() {
  const existingIds = await db().ref('wallet_ids').once('value');
  const taken = new Set(existingIds.val() ? Object.keys(existingIds.val()) : []);
  let id;
  do {
    id = String(Math.floor(10000000 + Math.random() * 90000000));
  } while (taken.has(id));
  return id;
}

async function getOrCreateWalletId(uid, displayName, email) {
  let walletIdRef = await db().ref(`wallet_ids_by_uid/${uid}`).once('value');
  if (walletIdRef.val()) return walletIdRef.val().walletId;

  const walletId = await generateWalletId();
  await db().ref(`wallet_ids/${walletId}`).set({ uid, displayName, email });
  await db().ref(`wallet_ids_by_uid/${uid}`).set({ walletId, displayName, email, createdAt: admin.database.ServerValue.TIMESTAMP });
  return walletId;
}

async function lookupWalletId(walletId) {
  const snap = await db().ref(`wallet_ids/${walletId}`).once('value');
  if (!snap.val()) return null;
  const { uid, displayName, email } = snap.val();
  const userSnap = await db().ref(`users/${uid}`).once('value');
  const user = userSnap.val() || {};
  return {
    uid,
    walletId,
    displayName: displayName || user.displayName || '',
    email: email || user.email || '',
    role: user.role || ''
  };
}

// ---------------------------------------------------------------------------
// HELPER: SANITIZATION & VALIDATION
// ---------------------------------------------------------------------------

function sanitize(v) {
  if (typeof v === 'string') return xss(v.trim());
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, sanitize(val)]));
  return v;
}

function sanitizeInput(req, res, next) {
  if (req.body) req.body = sanitize(req.body);
  if (req.query) {
    Object.keys(req.query).forEach(k => {
      if (typeof req.query[k] === 'string') req.query[k] = xss(req.query[k].trim());
    });
  }
  next();
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
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
  const key = req.headers['idempotency-key'] || req.body.idempotencyKey;
  if (!key) return next();
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    return res.status(400).json({ error: 'Invalid idempotency key format' });
  }
  try {
    const snap = await db().ref(`idempotency/${key}`).once('value');
    if (snap.val()) {
      return res.status(409).json({ error: 'Duplicate request', existingResult: snap.val().result });
    }
    req.idempotencyKey = key;
    next();
  } catch (e) {
    console.error('Idempotency check error:', e);
    next();
  }
}

async function recordIdempotency(key, result) {
  if (!key) return;
  try {
    await db().ref(`idempotency/${key}`).set({ result, processedAt: admin.database.ServerValue.TIMESTAMP });
  } catch (e) {
    console.error('Idempotency record error:', e);
  }
}

// ---------------------------------------------------------------------------
// DOUBLE-ENTRY LEDGER
// ---------------------------------------------------------------------------

async function createLedgerEntry({ type, amount, fromWallet, toWallet, fromUid, toUid, reference, description, relatedId, metadata }) {
  if (!type || !amount) throw new Error('Ledger entry requires type and amount');
  const entryId = uuidv4();
  const entry = {
    id: entryId,
    type,
    amount: parseFloat(amount.toFixed(2)),
    fromWallet: fromWallet || null,
    toWallet: toWallet || null,
    fromUid: fromUid || null,
    toUid: toUid || null,
    reference: reference || null,
    description: description || '',
    relatedId: relatedId || null,
    metadata: metadata || null,
    createdAt: admin.database.ServerValue.TIMESTAMP
  };
  await db().ref(`ledger/${entryId}`).set(entry);
  return entry;
}

async function computeBalance(uid, walletType = WALLET_TYPES.ACTIVE) {
  const snap = await db().ref('ledger').orderByChild('createdAt').once('value');
  const all = snap.val() || {};
  let balance = 0;
  Object.values(all).forEach(e => {
    if (e.toUid === uid && e.toWallet === walletType) balance += parseFloat(e.amount || 0);
    if (e.fromUid === uid && e.fromWallet === walletType) balance -= parseFloat(e.amount || 0);
  });
  return parseFloat(balance.toFixed(2));
}

// ---------------------------------------------------------------------------
// WALLET OPERATIONS
// ---------------------------------------------------------------------------

async function getWalletState(uid, walletType = WALLET_TYPES.ACTIVE) {
  const snap = await db().ref(`wallets/${uid}/${walletType}`).once('value');
  return snap.val() || null;
}

async function ensureWallet(uid, walletType = WALLET_TYPES.ACTIVE) {
  const existing = await getWalletState(uid, walletType);
  if (existing) return existing;
  const wallet = {
    uid,
    walletType,
    status: WALLET_STATUS.ACTIVE,
    frozenBalance: 0,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  };
  await db().ref(`wallets/${uid}/${walletType}`).set(wallet);
  if (walletType === WALLET_TYPES.ACTIVE) {
    const userSnap = await db().ref(`users/${uid}`).once('value');
    const user = userSnap.val() || {};
    await getOrCreateWalletId(uid, user.displayName || '', user.email || '');
  }
  return wallet;
}

async function checkWalletNotRestricted(uid, walletType = WALLET_TYPES.ACTIVE) {
  const wallet = await getWalletState(uid, walletType);
  if (!wallet) return true;
  if (wallet.status === WALLET_STATUS.FROZEN || wallet.status === WALLET_STATUS.SUSPENDED) {
    return false;
  }
  return true;
}

function walletRestrictionMiddleware(walletType = WALLET_TYPES.ACTIVE) {
  return async (req, res, next) => {
    const uid = req.user.uid;
    const allowed = await checkWalletNotRestricted(uid, walletType);
    if (!allowed) {
      return res.status(403).json({ error: 'Your account is restricted. Outbound transactions are blocked.' });
    }
    next();
  };
}

async function creditWallet(uid, walletType, amount, reference, description, relatedId, metadata) {
  amount = parseFloat(amount.toFixed(2));
  const wallet = await ensureWallet(uid, walletType);
  await db().ref(`wallets/${uid}/${walletType}`).update({ updatedAt: admin.database.ServerValue.TIMESTAMP });
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.DEPOSIT,
    amount,
    toWallet: walletType,
    toUid: uid,
    reference,
    description,
    relatedId,
    metadata
  });
  return entry;
}

async function debitWallet(uid, walletType, amount, reference, description, relatedId, metadata) {
  amount = parseFloat(amount.toFixed(2));
  const balance = await computeBalance(uid, walletType);
  const walletInfo = await getWalletState(uid, walletType);
  const availableBalance = parseFloat((balance - parseFloat(walletInfo?.frozenBalance || 0)).toFixed(2));
  if (availableBalance < amount) {
    throw new Error(`Insufficient ${walletType} wallet balance. Available: ${availableBalance}, Required: ${amount}`);
  }
  await db().ref(`wallets/${uid}/${walletType}`).update({ updatedAt: admin.database.ServerValue.TIMESTAMP });
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.WITHDRAWAL,
    amount: -amount,
    fromWallet: walletType,
    fromUid: uid,
    reference,
    description,
    relatedId,
    metadata
  });
  return entry;
}

async function walletTransfer(fromUid, toUid, fromWalletType, toWalletType, amount, reference, description) {
  amount = parseFloat(amount.toFixed(2));
  const fromBalance = await computeBalance(fromUid, fromWalletType);
  const fromWalletInfo = await getWalletState(fromUid, fromWalletType);
  const fromAvailable = parseFloat((fromBalance - parseFloat(fromWalletInfo?.frozenBalance || 0)).toFixed(2));
  if (fromAvailable < amount) {
    throw new Error(`Insufficient ${fromWalletType} wallet balance. Available: ${fromAvailable}, Required: ${amount}`);
  }
  await ensureWallet(toUid, toWalletType);
  await db().ref(`wallets/${fromUid}/${fromWalletType}`).update({ updatedAt: admin.database.ServerValue.TIMESTAMP });
  await db().ref(`wallets/${toUid}/${toWalletType}`).update({ updatedAt: admin.database.ServerValue.TIMESTAMP });
  const entry = await createLedgerEntry({
    type: LEDGER_ENTRY_TYPE.TRANSFER,
    amount,
    fromWallet: fromWalletType,
    toWallet: toWalletType,
    fromUid,
    toUid,
    reference,
    description
  });
  return entry;
}

// ---------------------------------------------------------------------------
// M-PESA STK PUSH (LIPA NA M-PESA ONLINE) - C2B Deposit
// ---------------------------------------------------------------------------

async function stkPush(phoneNumber, amount, accountReference, transactionDesc, idempotencyKey) {
  const normalizedPhone = phoneNumber.replace(/^0+/, '254').replace(/^\+?254/, '254');
  if (normalizedPhone.length !== 12 || !normalizedPhone.startsWith('254')) {
    throw new Error('Invalid phone number format. Must be a valid Safaricom number.');
  }
  const payload = {
    BusinessShortCode: MPESA.BUSINESS_SHORTCODE,
    Password: stkPassword(),
    Timestamp: timestamp(),
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: normalizedPhone,
    PartyB: MPESA.BUSINESS_SHORTCODE,
    PhoneNumber: normalizedPhone,
    CallBackURL: `${MPESA.CALLBACK_BASE}/api/mpesa/c2b/callback`,
    AccountReference: accountReference || 'AgriConnect Deposit',
    TransactionDesc: transactionDesc || 'Wallet Deposit'
  };
  async function doPush(token) {
    return await axios.post(MPESA.STK_PUSH_URL, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
  }
  let token = await getMpesaAccessToken();
  let response;
  try {
    response = await doPush(token);
  } catch (err) {
    const errBody = err.response?.data;
    const isAuthError = err.response?.status === 404 && errBody?.errorCode === '404.001.03';
    if (isAuthError) {
      console.log('[MPESA] Token rejected by STK Push, refreshing...');
      token = await getMpesaAccessToken(true);
      response = await doPush(token);
    } else {
      throw err;
    }
  }
  const data = response.data;
  if (data.ResponseCode !== '0') {
    throw new Error(`STK Push failed: ${data.ResponseDescription || 'Unknown error'}`);
  }
  await db().ref(`mpesa_stk_requests/${data.CheckoutRequestID}`).set({
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    phoneNumber: normalizedPhone,
    amount: Math.round(amount),
    accountReference,
    idempotencyKey: idempotencyKey || null,
    status: 'pending',
    createdAt: admin.database.ServerValue.TIMESTAMP
  });
  return data;
}

async function stkQuery(checkoutRequestId) {
  const token = await getMpesaAccessToken();
  const payload = {
    BusinessShortCode: MPESA.BUSINESS_SHORTCODE,
    Password: stkPassword(),
    Timestamp: timestamp(),
    CheckoutRequestID: checkoutRequestId
  };
  const response = await axios.post(MPESA.STK_QUERY_URL, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// M-PESA B2C - Payout to Farmer
// ---------------------------------------------------------------------------

async function b2cPayment(phoneNumber, amount, remarks, occasion) {
  const token = await getMpesaAccessToken();
  const normalizedPhone = phoneNumber.replace(/^0+/, '254').replace(/^\+?254/, '254');
  if (normalizedPhone.length !== 12 || !normalizedPhone.startsWith('254')) {
    throw new Error('Invalid phone number format.');
  }
  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME || 'testapi',
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL || '',
    CommandID: 'BusinessPayment',
    Amount: Math.round(amount),
    PartyA: MPESA.BUSINESS_SHORTCODE,
    PartyB: normalizedPhone,
    Remarks: remarks || 'AgriConnect Payout',
    QueueTimeOutURL: `${MPESA.CALLBACK_BASE}/api/mpesa/b2c/timeout`,
    ResultURL: `${MPESA.CALLBACK_BASE}/api/mpesa/b2c/result`,
    Occasion: occasion || 'Payout'
  };
  const response = await axios.post(MPESA.B2C_URL, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
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
      ResponseType: 'Completed',
      ConfirmationURL: `${MPESA.CALLBACK_BASE}/api/mpesa/c2b/confirmation`,
      ValidationURL: `${MPESA.CALLBACK_BASE}/api/mpesa/c2b/validation`
    };
    const response = await axios.post(MPESA.REGISTER_C2B_URL, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log('[MPESA] C2B URLs registered:', response.data);
    return response.data;
  } catch (e) {
    console.error('[MPESA] C2B URL registration failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// ORDER-ESCROW LIFECYCLE
// ---------------------------------------------------------------------------

async function createEscrowOrder(buyerUid, sellerUid, amount, listingId, quantity, reference) {
  amount = parseFloat(amount.toFixed(2));
  const buyerActiveBalance = await computeBalance(buyerUid, WALLET_TYPES.ACTIVE);
  const buyerWalletInfo = await getWalletState(buyerUid, WALLET_TYPES.ACTIVE);
  const buyerAvailable = parseFloat((buyerActiveBalance - parseFloat(buyerWalletInfo?.frozenBalance || 0)).toFixed(2));
  if (buyerAvailable < amount) {
    throw new Error(`Insufficient active wallet balance. Available: ${buyerAvailable}, Required: ${amount}`);
  }
  const orderId = db().ref('escrow_orders').push().key;
  const otp = generateOTP();
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
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
    createdAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  };
  await walletTransfer(buyerUid, orderId, WALLET_TYPES.ACTIVE, WALLET_TYPES.ESCROW, amount, reference, `Escrow hold for order ${orderId}`);
  await db().ref(`escrow_orders/${orderId}`).set(order);
  await db().ref(`orders/${orderId}`).set({
    id: orderId,
    listingId: listingId || null,
    farmerUid: sellerUid,
    orgUid: buyerUid,
    quantity: parseInt(quantity) || 1,
    totalPrice: amount,
    status: ORDER_STATUS.IN_ESCROW,
    escrowOrderId: orderId,
    createdAt: admin.database.ServerValue.TIMESTAMP
  });
  const userSnap = await db().ref(`users/${buyerUid}`).once('value');
  const buyerData = userSnap.val() || {};
  const sellerSnap = await db().ref(`users/${sellerUid}`).once('value');
  const sellerData = sellerSnap.val() || {};
  if (buyerData.email) {
    sendEmail(buyerData.email, 'Order Confirmed - Funds in Escrow', orderEmail(buyerData.displayName || 'Buyer', orderId, ORDER_STATUS.IN_ESCROW, listingId, amount, 'buyer'));
  }
  if (sellerData.email) {
    sendEmail(sellerData.email, 'New Order - Funds in Escrow', orderEmail(sellerData.displayName || 'Seller', orderId, ORDER_STATUS.IN_ESCROW, listingId, amount, 'seller'));
  }
  sendNotification(sellerUid, '💰 New Order', `A buyer has placed an order for KES ${amount.toFixed(2)}. Funds are held in escrow.`, 'success');
  return { order, otp, otpHash };
}

async function verifyEscrowDelivery(orderId, otp) {
  const snap = await db().ref(`escrow_orders/${orderId}`).once('value');
  const order = snap.val();
  if (!order) throw new Error('Order not found');
  if (order.status !== ORDER_STATUS.IN_ESCROW && order.status !== ORDER_STATUS.DISPATCHED) {
    throw new Error(`Order cannot be verified in current status: ${order.status}`);
  }
  if (Date.now() > order.otpExpiresAt) {
    throw new Error('OTP has expired. Please contact support.');
  }
  const hash = crypto.createHash('sha256').update(String(otp)).digest('hex');
  if (hash !== order.otpHash) {
    throw new Error('Invalid OTP. Please try again.');
  }
  await db().ref(`escrow_orders/${orderId}`).update({
    status: ORDER_STATUS.VERIFIED,
    verifiedAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`orders/${orderId}`).update({
    status: ORDER_STATUS.VERIFIED,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  return order;
}

async function releaseEscrowToSeller(orderId) {
  const snap = await db().ref(`escrow_orders/${orderId}`).once('value');
  const order = snap.val();
  if (!order) throw new Error('Order not found');
  if (order.status !== ORDER_STATUS.VERIFIED) {
    throw new Error('Order must be verified before releasing funds');
  }
  const amount = parseFloat(order.amount);
  const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
  const netAmount = parseFloat((amount - fee).toFixed(2));
  await walletTransfer(orderId, order.sellerUid, WALLET_TYPES.ESCROW, WALLET_TYPES.WITHDRAWABLE, netAmount, order.reference, `Escrow release for order ${orderId} to seller`);
  if (fee > 0) {
    await createLedgerEntry({
      type: LEDGER_ENTRY_TYPE.FEE,
      amount: fee,
      fromWallet: WALLET_TYPES.ESCROW,
      toWallet: WALLET_TYPES.ACTIVE,
      fromUid: order.sellerUid,
      toUid: 'platform',
      reference: order.reference,
      description: `Platform fee on order ${orderId} (${(DEPOSIT_FEE_RATE * 100)}%)`
    });
  }
  await db().ref(`escrow_orders/${orderId}`).update({
    status: ORDER_STATUS.COMPLETED,
    completedAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`orders/${orderId}`).update({
    status: ORDER_STATUS.COMPLETED,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  const sellerSnap = await db().ref(`users/${order.sellerUid}`).once('value');
  const sellerData = sellerSnap.val() || {};
  if (sellerData.email) {
    sendEmail(sellerData.email, 'Payment Released - AgriConnect', withdrawalEmail(sellerData.displayName || 'Seller', netAmount, `Order ${orderId} completed`));
  }
  sendNotification(order.sellerUid, '✅ Payment Released', `KES ${netAmount.toFixed(2)} has been released to your withdrawable wallet for order ${orderId}.`, 'success');
  return netAmount;
}

async function cancelEscrow(orderId) {
  const snap = await db().ref(`escrow_orders/${orderId}`).once('value');
  const order = snap.val();
  if (!order) throw new Error('Order not found');
  if (order.status === ORDER_STATUS.COMPLETED || order.status === ORDER_STATUS.REFUNDED) {
    throw new Error('Order already completed or refunded');
  }
  if (order.disputeOpened && !order.disputeResolved) {
    throw new Error('Cannot cancel an active disputed order. Resolve dispute first.');
  }
  const amount = parseFloat(order.amount);
  await walletTransfer(orderId, order.buyerUid, WALLET_TYPES.ESCROW, WALLET_TYPES.ACTIVE, amount, order.reference, `Escrow refund for cancelled order ${orderId}`);
  await db().ref(`escrow_orders/${orderId}`).update({
    status: ORDER_STATUS.CANCELLED,
    cancelledAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`orders/${orderId}`).update({
    status: ORDER_STATUS.CANCELLED,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  sendNotification(order.buyerUid, '↩️ Order Cancelled', `KES ${amount.toFixed(2)} has been returned to your active wallet for order ${orderId}.`, 'info');
  return amount;
}

async function refundEscrowToBuyer(orderId) {
  const snap = await db().ref(`escrow_orders/${orderId}`).once('value');
  const order = snap.val();
  if (!order) throw new Error('Order not found');
  const amount = parseFloat(order.amount);
  await walletTransfer(orderId, order.buyerUid, WALLET_TYPES.ESCROW, WALLET_TYPES.ACTIVE, amount, order.reference, `Escrow refund for order ${orderId} to buyer`);
  await db().ref(`escrow_orders/${orderId}`).update({
    status: ORDER_STATUS.REFUNDED,
    refundedAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`orders/${orderId}`).update({
    status: ORDER_STATUS.REFUNDED,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  const buyerSnap = await db().ref(`users/${order.buyerUid}`).once('value');
  const buyerData = buyerSnap.val() || {};
  if (buyerData.email) {
    sendEmail(buyerData.email, 'Refund Processed - AgriConnect', depositEmail(buyerData.displayName || 'Buyer', amount, `Order ${orderId} refunded`));
  }
  return amount;
}

// ---------------------------------------------------------------------------
// DISPUTE RESOLUTION
// ---------------------------------------------------------------------------

async function raiseDispute(orderId, raisedByUid, reason, evidenceUrls) {
  const snap = await db().ref(`escrow_orders/${orderId}`).once('value');
  const order = snap.val();
  if (!order) throw new Error('Order not found');
  if (order.disputeOpened) throw new Error('A dispute is already open for this order');
  if (order.status === ORDER_STATUS.COMPLETED || order.status === ORDER_STATUS.REFUNDED) {
    throw new Error('Cannot dispute a completed or refunded order');
  }
  if (raisedByUid !== order.buyerUid && raisedByUid !== order.sellerUid) {
    throw new Error('Only the buyer or seller can raise a dispute');
  }
  const disputeId = db().ref('disputes').push().key;
  const dispute = {
    id: disputeId,
    orderId,
    raisedByUid,
    reason: reason || 'No reason provided',
    evidenceUrls: evidenceUrls || [],
    status: DISPUTE_STATUS.OPEN,
    resolution: null,
    resolvedByUid: null,
    resolvedAt: null,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  };
  const amount = parseFloat(order.amount);
  const buyerWallet = await getWalletState(order.buyerUid, WALLET_TYPES.ACTIVE);
  const currentFrozen = parseFloat(buyerWallet?.frozenBalance || 0);
  await db().ref(`wallets/${order.buyerUid}/active`).update({ frozenBalance: parseFloat((currentFrozen + amount).toFixed(2)) });
  await db().ref(`escrow_orders/${orderId}`).update({
    disputeOpened: true,
    status: ORDER_STATUS.DISPUTED,
    disputeId,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`disputes/${disputeId}`).set(dispute);
  const adminSnap = await db().ref('users').orderByChild('role').equalTo('admin').once('value');
  if (adminSnap.val()) {
    Object.keys(adminSnap.val()).forEach(aid => {
      sendNotification(aid, '⚖️ New Dispute', `Dispute #${disputeId} raised on order ${orderId} by ${raisedByUid}. Reason: ${reason}`, 'warning');
    });
  }
  sendNotification(order.buyerUid, '⚖️ Dispute Raised', `Your dispute on order ${orderId} has been opened. An admin will review it shortly.`, 'info');
  sendNotification(order.sellerUid, '⚖️ Dispute Raised', `A dispute has been raised on order ${orderId}. The funds are frozen pending review.`, 'warning');
  return dispute;
}

async function resolveDispute(disputeId, adminUid, resolution, resolutionType) {
  const snap = await db().ref(`disputes/${disputeId}`).once('value');
  const dispute = snap.val();
  if (!dispute) throw new Error('Dispute not found');
  if (dispute.status !== DISPUTE_STATUS.OPEN && dispute.status !== DISPUTE_STATUS.UNDER_REVIEW) {
    throw new Error('Dispute is already resolved or dismissed');
  }
  const orderSnap = await db().ref(`escrow_orders/${dispute.orderId}`).once('value');
  const order = orderSnap.val();
  if (!order) throw new Error('Associated order not found');
  const amount = parseFloat(order.amount);
  const buyerWallet = await getWalletState(order.buyerUid, WALLET_TYPES.ACTIVE);
  const currentFrozen = parseFloat(buyerWallet?.frozenBalance || 0);
  const newFrozen = parseFloat(Math.max(0, currentFrozen - amount).toFixed(2));
  await db().ref(`wallets/${order.buyerUid}/active`).update({ frozenBalance: newFrozen });
  let releasedAmount = 0;
  if (resolutionType === 'release_to_seller') {
    const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
    const netAmount = parseFloat((amount - fee).toFixed(2));
    await walletTransfer(order.id, order.sellerUid, WALLET_TYPES.ESCROW, WALLET_TYPES.WITHDRAWABLE, netAmount, order.reference, `Dispute resolution: release to seller for order ${dispute.orderId}`);
    releasedAmount = netAmount;
    await db().ref(`escrow_orders/${dispute.orderId}`).update({
      status: ORDER_STATUS.COMPLETED,
      completedAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`orders/${dispute.orderId}`).update({ status: ORDER_STATUS.COMPLETED });
  } else if (resolutionType === 'refund_buyer') {
    await walletTransfer(order.id, order.buyerUid, WALLET_TYPES.ESCROW, WALLET_TYPES.ACTIVE, amount, order.reference, `Dispute resolution: refund buyer for order ${dispute.orderId}`);
    releasedAmount = amount;
    await db().ref(`escrow_orders/${dispute.orderId}`).update({
      status: ORDER_STATUS.REFUNDED,
      refundedAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`orders/${dispute.orderId}`).update({ status: ORDER_STATUS.REFUNDED });
  } else {
    throw new Error('Invalid resolution type. Must be release_to_seller or refund_buyer');
  }
  await db().ref(`disputes/${disputeId}`).update({
    status: DISPUTE_STATUS.RESOLVED,
    resolution: resolution || 'Resolved by admin',
    resolutionType,
    resolvedByUid: adminUid,
    resolvedAt: admin.database.ServerValue.TIMESTAMP,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await db().ref(`escrow_orders/${dispute.orderId}`).update({
    disputeResolved: true,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  sendNotification(order.buyerUid, '✅ Dispute Resolved', `The dispute on order ${dispute.orderId} has been resolved.`, 'info');
  sendNotification(order.sellerUid, '✅ Dispute Resolved', `The dispute on order ${dispute.orderId} has been resolved.`, 'info');
  return { releasedAmount, resolutionType };
}

// ---------------------------------------------------------------------------
// RECONCILIATION ENGINE
// ---------------------------------------------------------------------------

async function runReconciliation() {
  console.log('[RECONCILIATION] Starting daily reconciliation...');
  try {
    const ledgerSnap = await db().ref('ledger').once('value');
    const ledger = ledgerSnap.val() || {};
    let ledgerTotal = 0;
    Object.values(ledger).forEach(e => {
      ledgerTotal += parseFloat(e.amount || 0);
    });
    ledgerTotal = parseFloat(ledgerTotal.toFixed(2));
    const userSnap = await db().ref('users').once('value');
    const users = userSnap.val() || {};
    let sumActiveWallets = 0;
    let sumEscrowWallets = 0;
    let sumWithdrawableWallets = 0;
    let sumFrozenBalances = 0;
    for (const uid of Object.keys(users)) {
      const activeBal = await computeBalance(uid, WALLET_TYPES.ACTIVE);
      const escrowBal = await computeBalance(uid, WALLET_TYPES.ESCROW);
      const withdrawableBal = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
      sumActiveWallets += activeBal;
      sumEscrowWallets += escrowBal;
      sumWithdrawableWallets += withdrawableBal;
      const walletInfo = await getWalletState(uid, WALLET_TYPES.ACTIVE);
      if (walletInfo && walletInfo.frozenBalance) {
        sumFrozenBalances += parseFloat(walletInfo.frozenBalance);
      }
    }
    const totalInSystem = parseFloat((sumActiveWallets + sumEscrowWallets + sumWithdrawableWallets).toFixed(2));
    const availableMpesaBalance = parseFloat(process.env.MPESA_EXPECTED_BALANCE || '0');
    const discrepancy = parseFloat((totalInSystem - availableMpesaBalance).toFixed(2));
    const absDiscrepancy = Math.abs(discrepancy);
    const result = {
      timestamp: admin.database.ServerValue.TIMESTAMP,
      ledgerTotal,
      totalInSystem,
      sumActiveWallets,
      sumEscrowWallets,
      sumWithdrawableWallets,
      sumFrozenBalances,
      availableMpesaBalance,
      discrepancy,
      anomaly: absDiscrepancy > 1.0
    };
    await db().ref('reconciliation_log').push(result);
    if (result.anomaly) {
      console.error(`[RECONCILIATION] ANOMALY DETECTED! Discrepancy: KES ${discrepancy.toFixed(2)}`);
      const adminSnap = await db().ref('users').orderByChild('role').equalTo('admin').once('value');
      if (adminSnap.val()) {
        Object.keys(adminSnap.val()).forEach(aid => {
          sendNotification(aid, '🚨 Reconciliation Anomaly', `Discrepancy of KES ${discrepancy.toFixed(2)} detected between system balances and M-Pesa balance. Immediate attention required.`, 'error');
        });
      }
    } else {
      console.log(`[RECONCILIATION] OK. System: ${totalInSystem}, M-Pesa: ${availableMpesaBalance}, Diff: ${discrepancy.toFixed(2)}`);
    }
    return result;
  } catch (e) {
    console.error('[RECONCILIATION] Error:', e);
  }
}

// ---------------------------------------------------------------------------
// NOTIFICATION HELPER
// ---------------------------------------------------------------------------

async function sendNotification(uid, title, body, type) {
  try {
    const ref = db().ref(`notifications/${uid}`).push();
    await ref.set({ title, body, type: type || 'info', read: false, createdAt: admin.database.ServerValue.TIMESTAMP });
    io.to(uid).emit('notification', { title, body, type: type || 'info' });
  } catch (e) { console.error('Notification error:', e); }
}

// ---------------------------------------------------------------------------
// JWT AUTHENTICATION
// ---------------------------------------------------------------------------

function generateJWT(uid, role, email) {
  return jwt.sign({ uid, role, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyJWT(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function authenticateJWT(req, res, next) {
  let token = req.cookies && req.cookies.authToken;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
  }
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = verifyJWT(token);
    const userSnap = await db().ref(`users/${decoded.uid}`).once('value');
    if (!userSnap.val()) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = { uid: decoded.uid, role: decoded.role || userSnap.val().role, email: decoded.email || userSnap.val().email };
    req.userRole = req.user.role;
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function authenticateFirebase(req, res, next) {
  const idToken = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!idToken) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Firebase auth error:', error);
    return res.status(401).json({ error: 'Invalid Firebase token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

async function requireFirebaseAdmin(req, res, next) {
  const uid = req.user.uid;
  const snap = await db().ref(`users/${uid}/role`).once('value');
  if (snap.val() === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ---------------------------------------------------------------------------
// ROLE PAGE GUARD (for .html routing)
// ---------------------------------------------------------------------------

const rolePages = { '/farmer': 'farmer', '/organisation': 'organization', '/consumer': 'consumer', '/admin': 'admin' };

app.use(async (req, res, next) => {
  const path = req.path;
  const requiredRole = rolePages[path];
  if (!requiredRole) return next();
  const token = req.cookies && req.cookies.idToken;
  if (!token) return res.redirect('/login');
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const roleSnap = await db().ref(`users/${decoded.uid}/role`).once('value');
    const userRole = roleSnap.val() || 'consumer';
    if (userRole !== requiredRole) return res.redirect('/login');
    req.user = decoded;
    req.userRole = userRole;
    next();
  } catch {
    return res.redirect('/login');
  }
});

app.use((req, res, next) => {
  if (req.path.indexOf('.') === -1 && req.path !== '/') {
    const fs = require('fs');
    const testPath = __dirname + req.path + '.html';
    try {
      if (fs.existsSync(testPath)) return res.sendFile(testPath);
    } catch (_) {}
  }
  next();
});

app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/landing-page.html'); });

// ---------------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------------

// ---- AUTH ----

app.post('/api/auth/signup', authLimiter, sanitizeInput, [
  body('idToken').isString().notEmpty(),
  body('displayName').optional().isString(),
  body('role').optional().isIn(['farmer', 'organization', 'consumer', 'admin'])
], validate, async (req, res) => {
  const { idToken, displayName, role } = req.body;
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email;
    const mappedRole = role === 'commercial' ? 'consumer' : (role || 'user');
    await db().ref(`users/${uid}`).set({
      uid, email,
      displayName: displayName || '',
      role: mappedRole,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      lastLoginAt: admin.database.ServerValue.TIMESTAMP,
    });
    await ensureWallet(uid, WALLET_TYPES.ACTIVE);
    await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);
    const jwtToken = generateJWT(uid, mappedRole, email);
    res.cookie('authToken', jwtToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.status(201).json({ uid, email, displayName: displayName || '', role: mappedRole, message: 'User created successfully' });
    if (email) {
      const name = displayName || email.split('@')[0];
      sendEmail(email, 'Welcome to AgriConnect!', welcomeEmail(name));
    }
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create user profile' });
  }
});

app.post('/api/auth/login', authLimiter, sanitizeInput, [
  body('idToken').isString().notEmpty()
], validate, async (req, res) => {
  const { idToken } = req.body;
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const userSnap = await db().ref(`users/${uid}`).once('value');
    let userData = userSnap.val();
    if (!userData) {
      userData = { uid, email: decodedToken.email || '', displayName: decodedToken.name || '', role: 'user', createdAt: admin.database.ServerValue.TIMESTAMP, lastLoginAt: admin.database.ServerValue.TIMESTAMP };
      await db().ref(`users/${uid}`).set(userData);
      await ensureWallet(uid, WALLET_TYPES.ACTIVE);
      await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);
    } else {
      await db().ref(`users/${uid}`).update({ lastLoginAt: admin.database.ServerValue.TIMESTAMP });
    }
    const jwtToken = generateJWT(uid, userData.role, userData.email);
    res.cookie('authToken', jwtToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({
      uid, email: decodedToken.email || userData.email,
      displayName: decodedToken.name || userData.displayName || '',
      phoneNumber: userData.phoneNumber || '',
      role: userData.role || 'user',
      profileComplete: !!(userData.displayName && userData.displayName.trim() && userData.phoneNumber && userData.phoneNumber.trim()),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('authToken', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ message: 'Logged out successfully' });
});

app.post('/api/auth/google', authLimiter, sanitizeInput, [
  body('idToken').isString().notEmpty(),
  body('role').optional().isString()
], validate, async (req, res) => {
  const { idToken, role } = req.body;
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const mappedRole = role === 'commercial' ? 'consumer' : (role || 'user');
    const userSnap = await db().ref(`users/${uid}`).once('value');
    let userData = userSnap.val();
    if (!userData) {
      if (!role) return res.status(404).json({ error: 'User not found. Please sign up first.' });
      userData = { uid, email: decodedToken.email || '', displayName: decodedToken.name || '', photoURL: decodedToken.picture || '', role: mappedRole, provider: 'google', createdAt: admin.database.ServerValue.TIMESTAMP, lastLoginAt: admin.database.ServerValue.TIMESTAMP };
      await db().ref(`users/${uid}`).set(userData);
      await ensureWallet(uid, WALLET_TYPES.ACTIVE);
      await ensureWallet(uid, WALLET_TYPES.WITHDRAWABLE);
    } else {
      await db().ref(`users/${uid}`).update({ lastLoginAt: admin.database.ServerValue.TIMESTAMP, displayName: userData.displayName || decodedToken.name || '', photoURL: userData.photoURL || decodedToken.picture || '' });
    }
    const jwtToken = generateJWT(uid, userData.role || mappedRole, userData.email);
    res.cookie('authToken', jwtToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
    const finalData = userSnap.val() || userData;
    res.json({
      uid, email: finalData.email || decodedToken.email, displayName: finalData.displayName || decodedToken.name || '',
      phoneNumber: finalData.phoneNumber || '', photoURL: finalData.photoURL || decodedToken.picture || '',
      role: (finalData && finalData.role) || mappedRole,
      profileComplete: !!(finalData.displayName && finalData.displayName.trim() && finalData.phoneNumber && finalData.phoneNumber.trim()),
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({ error: 'Invalid or expired Google token' });
  }
});

// ---- USERS ----

app.get('/api/users/:uid', authenticateJWT, async (req, res) => {
  const { uid } = req.params;
  if (req.user.uid !== uid) return res.status(403).json({ error: 'Forbidden' });
  try {
    const snap = await db().ref(`users/${uid}`).once('value');
    const data = snap.val();
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.get('/api/profile/status', authenticateJWT, async (req, res) => {
  try {
    const snap = await db().ref(`users/${req.user.uid}`).once('value');
    const u = snap.val() || {};
    const missing = [];
    if (!u.displayName || !u.displayName.trim()) missing.push('Full Name');
    if (!u.phoneNumber || !u.phoneNumber.trim()) missing.push('Phone Number');
    res.json({ complete: missing.length === 0, missingFields: missing });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check profile' });
  }
});

app.put('/api/users/profile', authenticateJWT, sanitizeInput, async (req, res) => {
  const uid = req.user.uid;
  const { businessName, category, manufacture, produce, location, imageUrls, bio, displayName, phoneNumber } = req.body;
  try {
    const profileData = {};
    if (businessName !== undefined) profileData['profile/businessName'] = businessName;
    if (category !== undefined) profileData['profile/category'] = category;
    if (manufacture !== undefined) profileData['profile/manufacture'] = manufacture;
    if (produce !== undefined) profileData['profile/produce'] = produce;
    if (location !== undefined) profileData['profile/location'] = location;
    if (imageUrls !== undefined) profileData['profile/imageUrls'] = imageUrls;
    if (bio !== undefined) profileData['profile/bio'] = bio;
    if (displayName !== undefined) profileData['displayName'] = displayName;
    if (phoneNumber !== undefined) profileData['phoneNumber'] = phoneNumber;
    profileData['profile/updatedAt'] = admin.database.ServerValue.TIMESTAMP;
    await db().ref(`users/${uid}`).update(profileData);
    const snap = await db().ref(`users/${uid}`).once('value');
    res.json(snap.val());
  } catch (e) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/users', authenticateJWT, async (req, res) => {
  const { role, email } = req.query;
  try {
    const snap = await db().ref('users').once('value');
    const all = snap.val() || {};
    let list = Object.entries(all).map(([uid, u]) => ({ uid, ...u }));
    if (role) list = list.filter(u => u.role === role);
    if (email) list = list.filter(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    list = list.map(({ uid, email, displayName, role, photoURL }) => ({ uid, email, displayName, role, photoURL }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ---- WALLET ID LOOKUP & TRANSFER ----

app.get('/api/wallet/id', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`wallet_ids_by_uid/${uid}`).once('value');
    const data = snap.val();
    if (!data) {
      await getOrCreateWalletId(uid, req.user.email || '', req.user.email || '');
      const retry = await db().ref(`wallet_ids_by_uid/${uid}`).once('value');
      if (!retry.val()) return res.status(500).json({ error: 'Failed to create wallet ID' });
      return res.json({ walletId: retry.val().walletId });
    }
    res.json({ walletId: data.walletId });
  } catch (e) {
    console.error('Wallet ID fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch wallet ID' });
  }
});

app.get('/api/wallet/lookup', authenticateJWT, sanitizeInput, [
  query('walletId').isString().isLength({ min: 8, max: 8 })
], validate, async (req, res) => {
  const { walletId } = req.query;
  try {
    const recipient = await lookupWalletId(walletId);
    if (!recipient) return res.status(404).json({ error: 'Wallet ID not found' });
    if (recipient.uid === req.user.uid) return res.status(400).json({ error: 'Cannot transfer to yourself' });
    res.json(recipient);
  } catch (e) {
    console.error('Wallet lookup error:', e);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.post('/api/wallet/transfer', authenticateJWT, walletRestrictionMiddleware(WALLET_TYPES.ACTIVE), apiLimiter, sanitizeInput, [
  body('walletId').isString().isLength({ min: 8, max: 8 }),
  body('amount').isFloat({ min: MIN_TRANSFER }),
  body('description').optional().isString(),
  body('idempotencyKey').optional().isString().isLength({ min: 8, max: 128 })
], validate, checkIdempotency, async (req, res) => {
  const { walletId, amount, description, idempotencyKey } = req.body;
  const fromUid = req.user.uid;
  try {
    const recipient = await lookupWalletId(walletId);
    if (!recipient) return res.status(404).json({ error: 'Recipient wallet ID not found' });
    if (recipient.uid === fromUid) return res.status(400).json({ error: 'Cannot transfer to yourself' });

    const allowed = await checkWalletNotRestricted(recipient.uid, WALLET_TYPES.ACTIVE);
    if (!allowed) return res.status(400).json({ error: 'Recipient account is restricted' });

    const parsedAmount = parseAmount(amount);
    if (!parsedAmount || parsedAmount < MIN_TRANSFER) return res.status(400).json({ error: `Minimum transfer is KES ${MIN_TRANSFER}` });

    const fromBalance = await computeBalance(fromUid, WALLET_TYPES.ACTIVE);
    const fromWalletInfo = await getWalletState(fromUid, WALLET_TYPES.ACTIVE);
    const fromAvailable = parseFloat((fromBalance - parseFloat(fromWalletInfo?.frozenBalance || 0)).toFixed(2));

    const fee = parseFloat((parsedAmount * TRANSFER_FEE_RATE).toFixed(2));
    const totalDeduction = parseFloat((parsedAmount + fee).toFixed(2));
    if (fromAvailable < totalDeduction) {
      return res.status(400).json({ error: `Insufficient balance. Available: KES ${fromAvailable.toFixed(2)}, needed: KES ${totalDeduction.toFixed(2)} (incl. fee KES ${fee.toFixed(2)})` });
    }

    const txnRef = generateTxnId();
    const desc = description || `Wallet transfer to ${recipient.displayName}`;

    await debitWallet(fromUid, WALLET_TYPES.ACTIVE, totalDeduction, txnRef, desc, null, { fee, toUid: recipient.uid, walletId });
    await creditWallet(recipient.uid, WALLET_TYPES.ACTIVE, parsedAmount, txnRef, `Transfer from ${req.user.email || fromUid}: ${desc}`, null, { fee, fromUid });

    if (fee > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: fee,
        fromWallet: WALLET_TYPES.ACTIVE,
        fromUid,
        toUid: 'platform',
        reference: txnRef,
        description: `Transfer fee (${(TRANSFER_FEE_RATE * 100)}%) on ${txnRef}`
      });
    }

    const newBalance = await computeBalance(fromUid, WALLET_TYPES.ACTIVE);
    await db().ref(`transactions/${fromUid}`).push({
      type: 'transfer', amount: -totalDeduction, fee, balance: newBalance, reference: txnRef,
      description: `Transfer to ${recipient.displayName} (${recipient.walletId}): ${desc}`,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`transactions/${recipient.uid}`).push({
      type: 'transfer', amount: parsedAmount, balance: await computeBalance(recipient.uid, WALLET_TYPES.ACTIVE), reference: txnRef,
      description: `Transfer from ${req.user.email || fromUid}: ${desc}`,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    if (idempotencyKey) {
      await recordIdempotency(idempotencyKey, { status: 'success', reference: txnRef, amount: parsedAmount, toUid: recipient.uid });
    }

    sendNotification(recipient.uid, '💰 Payment Received', `${req.user.email || 'A user'} sent you KES ${parsedAmount.toFixed(2)}.`, 'success');
    res.json({ balance: newBalance, fee, amount: parsedAmount, toWalletId: walletId, toName: recipient.displayName, message: `KES ${parsedAmount.toFixed(2)} sent to ${recipient.displayName} (fee: KES ${fee.toFixed(2)})` });
  } catch (e) {
    console.error('Transfer error:', e);
    res.status(400).json({ error: e.message || 'Failed to process transfer' });
  }
});

// ---- M-PESA DEPOSIT (STK PUSH) ----

app.post('/api/mpesa/stkpush', authenticateJWT, walletRestrictionMiddleware(WALLET_TYPES.ACTIVE), apiLimiter, sanitizeInput, [
  body('phoneNumber').isString().matches(/^(0|\+?254)\d{9}$/),
  body('amount').isFloat({ min: MIN_DEPOSIT }),
  body('idempotencyKey').optional().isString().isLength({ min: 8, max: 128 })
], validate, checkIdempotency, async (req, res) => {
  const { phoneNumber, amount, idempotencyKey } = req.body;
  const uid = req.user.uid;
  try {
    const parsedAmount = Math.round(parseFloat(amount));
    if (parsedAmount < MIN_DEPOSIT) return res.status(400).json({ error: `Minimum deposit is KES ${MIN_DEPOSIT}` });
    const reference = generateTxnId();
    const result = await stkPush(phoneNumber, parsedAmount, reference, `AgriConnect deposit for ${uid}`, idempotencyKey || null);
    await db().ref(`mpesa_deposits/${uid}/${result.CheckoutRequestID}`).set({
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      amount: parsedAmount,
      phoneNumber,
      reference,
      status: 'pending',
      uid,
      idempotencyKey: idempotencyKey || null,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    if (idempotencyKey) {
      await recordIdempotency(idempotencyKey, { checkoutRequestId: result.CheckoutRequestID, reference, status: 'pending' });
    }
    res.json({
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      reference,
      message: 'STK Push sent. Please check your phone and enter your M-Pesa PIN.'
    });
  } catch (e) {
    console.error('STK Push error:', e);
    res.status(400).json({ error: e.message || 'Failed to initiate STK Push' });
  }
});

app.post('/api/mpesa/stkquery', authenticateJWT, sanitizeInput, [
  body('checkoutRequestId').isString().notEmpty()
], validate, async (req, res) => {
  try {
    const result = await stkQuery(req.body.checkoutRequestId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Query failed' });
  }
});

app.post('/api/mpesa/status', authenticateJWT, sanitizeInput, [
  body('checkoutRequestId').isString().notEmpty()
], validate, async (req, res) => {
  const { checkoutRequestId } = req.body;
  try {
    const [stkSnap, depositSnaps] = await Promise.all([
      db().ref(`mpesa_stk_requests/${checkoutRequestId}`).once('value'),
      db().ref('mpesa_deposits').once('value')
    ]);
    let depositRecord = stkSnap.val();
    if (!depositRecord) {
      const deposits = depositSnaps.val() || {};
      for (const uid of Object.keys(deposits)) {
        if (deposits[uid][checkoutRequestId]) {
          depositRecord = deposits[uid][checkoutRequestId];
          break;
        }
      }
    }
    if (!depositRecord) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ status: depositRecord.status, reference: depositRecord.reference, amount: depositRecord.amount });
  } catch (e) {
    console.error('M-Pesa status fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ---- C2B CALLBACK (M-Pesa sends result here) ----

app.post('/api/mpesa/c2b/callback', webhookLimiter, async (req, res) => {
  try {
    const body = req.body;
    const stkCallback = body.Body && body.Body.stkCallback;
    if (!stkCallback) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = stkCallback;
    if (ResultCode !== 0) {
      await db().ref(`mpesa_stk_requests/${CheckoutRequestID}/status`).set('failed');
      await db().ref('mpesa_failed_callbacks').push({
        checkoutRequestId: CheckoutRequestID, resultCode: ResultCode, resultDesc: ResultDesc,
        receivedAt: admin.database.ServerValue.TIMESTAMP
      });
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    const items = CallbackMetadata && CallbackMetadata.Item ? CallbackMetadata.Item : [];
    let amount = 0, mpesaReceiptNumber = '', phoneNumber = '', transactionDate = '';
    items.forEach(item => {
      if (item.Name === 'Amount') amount = parseFloat(item.Value || 0);
      if (item.Name === 'MpesaReceiptNumber') mpesaReceiptNumber = item.Value;
      if (item.Name === 'PhoneNumber') phoneNumber = String(item.Value);
      if (item.Name === 'TransactionDate') transactionDate = String(item.Value);
    });
    if (!mpesaReceiptNumber) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    const processedSnap = await db().ref(`mpesa_processed/${mpesaReceiptNumber}`).once('value');
    if (processedSnap.val()) {
      console.log(`[MPESA] Duplicate callback ignored for receipt: ${mpesaReceiptNumber}`);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    await db().ref(`mpesa_processed/${mpesaReceiptNumber}`).set({
      processedAt: admin.database.ServerValue.TIMESTAMP,
      checkoutRequestId: CheckoutRequestID
    });
    const stkReqSnap = await db().ref(`mpesa_stk_requests/${CheckoutRequestID}`).once('value');
    const stkReq = stkReqSnap.val() || {};
    const uid = stkReq.uid || null;
    const idempotencyKey = stkReq.idempotencyKey || null;
    if (!uid) {
      const depositsSnap = await db().ref('mpesa_deposits').once('value');
      const deposits = depositsSnap.val() || {};
      for (const someUid of Object.keys(deposits)) {
        if (deposits[someUid][CheckoutRequestID]) {
          uid = someUid;
          break;
        }
      }
    }
    if (!uid) {
      console.error(`[MPESA] No user found for callback ${CheckoutRequestID}`);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
    const netAmount = parseFloat((amount - fee).toFixed(2));
    await creditWallet(uid, WALLET_TYPES.ACTIVE, netAmount, mpesaReceiptNumber, `M-Pesa deposit via ${mpesaReceiptNumber} (fee: KES ${fee.toFixed(2)})`, null, {
      mpesaReceiptNumber,
      checkoutRequestId: CheckoutRequestID,
      phoneNumber,
      grossAmount: amount,
      fee
    });
    if (fee > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: fee,
        fromWallet: WALLET_TYPES.ACTIVE,
        toWallet: WALLET_TYPES.ACTIVE,
        fromUid: uid,
        toUid: 'platform',
        reference: mpesaReceiptNumber,
        description: `Deposit fee (${(DEPOSIT_FEE_RATE * 100)}%) on ${mpesaReceiptNumber}`
      });
    }
    const newBalance = await computeBalance(uid, WALLET_TYPES.ACTIVE);
    await db().ref(`mpesa_stk_requests/${CheckoutRequestID}`).update({
      status: 'success',
      amount,
      netAmount,
      fee,
      mpesaReceiptNumber,
      phoneNumber,
      transactionDate,
      processedAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`mpesa_deposits/${uid}/${CheckoutRequestID}`).update({
      status: 'success',
      netAmount,
      fee,
      mpesaReceiptNumber,
      processedAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`transactions/${uid}`).push({
      type: 'deposit', amount: netAmount, fee, balance: newBalance, reference: mpesaReceiptNumber,
      description: `M-Pesa deposit (fee: KES ${fee.toFixed(2)})`,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    if (idempotencyKey) {
      await recordIdempotency(idempotencyKey, { status: 'success', mpesaReceiptNumber, amount: netAmount });
    }
    const userSnap = await db().ref(`users/${uid}`).once('value');
    const userData = userSnap.val() || {};
    if (userData.email) {
      sendEmail(userData.email, 'Deposit Confirmed - AgriConnect', depositEmail(userData.displayName || 'User', netAmount, newBalance, mpesaReceiptNumber));
    }
    sendNotification(uid, '💰 Deposit Received', `KES ${netAmount.toFixed(2)} has been credited to your active wallet. Receipt: ${mpesaReceiptNumber}`, 'success');
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('[MPESA] Callback error:', e);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

app.post('/api/mpesa/c2b/confirmation', webhookLimiter, async (req, res) => {
  console.log('[MPESA] C2B Confirmation received:', req.body);
  const { TransactionType, TransID, TransTime, TransAmount, BusinessShortCode, BillRefNumber, OrgAccountBalance, MSISDN, FirstName, MiddleName, LastName } = req.body;
  try {
    const processedSnap = await db().ref(`mpesa_processed/${TransID}`).once('value');
    if (processedSnap.val()) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    await db().ref(`mpesa_processed/${TransID}`).set({ processedAt: admin.database.ServerValue.TIMESTAMP, type: 'c2b_confirmation' });
    const amount = parseFloat(TransAmount || 0);
    const senderPhone = String(MSISDN || '');
    const uid = BillRefNumber && BillRefNumber.startsWith('uid_') ? BillRefNumber.replace('uid_', '') : null;
    if (uid) {
      const fee = parseFloat((amount * DEPOSIT_FEE_RATE).toFixed(2));
      const netAmount = parseFloat((amount - fee).toFixed(2));
      await creditWallet(uid, WALLET_TYPES.ACTIVE, netAmount, TransID, `M-Pesa C2B deposit via ${TransID}`, null, { transId: TransID, senderPhone, grossAmount: amount, fee });
      sendNotification(uid, '💰 M-Pesa Deposit', `KES ${netAmount.toFixed(2)} received. Receipt: ${TransID}`, 'success');
    } else {
      await db().ref('mpesa_unlinked_c2b').push({
        transId: TransID, transTime: TransTime, amount, senderPhone, billRefNumber: BillRefNumber,
        receivedAt: admin.database.ServerValue.TIMESTAMP
      });
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('[MPESA] C2B Confirmation error:', e);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
  }
});

app.post('/api/mpesa/c2b/validation', webhookLimiter, async (req, res) => {
  console.log('[MPESA] C2B Validation received:', req.body);
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ---- B2C RESULT (Payout callback) ----

app.post('/api/mpesa/b2c/result', webhookLimiter, async (req, res) => {
  console.log('[MPESA] B2C Result:', req.body);
  try {
    const { Result } = req.body;
    if (Result) {
      const { ResultType, ResultCode, ResultDesc, TransactionID, ReferenceData } = Result;
      await db().ref('mpesa_b2c_results').push({
        resultType: ResultType, resultCode: ResultCode, resultDesc: ResultDesc,
        transactionId: TransactionID, referenceData: ReferenceData,
        receivedAt: admin.database.ServerValue.TIMESTAMP
      });
      if (ResultCode === 0 && ReferenceData && ReferenceData.ReferenceItem) {
        const payoutId = ReferenceData.ReferenceItem.Value;
        if (payoutId) {
          await db().ref(`payouts/${payoutId}`).update({
            status: 'completed',
            mpesaTransactionId: TransactionID,
            completedAt: admin.database.ServerValue.TIMESTAMP
          });
          const payoutSnap = await db().ref(`payouts/${payoutId}`).once('value');
          const payout = payoutSnap.val();
          if (payout) {
            sendNotification(payout.uid, '✅ Withdrawal Complete', `KES ${payout.amount} sent to your M-Pesa. Transaction: ${TransactionID}`, 'success');
          }
        }
      }
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (e) {
    console.error('[MPESA] B2C result error:', e);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
  }
});

app.post('/api/mpesa/b2c/timeout', webhookLimiter, async (req, res) => {
  console.log('[MPESA] B2C Timeout:', req.body);
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ---- WALLET ----

app.get('/api/wallet', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const activeBalance = await computeBalance(uid, WALLET_TYPES.ACTIVE);
    const escrowBalance = await computeBalance(uid, WALLET_TYPES.ESCROW);
    const withdrawableBalance = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
    const walletInfo = await getWalletState(uid, WALLET_TYPES.ACTIVE);
    const txSnap = await db().ref(`transactions/${uid}`).orderByChild('createdAt').limitToLast(50).once('value');
    const txs = txSnap.val() || {};
    const transactions = Object.entries(txs).map(([id, t]) => ({ id, ...t })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({
      activeBalance,
      escrowBalance,
      withdrawableBalance,
      frozenBalance: parseFloat(walletInfo?.frozenBalance || 0),
      status: walletInfo?.status || WALLET_STATUS.ACTIVE,
      transactions
    });
  } catch (e) {
    console.error('Wallet fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

app.get('/api/wallet/transactions', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snapshot = await db().ref('ledger').once('value');
    const all = snapshot.val() || {};
    const userTx = Object.values(all).filter(e => e.fromUid === uid || e.toUid === uid);
    res.json(userTx.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.post('/api/wallet/withdraw', authenticateJWT, walletRestrictionMiddleware(WALLET_TYPES.WITHDRAWABLE), sanitizeInput, [
  body('amount').isFloat({ min: MIN_WITHDRAWAL }),
  body('phoneNumber').isString().matches(/^(0|\+?254)\d{9}$/),
  body('idempotencyKey').optional().isString().isLength({ min: 8, max: 128 })
], validate, checkIdempotency, async (req, res) => {
  const uid = req.user.uid;
  const { amount, phoneNumber, idempotencyKey } = req.body;
  try {
    const parsedAmount = parseAmount(amount);
    if (!parsedAmount || parsedAmount < MIN_WITHDRAWAL) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}` });
    const withdrawableBalance = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
    if (withdrawableBalance < parsedAmount) {
      return res.status(400).json({ error: `Insufficient withdrawable balance. Available: KES ${withdrawableBalance.toFixed(2)}` });
    }
    const feeRate = parseFloat(process.env.WITHDRAWAL_FEE_RATE || '0.01');
    const fee = parseFloat(Math.max(10, parsedAmount * feeRate).toFixed(2));
    const netAmount = parseFloat((parsedAmount - fee).toFixed(2));
    const txnRef = generateTxnId();
    await debitWallet(uid, WALLET_TYPES.WITHDRAWABLE, parsedAmount, txnRef, `Withdrawal to M-Pesa ${phoneNumber}`, null, { fee, netAmount });
    if (fee > 0) {
      await createLedgerEntry({
        type: LEDGER_ENTRY_TYPE.FEE,
        amount: fee,
        fromWallet: WALLET_TYPES.WITHDRAWABLE,
        toWallet: WALLET_TYPES.ACTIVE,
        fromUid: uid,
        toUid: 'platform',
        reference: txnRef,
        description: `Withdrawal fee on ${txnRef}`
      });
    }
    const payoutRef = db().ref('payouts').push();
    await payoutRef.set({
      uid, amount: parsedAmount, fee, netAmount, method: 'mpesa',
      phoneNumber: phoneNumber.replace(/^0+/, '254').replace(/^\+?254/, '254'),
      status: 'pending', reference: txnRef,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref(`transactions/${uid}`).push({
      type: 'withdrawal', amount: -parsedAmount, fee, balance: await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE), reference: txnRef,
      description: `Withdrawal to M-Pesa ${phoneNumber} (fee: KES ${fee.toFixed(2)})`,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    if (idempotencyKey) {
      await recordIdempotency(idempotencyKey, { status: 'pending', reference: txnRef, payoutId: payoutRef.key });
    }
    try {
      const b2cResult = await b2cPayment(phoneNumber, netAmount, `AgriConnect payout ${txnRef}`, 'Payout');
      await payoutRef.update({ b2cResult: JSON.stringify(b2cResult), initiatedAt: admin.database.ServerValue.TIMESTAMP });
    } catch (b2cErr) {
      console.error('[MPESA] B2C failed, payout queued for manual processing:', b2cErr.message);
      await payoutRef.update({ b2cError: b2cErr.message, queuedForManual: true });
    }
    const adminSnap = await db().ref('users').orderByChild('role').equalTo('admin').once('value');
    if (adminSnap.val()) {
      Object.keys(adminSnap.val()).forEach(aid => {
        sendNotification(aid, '💰 New Withdrawal', `KES ${parsedAmount.toFixed(2)} withdrawal by ${uid}`, 'info');
      });
    }
    const userSnap = await db().ref(`users/${uid}`).once('value');
    const userData = userSnap.val() || {};
    if (userData.email) {
      sendEmail(userData.email, 'Withdrawal Initiated - AgriConnect', withdrawalEmail(userData.displayName || 'User', parsedAmount, `Reference: ${txnRef}`));
    }
    sendNotification(uid, '💰 Withdrawal Initiated', `KES ${netAmount.toFixed(2)} will be sent to your M-Pesa.`, 'info');
    res.json({ message: 'Withdrawal initiated', reference: txnRef, payoutId: payoutRef.key, amount: parsedAmount, fee, netAmount });
    io.emit('payoutUpdate', { action: 'created', id: payoutRef.key });
  } catch (e) {
    console.error('Withdrawal error:', e);
    res.status(400).json({ error: e.message || 'Failed to process withdrawal' });
  }
});

// ---- ORDERS & ESCROW ----

app.post('/api/orders', authenticateJWT, walletRestrictionMiddleware(WALLET_TYPES.ACTIVE), sanitizeInput, [
  body('listingId').isString().notEmpty(),
  body('farmerUid').isString().notEmpty(),
  body('quantity').isInt({ min: 1 }),
  body('totalPrice').isFloat({ min: 1 }),
  body('idempotencyKey').optional().isString().isLength({ min: 8, max: 128 })
], validate, checkIdempotency, async (req, res) => {
  const { listingId, farmerUid, quantity, totalPrice, idempotencyKey } = req.body;
  const buyerUid = req.user.uid;
  if (buyerUid === farmerUid) return res.status(400).json({ error: 'Cannot place order on your own listing' });
  try {
    const parsedAmount = parseAmount(totalPrice);
    if (!parsedAmount) return res.status(400).json({ error: 'Invalid price' });
    const reference = generateTxnId();
    const { order, otp } = await createEscrowOrder(buyerUid, farmerUid, parsedAmount, listingId, quantity, reference);
    if (idempotencyKey) {
      await recordIdempotency(idempotencyKey, { orderId: order.id, status: ORDER_STATUS.IN_ESCROW, reference });
    }
    sendNotification(buyerUid, '🔐 Order Placed - Funds in Escrow', `Order #${order.id} placed. KES ${parsedAmount.toFixed(2)} held in escrow.`, 'success');
    res.status(201).json({
      orderId: order.id,
      reference,
      status: order.status,
      amount: parsedAmount,
      message: 'Order placed. Funds are now in escrow.',
      qrData: JSON.stringify({ orderId: order.id, otp }),
      otp
    });
  } catch (e) {
    console.error('Order creation error:', e);
    res.status(400).json({ error: e.message || 'Failed to create order' });
  }
});

app.get('/api/orders', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref('escrow_orders').once('value');
    const all = snap.val() || {};
    const list = Object.values(all).filter(o => o.buyerUid === uid || o.sellerUid === uid)
      .map(o => ({ ...o, otpHash: undefined })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.get('/api/orders/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const snap = await db().ref(`escrow_orders/${id}`).once('value');
    const order = snap.val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerUid !== req.user.uid && order.sellerUid !== req.user.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { otpHash, ...safe } = order;
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

app.patch('/api/orders/:id/deliver', authenticateJWT, sanitizeInput, [
  param('id').isString().notEmpty()
], validate, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`escrow_orders/${id}`).once('value');
    const order = snap.val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.sellerUid !== uid) return res.status(403).json({ error: 'Only the seller can mark as dispatched' });
    if (order.status !== ORDER_STATUS.IN_ESCROW) return res.status(400).json({ error: `Order cannot be dispatched in status: ${order.status}` });
    await db().ref(`escrow_orders/${id}`).update({ status: ORDER_STATUS.DISPATCHED, dispatchedAt: admin.database.ServerValue.TIMESTAMP, updatedAt: admin.database.ServerValue.TIMESTAMP });
    await db().ref(`orders/${id}`).update({ status: ORDER_STATUS.DISPATCHED, updatedAt: admin.database.ServerValue.TIMESTAMP });
    sendNotification(order.buyerUid, '📦 Order Dispatched', `Order #${id} has been marked as dispatched. Verify delivery using the OTP.`, 'info');
    res.json({ message: 'Order marked as dispatched', status: ORDER_STATUS.DISPATCHED });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to update order' });
  }
});

app.post('/api/orders/:id/verify', authenticateJWT, sanitizeInput, [
  param('id').isString().notEmpty(),
  body('otp').isString().isLength({ min: 6, max: 6 })
], validate, async (req, res) => {
  const { id } = req.params;
  const { otp } = req.body;
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`escrow_orders/${id}`).once('value');
    const order = snap.val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerUid !== uid) return res.status(403).json({ error: 'Only the buyer can verify delivery' });
    await verifyEscrowDelivery(id, otp);
    const netAmount = await releaseEscrowToSeller(id);
    sendNotification(order.sellerUid, '✅ Payment Released', `KES ${netAmount.toFixed(2)} has been released to your withdrawable wallet.`, 'success');
    res.json({ message: 'Delivery verified and funds released to seller', status: ORDER_STATUS.COMPLETED, releasedAmount: netAmount });
  } catch (e) {
    console.error('Verify delivery error:', e);
    res.status(400).json({ error: e.message || 'Failed to verify delivery' });
  }
});

app.post('/api/orders/:id/cancel', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`escrow_orders/${id}`).once('value');
    const order = snap.val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerUid !== uid && order.sellerUid !== uid) return res.status(403).json({ error: 'Forbidden' });
    const refunded = await cancelEscrow(id);
    res.json({ message: 'Order cancelled, funds returned', refundedAmount: refunded });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to cancel order' });
  }
});

// ---- QR CODE DATA ----

app.get('/api/orders/:id/qr', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const snap = await db().ref(`escrow_orders/${id}`).once('value');
    const order = snap.val();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyerUid !== req.user.uid && order.sellerUid !== req.user.uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const qrData = JSON.stringify({ orderId: id, otp: order.otpHash ? 'Use OTP directly' : 'No OTP', amount: order.amount, status: order.status });
    res.json({ qrData, orderId: id, amount: order.amount, status: order.status });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate QR data' });
  }
});

// ---- DISPUTES ----

app.post('/api/disputes', authenticateJWT, sanitizeInput, [
  body('orderId').isString().notEmpty(),
  body('reason').isString().isLength({ min: 10, max: 2000 }),
  body('evidenceUrls').optional().isArray()
], validate, async (req, res) => {
  const { orderId, reason, evidenceUrls } = req.body;
  try {
    const dispute = await raiseDispute(orderId, req.user.uid, reason, evidenceUrls || []);
    res.status(201).json({ disputeId: dispute.id, status: dispute.status, message: 'Dispute raised. An admin will review it shortly.' });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to raise dispute' });
  }
});

app.get('/api/disputes', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref('disputes').once('value');
    const all = snap.val() || {};
    const list = Object.values(all).filter(d => {
      return d.raisedByUid === uid;
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

app.get('/api/disputes/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  try {
    const snap = await db().ref(`disputes/${id}`).once('value');
    const dispute = snap.val();
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
    const orderSnap = await db().ref(`escrow_orders/${dispute.orderId}`).once('value');
    const order = orderSnap.val() || {};
    if (order.buyerUid !== req.user.uid && order.sellerUid !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ ...dispute, order });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch dispute' });
  }
});

// ---- LISTINGS ----

app.post('/api/listings', authenticateJWT, sanitizeInput, [
  body('title').isString().notEmpty(),
  body('description').isString().notEmpty(),
  body('price').isFloat({ min: 1 })
], validate, async (req, res) => {
  const { title, description, price, category, location, quantity, imageUrls } = req.body;
  const uid = req.user.uid;
  try {
    const newRef = db().ref('listings').push();
    await newRef.set({
      uid, title, description, price: parseFloat(price), category: category || '', location: location || '',
      quantity: quantity || '', imageUrls: imageUrls || [], createdAt: admin.database.ServerValue.TIMESTAMP, status: 'active'
    });
    const listing = await newRef.once('value');
    const allUsersSnap = await db().ref('users').once('value');
    const allUsers = allUsersSnap.val() || {};
    Object.entries(allUsers).forEach(([ouid, ou]) => {
      if (ou.role === 'organization') {
        sendNotification(ouid, '📦 New Product', `${title} listed at KES ${parseFloat(price).toFixed(2)}`, 'info');
      }
    });
    res.status(201).json({ id: newRef.key, ...listing.val() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

app.get('/api/listings', authenticateJWT, async (req, res) => {
  try {
    const snap = await db().ref('listings').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).filter(([, l]) => l.status === 'active').map(([id, l]) => ({ id, ...l }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

app.get('/api/listings/mine', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref('listings').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).filter(([, l]) => l.uid === uid).map(([id, l]) => ({ id, ...l }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ---- AGREEMENTS ----

app.post('/api/agreements', authenticateJWT, sanitizeInput, [
  body('orgUid').isString().notEmpty()
], validate, async (req, res) => {
  const { orgUid, terms } = req.body;
  const farmerUid = req.user.uid;
  try {
    const newRef = db().ref('agreements').push();
    await newRef.set({ farmerUid, orgUid, terms: terms || '', status: 'pending', createdAt: admin.database.ServerValue.TIMESTAMP });
    const snap = await newRef.once('value');
    res.status(201).json({ id: newRef.key, ...snap.val() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create agreement' });
  }
});

app.get('/api/agreements', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref('agreements').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).filter(([, a]) => a.farmerUid === uid || a.orgUid === uid).map(([id, a]) => ({ id, ...a }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch agreements' });
  }
});

app.patch('/api/agreements/:id', authenticateJWT, sanitizeInput, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const uid = req.user.uid;
  if (!['active', 'rejected', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const ref = db().ref(`agreements/${id}`);
    const snap = await ref.once('value');
    const agreement = snap.val();
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    if (agreement.farmerUid !== uid && agreement.orgUid !== uid) return res.status(403).json({ error: 'Not authorized' });
    await ref.update({ status, updatedAt: admin.database.ServerValue.TIMESTAMP });
    res.json({ id, status, message: `Agreement ${status}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update agreement' });
  }
});

// ---- REQUESTS (Org posts needs) ----

app.post('/api/requests', authenticateJWT, sanitizeInput, [
  body('title').isString().notEmpty(),
  body('description').isString().notEmpty()
], validate, async (req, res) => {
  const { title, description, quantity, location } = req.body;
  const uid = req.user.uid;
  try {
    const userSnap = await db().ref(`users/${uid}`).once('value');
    const userData = userSnap.val() || {};
    const newRef = db().ref('requests').push();
    await newRef.set({
      uid, displayName: userData.displayName || userData.profile?.businessName || 'Unknown Organization',
      title, description, quantity: quantity || '', location: location || '',
      createdAt: admin.database.ServerValue.TIMESTAMP, status: 'open'
    });
    const snap = await newRef.once('value');
    const allUsersSnap = await db().ref('users').once('value');
    const allUsers = allUsersSnap.val() || {};
    Object.entries(allUsers).forEach(([fuid, fu]) => {
      if (fu.role === 'farmer') {
        sendNotification(fuid, '📢 New Request', `${userData.displayName || 'An organization'} posted: "${title}"`, 'info');
      }
    });
    res.status(201).json({ id: newRef.key, ...snap.val() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create request' });
  }
});

app.get('/api/requests', authenticateJWT, async (req, res) => {
  try {
    const snap = await db().ref('requests').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).filter(([, r]) => r.status === 'open').map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

app.delete('/api/requests/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`requests/${id}`).once('value');
    const reqData = snap.val();
    if (!reqData) return res.status(404).json({ error: 'Request not found' });
    if (reqData.uid !== uid) return res.status(403).json({ error: 'Not authorized' });
    await db().ref(`requests/${id}`).update({ status: 'closed' });
    res.json({ message: 'Request closed' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to close request' });
  }
});

app.post('/api/requests/:id/reply', authenticateJWT, sanitizeInput, [
  param('id').isString().notEmpty(),
  body('message').isString().notEmpty()
], validate, async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const uid = req.user.uid;
  try {
    const reqSnap = await db().ref(`requests/${id}`).once('value');
    const reqData = reqSnap.val();
    if (!reqData || reqData.status !== 'open') return res.status(404).json({ error: 'Request not found or closed' });
    const replyRef = db().ref(`requests/${id}/replies`).push();
    const userSnap = await db().ref(`users/${uid}`).once('value');
    const userData = userSnap.val() || {};
    await replyRef.set({ uid, displayName: userData.displayName || 'Unknown', message, createdAt: admin.database.ServerValue.TIMESTAMP });
    sendNotification(reqData.uid, 'New Reply', `${userData.displayName || 'A farmer'} replied to your request: "${reqData.title}"`, 'success');
    const snap = await replyRef.once('value');
    res.status(201).json({ id: replyRef.key, ...snap.val() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reply' });
  }
});

// ---- NOTIFICATIONS ----

app.get('/api/notifications', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`notifications/${uid}`).orderByChild('createdAt').limitToLast(50).once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).map(([id, n]) => ({ id, ...n })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications/read', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref(`notifications/${uid}`).once('value');
    const all = snap.val() || {};
    const updates = {};
    Object.keys(all).forEach(key => { updates[`${key}/read`] = true; });
    await db().ref(`notifications/${uid}`).update(updates);
    res.json({ message: 'All marked read' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

app.post('/api/notifications/read/:id', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  const { id } = req.params;
  try {
    await db().ref(`notifications/${uid}/${id}/read`).set(true);
    res.json({ message: 'Marked as read' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// ---- CONTACT / SUPPORT ----

app.post('/api/contact', sanitizeInput, [
  body('name').isString().notEmpty(),
  body('email').isEmail(),
  body('subject').isString().notEmpty(),
  body('message').isString().notEmpty()
], validate, async (req, res) => {
  const { name, email, subject, message } = req.body;
  try {
    await db().ref('contact_queries').push({ name, email, subject, message, replied: false, createdAt: admin.database.ServerValue.TIMESTAMP });
    res.json({ message: 'Query submitted successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to submit query' });
  }
});

// ---- ADMIN ROUTES ----

app.get('/api/admin/stats', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const [usersSnap, listingsSnap, ordersSnap, agreementsSnap, requestsSnap] = await Promise.all([
      db().ref('users').once('value'), db().ref('listings').once('value'),
      db().ref('orders').once('value'), db().ref('agreements').once('value'),
      db().ref('requests').once('value')
    ]);
    const users = usersSnap.val() || {};
    const listings = listingsSnap.val() || {};
    const orders = ordersSnap.val() || {};
    const agreements = agreementsSnap.val() || {};
    const requests = requestsSnap.val() || {};
    const roleCounts = {};
    Object.values(users).forEach(u => { const r = u.role || 'unknown'; roleCounts[r] = (roleCounts[r] || 0) + 1; });
    res.json({
      totalUsers: Object.keys(users).length, totalListings: Object.keys(listings).length,
      totalOrders: Object.keys(orders).length, totalAgreements: Object.keys(agreements).length,
      activeRequests: Object.values(requests).filter(r => r.status === 'open').length,
      roleCounts, pendingOrders: Object.values(orders).filter(o => o.status === 'pending').length,
      activeAgreements: Object.values(agreements).filter(a => a.status === 'active').length,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/analytics', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const [ordersSnap, usersSnap, transactionsSnap] = await Promise.all([
      db().ref('orders').once('value'), db().ref('users').once('value'),
      db().ref('transactions').once('value')
    ]);
    const orders = ordersSnap.val() || {};
    const users = usersSnap.val() || {};
    const transactions = transactionsSnap.val() || {};
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekStart = now - 6 * dayMs;
    const revenueByDay = Array(7).fill(0);
    const ordersByDay = Array(7).fill(0);
    const signupsByDay = Array(7).fill(0);
    Object.values(orders).forEach(o => {
      const created = o.createdAt ? new Date(o.createdAt).getTime() : 0;
      if (created >= weekStart && created <= now) {
        const dayIndex = Math.floor((created - weekStart) / dayMs);
        if (dayIndex >= 0 && dayIndex < 7) { ordersByDay[dayIndex]++; revenueByDay[dayIndex] += parseFloat(o.totalPrice || 0); }
      }
    });
    Object.values(users).forEach(u => {
      const created = u.createdAt ? new Date(u.createdAt).getTime() : 0;
      if (created >= weekStart && created <= now) {
        const dayIndex = Math.floor((created - weekStart) / dayMs);
        if (dayIndex >= 0 && dayIndex < 7) { signupsByDay[dayIndex]++; }
      }
    });
    res.json({ revenueByDay, ordersByDay, signupsByDay, dayLabels });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/admin/users', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('users').once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([uid, u]) => ({ uid, ...u })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.patch('/api/admin/users/:uid', authenticateJWT, requireFirebaseAdmin, sanitizeInput, [
  body('role').optional().isString()
], validate, async (req, res) => {
  const { uid } = req.params;
  const { role } = req.body;
  try {
    const updates = {};
    if (role) updates.role = role;
    updates.updatedAt = admin.database.ServerValue.TIMESTAMP;
    await db().ref(`users/${uid}`).update(updates);
    res.json({ message: 'User updated' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/admin/users/:uid', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    await db().ref(`users/${uid}`).remove();
    try { await admin.auth().deleteUser(uid); } catch (_) {}
    res.json({ message: 'User deleted' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/admin/orders', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const [ordersSnap, escrowSnap] = await Promise.all([
      db().ref('orders').once('value'), db().ref('escrow_orders').once('value')
    ]);
    const orders = ordersSnap.val() || {};
    const escrow = escrowSnap.val() || {};
    const enriched = Object.entries(orders).map(([id, o]) => ({ id, ...o, escrowDetails: escrow[id] || null }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/admin/orders/:id', authenticateJWT, requireFirebaseAdmin, sanitizeInput, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db().ref(`orders/${id}`).update({ status, updatedAt: admin.database.ServerValue.TIMESTAMP });
    if (status) {
      await db().ref(`escrow_orders/${id}`).update({ status, updatedAt: admin.database.ServerValue.TIMESTAMP });
    }
    res.json({ message: `Order ${status || 'updated'}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

app.get('/api/admin/listings', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('listings').once('value');
    res.json(Object.entries(snap.val() || {}).map(([id, l]) => ({ id, ...l })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

app.patch('/api/admin/listings/:id', authenticateJWT, requireFirebaseAdmin, sanitizeInput, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await db().ref(`listings/${id}`).update({ status, updatedAt: admin.database.ServerValue.TIMESTAMP });
    res.json({ message: `Listing ${status}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

app.get('/api/admin/payouts', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('payouts').once('value');
    const all = snap.val() || {};
    const userSnap = await db().ref('users').once('value');
    const users = userSnap.val() || {};
    const list = Object.entries(all).map(([id, p]) => ({ id, ...p, displayName: users[p.uid]?.displayName || p.uid, email: users[p.uid]?.email || '' }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

app.post('/api/admin/payouts/:id/approve', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const snap = await db().ref(`payouts/${id}`).once('value');
    const payout = snap.val();
    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    if (payout.status !== 'pending') return res.status(400).json({ error: 'Payout already processed' });
    if (payout.queuedForManual) {
      try {
        const b2cResult = await b2cPayment(payout.phoneNumber, payout.netAmount || payout.amount, `AgriConnect payout ${payout.reference}`, 'Payout');
        await db().ref(`payouts/${id}`).update({ b2cResult: JSON.stringify(b2cResult), initiatedAt: admin.database.ServerValue.TIMESTAMP, queuedForManual: false });
      } catch (b2cErr) {
        return res.status(400).json({ error: `B2C failed: ${b2cErr.message}. Please process manually.` });
      }
    }
    await db().ref(`payouts/${id}`).update({ status: 'approved', approvedAt: admin.database.ServerValue.TIMESTAMP, approvedBy: req.user.uid });
    sendNotification(payout.uid, '✅ Withdrawal Approved', `Your withdrawal of KES ${payout.amount.toFixed(2)} has been approved.`, 'success');
    res.json({ message: 'Payout approved' });
    io.emit('payoutUpdate', { action: 'approved', id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve payout' });
  }
});

app.post('/api/admin/payouts/:id/reject', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const snap = await db().ref(`payouts/${id}`).once('value');
    const payout = snap.val();
    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    if (payout.status !== 'pending') return res.status(400).json({ error: 'Payout already processed' });
    const { uid, amount, fee = 0 } = payout;
    const refundTotal = amount + fee;
    await creditWallet(uid, WALLET_TYPES.WITHDRAWABLE, refundTotal, payout.reference, `Refund for rejected payout ${id}`);
    await db().ref(`payouts/${id}`).update({ status: 'rejected', rejectedAt: admin.database.ServerValue.TIMESTAMP, rejectedBy: req.user.uid });
    sendNotification(uid, '❌ Withdrawal Rejected', `KES ${refundTotal.toFixed(2)} returned to your withdrawable wallet.`, 'error');
    res.json({ message: 'Payout rejected, funds returned' });
    io.emit('payoutUpdate', { action: 'rejected', id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject payout' });
  }
});

app.get('/api/payout/history', authenticateJWT, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db().ref('payouts').orderByChild('uid').equalTo(uid).once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([id, p]) => ({ id, ...p })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch payout history' });
  }
});

// ---- ADMIN: DISPUTES ----

app.get('/api/admin/disputes', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('disputes').once('value');
    const all = snap.val() || {};
    const enriched = await Promise.all(Object.entries(all).map(async ([id, d]) => {
      const orderSnap = await db().ref(`escrow_orders/${d.orderId}`).once('value');
      return { id, ...d, order: orderSnap.val() || null };
    }));
    res.json(enriched.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

app.post('/api/admin/disputes/:id/resolve', authenticateJWT, requireFirebaseAdmin, sanitizeInput, [
  param('id').isString().notEmpty(),
  body('resolutionType').isIn(['release_to_seller', 'refund_buyer']),
  body('resolution').optional().isString()
], validate, async (req, res) => {
  const { id } = req.params;
  const { resolutionType, resolution } = req.body;
  try {
    const result = await resolveDispute(id, req.user.uid, resolution || resolutionType, resolutionType);
    res.json({ message: 'Dispute resolved', ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to resolve dispute' });
  }
});

// ---- ADMIN: WALLET MANAGEMENT ----

app.get('/api/admin/wallets', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('wallets').once('value');
    const all = snap.val() || {};
    const userSnap = await db().ref('users').once('value');
    const users = userSnap.val() || {};
    const result = {};
    for (const [uid, wallets] of Object.entries(all)) {
      const active = await computeBalance(uid, WALLET_TYPES.ACTIVE);
      const escrow = await computeBalance(uid, WALLET_TYPES.ESCROW);
      const withdrawable = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
      result[uid] = {
        displayName: users[uid]?.displayName || uid, email: users[uid]?.email || '',
        activeBalance: active, escrowBalance: escrow, withdrawableBalance: withdrawable,
        status: wallets.active?.status || 'unknown', frozenBalance: wallets.active?.frozenBalance || 0
      };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

app.post('/api/admin/wallet/:uid/freeze', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    await db().ref(`wallets/${uid}/active/status`).set(WALLET_STATUS.FROZEN);
    await db().ref(`wallets/${uid}/withdrawable/status`).set(WALLET_STATUS.FROZEN);
    await db().ref(`wallets/${uid}/active/updatedAt`).set(admin.database.ServerValue.TIMESTAMP);
    sendNotification(uid, '🔒 Account Frozen', 'Your account has been frozen. Incoming deposits are still accepted but withdrawals and transfers are blocked.', 'error');
    const adminSnap = await db().ref('users').orderByChild('role').equalTo('admin').once('value');
    if (adminSnap.val()) {
      Object.keys(adminSnap.val()).forEach(aid => {
        if (aid !== req.user.uid) sendNotification(aid, '🔒 Account Frozen', `${uid} account frozen by admin`, 'warning');
      });
    }
    res.json({ message: 'Wallet frozen. Outbound transactions blocked, inbound deposits still accepted.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to freeze wallet' });
  }
});

app.post('/api/admin/wallet/:uid/unfreeze', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    await db().ref(`wallets/${uid}/active/status`).set(WALLET_STATUS.ACTIVE);
    await db().ref(`wallets/${uid}/withdrawable/status`).set(WALLET_STATUS.ACTIVE);
    await db().ref(`wallets/${uid}/active/updatedAt`).set(admin.database.ServerValue.TIMESTAMP);
    sendNotification(uid, '✅ Account Unfrozen', 'Your account has been unfrozen. All features are now available.', 'success');
    res.json({ message: 'Wallet unfrozen' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unfreeze wallet' });
  }
});

app.get('/api/admin/reconciliation', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('reconciliation_log').orderByChild('timestamp').limitToLast(30).once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([id, r]) => ({ id, ...r })).reverse());
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch reconciliation logs' });
  }
});

app.post('/api/admin/reconciliation/run', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const result = await runReconciliation();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Reconciliation failed' });
  }
});

app.get('/api/admin/ledger', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('ledger').orderByChild('createdAt').limitToLast(200).once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([id, e]) => ({ id, ...e })).reverse());
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

app.get('/api/admin/finance', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const userSnap = await db().ref('users').once('value');
    const users = userSnap.val() || {};
    let totalActive = 0, totalEscrow = 0, totalWithdrawable = 0, totalFrozen = 0, frozenCount = 0;
    for (const uid of Object.keys(users)) {
      const active = await computeBalance(uid, WALLET_TYPES.ACTIVE);
      const escrow = await computeBalance(uid, WALLET_TYPES.ESCROW);
      const withdrawable = await computeBalance(uid, WALLET_TYPES.WITHDRAWABLE);
      totalActive += active;
      totalEscrow += escrow;
      totalWithdrawable += withdrawable;
      const walletInfo = await getWalletState(uid, WALLET_TYPES.ACTIVE);
      if (walletInfo) {
        if (walletInfo.frozenBalance) totalFrozen += parseFloat(walletInfo.frozenBalance);
        if (walletInfo.status === WALLET_STATUS.FROZEN) frozenCount++;
      }
    }
    const ledgerSnap = await db().ref('ledger').once('value');
    const ledger = ledgerSnap.val() || {};
    const totalLedger = Object.values(ledger).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const recentReconSnap = await db().ref('reconciliation_log').orderByChild('timestamp').limitToLast(1).once('value');
    const recentRecon = recentReconSnap.val() ? Object.values(recentReconSnap.val())[0] : null;
    res.json({
      totalActive: parseFloat(totalActive.toFixed(2)),
      totalEscrow: parseFloat(totalEscrow.toFixed(2)),
      totalWithdrawable: parseFloat(totalWithdrawable.toFixed(2)),
      totalInSystem: parseFloat((totalActive + totalEscrow + totalWithdrawable).toFixed(2)),
      totalFrozen: parseFloat(totalFrozen.toFixed(2)),
      frozenAccounts: frozenCount,
      ledgerTotal: parseFloat(totalLedger.toFixed(2)),
      activeUsers: Object.keys(users).length,
      lastReconciliation: recentRecon
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch finance data' });
  }
});

app.get('/api/admin/support', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('contact_queries').orderByChild('createdAt').once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([id, q]) => ({ id, ...q })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch queries' });
  }
});

app.post('/api/admin/support/:id/reply', authenticateJWT, requireFirebaseAdmin, sanitizeInput, async (req, res) => {
  const { id } = req.params;
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'Reply is required' });
  try {
    const snap = await db().ref(`contact_queries/${id}`).once('value');
    const query = snap.val();
    if (!query) return res.status(404).json({ error: 'Query not found' });
    await db().ref(`contact_queries/${id}`).update({ reply, replied: true, repliedAt: admin.database.ServerValue.TIMESTAMP });
    try {
      await sendEmail(query.email, `Re: ${query.subject} - AgriConnect Support`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f9fafb;border-radius:8px;">
        <div style="text-align:center;padding:20px 0;border-bottom:2px solid #16a34a;"><h1 style="color:#16a34a;margin:0;font-size:24px;">AgriConnect</h1></div>
        <div style="padding:20px 0;">
          <p style="color:#374151;font-size:16px;line-height:1.6;">Hi <strong>${query.name}</strong>,</p>
          <p style="color:#374151;font-size:16px;line-height:1.6;">We have received your query and our support team has responded:</p>
          <div style="background:#ffffff;border-radius:8px;padding:20px;margin:16px 0;border:1px solid #e5e7eb;">
            <p style="color:#374151;font-size:16px;line-height:1.6;">${reply.replace(/\n/g, '<br>')}</p>
          </div>
          <p style="color:#6b7280;font-size:14px;">Your original message:</p>
          <blockquote style="border-left:3px solid #d1d5db;margin:8px 0;padding:8px 16px;color:#6b7280;font-size:14px;line-height:1.5;">
            <strong>${query.subject}</strong><br>${query.message.replace(/\n/g, '<br>')}
          </blockquote>
          <p style="color:#374151;font-size:16px;line-height:1.6;">Best regards,<br><strong>AgriConnect Support Team</strong></p>
        </div>
        <div style="text-align:center;padding:16px 0;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">
          <p>&copy; ${new Date().getFullYear()} AgriConnect. All rights reserved.</p>
        </div></div>`
      );
      res.json({ message: 'Reply sent and emailed successfully' });
    } catch (emailErr) {
      res.json({ message: 'Reply saved but email failed to send', emailError: emailErr.message });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to reply' });
  }
});

app.post('/api/admin/notifications', authenticateJWT, requireFirebaseAdmin, sanitizeInput, async (req, res) => {
  const { title, body, type, targetRole } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  try {
    const userSnap = await db().ref('users').once('value');
    const users = userSnap.val() || {};
    let count = 0;
    const promises = [];
    Object.entries(users).forEach(([uid, u]) => {
      if (targetRole && u.role !== targetRole) return;
      const ref = db().ref(`notifications/${uid}`).push();
      promises.push(ref.set({ title, body, type: type || 'info', read: false, createdAt: admin.database.ServerValue.TIMESTAMP }));
      io.to(uid).emit('notification', { title, body, type: type || 'info' });
      count++;
    });
    await Promise.all(promises);
    res.json({ message: `Notification sent to ${count} users` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ---- M-PESA ADMIN ----

app.post('/api/admin/mpesa/register-urls', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const result = await registerC2BUrls();
    res.json({ message: 'C2B URLs registered', result });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register C2B URLs' });
  }
});

app.get('/api/admin/mpesa/stk-requests', authenticateJWT, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db().ref('mpesa_stk_requests').once('value');
    const all = snap.val() || {};
    res.json(Object.entries(all).map(([id, r]) => ({ id, ...r })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch STK requests' });
  }
});

// ---------------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// SCHEDULED JOBS
// ---------------------------------------------------------------------------

cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] Running daily reconciliation...');
  await runReconciliation();
});

cron.schedule('0 */6 * * *', async () => {
  console.log('[CRON] Checking expired escrow orders...');
  try {
    const snap = await db().ref('escrow_orders').once('value');
    const all = snap.val() || {};
    const now = Date.now();
    for (const [id, order] of Object.entries(all)) {
      if (order.status === ORDER_STATUS.IN_ESCROW && now > order.escrowExpiresAt && !order.disputeOpened) {
        console.log(`[CRON] Escrow order ${id} expired. Processing auto-refund...`);
        try {
          await cancelEscrow(id);
          sendNotification(order.buyerUid, '↩️ Escrow Expired', `Order ${id} escrow expired. KES ${order.amount} returned to your active wallet.`, 'info');
          sendNotification(order.sellerUid, '⏰ Escrow Expired', `Order ${id} escrow expired. Funds returned to buyer.`, 'info');
        } catch (e) {
          console.error(`[CRON] Failed to process expired escrow ${id}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[CRON] Escrow expiry check error:', e);
  }
});

// ---- Helper: wrap async route handlers to catch errors ----
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[ASYNC ERROR] %s %s:', req.method, req.originalUrl, err.message || err);
      if (err.stack) console.error(err.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`M-Pesa Environment: ${MPESA.ENVIRONMENT}`);
  if (MPESA.ENVIRONMENT === 'production' && MPESA.CONSUMER_KEY) {
    registerC2BUrls();
  }
});

module.exports = app;
