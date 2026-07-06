function emailLayout(title, bodyContent) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;min-height:100vh">
    <tr><td align="center" style="padding:40px 16px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:24px">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="background:#2d6a4f;border-radius:50%;width:56px;height:56px;line-height:56px;font-size:28px;color:#fff;font-weight:700">A</td>
              </tr>
              <tr>
                <td align="center" style="padding-top:8px;font-size:20px;font-weight:700;color:#2d6a4f;letter-spacing:-0.5px">AgriConnect</td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Card -->
        <tr>
          <td style="background:#ffffff;border-radius:16px;padding:40px 48px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
            ${bodyContent}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;font-size:13px;color:#8899aa;line-height:1.6">
            <p style="margin:0 0 4px">AgriConnect &mdash; Bridging Farmers &amp; Organizations</p>
            <p style="margin:0">You received this email because you have an AgriConnect account.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function welcomeEmail(name) {
  return emailLayout('Welcome to AgriConnect', `
    <h1 style="margin:0 0 8px;font-size:24px;color:#1a1a2e">Welcome to AgriConnect, ${name}!</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6">We're thrilled to have you join our agricultural marketplace. Whether you're a farmer, organization, or industry partner, AgriConnect helps you grow your network and streamline your agribusiness.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:16px;background:#f0fdf4;border-radius:8px;vertical-align:top;width:33%">
          <div style="font-size:24px;margin-bottom:4px">🌱</div>
          <div style="font-size:13px;font-weight:600;color:#1a1a2e">List Products</div>
          <div style="font-size:12px;color:#666">Showcase your produce to buyers</div>
        </td>
        <td style="width:8px">&nbsp;</td>
        <td style="padding:16px;background:#f0fdf4;border-radius:8px;vertical-align:top;width:33%">
          <div style="font-size:24px;margin-bottom:4px">🤝</div>
          <div style="font-size:13px;font-weight:600;color:#1a1a2e">Connect</div>
          <div style="font-size:12px;color:#666">Build partnerships that matter</div>
        </td>
        <td style="width:8px">&nbsp;</td>
        <td style="padding:16px;background:#f0fdf4;border-radius:8px;vertical-align:top;width:33%">
          <div style="font-size:24px;margin-bottom:4px">💰</div>
          <div style="font-size:13px;font-weight:600;color:#1a1a2e">Earn &amp; Grow</div>
          <div style="font-size:12px;color:#666">Transact securely on our platform</div>
        </td>
      </tr>
    </table>
    <a href="${process.env.BASE_URL || 'http://localhost:3000'}/login" style="display:inline-block;padding:14px 32px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">Get Started &rarr;</a>
    <p style="margin:24px 0 0;font-size:13px;color:#8899aa">If you have questions, reply to this email or visit our <a href="${process.env.BASE_URL || 'http://localhost:3000'}/help-center" style="color:#2d6a4f">Help Center</a>.</p>
  `);
}

function depositEmail(name, amount, balance, reference) {
  const fmt = n => 'KES ' + Number(n).toFixed(2);
  return emailLayout('Deposit Confirmed', `
    <h1 style="margin:0 0 4px;font-size:24px;color:#1a1a2e">Deposit Successful!</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555">Hi ${name}, your wallet has been funded.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:20px;background:#f0fdf4;border-radius:12px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#2d6a4f">${fmt(amount)}</div>
          <div style="font-size:13px;color:#666;margin-top:4px">Amount Deposited</div>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;font-size:14px;color:#444">
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee">Reference</td><td style="padding:8px 0;text-align:right;font-family:monospace;color:#333">${reference}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee">New Balance</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#2d6a4f">${fmt(balance)}</td></tr>
    </table>
    <a href="${process.env.BASE_URL || 'http://localhost:3000'}/home" style="display:inline-block;padding:14px 32px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">View Wallet &rarr;</a>
  `);
}

function withdrawalEmail(name, amount, balance, accountInfo) {
  const fmt = n => 'KES ' + Number(n).toFixed(2);
  return emailLayout('Withdrawal Initiated', `
    <h1 style="margin:0 0 4px;font-size:24px;color:#1a1a2e">Withdrawal Initiated</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555">Hi ${name}, we're processing your withdrawal request.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:20px;background:#fff7ed;border-radius:12px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:#c2410c">${fmt(amount)}</div>
          <div style="font-size:13px;color:#666;margin-top:4px">Withdrawal Amount</div>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;font-size:14px;color:#444">
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee">Account</td><td style="padding:8px 0;text-align:right">${accountInfo || 'N/A'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee">Remaining Balance</td><td style="padding:8px 0;text-align:right;font-weight:600">${fmt(balance)}</td></tr>
      <tr><td style="padding:8px 0">Estimated Processing</td><td style="padding:8px 0;text-align:right">1-3 business days</td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#8899aa">Funds will be sent to your provided bank account. Contact support if you have questions.</p>
  `);
}

