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
  const statusColors = { pending: '#f59e0b', confirmed: '#3b82f6', shipped: '#8b5cf6', delivered: '#2d6a4f', cancelled: '#ef4444' };
  const color = statusColors[status] || '#666';
  const isOrg = actor === 'organization';
  return emailLayout(`Order ${status.charAt(0).toUpperCase() + status.slice(1)}`, `
    <h1 style="margin:0 0 4px;font-size:24px;color:#1a1a2e">Order ${status.charAt(0).toUpperCase() + status.slice(1)}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#555">Hi ${name}, ${isOrg ? 'an organization has' : 'a farmer has'} ${status === 'pending' ? 'placed' : status === 'confirmed' ? 'confirmed' : status === 'shipped' ? 'shipped' : status === 'delivered' ? 'marked as delivered' : 'cancelled'} an order.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px;font-size:14px;color:#444">
      <tr>
        <td style="padding:16px;background:#f9fafb;border-radius:8px">
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">
            <tr><td style="padding:4px 0;font-size:12px;color:#8899aa;text-transform:uppercase;letter-spacing:0.5px">Order #${orderId}</td></tr>
            <tr><td style="padding:4px 0;font-weight:600;font-size:16px;color:#1a1a2e">${listingTitle || 'Product'}</td></tr>
            <tr><td style="padding:4px 0"><span style="display:inline-block;padding:4px 12px;background:${color}15;color:${color};border-radius:20px;font-size:13px;font-weight:600">${status.charAt(0).toUpperCase() + status.slice(1)}</span></td></tr>
            ${amount ? `<tr><td style="padding:4px 0;font-weight:600;font-size:18px;color:#1a1a2e">${fmt(amount)}</td></tr>` : ''}
          </table>
        </td>
      </tr>
    </table>
    <a href="${process.env.BASE_URL || 'http://localhost:3000'}/home" style="display:inline-block;padding:14px 32px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">View Order &rarr;</a>
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
