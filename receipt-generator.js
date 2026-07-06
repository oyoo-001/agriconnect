/**
 * receipt-generator.js
 * Generates professional PDF receipt and invoice for completed AgriConnect orders.
 * Uses pdfkit. Returns a Buffer for saving to disk / attaching to email.
 */

"use strict";

const PDFDocument = require("pdfkit");
const path        = require("path");
const fs          = require("fs");

// ── Brand colours ────────────────────────────────────────────────────────────
const GREEN       = "#1B5E20";
const GREEN_MID   = "#2E7D32";
const GREEN_LITE  = "#E8F5E9";
const ACCENT      = "#FFB300";
const GRAY        = "#6B7280";
const GRAY_LIGHT  = "#E5E7EB";
const DARK        = "#1A1A2E";
const RED_STAMP   = "#C62828";
const WHITE       = "#FFFFFF";

// Logo image path (64×64 app icon)
const LOGO_PATH = path.join(
  __dirname,
  "icons", "Assets.xcassets", "AppIcon.appiconset", "_", "64.png"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely convert any value to a finite float. Returns 0 on failure. */
function toNum(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

/** Format a number as KES currency string. */
function fmt(v) {
  return "KES " + toNum(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Convert a timestamp to a readable date string.
 * Accepts: JS Date, BIGINT number (ms), BIGINT string (ms), ISO string.
 */
function toDate(ts) {
  if (!ts) return "—";
  let d;
  if (ts instanceof Date) {
    d = ts;
  } else if (typeof ts === "number" || /^\d+$/.test(String(ts))) {
    // Raw milliseconds integer (Postgres BIGINT → string of digits)
    const ms = Number(ts);
    d = new Date(ms > 9999999999 ? ms : ms * 1000); // handle sec vs ms
  } else {
    d = new Date(ts);
  }
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-KE", {
    day: "2-digit", month: "long", year: "numeric",
    timeZone: "Africa/Nairobi",
  }) + " " + d.toLocaleTimeString("en-KE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi",
  });
}

/** Shorten an order ID to 8 uppercase chars. */
function shortId(id) {
  return String(id || "").substring(0, 8).toUpperCase();
}

// ── Core PDF builder ──────────────────────────────────────────────────────────

function buildPDF(docType, data) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 50, compress: true });
    doc.on("data",  c   => chunks.push(c));
    doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
    doc.on("error", err => reject(err));

    // ── Normalise all numeric fields coming from Postgres as strings ──────────
    const orderId      = String(data.orderId || "");
    const reference    = String(data.reference || "—");
    const completedAt  = data.completedAt;
    const createdAt    = data.createdAt;
    const buyerName    = String(data.buyerName  || "Buyer");
    const buyerEmail   = String(data.buyerEmail || "");
    const sellerName   = String(data.sellerName || "Seller");
    const sellerEmail  = String(data.sellerEmail || "");
    const productTitle = String(data.productTitle || "Product");
    const productImage = data.productImage || null;
    const quantity     = Math.max(1, parseInt(data.quantity) || 1);
    const totalAmount  = toNum(data.totalAmount);
    const fee          = toNum(data.fee);
    const netAmount    = toNum(data.netAmount);
    const unitPrice    = quantity > 0 ? totalAmount / quantity : totalAmount;
    const deliveryInstructions = data.deliveryInstructions ? String(data.deliveryInstructions).trim() : null;

    const pageW = doc.page.width - 100; // usable width (50pt margin each side)
    const isBuyer = docType === "receipt";

    // ── TOP GREEN BAR ─────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 8).fill(GREEN);

    // ── LOGO + BRAND ──────────────────────────────────────────────────────────
    let logoPlaced = false;
    if (fs.existsSync(LOGO_PATH)) {
      try {
        doc.image(LOGO_PATH, 50, 18, { width: 48, height: 48 });
        logoPlaced = true;
      } catch (_) { /* fall through to text fallback */ }
    }
    if (!logoPlaced) {
      doc.roundedRect(50, 18, 48, 48, 8).fill(GREEN);
      doc.fill(WHITE).font("Helvetica-Bold").fontSize(22).text("A", 50, 30, { width: 48, align: "center" });
    }

    // App name beside logo
    doc.fill(GREEN).font("Helvetica-Bold").fontSize(18).text("AgriConnect", 108, 24);
    doc.fill(GRAY).font("Helvetica").fontSize(9).text("Farm‑to‑Market Platform", 108, 44);

    // Document type badge (top-right)
    const badgeLabel  = docType === "receipt" ? "PAYMENT RECEIPT" : "TAX INVOICE";
    const badgeX      = doc.page.width - 205;
    doc.roundedRect(badgeX, 22, 155, 34, 6).fill(GREEN_LITE);
    doc.fill(GREEN).font("Helvetica-Bold").fontSize(11)
       .text(badgeLabel, badgeX, 32, { width: 155, align: "center" });

    // Divider
    doc.moveTo(50, 78).lineTo(doc.page.width - 50, 78).lineWidth(1).stroke(GREEN_LITE);

    // ── APPROVED STAMP (rotated, top-right area) ──────────────────────────────
    doc.save();
    doc.translate(doc.page.width - 100, 120);
    doc.rotate(-28);
    doc.roundedRect(-58, -24, 116, 48, 6).lineWidth(3).stroke(RED_STAMP);
    doc.fill(RED_STAMP).font("Helvetica-Bold").fontSize(17)
       .text("APPROVED", -54, -10, { width: 108, align: "center" });
    doc.restore();

    // ── DOCUMENT META ─────────────────────────────────────────────────────────
    let y = 98;
    const col2 = 50 + pageW / 2;

    doc.fill(GRAY).font("Helvetica").fontSize(9)
       .text(docType === "receipt" ? "Receipt No." : "Invoice No.", 50, y);
    doc.fill(DARK).font("Helvetica-Bold").fontSize(11)
       .text(shortId(orderId), 50, y + 13);

    doc.fill(GRAY).font("Helvetica").fontSize(9).text("Transaction Ref.", 50, y + 30);
    doc.fill(DARK).font("Helvetica").fontSize(9).text(reference, 50, y + 43, { width: col2 - 56 });

    doc.fill(GRAY).font("Helvetica").fontSize(9).text("Order Date",  col2, y);
    doc.fill(DARK).font("Helvetica").fontSize(10).text(toDate(createdAt), col2, y + 13);
    doc.fill(GRAY).font("Helvetica").fontSize(9).text("Completed",   col2, y + 30);
    doc.fill(DARK).font("Helvetica").fontSize(10).text(toDate(completedAt), col2, y + 43);

    y += 68;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke(GRAY_LIGHT);
    y += 14;

    // ── PARTIES ───────────────────────────────────────────────────────────────
    const partyW = (pageW / 2) - 10;

    doc.roundedRect(50, y, partyW, 76, 6).fill(GREEN_LITE);
    doc.fill(GREEN).font("Helvetica-Bold").fontSize(8).text("BUYER (BILL TO)", 62, y + 10);
    doc.fill(DARK).font("Helvetica-Bold").fontSize(11)
       .text(buyerName, 62, y + 22, { width: partyW - 24 });
    doc.fill(GRAY).font("Helvetica").fontSize(9)
       .text(buyerEmail, 62, y + 38, { width: partyW - 24 });

    const selX = 50 + partyW + 20;
    doc.roundedRect(selX, y, partyW, 76, 6).fill("#F3F4F6");
    doc.fill(GREEN).font("Helvetica-Bold").fontSize(8).text("SELLER (SHIP FROM)", selX + 12, y + 10);
    doc.fill(DARK).font("Helvetica-Bold").fontSize(11)
       .text(sellerName, selX + 12, y + 22, { width: partyW - 24 });
    doc.fill(GRAY).font("Helvetica").fontSize(9)
       .text(sellerEmail, selX + 12, y + 38, { width: partyW - 24 });

    y += 92;

    // ── PRODUCT IMAGE (if available) ──────────────────────────────────────────
    if (productImage) {
      try {
        let imgSrc;
        if (typeof productImage === "string" && productImage.startsWith("data:")) {
          const base64 = productImage.split(",")[1];
          if (base64) imgSrc = Buffer.from(base64, "base64");
        } else if (typeof productImage === "string" && fs.existsSync(productImage)) {
          imgSrc = productImage;
        }
        if (imgSrc) {
          doc.roundedRect(50, y, 80, 64, 6).clip();
          doc.image(imgSrc, 50, y, { width: 80, height: 64, cover: [80, 64] });
          doc.restore();
          doc.fill(DARK).font("Helvetica-Bold").fontSize(12)
             .text(productTitle, 142, y + 8, { width: pageW - 96 });
          doc.fill(GRAY).font("Helvetica").fontSize(9)
             .text(`Quantity: ${quantity}`, 142, y + 26);
          y += 80;
        }
      } catch (_) {
        // image failed — simple text row
        y = drawProductFallback(doc, y, pageW, productTitle, quantity);
      }
    } else {
      y = drawProductFallback(doc, y, pageW, productTitle, quantity);
    }

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke(GRAY_LIGHT);
    y += 14;

    // ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    const C = { desc: 50, qty: 290, unit: 360, total: 450 };

    // Header row
    doc.rect(50, y, pageW, 22).fill("#F3F4F6");
    doc.fill(GRAY).font("Helvetica-Bold").fontSize(8);
    doc.text("DESCRIPTION",         C.desc + 8, y + 7);
    doc.text("QTY",                 C.qty,      y + 7);
    doc.text("UNIT PRICE",          C.unit,     y + 7);
    doc.text("AMOUNT",              C.total,    y + 7);
    y += 22;

    // Product row
    doc.rect(50, y, pageW, 26).fill("#FAFAFA");
    doc.fill(DARK).font("Helvetica").fontSize(10);
    doc.text(productTitle,          C.desc + 8, y + 7, { width: 230 });
    doc.text(String(quantity),      C.qty,      y + 7);
    doc.text(fmt(unitPrice),        C.unit,     y + 7);
    doc.text(fmt(totalAmount),      C.total,    y + 7);
    y += 26;

    // Platform fee row (receipt only)
    if (docType === "receipt" && fee > 0) {
      doc.rect(50, y, pageW, 22).fill(WHITE);
      doc.fill(GRAY).font("Helvetica").fontSize(9);
      doc.text("Platform Service Fee",   C.desc + 8, y + 6);
      doc.text("1",                      C.qty,      y + 6);
      doc.text(fmt(fee),                 C.unit,     y + 6);
      doc.text(fmt(fee),                 C.total,    y + 6);
      y += 22;
    }

    y += 6;
    doc.moveTo(310, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke(GRAY_LIGHT);
    y += 10;

    // ── DELIVERY INSTRUCTIONS (if present) ───────────────────────────────────
    if (deliveryInstructions) {
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke(GRAY_LIGHT);
      y += 12;
      doc.fill(GREEN).font("Helvetica-Bold").fontSize(9).text("DELIVERY INSTRUCTIONS", 50, y);
      y += 14;
      doc.roundedRect(50, y, pageW, Math.max(28, Math.ceil(deliveryInstructions.length / 90) * 14 + 16), 6)
         .fill("#FFFBEB");
      doc.fill("#92400E").font("Helvetica").fontSize(9)
         .text(deliveryInstructions, 62, y + 8, { width: pageW - 24, lineGap: 3 });
      y += Math.max(28, Math.ceil(deliveryInstructions.length / 90) * 14 + 16) + 12;
    }

    // Totals
    function totalRow(label, value, bold, colour) {
      doc.fill(colour || GRAY).font(bold ? "Helvetica-Bold" : "Helvetica")
         .fontSize(bold ? 11 : 9);
      doc.text(label, 340, y, { width: 100 });
      doc.text(value, C.total, y, { width: 100 });
      y += 18;
    }

    totalRow("Subtotal",        fmt(totalAmount), false);
    if (fee > 0 && docType === "receipt") {
      totalRow("Platform Fee",  fmt(fee),         false);
    }
    doc.moveTo(310, y).lineTo(doc.page.width - 50, y).lineWidth(1).stroke(GREEN);
    y += 6;
    if (docType === "receipt") {
      totalRow("Total Paid",     fmt(totalAmount), true,  DARK);
      totalRow("Net to Seller",  fmt(netAmount),   false, GRAY);
    } else {
      totalRow("Total Due",      fmt(totalAmount), true,  DARK);
    }

    y += 18;

    // ── STATUS BADGE ──────────────────────────────────────────────────────────
    doc.roundedRect(50, y, 110, 26, 6).fill(GREEN_LITE);
    doc.fill(GREEN).font("Helvetica-Bold").fontSize(10)
       .text(
         docType === "receipt" ? "✓  PAYMENT CONFIRMED" : "✓  ORDER COMPLETE",
         54, y + 7, { width: 102, align: "center" }
       );

    y += 46;

    // ── FOOTER ────────────────────────────────────────────────────────────────
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke(GRAY_LIGHT);
    y += 10;
    doc.fill(GRAY).font("Helvetica").fontSize(7.5)
       .text(
         "AgriConnect · Farm‑to‑Market Platform · This document is system-generated and valid without a signature.",
         50, y, { width: pageW, align: "center" }
       );
    doc.fill(GRAY).font("Helvetica").fontSize(7.5)
       .text(
         `Order ID: ${orderId}  ·  Generated: ${toDate(Date.now())}`,
         50, y + 13, { width: pageW, align: "center" }
       );

    // Bottom green bar
    doc.rect(0, doc.page.height - 8, doc.page.width, 8).fill(GREEN);

    doc.end();
  });
}

function drawProductFallback(doc, y, pageW, productTitle, quantity) {
  doc.rect(50, y, pageW, 34).fill("#F9FAFB");
  doc.fill(DARK).font("Helvetica-Bold").fontSize(11)
     .text(productTitle, 62, y + 7, { width: pageW - 24 });
  doc.fill(GRAY).font("Helvetica").fontSize(9)
     .text(`Quantity: ${quantity}`, 62, y + 21);
  return y + 48;
}

// ── Public API ────────────────────────────────────────────────────────────────

function generateReceiptPDF(data) {
  return buildPDF("receipt", data);
}

function generateInvoicePDF(data) {
  return buildPDF("invoice", data);
}

module.exports = { generateReceiptPDF, generateInvoicePDF };
