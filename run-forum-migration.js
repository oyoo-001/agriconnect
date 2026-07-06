/**
 * One-shot script: creates forum tables if they don't exist.
 * Run once: node run-forum-migration.js
 * Safe to run multiple times (all statements use IF NOT EXISTS).
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'agriconnect',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: { rejectUnauthorized: false },   // Aiven requires SSL
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('[MIGRATION] Connected to database');

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_posts (
        id TEXT PRIMARY KEY,
        uid TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT DEFAULT '',
        banner_image TEXT DEFAULT '',
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      )
    `);
    console.log('[MIGRATION] forum_posts: OK');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_forum_posts_uid     ON forum_posts(uid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_forum_posts_created  ON forum_posts(created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        parent_comment_id TEXT DEFAULT NULL,
        content TEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      )
    `);
    console.log('[MIGRATION] forum_comments: OK');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_forum_comments_post   ON forum_comments(post_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_forum_comments_parent ON forum_comments(parent_comment_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_likes (
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        uid         TEXT NOT NULL,
        created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        UNIQUE (target_type, target_id, uid)
      )
    `);
    console.log('[MIGRATION] forum_likes: OK');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_forum_likes_target ON forum_likes(target_type, target_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS request_replies (
        id           TEXT PRIMARY KEY,
        request_id   TEXT NOT NULL,
        uid          TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        message      TEXT NOT NULL,
        created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      )
    `);
    console.log('[MIGRATION] request_replies: OK');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_request_replies_req ON request_replies(request_id)`);

    await client.query(`
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
    console.log('[MIGRATION] order_documents: OK');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_docs_order ON order_documents(order_id)`);

    // ── wallet_risk_scores — persists per-wallet risk score across reconciliation runs
    await client.query(`
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallet_risk_uid ON wallet_risk_scores(uid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wallet_risk_restriction ON wallet_risk_scores(restriction)`);
    console.log('[MIGRATION] wallet_risk_scores: OK');

    // ── wallet_anomaly_history — tracks anomalies per wallet over time for escalation
    await client.query(`
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_anomaly_hist_uid ON wallet_anomaly_history(uid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_anomaly_hist_resolved ON wallet_anomaly_history(resolved)`);
    console.log('[MIGRATION] wallet_anomaly_history: OK');

    console.log('\n[MIGRATION] All tables created successfully.');
    console.log('[MIGRATION] You can now restart the server normally.\n');
  } catch (err) {
    console.error('[MIGRATION] ERROR:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