function orderEmail(name, orderId, status, listingTitle, amount, actor) {
  const fmt = n => 'KES ' + Number(n).toFixed(2);

  // Status display config
  const statusConfig = {
    pending:    { label: 'Order Received',        color: '#f59e0b', icon: '📋' },
    in_escrow:  { label: 'Order Confirmed',        color: '#3b82f6', icon: '🔒' },
    accepted:   { label: 'Order Accepted',         color: '#10b981', icon: '✅' },
    processing: { label: 'Order Processing',       color: '#8b5cf6', icon: '⚙️' },
    dispatched: { label: 'Order Dispatched',       color: '#6366f1', icon: '🚚' },
    delivered:  { label: 'Delivery Confirmed',     color: '#2d6a4f', icon: '📦' },
    verified:   { label: 'Order Verified',         color: '#2d6a4f', icon: '✔️' },
    completed:  { label: 'Order Completed',        color: '#16a34a', icon: '🎉' },
    cancelled:  { label: 'Order Cancelled',        color: '#ef4444', icon: '❌' },
    disputed:   { label: 'Order Disputed',         color: '#f97316', icon: '⚠️' },
    refunded:   { label: 'Order Refunded',         color: '#6b7280', icon: '↩️' },
  };

  const cfg = statusConfig[status] || { label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '), color: '#6b7280', icon: '📋' };

  // Per-status message, tailored to buyer vs seller
  const isBuyer = actor === 'buyer';
  const messages = {
    pending:    isBuyer ? 'Your order has been placed and is awaiting confirmation.'
                        : 'You have received a new order.',
    in_escrow:  isBuyer ? 'Your order is confirmed. Payment is securely held in escrow until delivery.'
                        : 'A buyer has placed an order. Payment is securely held in escrow.',
    accepted:   isBuyer ? 'The seller has accepted your order and will prepare it for dispatch.'
                        : 'You have accepted the order. Please prepare for dispatch.',
    processing: isBuyer ? 'Your order is being processed and prepared for dispatch.'
                        : 'Your order is being processed.',
    dispatched: isBuyer ? 'Your order has been dispatched and is on the way. Please check your email for the delivery OTP.'
                        : 'You have dispatched the order. Awaiting buyer confirmation.',
    delivered:  isBuyer ? 'The seller has marked your order as delivered. Please verify receipt with the OTP sent to you.'
                        : 'You have marked the order as delivered. Awaiting buyer verification.',
    verified:   isBuyer ? 'You have verified delivery. Payment will be released to the seller.'
                        : 'The buyer has verified delivery. Payment will be released to your wallet.',
    completed:  isBuyer ? 'Your order is complete. Thank you for using AgriConnect!'
                        : 'The order is complete. Payment has been released to your wallet.',
    cancelled:  isBuyer ? 'Your order has been cancelled and a full refund has been issued to your wallet.'
                        : 'The order has been cancelled. Funds have been returned to the buyer.',
    disputed:   isBuyer ? 'You have raised a dispute on this order. Our team will review it.'
                        : 'The buyer has raised a dispute on this order. Our team will review it.',
    refunded:   isBuyer ? 'A refund has been issued to your wallet.'
                        : 'The order was refunded to the buyer.',
  };

  const message = messages[status] || `Your order status has been updated to ${cfg.label}.`;

  return emailLayout(`${cfg.icon} ${cfg.label}`, `
    <h1 style="margin:0 0 4px;font-size:24px;color:#1a1a2e">${cfg.icon} ${cfg.label}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6">Hi ${name}, ${message}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:20px;background:#f9fafb;border-radius:12px">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:#444">
            <tr>
              <td style="padding:4px 0;font-size:11px;color:#8899aa;text-transform:uppercase;letter-spacing:0.5px" colspan="2">Order Details</td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #eee">Order ID</td>
              <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:#333">#${String(orderId).substring(0,8).toUpperCase()}</td>
            </tr>
            ${listingTitle ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">Product</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;color:#1a1a2e">${listingTitle}</td></tr>` : ''}
            ${amount ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">Amount</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:#2d6a4f">${fmt(amount)}</td></tr>` : ''}
            <tr>
              <td style="padding:8px 0">Status</td>
              <td style="padding:8px 0;text-align:right">
                <span style="display:inline-block;padding:4px 12px;background:${cfg.color}18;color:${cfg.color};border-radius:20px;font-size:13px;font-weight:600">${cfg.label}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    ${status === 'dispatched' && isBuyer ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:16px;background:#fef3c7;border-radius:8px;border-left:4px solid #f59e0b">
          <p style="margin:0;font-size:14px;color:#92400e;font-weight:600">📧 Check your email for the delivery OTP</p>
          <p style="margin:4px 0 0;font-size:13px;color:#92400e">You'll need it to confirm receipt when your order arrives.</p>
        </td>
      </tr>
    </table>` : ''}
    ${status === 'completed' ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="padding:16px;background:#f0fdf4;border-radius:8px;border-left:4px solid #16a34a">
          <p style="margin:0;font-size:14px;color:#166534;font-weight:600">🎉 Transaction Complete</p>
          <p style="margin:4px 0 0;font-size:13px;color:#166534">${isBuyer ? 'Thank you for your purchase!' : 'Payment has been added to your withdrawable wallet.'}</p>
        </td>
      </tr>
    </table>` : ''}
    <a href="${process.env.BASE_URL || 'http://localhost:3000'}/${isBuyer ? 'consumer' : 'farmer'}" style="display:inline-block;padding:14px 32px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">View Order &rarr;</a>
    <p style="margin:16px 0 0;font-size:12px;color:#8899aa">Need help? Contact our <a href="${process.env.BASE_URL || 'http://localhost:3000'}/help-center" style="color:#2d6a4f">support team</a>.</p>
  `);
}

function passwordResetEmail(name, link) {
  return emailLayout('Password Reset', `
    <h1 style="margin:0 0 8px;font-size:24px;color:#1a1a2e">Reset Your Password</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6">Hi ${name}, we received a request to reset your AgriConnect password. Click the button below to set a new password. This link expires in 1 hour.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td align="center">
          <a href="${link}" style="display:inline-block;padding:14px 32px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">Reset Password &rarr;</a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#8899aa">If you didn't request this, you can safely ignore this email. Your password won't change unless you click the link above.</p>
  `);
}

module.exports = { welcomeEmail, depositEmail, withdrawalEmail, orderEmail, passwordResetEmail };
