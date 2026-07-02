-- AgriConnect PostgreSQL Schema
-- Run this to initialize the database

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  uid TEXT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255) DEFAULT '',
  password_hash VARCHAR(255) DEFAULT '',
  phone_number VARCHAR(20) DEFAULT '',
  photo_url TEXT DEFAULT '',
  role VARCHAR(50) DEFAULT 'user',
  provider VARCHAR(50) DEFAULT 'email',
  profile JSONB DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  last_login_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at BIGINT NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_password_reset_token ON password_reset_tokens(token);
CREATE INDEX idx_password_reset_email ON password_reset_tokens(email);

CREATE TYPE wallet_status AS ENUM ('active', 'frozen', 'suspended');
CREATE TYPE wallet_type AS ENUM ('active', 'escrow', 'withdrawable');

CREATE TABLE wallets (
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  wallet_type wallet_type NOT NULL,
  status wallet_status DEFAULT 'active',
  balance DECIMAL(20,2) DEFAULT 0,
  frozen_balance DECIMAL(20,2) DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  PRIMARY KEY (uid, wallet_type)
);

CREATE TABLE wallet_ids (
  wallet_id VARCHAR(8) PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  display_name VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE UNIQUE INDEX idx_wallet_ids_uid ON wallet_ids(uid);

CREATE TYPE ledger_entry_type AS ENUM ('deposit', 'withdrawal', 'transfer', 'fee', 'escrow_hold', 'escrow_release', 'escrow_refund');

CREATE TABLE ledger (
  id UUID PRIMARY KEY,
  type ledger_entry_type NOT NULL,
  amount DECIMAL(20,2) NOT NULL,
  from_wallet wallet_type,
  to_wallet wallet_type,
  from_uid TEXT,
  to_uid VARCHAR(255),
  reference VARCHAR(255),
  description TEXT DEFAULT '',
  related_id VARCHAR(255),
  metadata JSONB,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_ledger_from_uid ON ledger(from_uid);
CREATE INDEX idx_ledger_from_wallet ON ledger(from_wallet);
CREATE INDEX idx_ledger_to_uid ON ledger(to_uid);
CREATE INDEX idx_ledger_to_wallet ON ledger(to_wallet);
CREATE INDEX idx_ledger_from_pair ON ledger(from_uid, from_wallet);
CREATE INDEX idx_ledger_to_pair ON ledger(to_uid, to_wallet);
CREATE INDEX idx_ledger_created_at ON ledger(created_at);
CREATE INDEX idx_ledger_reference ON ledger(reference);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(20,2) NOT NULL,
  fee DECIMAL(20,2) DEFAULT 0,
  balance DECIMAL(20,2) DEFAULT 0,
  reference VARCHAR(255),
  description TEXT DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_transactions_uid ON transactions(uid);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);

CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  price DECIMAL(20,2) NOT NULL,
  category VARCHAR(100) DEFAULT '',
  location VARCHAR(255) DEFAULT '',
  quantity VARCHAR(100) DEFAULT '',
  image_urls JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(50) DEFAULT 'active',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT
);

CREATE INDEX idx_listings_uid ON listings(uid);
CREATE INDEX idx_listings_status ON listings(status);

CREATE TYPE order_status AS ENUM ('in_escrow', 'dispatched', 'verified', 'completed', 'cancelled', 'refunded', 'disputed');

CREATE TABLE escrow_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_uid TEXT NOT NULL REFERENCES users(uid),
  seller_uid TEXT NOT NULL REFERENCES users(uid),
  listing_id UUID REFERENCES listings(id),
  quantity INTEGER DEFAULT 1,
  amount DECIMAL(20,2) NOT NULL,
  status order_status DEFAULT 'in_escrow',
  otp_hash VARCHAR(255),
  otp_expires_at BIGINT,
  escrow_expires_at BIGINT,
  reference VARCHAR(255),
  dispute_opened BOOLEAN DEFAULT FALSE,
  dispute_resolved BOOLEAN DEFAULT FALSE,
  dispute_id UUID,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT,
  verified_at BIGINT,
  completed_at BIGINT,
  cancelled_at BIGINT,
  refunded_at BIGINT,
  dispatched_at BIGINT
);

CREATE INDEX idx_escrow_orders_buyer ON escrow_orders(buyer_uid);
CREATE INDEX idx_escrow_orders_seller ON escrow_orders(seller_uid);
CREATE INDEX idx_escrow_orders_status ON escrow_orders(status);

CREATE TABLE orders (
  id UUID PRIMARY KEY REFERENCES escrow_orders(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id),
  farmer_uid TEXT NOT NULL REFERENCES users(uid),
  org_uid TEXT NOT NULL REFERENCES users(uid),
  quantity INTEGER DEFAULT 1,
  total_price DECIMAL(20,2) NOT NULL,
  status order_status DEFAULT 'in_escrow',
  escrow_order_id UUID,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT
);

CREATE INDEX idx_orders_farmer ON orders(farmer_uid);
CREATE INDEX idx_orders_org ON orders(org_uid);

CREATE TABLE agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_uid TEXT NOT NULL REFERENCES users(uid),
  org_uid TEXT NOT NULL REFERENCES users(uid),
  terms TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'pending',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT
);

