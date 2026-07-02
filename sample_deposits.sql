-- =============================================================
-- AgriConnect — Sample Deposit Data for Testing Money Flow
-- =============================================================
-- This script creates test users, wallets, ledger entries,
-- transactions, and M-Pesa deposit records so you can
-- immediately test deposit → balance → transfer → withdraw.
--
-- Usage:
--   1. Ensure the schema is already applied (schema.sql).
--   2. Run this against your database.
--   3. Log in as one of the test users and check the wallet.
--
-- Test credentials (all passwords: "Test1234!"):
--   farmer@test.com     (role: farmer)
--   org@test.com        (role: organization)
--   consumer@test.com   (role: user)
-- =============================================================

-- =============================================================
-- 1. SAMPLE USERS
-- =============================================================
INSERT INTO users (uid, email, display_name, phone_number, role, provider, profile, created_at) VALUES
  ('test-farmer-001',  'farmer@test.com',   'Mwangi Farm',       '+254712345678', 'farmer',       'email', '{"location":"Nakuru","manufacture":"Maize, Beans, Tomatoes"}', 1740000000000),
  ('test-org-001',     'org@test.com',      'Nakuru Fresh Produce Ltd', '+254723456789', 'organization', 'email', '{"location":"Nakuru","category":"Fresh Produce","bio":"Leading fresh produce distributor in the Rift Valley."}', 1740000000001),
  ('test-consumer-001','consumer@test.com', 'Jane Wangari',       '+254734567890', 'user',         'email', '{}', 1740000000002);

-- =============================================================
-- 2. WALLET IDs (8-digit identifiers for transfers)
-- =============================================================
INSERT INTO wallet_ids (wallet_id, uid, display_name, email, created_at) VALUES
  ('10000001', 'test-farmer-001',  'Mwangi Farm',       'farmer@test.com',   1740000000000),
  ('10000002', 'test-org-001',     'Nakuru Fresh Produce Ltd', 'org@test.com', 1740000000001),
  ('10000003', 'test-consumer-001','Jane Wangari',       'consumer@test.com',1740000000002);

-- =============================================================
-- 3. WALLETS (active, escrow, withdrawable)
--    balance mirrors the computed ledger sum (manual here).
-- =============================================================
INSERT INTO wallets (uid, wallet_type, status, balance, frozen_balance, created_at, updated_at) VALUES
  -- Farmer: 5 000 active, 0 escrow, 0 withdrawable
  ('test-farmer-001',  'active',       'active', 5000.00, 0, 1740000000000, 1740000000000),
  ('test-farmer-001',  'escrow',       'active', 0,       0, 1740000000000, 1740000000000),
  ('test-farmer-001',  'withdrawable', 'active', 0,       0, 1740000000000, 1740000000000),
  -- Org: 10 000 active
  ('test-org-001',     'active',       'active', 10000.00,0, 1740000000001, 1740000000001),
  ('test-org-001',     'escrow',       'active', 0,       0, 1740000000001, 1740000000001),
  ('test-org-001',     'withdrawable', 'active', 0,       0, 1740000000001, 1740000000001),
  -- Consumer: 2 000 active
  ('test-consumer-001','active',       'active', 2000.00, 0, 1740000000002, 1740000000002),
  ('test-consumer-001','escrow',       'active', 0,       0, 1740000000002, 1740000000002),
  ('test-consumer-001','withdrawable', 'active', 0,       0, 1740000000002, 1740000000002);

-- =============================================================
-- 4. LEDGER (source of truth for all balances)
-- =============================================================
INSERT INTO ledger (id, type, amount, to_wallet, to_uid, reference, description, created_at) VALUES
  -- Farmer deposits (3 deposits totalling 5 000)
  ('a0000000-0000-0000-0000-000000000001', 'deposit', 2000.00, 'active', 'test-farmer-001',  'MPESA-TEST-001',  'M-Pesa deposit — initial funding',  1740001000000),
  ('a0000000-0000-0000-0000-000000000002', 'deposit', 1500.00, 'active', 'test-farmer-001',  'MPESA-TEST-002',  'M-Pesa deposit — equipment purchase',1740002000000),
  ('a0000000-0000-0000-0000-000000000003', 'deposit', 1500.00, 'active', 'test-farmer-001',  'MPESA-TEST-003',  'M-Pesa deposit — seeds',            1740003000000),
  -- Org deposits (3 deposits totalling 10 000)
  ('b0000000-0000-0000-0000-000000000001', 'deposit', 5000.00, 'active', 'test-org-001',     'MPESA-TEST-004',  'M-Pesa deposit — bulk purchase fund',1740004000000),
  ('b0000000-0000-0000-0000-000000000002', 'deposit', 3000.00, 'active', 'test-org-001',     'MPESA-TEST-005',  'M-Pesa deposit — operations',       1740005000000),
  ('b0000000-0000-0000-0000-000000000003', 'deposit', 2000.00, 'active', 'test-org-001',     'MPESA-TEST-006',  'M-Pesa deposit — transport',        1740006000000),
  -- Consumer deposits (2 deposits totalling 2 000)
  ('c0000000-0000-0000-0000-000000000001', 'deposit', 1000.00, 'active', 'test-consumer-001','MPESA-TEST-007',  'M-Pesa deposit — grocery budget',   1740007000000),
  ('c0000000-0000-0000-0000-000000000002', 'deposit', 1000.00, 'active', 'test-consumer-001','MPESA-TEST-008',  'M-Pesa deposit — market day',       1740008000000);

