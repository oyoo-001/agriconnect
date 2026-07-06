/**
 * reconciliation-engine.js
 * Smart risk-based reconciliation engine for AgriConnect.
 * Imported by server.js — call findReconciliationCulprits(deps) where
 * deps = { db, io, WALLET_TYPES, WALLET_STATUS, WALLET_RESTRICTION,
 *           RISK_POINTS, RISK_THRESHOLDS, sendNotification }
 */

"use strict";

async function findReconciliationCulprits(deps) {
  const {
    db, io,
    WALLET_TYPES, WALLET_STATUS, WALLET_RESTRICTION,
    RISK_POINTS, RISK_THRESHOLDS,
    sendNotification,
  } = deps;

  const culprits    = [];
  const walletScores = {}; // "uid::walletType" → { score, flags[], uid, walletType }

  function addScore(uid, walletType, points, flag) {
    if (!uid) return;
    const key = `${uid}::${walletType}`;
    if (!walletScores[key]) walletScores[key] = { score: 0, flags: [], uid, walletType };
    walletScores[key].score += points;
    walletScores[key].flags.push(flag);
  }

  function riskLevel(score) {
    if (score >= RISK_THRESHOLDS.FREEZE)               return WALLET_RESTRICTION.FREEZE;
    if (score >= RISK_THRESHOLDS.RESTRICT_WITHDRAWALS) return WALLET_RESTRICTION.RESTRICT_WITHDRAWALS;
    if (score >= RISK_THRESHOLDS.MONITOR)              return WALLET_RESTRICTION.MONITOR;
    return WALLET_RESTRICTION.NONE;
  }

  function recommendedAction(restriction) {
    switch (restriction) {
      case WALLET_RESTRICTION.FREEZE:
        return "🔒 Freeze wallet immediately — high probability of ledger inconsistency";
      case WALLET_RESTRICTION.RESTRICT_WITHDRAWALS:
        return "⚠️ Restrict withdrawals — allow deposits and balance inquiries only";
      case WALLET_RESTRICTION.MONITOR:
        return "👁 Monitor — flag for review on next reconciliation run";
      default:
        return "✅ No action required";
    }
  }

  try {
    const now = Date.now();

    // ── 0. Global gap % check ─────────────────────────────────────────────────
    const mpesaInRes    = await db.query("SELECT COALESCE(SUM(net_amount),0) AS t FROM mpesa_stk_requests WHERE status='success'");
    const payoutsOutRes = await db.query("SELECT COALESCE(SUM(net_amount),0) AS t FROM payouts WHERE status='approved'");
    const walletsRes    = await db.query("SELECT COALESCE(SUM(balance),0) AS t FROM wallets");
    const totalExpected = parseFloat(mpesaInRes.rows[0].t) - parseFloat(payoutsOutRes.rows[0].t);
    const totalActual   = parseFloat(walletsRes.rows[0].t);
    const globalGapPct  = totalExpected > 0 ? Math.abs((totalActual - totalExpected) / totalExpected) * 100 : 0;
    const globalGapHigh = globalGapPct > 5;

    // ── A: Unmatched M-Pesa deposits ─────────────────────────────────────────
    const mpesaRows = await db.query(
      `SELECT checkout_request_id,uid,net_amount,mpesa_receipt_number,phone_number,created_at,processed_at
       FROM mpesa_stk_requests WHERE status='success' AND net_amount>0 ORDER BY created_at DESC LIMIT 500`,
    );
    for (const dep of mpesaRows.rows) {
      if (!dep.mpesa_receipt_number) continue;
      const match = await db.query(
        `SELECT id FROM ledger WHERE type='deposit' AND to_uid=$1
         AND (reference=$2 OR description ILIKE $3) LIMIT 1`,
        [dep.uid, dep.mpesa_receipt_number, `%${dep.mpesa_receipt_number}%`],
      );
      if (match.rows.length > 0) continue;
      const amt = parseFloat(dep.net_amount);
      if (amt <= RISK_THRESHOLDS.AUTO_RESOLVE_MAX) continue; // auto-resolve tiny amounts
      const pts = RISK_POINTS.unmatched_deposit;
      culprits.push({
        category: "unmatched_deposit", severity: "high", riskPoints: pts,
        id: dep.checkout_request_id, amount: amt, uid: dep.uid,
        reference: dep.mpesa_receipt_number, phone: dep.phone_number,
        description: `M-Pesa deposit ${dep.mpesa_receipt_number} has no matching ledger credit`,
        detailedDescription: `M-Pesa confirmed KES ${amt.toFixed(2)} (receipt: ${dep.mpesa_receipt_number}, phone: ${dep.phone_number}) but no ledger deposit entry found.`,
        recommendedAction: "Freeze affected amount until verified. Reconcile with M-Pesa statement.",
        date: Number(dep.processed_at || dep.created_at),
      });
      addScore(dep.uid, WALLET_TYPES.ACTIVE, pts, `Unmatched M-Pesa deposit KES ${amt.toFixed(2)} (${dep.mpesa_receipt_number})`);
    }

    // ── B: Unmatched approved payouts ─────────────────────────────────────────
    const payoutRows = await db.query(
      `SELECT id,uid,net_amount,reference,phone_number,approved_at FROM payouts
       WHERE status='approved' AND net_amount>0 ORDER BY approved_at DESC LIMIT 500`,
    );
    for (const p of payoutRows.rows) {
      const match = await db.query(
        `SELECT id FROM ledger WHERE type='withdrawal' AND from_uid=$1
         AND (reference=$2 OR description ILIKE $3) LIMIT 1`,
        [p.uid, p.reference, `%${p.reference}%`],
      );
      if (match.rows.length > 0) continue;
      const amt = parseFloat(p.net_amount);
      const pts = RISK_POINTS.unmatched_deposit;
      culprits.push({
        category: "unmatched_payout", severity: "high", riskPoints: pts,
        id: p.id, amount: -amt, uid: p.uid,
        reference: p.reference, phone: p.phone_number,
        description: `Approved payout ref ${p.reference} has no matching ledger debit`,
        detailedDescription: `KES ${amt.toFixed(2)} payout approved to ${p.phone_number} (ref: ${p.reference}) but no ledger withdrawal entry found.`,
        recommendedAction: "Verify M-Pesa B2C result. Create correcting ledger entry if payout was successful.",
        date: Number(p.approved_at || 0),
      });
      addScore(p.uid, WALLET_TYPES.WITHDRAWABLE, pts, `Unmatched payout KES ${amt.toFixed(2)} (${p.reference})`);
    }

    // ── C: Orphaned ledger deposits ───────────────────────────────────────────
    const ledgerDeps = await db.query(
      `SELECT id,to_uid,amount,reference,description,created_at FROM ledger
       WHERE type='deposit' AND amount>0 ORDER BY created_at DESC LIMIT 300`,
    );
    for (const entry of ledgerDeps.rows) {
      if (!entry.reference) continue;
      if (/transfer|escrow|fee|commission/i.test(entry.description || "")) continue;
      const mpesaM = await db.query(
        `SELECT 1 FROM mpesa_stk_requests WHERE mpesa_receipt_number=$1 AND status='success' LIMIT 1`,
        [entry.reference],
      );
      if (mpesaM.rows.length > 0) continue;
      const amt = parseFloat(entry.amount);
      if (amt <= RISK_THRESHOLDS.AUTO_RESOLVE_MAX) continue;
      const pts = RISK_POINTS.orphaned_ledger;
      culprits.push({
        category: "orphaned_ledger", severity: "high", riskPoints: pts,
        id: entry.id, amount: amt, uid: entry.to_uid, reference: entry.reference,
        description: `Ledger deposit ref ${entry.reference} has no M-Pesa receipt backing`,
        detailedDescription: `Ledger shows KES ${amt.toFixed(2)} deposit (ref: ${entry.reference}) but no matching M-Pesa receipt found. Possible manual entry or duplicate credit.`,
        recommendedAction: "Freeze wallet and investigate source. Review manual ledger entries.",
        date: Number(entry.created_at),
      });
      addScore(entry.to_uid, WALLET_TYPES.ACTIVE, pts, `Orphaned ledger deposit KES ${amt.toFixed(2)} (${entry.reference})`);
    }

    // ── D: Duplicate transaction references ───────────────────────────────────
    const dupRefs = await db.query(
      `SELECT reference, COUNT(*) AS cnt, SUM(amount) AS total_amount, MIN(to_uid) AS uid
       FROM ledger WHERE type='deposit' AND reference IS NOT NULL
       GROUP BY reference HAVING COUNT(*) > 1`,
    );
    for (const dup of dupRefs.rows) {
      const cnt = parseInt(dup.cnt), amt = parseFloat(dup.total_amount);
      const pts = RISK_POINTS.duplicate_reference;
      culprits.push({
        category: "duplicate_reference", severity: "critical", riskPoints: pts,
        id: dup.reference, amount: amt, uid: dup.uid, reference: dup.reference,
        description: `Reference ${dup.reference} appears ${cnt}× in ledger — possible double-credit`,
        detailedDescription: `Transaction ref ${dup.reference} was credited ${cnt} times totalling KES ${amt.toFixed(2)}. Likely duplicate transaction.`,
        recommendedAction: "Freeze wallet immediately. Reverse duplicate entries after verification.",
        date: now,
      });
      if (dup.uid) addScore(dup.uid, WALLET_TYPES.ACTIVE, pts, `Duplicate ref ${dup.reference} ×${cnt}`);
    }

    // ── E: Wallet balance drift ───────────────────────────────────────────────
    const allWallets = await db.query("SELECT uid, wallet_type, balance FROM wallets");
    const allLE      = (await db.query("SELECT from_uid,from_wallet,to_uid,to_wallet,amount FROM ledger")).rows;
    const lMap       = {};
    for (const e of allLE) {
      const kTo   = `${e.to_uid}::${e.to_wallet}`;
      const kFrom = `${e.from_uid}::${e.from_wallet}`;
      lMap[kTo]   = (lMap[kTo]   || 0) + parseFloat(e.amount || 0);
      lMap[kFrom] = (lMap[kFrom] || 0) - parseFloat(e.amount || 0);
    }
    for (const w of allWallets.rows) {
      const key      = `${w.uid}::${w.wallet_type}`;
      const ledgerBal= parseFloat((lMap[key] || 0).toFixed(2));
      const stored   = parseFloat(w.balance);
      const drift    = parseFloat(Math.abs(ledgerBal - stored).toFixed(2));
      if (drift <= 1.0) continue;
      if (drift <= RISK_THRESHOLDS.AUTO_RESOLVE_MAX) continue;
      let pts, severity;
      if (drift >= 10000) { pts = RISK_POINTS.wallet_drift_high;   severity = "critical"; }
      else                { pts = RISK_POINTS.wallet_drift_medium;  severity = "medium_high"; }
      if (globalGapHigh) pts += RISK_POINTS.recon_gap_large;
      culprits.push({
        category: "wallet_drift", severity, riskPoints: pts,
        id: `${w.uid}_${w.wallet_type}`, amount: stored - ledgerBal,
        uid: w.uid, reference: w.wallet_type,
        description: `${w.wallet_type} wallet drift KES ${drift.toFixed(2)} — stored ${stored.toFixed(2)} vs ledger ${ledgerBal.toFixed(2)}`,
        detailedDescription: `Stored balance KES ${stored.toFixed(2)} vs ledger-computed KES ${ledgerBal.toFixed(2)} — drift of KES ${drift.toFixed(2)}. ${drift >= 10000 ? 'Large discrepancy — serious ledger inconsistency.' : 'Possible missed ledger entry.'}`,
        recommendedAction: drift >= 10000 ? "Freeze wallet. Full ledger audit required." : "Restrict withdrawals. Allow deposits. Reconcile ledger.",
        date: now,
      });
      addScore(w.uid, w.wallet_type, pts, `Wallet drift KES ${drift.toFixed(2)} on ${w.wallet_type}`);
    }

    // ── F: Stuck escrow orders ────────────────────────────────────────────────
    const stuckEscrow = await db.query(
      `SELECT id,buyer_uid,seller_uid,amount,reference,created_at,escrow_expires_at
       FROM escrow_orders WHERE status='in_escrow' AND escrow_expires_at < $1`, [now],
    );
    for (const order of stuckEscrow.rows) {
      const daysStuck = Math.floor((now - Number(order.escrow_expires_at)) / 86400000);
      const amt = parseFloat(order.amount);
      const pts = RISK_POINTS.stuck_escrow;
      culprits.push({
        category: "stuck_escrow", severity: "medium", riskPoints: pts,
        id: order.id, amount: amt, uid: order.buyer_uid, reference: order.reference,
        description: `Escrow order expired ${daysStuck} day(s) ago — funds locked`,
        detailedDescription: `Escrow order ${order.id.substring(0,8)} holding KES ${amt.toFixed(2)} expired ${daysStuck} day(s) ago but is still 'in_escrow'. Auto-release may have failed.`,
        recommendedAction: "Trigger auto-release or manual resolution. Review cron job health.",
        date: Number(order.created_at),
      });
      if (order.buyer_uid) addScore(order.buyer_uid, WALLET_TYPES.ACTIVE, pts, `Stuck escrow KES ${amt.toFixed(2)} (${daysStuck}d expired)`);
    }

    // ── G: Escalation — bonus for wallets with repeated anomaly history ───────
    for (const key of Object.keys(walletScores)) {
      const { uid, walletType } = walletScores[key];
      const histRes = await db.query(
        `SELECT COUNT(DISTINCT DATE_TRUNC('day', TO_TIMESTAMP(created_at/1000))) AS days
         FROM wallet_anomaly_history WHERE uid=$1 AND wallet_type=$2 AND resolved=false`,
        [uid, walletType],
      );
      const repeatDays = parseInt(histRes.rows[0]?.days || 0);
      if (repeatDays > 1) {
        const bonus = RISK_POINTS.repeat_anomaly * (repeatDays - 1);
        walletScores[key].score += bonus;
        walletScores[key].flags.push(`Recurring anomaly on ${repeatDays} day(s) (+${bonus}pts)`);
      }
    }

    // ── H: Apply restrictions and persist risk scores ─────────────────────────
    for (const key of Object.keys(walletScores)) {
      const ws          = walletScores[key];
      const restriction = riskLevel(ws.score);
      const action      = recommendedAction(restriction);

      await db.query(
        `INSERT INTO wallet_risk_scores (uid,wallet_type,risk_score,restriction,anomaly_flags,last_updated)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (uid,wallet_type) DO UPDATE
         SET risk_score=EXCLUDED.risk_score, restriction=EXCLUDED.restriction,
             anomaly_flags=EXCLUDED.anomaly_flags, last_updated=EXCLUDED.last_updated`,
        [ws.uid, ws.walletType, ws.score, restriction, JSON.stringify(ws.flags), now],
      );

      for (const c of culprits.filter(x => x.uid === ws.uid)) {
        await db.query(
          `INSERT INTO wallet_anomaly_history
           (uid,wallet_type,category,risk_points,amount,description,reference,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ws.uid, ws.walletType, c.category, c.riskPoints,
           Math.abs(c.amount), c.description, c.reference || null, now],
        ).catch(() => {});
      }

      if (restriction === WALLET_RESTRICTION.FREEZE) {
        // Build a human-readable freeze reason from the anomaly flags detected
        const freezeReason = ws.flags.length > 0
          ? `Automated reconciliation detected: ${ws.flags.slice(0, 3).join('; ')}${ws.flags.length > 3 ? ` (+${ws.flags.length - 3} more issues)` : ''}. Risk score: ${ws.score}.`
          : `Automated reconciliation flagged this wallet with a high risk score of ${ws.score}. Please contact support.`;

        await db.query(
          `UPDATE wallets SET status=$1, updated_at=$2, freeze_reason=$3 WHERE uid=$4 AND wallet_type=$5::wallet_type`,
          [WALLET_STATUS.FROZEN, now, freezeReason, ws.uid, ws.walletType],
        );
        sendNotification(ws.uid, "Wallet Frozen — Action Required",
          `Your ${ws.walletType} wallet has been frozen by the automated reconciliation system. Reason: ${freezeReason} Please contact support to resolve.`,
          "error",
        );
        console.error(`[RISK] FREEZE uid=${ws.uid} wallet=${ws.walletType} score=${ws.score} reason="${freezeReason}"`);
      } else if (restriction === WALLET_RESTRICTION.RESTRICT_WITHDRAWALS) {
        await db.query(
          `UPDATE wallets SET status=$1,updated_at=$2 WHERE uid=$3 AND wallet_type=$4::wallet_type AND status!='frozen'`,
          [WALLET_STATUS.ACTIVE, now, ws.uid, ws.walletType],
        );
        sendNotification(ws.uid, "Withdrawals Temporarily Restricted",
          `Your ${ws.walletType} wallet withdrawals are restricted pending reconciliation (score: ${ws.score}). Deposits remain available.`,
          "warning",
        );
        console.warn(`[RISK] RESTRICT uid=${ws.uid} wallet=${ws.walletType} score=${ws.score}`);
      } else if (restriction === WALLET_RESTRICTION.MONITOR) {
        console.log(`[RISK] MONITOR uid=${ws.uid} wallet=${ws.walletType} score=${ws.score}`);
      }
    }

    // ── I: Annotate culprits with wallet risk scores ───────────────────────────
    for (const c of culprits) {
      if (!c.uid) continue;
      const wt  = ["withdrawable","escrow"].includes(c.reference) ? c.reference : WALLET_TYPES.ACTIVE;
      const ws  = walletScores[`${c.uid}::${wt}`];
      c.walletRiskScore   = ws?.score      || c.riskPoints;
      c.walletRestriction = ws ? riskLevel(ws.score) : WALLET_RESTRICTION.NONE;
      c.walletAction      = ws ? recommendedAction(riskLevel(ws.score)) : "Monitor";
      c.walletFlags       = ws?.flags || [];
    }

  } catch (e) {
    console.error("[RECONCILIATION] Risk engine error:", e.message);
  }
  return culprits;
}

module.exports = { findReconciliationCulprits };
