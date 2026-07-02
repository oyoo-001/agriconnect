// =============================================================
// AgriConnect — Seed Test Data
// =============================================================
// Run: node seed_test_data.js
//
// Creates 3 test users + wallets + deposits so you can
// immediately test the money flow.
//
// Test credentials (all passwords: "Test1234!"):
//   farmer@test.com     (role: farmer)
//   org@test.com        (role: organization)
//   consumer@test.com   (role: user)
// =============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const now = Date.now();
    const passwordHash = await bcrypt.hash('Test1234!', 10);

    // ── Users ────────────────────────────────────────────────
    const users = [
      {
        uid: 'test-farmer-001',
        email: 'farmer@test.com',
        displayName: 'Mwangi Farm',
        phone: '+254712345678',
        role: 'farmer',
        profile: JSON.stringify({ location: 'Nakuru', manufacture: 'Maize, Beans, Tomatoes' }),
      },
      {
        uid: 'test-org-001',
        email: 'org@test.com',
        displayName: 'Nakuru Fresh Produce Ltd',
        phone: '+254723456789',
        role: 'organization',
        profile: JSON.stringify({ location: 'Nakuru', category: 'Fresh Produce', bio: 'Leading fresh produce distributor in the Rift Valley.' }),
      },
      {
        uid: 'test-consumer-001',
        email: 'consumer@test.com',
        displayName: 'Jane Wangari',
        phone: '+254734567890',
        role: 'user',
        profile: '{}',
      },
    ];

    for (const u of users) {
      await client.query(
        `INSERT INTO users (uid, email, display_name, phone_number, password_hash, role, provider, profile, created_at, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6,'email',$7::jsonb,$8,$8)
         ON CONFLICT (uid) DO UPDATE SET password_hash = $5`,
        [u.uid, u.email, u.displayName, u.phone, passwordHash, u.role, u.profile, now]
      );
    }
    console.log('✓ Users created');

    // ── Wallet IDs ───────────────────────────────────────────
    const walletIds = [
      { wid: '10000001', uid: 'test-farmer-001', name: 'Mwangi Farm', email: 'farmer@test.com' },
      { wid: '10000002', uid: 'test-org-001', name: 'Nakuru Fresh Produce Ltd', email: 'org@test.com' },
      { wid: '10000003', uid: 'test-consumer-001', name: 'Jane Wangari', email: 'consumer@test.com' },
    ];
    for (const w of walletIds) {
      await client.query(
        `INSERT INTO wallet_ids (wallet_id, uid, display_name, email, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (wallet_id) DO NOTHING`,
        [w.wid, w.uid, w.name, w.email, now]
      );
    }
    console.log('✓ Wallet IDs created');

    // ── Wallets ──────────────────────────────────────────────
    const walletDefs = [
      { uid: 'test-farmer-001',   type: 'active',       balance: 5000.00 },
      { uid: 'test-farmer-001',   type: 'escrow',       balance: 0 },
      { uid: 'test-farmer-001',   type: 'withdrawable', balance: 0 },
      { uid: 'test-org-001',      type: 'active',       balance: 10000.00 },
      { uid: 'test-org-001',      type: 'escrow',       balance: 0 },
      { uid: 'test-org-001',      type: 'withdrawable', balance: 0 },
      { uid: 'test-consumer-001', type: 'active',       balance: 2000.00 },
      { uid: 'test-consumer-001', type: 'escrow',       balance: 0 },
      { uid: 'test-consumer-001', type: 'withdrawable', balance: 0 },
    ];
    for (const w of walletDefs) {
      await client.query(
        `INSERT INTO wallets (uid, wallet_type, status, balance, frozen_balance, created_at, updated_at)
         VALUES ($1,$2::wallet_type,'active',$3,0,$4,$4)
         ON CONFLICT (uid, wallet_type) DO UPDATE SET balance = $3`,
        [w.uid, w.type, w.balance, now]
      );
    }
    console.log('✓ Wallets created');

    // ── Ledger entries (deposits) ────────────────────────────
    const deposits = [
      { uid: 'test-farmer-001',   amount: 2000.00, ref: 'MPESA-TEST-001', desc: 'M-Pesa deposit — initial funding',       ts: now - 7000000 },
      { uid: 'test-farmer-001',   amount: 1500.00, ref: 'MPESA-TEST-002', desc: 'M-Pesa deposit — equipment purchase',   ts: now - 6000000 },
      { uid: 'test-farmer-001',   amount: 1500.00, ref: 'MPESA-TEST-003', desc: 'M-Pesa deposit — seeds',                ts: now - 5000000 },
      { uid: 'test-org-001',      amount: 5000.00, ref: 'MPESA-TEST-004', desc: 'M-Pesa deposit — bulk purchase fund',   ts: now - 4000000 },
      { uid: 'test-org-001',      amount: 3000.00, ref: 'MPESA-TEST-005', desc: 'M-Pesa deposit — operations',            ts: now - 3000000 },
      { uid: 'test-org-001',      amount: 2000.00, ref: 'MPESA-TEST-006', desc: 'M-Pesa deposit — transport',             ts: now - 2000000 },
      { uid: 'test-consumer-001', amount: 1000.00, ref: 'MPESA-TEST-007', desc: 'M-Pesa deposit — grocery budget',        ts: now - 1000000 },
      { uid: 'test-consumer-001', amount: 1000.00, ref: 'MPESA-TEST-008', desc: 'M-Pesa deposit — market day',            ts: now },
    ];

    for (const d of deposits) {
      const ledgerId = uuidv4();
      await client.query(
        `INSERT INTO ledger (id, type, amount, to_wallet, to_uid, reference, description, created_at)
         VALUES ($1,'deposit',$2,'active',$3,$4,$5,$6)`,
        [ledgerId, d.amount, d.uid, d.ref, d.desc, d.ts]
      );

      let running = 0;
      const prev = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0) AS bal
         FROM ledger WHERE to_uid=$1 AND to_wallet='active' AND created_at <= $2`,
        [d.uid, d.ts]
      );
      running = parseFloat(prev.rows[0].bal) || d.amount;

      await client.query(
        `INSERT INTO transactions (uid, type, amount, fee, balance, reference, description, created_at)
         VALUES ($1,'deposit',$2,0,$3,$4,$5,$6)`,
        [d.uid, d.amount, running, d.ref, d.desc, d.ts]
      );

      await client.query(
        `INSERT INTO mpesa_deposits (id, uid, checkout_request_id, merchant_request_id, amount, phone_number, reference, status, idempotency_key, net_amount, fee, mpesa_receipt_number, processed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13)`,
        [uuidv4(), d.uid, 'chr-' + d.ref, 'mri-' + d.ref, d.amount,
         users.find(u => u.uid === d.uid).phone, d.ref, 'idem-' + d.ref,
         parseFloat((d.amount * 0.99).toFixed(2)), parseFloat((d.amount * 0.01).toFixed(2)),
         'NFC' + d.ref.replace('MPESA-TEST-', ''), d.ts + 500, d.ts]
      );
    }
    console.log('✓ Ledger entries, transactions, and M-Pesa records created');

    await client.query('COMMIT');
    console.log('\n✅ Seed complete!');
    console.log('   Login credentials (password: Test1234!):');
    console.log('   farmer@test.com     → Farmer Dashboard');
    console.log('   org@test.com        → Organisation Dashboard');
    console.log('   consumer@test.com   → Consumer Dashboard');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();