CREATE INDEX idx_agreements_farmer ON agreements(farmer_uid);
CREATE INDEX idx_agreements_org ON agreements(org_uid);

CREATE TABLE requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  display_name VARCHAR(255) DEFAULT '',
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  quantity VARCHAR(100) DEFAULT '',
  location VARCHAR(255) DEFAULT '',
  status VARCHAR(50) DEFAULT 'open',
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_requests_uid ON requests(uid);
CREATE INDEX idx_requests_status ON requests(status);

CREATE TABLE request_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  uid TEXT NOT NULL REFERENCES users(uid),
  display_name VARCHAR(255) DEFAULT '',
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_request_replies_request ON request_replies(request_id);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT DEFAULT '',
  type VARCHAR(50) DEFAULT 'info',
  read BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_notifications_uid ON notifications(uid);
CREATE INDEX idx_notifications_read ON notifications(uid, read);
CREATE INDEX idx_notifications_created_at ON notifications(uid, created_at DESC);

CREATE TABLE contact_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  replied BOOLEAN DEFAULT FALSE,
  reply TEXT,
  replied_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES escrow_orders(id),
  raised_by_uid TEXT NOT NULL REFERENCES users(uid),
  reason TEXT NOT NULL,
  evidence_urls JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(50) DEFAULT 'open',
  resolution TEXT,
  resolution_type VARCHAR(50),
  resolved_by_uid TEXT REFERENCES users(uid),
  resolved_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT
);

CREATE INDEX idx_disputes_order ON disputes(order_id);

CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  amount DECIMAL(20,2) NOT NULL,
  fee DECIMAL(20,2) DEFAULT 0,
  net_amount DECIMAL(20,2),
  method VARCHAR(50) DEFAULT 'mpesa',
  phone_number VARCHAR(20),
  status VARCHAR(50) DEFAULT 'pending',
  reference VARCHAR(255),
  mpesa_transaction_id VARCHAR(255),
  b2c_result TEXT,
  b2c_error TEXT,
  queued_for_manual BOOLEAN DEFAULT FALSE,
  initiated_at BIGINT,
  completed_at BIGINT,
  approved_at BIGINT,
  approved_by TEXT REFERENCES users(uid),
  rejected_at BIGINT,
  rejected_by TEXT REFERENCES users(uid),
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_payouts_uid ON payouts(uid);
CREATE INDEX idx_payouts_status ON payouts(status);

CREATE TABLE mpesa_stk_requests (
  checkout_request_id VARCHAR(255) PRIMARY KEY,
  merchant_request_id VARCHAR(255),
  phone_number VARCHAR(20),
  amount DECIMAL(20,2),
  account_reference VARCHAR(255),
  idempotency_key VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  uid TEXT REFERENCES users(uid),
  mpesa_receipt_number VARCHAR(255),
  net_amount DECIMAL(20,2),
  fee DECIMAL(20,2),
  transaction_date VARCHAR(50),
  processed_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE mpesa_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  checkout_request_id VARCHAR(255),
  merchant_request_id VARCHAR(255),
  amount DECIMAL(20,2),
  phone_number VARCHAR(20),
  reference VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  idempotency_key VARCHAR(255),
  net_amount DECIMAL(20,2),
  fee DECIMAL(20,2),
  mpesa_receipt_number VARCHAR(255),
  processed_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX idx_mpesa_deposits_uid ON mpesa_deposits(uid);
CREATE INDEX idx_mpesa_deposits_checkout ON mpesa_deposits(checkout_request_id);

CREATE TABLE mpesa_processed (
  mpesa_receipt_number VARCHAR(255) PRIMARY KEY,
  processed_at BIGINT NOT NULL,
  checkout_request_id VARCHAR(255),
  type VARCHAR(50) DEFAULT 'stk_callback'
);

CREATE TABLE mpesa_failed_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id VARCHAR(255),
  result_code VARCHAR(50),
  result_desc TEXT,
  received_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE mpesa_unlinked_c2b (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trans_id VARCHAR(255),
  trans_time VARCHAR(50),
  amount DECIMAL(20,2),
  sender_phone VARCHAR(20),
  bill_ref_number VARCHAR(255),
  received_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE mpesa_b2c_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  result_type VARCHAR(50),
  result_code VARCHAR(50),
  result_desc TEXT,
  transaction_id VARCHAR(255),
  reference_data JSONB,
  received_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE reconciliation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  ledger_total DECIMAL(20,2) DEFAULT 0,
  total_in_system DECIMAL(20,2) DEFAULT 0,
  sum_active_wallets DECIMAL(20,2) DEFAULT 0,
  sum_escrow_wallets DECIMAL(20,2) DEFAULT 0,
  sum_withdrawable_wallets DECIMAL(20,2) DEFAULT 0,
  sum_frozen_balances DECIMAL(20,2) DEFAULT 0,
  available_mpesa_balance DECIMAL(20,2) DEFAULT 0,
  discrepancy DECIMAL(20,2) DEFAULT 0,
  anomaly BOOLEAN DEFAULT FALSE
);

CREATE TABLE idempotency (
  key VARCHAR(255) PRIMARY KEY,
  result JSONB,
  processed_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
