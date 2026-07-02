const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const SALT_ROUNDS = 10;

let googleClient;
let jwtSecret;
let jwtExpiry;

function initAuth(config) {
  jwtSecret = config.JWT_SECRET;
  jwtExpiry = config.JWT_EXPIRY || '7d';
  if (config.GOOGLE_CLIENT_ID) {
    OAuth2Client.CLOCK_SKEW_SECS_ = 600;
    googleClient = new OAuth2Client(config.GOOGLE_CLIENT_ID);
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

async function verifyGoogleToken(idToken) {
  if (!googleClient) throw new Error('Google Auth not configured');
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: googleClient._clientId,
  });
  const payload = ticket.getPayload();
  return {
    uid: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

function generateJWT(uid, email) {
  // SECURITY FIX: Don't include role in JWT token to prevent role confusion
  // Role should always be fetched from database for security
  return jwt.sign({ uid, email }, jwtSecret, { expiresIn: jwtExpiry });
}

function verifyJWT(token) {
  return jwt.verify(token, jwtSecret);
}

module.exports = { initAuth, hashPassword, verifyPassword, verifyGoogleToken, generateJWT, verifyJWT };
