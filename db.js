const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

let pool;

function initDb(config) {
  pool = new Pool({
    host: config.DB_HOST || "localhost",
    port: parseInt(config.DB_PORT || "5432"),
    database: config.DB_NAME || "agriconnect",
    user: config.DB_USER || "postgres",
    password: config.DB_PASSWORD || "",
    ssl: {
      rejectUnauthorized: false,
    },

    // Reduced pool size for cloud databases with connection limits
    max: 10, // Reduced from 20 to be more conservative
    min: 2, // Minimum idle connections
    idleTimeoutMillis: 20000, // Release idle connections faster (20s instead of 30s)
    connectionTimeoutMillis: 10000, // Increased timeout for connection acquisition
    allowExitOnIdle: true, // Allow pool to close when idle
  });

  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });

  pool.on("connect", () => {
    console.log("New database connection established");
  });

  pool.on("remove", () => {
    console.log("Database connection removed from pool");
  });

  return pool;
}

async function testConnection() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connected successfully");
    return true;
  } catch (err) {
    console.error("Database connection failed:", err.message);
    return false;
  }
}

function getPool() {
  if (!pool) throw new Error("Database not initialized. Call initDb() first.");
  return pool;
}

/**
 * Execute a single query using native pool.query()
 * This avoids manual connection checkout/release and reduces pool exhaustion
 */
async function query(text, params) {
  try {
    const result = await getPool().query(text, params);
    return result;
  } catch (err) {
    console.error("Query error:", err.message);
    throw err;
  }
}

/**
 * Execute a transaction with multiple statements
 * This is the ONLY place where we use manual connection checkout
 */
async function queryTx(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      console.error("Rollback error:", rollbackErr.message);
    });
    throw e;
  } finally {
    // Always release the client back to the pool
    if (client) {
      client.release();
    }
  }
}

async function closeDb() {
  if (pool) await pool.end();
}

function getPoolStats() {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

module.exports = { initDb, getPool, query, queryTx, closeDb, testConnection, getPoolStats };