-- =============================================================
-- 5. TRANSACTIONS (user-facing history)
-- =============================================================
INSERT INTO transactions (id, uid, type, amount, fee, balance, reference, description, created_at) VALUES
  ('a0000000-0000-0000-0000-000000000010', 'test-farmer-001',  'deposit', 2000.00, 0, 2000.00, 'MPESA-TEST-001', 'M-Pesa deposit — initial funding',  1740001000000),
  ('a0000000-0000-0000-0000-000000000011', 'test-farmer-001',  'deposit', 1500.00, 0, 3500.00, 'MPESA-TEST-002', 'M-Pesa deposit — equipment purchase',1740002000000),
  ('a0000000-0000-0000-0000-000000000012', 'test-farmer-001',  'deposit', 1500.00, 0, 5000.00, 'MPESA-TEST-003', 'M-Pesa deposit — seeds',            1740003000000),
  ('b0000000-0000-0000-0000-000000000010', 'test-org-001',     'deposit', 5000.00, 0, 5000.00, 'MPESA-TEST-004', 'M-Pesa deposit — bulk purchase fund',1740004000000),
  ('b0000000-0000-0000-0000-000000000011', 'test-org-001',     'deposit', 3000.00, 0, 8000.00, 'MPESA-TEST-005', 'M-Pesa deposit — operations',       1740005000000),
  ('b0000000-0000-0000-0000-000000000012', 'test-org-001',     'deposit', 2000.00, 0,10000.00, 'MPESA-TEST-006', 'M-Pesa deposit — transport',        1740006000000),
  ('c0000000-0000-0000-0000-000000000010', 'test-consumer-001','deposit',1000.00, 0,1000.00, 'MPESA-TEST-007', 'M-Pesa deposit — grocery budget',    1740007000000),
  ('c0000000-0000-0000-0000-000000000011', 'test-consumer-001','deposit',1000.00, 0,2000.00, 'MPESA-TEST-008', 'M-Pesa deposit — market day',        1740008000000);

-- =============================================================
-- 6. M-PESA DEPOSIT RECORDS (what the STK callback inserts)
-- =============================================================
INSERT INTO mpesa_deposits (id, uid, checkout_request_id, merchant_request_id, amount, phone_number, reference, status, idempotency_key, net_amount, fee, mpesa_receipt_number, processed_at, created_at) VALUES
  ('a0000000-0000-0000-0000-000000000020', 'test-farmer-001',  'chr-test-001', 'mri-test-001', 2000.00, '+254712345678', 'MPESA-TEST-001', 'completed', 'idem-test-001', 1980.00, 20.00, 'NFC12AB001', 1740001000500, 1740001000000),
  ('a0000000-0000-0000-0000-000000000021', 'test-farmer-001',  'chr-test-002', 'mri-test-002', 1500.00, '+254712345678', 'MPESA-TEST-002', 'completed', 'idem-test-002', 1485.00, 15.00, 'NFC12AB002', 1740002000500, 1740002000000),
  ('a0000000-0000-0000-0000-000000000022', 'test-farmer-001',  'chr-test-003', 'mri-test-003', 1500.00, '+254712345678', 'MPESA-TEST-003', 'completed', 'idem-test-003', 1485.00, 15.00, 'NFC12AB003', 1740003000500, 1740003000000),
  ('b0000000-0000-0000-0000-000000000020', 'test-org-001',     'chr-test-004', 'mri-test-004', 5000.00, '+254723456789', 'MPESA-TEST-004', 'completed', 'idem-test-004', 4950.00, 50.00, 'NFC12AB004', 1740004000500, 1740004000000),
  ('b0000000-0000-0000-0000-000000000021', 'test-org-001',     'chr-test-005', 'mri-test-005', 3000.00, '+254723456789', 'MPESA-TEST-005', 'completed', 'idem-test-005', 2970.00, 30.00, 'NFC12AB005', 1740005000500, 1740005000000),
  ('b0000000-0000-0000-0000-000000000022', 'test-org-001',     'chr-test-006', 'mri-test-006', 2000.00, '+254723456789', 'MPESA-TEST-006', 'completed', 'idem-test-006', 1980.00, 20.00, 'NFC12AB006', 1740006000500, 1740006000000),
  ('c0000000-0000-0000-0000-000000000020', 'test-consumer-001','chr-test-007', 'mri-test-007', 1000.00, '+254734567890', 'MPESA-TEST-007', 'completed', 'idem-test-007', 990.00, 10.00, 'NFC12AB007', 1740007000500, 1740007000000),
  ('c0000000-0000-0000-0000-000000000021', 'test-consumer-001','chr-test-008', 'mri-test-008', 1000.00, '+254734567890', 'MPESA-TEST-008', 'completed', 'idem-test-008', 990.00, 10.00, 'NFC12AB008', 1740008000500, 1740008000000);

-- =============================================================
-- VERIFICATION QUERIES (run these after inserting)
-- =============================================================
-- SELECT uid, wallet_type, balance FROM wallets ORDER BY uid, wallet_type;
-- SELECT type, SUM(amount) FROM ledger WHERE type = 'deposit' GROUP BY type;
-- SELECT uid, SUM(amount) AS total_deposits FROM transactions WHERE type = 'deposit' GROUP BY uid;
-- SELECT w.uid, w.wallet_type, w.balance,
--   COALESCE((SELECT SUM(amount) FROM ledger WHERE to_uid = w.uid AND to_wallet = w.wallet_type::text), 0) -
--   COALESCE((SELECT SUM(ABS(amount)) FROM ledger WHERE from_uid = w.uid AND from_wallet = w.wallet_type::text AND amount < 0), 0) AS ledger_balance
-- FROM wallets w ORDER BY w.uid, w.wallet_type;
