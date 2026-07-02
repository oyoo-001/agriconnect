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

    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });

  return pool;
}

async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
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

async function query(text, params) {
  const client = await getPool().connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

async function queryTx(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (pool) await pool.end();
}

module.exports = { initDb, getPool, query, queryTx, closeDb, testConnection };
