import os

path = r'C:\Users\oyooo\landing page\organisation.html'

content = r'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Organisation Dashboard – AgriConnect</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #1B5E20;
            --primary-light: #2E7D32;
            --secondary: #43A047;
            --accent: #FFB300;
            --accent-dark: #FF8F00;
            --dark: #1a1a2e;
            --dark-2: #16213e;
            --light: #f8f9fa;
            --gray: #6c757d;
            --gray-light: #e9ecef;
            --white: #ffffff;
            --sidebar-w: 260px;
            --radius-sm: 8px;
            --radius-md: 16px;
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            --shadow-sm: 0 2px 8px rgba(0,0,0,0.06);
            --shadow-md: 0 8px 30px rgba(0,0,0,0.12);
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
            background:var(--light); color:var(--dark); line-height:1.6;
            display:flex; min-height:100vh;
        }
        a { text-decoration:none; color:inherit; }
        .sidebar {
            position:fixed; top:0; left:0; width:var(--sidebar-w); height:100vh;
            background:linear-gradient(180deg,var(--dark) 0%,var(--dark-2) 100%);
            z-index:200; display:flex; flex-direction:column;
            transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);
        }
        .sidebar.open { transform:translateX(0); }
        .sidebar-brand {
            padding:1.5rem 1.25rem; display:flex; align-items:center; gap:0.75rem;
            border-bottom:1px solid rgba(255,255,255,0.06);
        }
        .sidebar-brand-icon {
            width:36px; height:36px;
            background:linear-gradient(135deg,var(--accent),var(--accent-dark));
            border-radius:var(--radius-sm); display:flex; align-items:center;
            justify-content:center; font-size:1.1rem; flex-shrink:0;
        }
        .sidebar-brand span { font-weight:800; font-size:1.15rem; color:var(--white); }
        .sidebar-nav { flex:1; padding:1rem 0.75rem; overflow-y:auto; }
        .sidebar-nav-label {
            font-size:0.7rem; font-weight:700; text-transform:uppercase;
            letter-spacing:1.2px; color:rgba(255,255,255,0.3);
            padding:1rem 0.75rem 0.5rem;
        }
        .sidebar-link {
            display:flex; align-items:center; gap:0.75rem;
            padding:0.7rem 0.75rem; border-radius:var(--radius-sm);
            color:rgba(255,255,255,0.6); font-size:0.9rem; font-weight:500;
            transition:var(--transition); cursor:pointer; border:none;
            background:none; width:100%; text-align:left; font-family:inherit;
        }
        .sidebar-link:hover { background:rgba(255,255,255,0.06); color:var(--white); }
        .sidebar-link.active {
            background:rgba(255,255,255,0.1); color:var(--white); font-weight:600;
            border-left:3px solid var(--accent);
            border-radius:0 var(--radius-sm) var(--radius-sm) 0; margin-left:-3px;
        }
        .sidebar-link .icon {
            width:28px; height:28px; display:flex; align-items:center;
            justify-content:center; flex-shrink:0; color:rgba(255,255,255,0.5);
        }
        .sidebar-link:hover .icon { color:var(--accent); }
        .sidebar-link.active .icon { color:var(--accent); }
        .sidebar-link .badge {
            margin-left:auto;
            background:linear-gradient(135deg,var(--accent),var(--accent-dark));
            color:var(--dark); font-size:0.65rem; font-weight:700;
            padding:0.15rem 0.5rem; border-radius:50px;
        }
        .sidebar-footer { padding:1rem 0.75rem; border-top:1px solid rgba(255,255,255,0.06); }
        .sidebar-overlay {
            position:fixed; inset:0; background:rgba(0,0,0,0.4);
            backdrop-filter:blur(4px); z-index:150; display:none;
        }
        .sidebar-overlay.open { display:block; }
        .mobile-menu-btn {
            display:none; position:fixed; top:12px; left:12px; z-index:300;
            width:42px; height:42px; background:var(--dark); color:var(--white);
            border:none; border-radius:var(--radius-sm); cursor:pointer;
            font-size:1.3rem; align-items:center; justify-content:center;
            box-shadow:0 4px 15px rgba(0,0,0,0.25);
        }
        .mobile-menu-btn:hover { background:var(--dark-2); }
        .main {
            flex:1; min-height:100vh; max-width:100%;
            margin-left:var(--sidebar-w);
            transition:margin-left 0.3s cubic-bezier(0.4,0,0.2,1);
        }
        .content { padding:2rem; flex:1; overflow-y:auto; }
        .page-header { margin-bottom:2rem; position:relative; padding-bottom:1rem; }
        .page-header::after {
            content:''; position:absolute; bottom:0; left:0; width:60px; height:3px;
            background:linear-gradient(90deg,var(--primary),var(--accent)); border-radius:2px;
        }
        .page-header h1 { font-size:1.6rem; font-weight:800; color:var(--dark); letter-spacing:-0.02em; }
        .page-header p { color:var(--gray); font-size:0.95rem; margin-top:0.35rem; }
        .dashboard-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1.5rem; margin-bottom:2rem; }
        .dashboard-grid.cols-2 { grid-template-columns:repeat(2,1fr); }
        .dashboard-grid.cols-4 { grid-template-columns:repeat(4,1fr); }
        .card {
            background:var(--white); border-radius:var(--radius-md);
            box-shadow:var(--shadow-sm); border:1px solid var(--gray-light);
            overflow:hidden; transition:var(--transition);
        }
        .card:hover { box-shadow:var(--shadow-md); }
        .card-header { padding:1.25rem 1.5rem 0; display:flex; align-items:center; justify-content:space-between; }
        .card-header h3 { font-size:1rem; font-weight:700; color:var(--dark); display:flex; align-items:center; gap:0.5rem; }
        .card-body { padding:1.5rem; }
        .card-body:first-child { padding-top:1.5rem; }
        .stat-card {
            background:var(--white); border-radius:var(--radius-md); padding:1.5rem;
            box-shadow:var(--shadow-sm); border:1px solid var(--gray-light);
            transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
            position:relative; overflow:hidden;
        }
        .stat-card::before {
            content:''; position:absolute; top:0; left:0; right:0; height:3px;
            border-radius:var(--radius-md) var(--radius-md) 0 0;
        }
        .stat-card:nth-child(1)::before { background:linear-gradient(90deg,#2e7d32,#66bb6a); }
        .stat-card:nth-child(2)::before { background:linear-gradient(90deg,#f9a825,#ffd54f); }
        .stat-card:nth-child(3)::before { background:linear-gradient(90deg,#1565c0,#42a5f5); }
        .stat-card:nth-child(4)::before { background:linear-gradient(90deg,#7b1fa2,#ab47bc); }
        .stat-card:hover { transform:translateY(-4px); box-shadow:0 12px 40px rgba(46,125,50,0.1); }
        .stat-card-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem; }
        .stat-card-icon { width:44px; height:44px; border-radius:var(--radius-sm); display:flex; align-items:center; justify-content:center; font-size:1.2rem; }
        .stat-card-icon.green { background:rgba(46,125,50,0.1); }
        .stat-card-icon.amber { background:rgba(255,179,0,0.1); }
        .stat-card-icon.blue { background:rgba(37,99,235,0.1); }
        .stat-card-icon.purple { background:rgba(147,51,234,0.1); }
        .stat-card-icon.red { background:rgba(239,68,68,0.1); }
        .stat-card-icon.teal { background:rgba(20,184,166,0.1); }
        .stat-card-change { font-size:0.75rem; font-weight:700; padding:0.2rem 0.5rem; border-radius:50px; }
        .stat-card-change.up { background:rgba(34,197,94,0.1); color:#16a34a; }
        .stat-card-change.down { background:rgba(239,68,68,0.1); color:#dc2626; }
        .stat-card h4 { font-size:1.8rem; font-weight:800; color:var(--dark); margin-bottom:0.25rem; }
        .stat-card p { font-size:0.85rem; color:var(--gray); }
        .section-card {
            background:var(--white); border-radius:var(--radius-md);
            border:1px solid var(--gray-light); overflow:hidden;
            transition:all 0.3s cubic-bezier(0.4,0,0.2,1);
            box-shadow:0 1px 3px rgba(0,0,0,0.04); position:relative;
        }
        .section-card:hover { box-shadow:0 8px 32px rgba(46,125,50,0.08); border-color:rgba(46,125,50,0.15); transform:translateY(-2px); }
        .section-card-header {
            padding:1.25rem 1.5rem; border-bottom:1px solid var(--gray-light);
            display:flex; align-items:center; justify-content:space-between;
            font-weight:700; font-size:0.95rem;
            background:linear-gradient(135deg,rgba(46,125,50,0.04),rgba(255,179,0,0.04));
        }
        .section-card-header h3 { font-size:1rem; font-weight:700; display:flex; align-items:center; gap:0.5rem; }
        .section-card-body { padding:1.5rem; }
        .info-row { display:flex; align-items:center; justify-content:space-between; padding:0.75rem 0; border-bottom:1px solid var(--gray-light); }
        .info-row:last-child { border-bottom:none; }
        .info-label { font-size:0.85rem; color:var(--gray); }
        .info-value { font-size:0.9rem; font-weight:600; color:var(--dark); }
        .connection-item { display:flex; align-items:center; gap:1rem; padding:0.75rem 0; border-bottom:1px solid var(--gray-light); }
        .connection-item:last-child { border-bottom:none; }
        .connection-avatar { width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg,var(--secondary),var(--primary)); color:var(--white); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.85rem; flex-shrink:0; }
        .connection-info { flex:1; }
        .connection-name { font-weight:600; font-size:0.9rem; }
        .connection-role { font-size:0.8rem; color:var(--gray); }
        .connection-status { font-size:0.75rem; padding:0.2rem 0.6rem; border-radius:50px; font-weight:600; }
        .connection-status.online { background:rgba(34,197,94,0.1); color:#16a34a; }
        .connection-status.offline { background:rgba(156,163,175,0.1); color:#6b7280; }
        .chain-item { display:flex; gap:1rem; padding-bottom:1.25rem; position:relative; }
        .chain-item:not(:last-child)::before { content:''; position:absolute; left:15px; top:32px; bottom:0; width:2px; background:var(--gray-light); }
        .chain-dot { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.8rem; flex-shrink:0; z-index:1; }
        .chain-dot.done { background:rgba(46,125,50,0.15); color:var(--primary); }
        .chain-dot.current { background:rgba(255,179,0,0.15); color:var(--accent-dark); }
        .chain-dot.pending { background:var(--gray-light); color:var(--gray); }
        .chain-content h4 { font-size:0.9rem; font-weight:600; margin-bottom:0.15rem; }
        .chain-content p { font-size:0.8rem; color:var(--gray); }
        .perf-metric { text-align:center; padding:1rem; }
        .perf-metric .value { font-size:2rem; font-weight:800; color:var(--primary); }
        .perf-metric .label { font-size:0.8rem; color:var(--gray); margin-top:0.25rem; }
        .perf-bar { height:8px; background:var(--gray-light); border-radius:50px; overflow:hidden; margin-top:0.5rem; }
        .perf-bar-fill { height:100%; border-radius:50px; transition:width 1s ease; }
        .linkage-item { display:flex; align-items:center; gap:1rem; padding:0.75rem 0; border-bottom:1px solid var(--gray-light); }
        .linkage-item:last-child { border-bottom:none; }
        .linkage-icon { width:40px; height:40px; border-radius:var(--radius-sm); display:flex; align-items:center; justify-content:center; font-size:1.1rem; }
        .linkage-info { flex:1; }
        .linkage-name { font-weight:600; font-size:0.9rem; }
        .linkage-desc { font-size:0.8rem; color:var(--gray); }
        .linkage-status { font-size:0.75rem; font-weight:600; padding:0.2rem 0.6rem; border-radius:50px; }
        .linkage-status.active { background:rgba(34,197,94,0.1); color:#16a34a; }
        .linkage-status.pending { background:rgba(255,179,0,0.1); color:var(--accent-dark); }
        .wallet-balance { text-align:center; padding:1.5rem 0; }
        .wallet-balance .amount { font-size:2.5rem; font-weight:900; color:var(--primary); }
        .wallet-balance .label { font-size:0.85rem; color:var(--gray); }
        .wallet-actions { display:flex; gap:0.75rem; justify-content:center; margin-top:1rem; }
        .wallet-actions .btn { padding:0.6rem 1.25rem; border-radius:50px; font-size:0.85rem; font-weight:600; border:none; cursor:pointer; font-family:inherit; transition:var(--transition); }
        .wallet-actions .btn-primary { background:linear-gradient(135deg,var(--primary),var(--secondary)); color:var(--white); }
        .wallet-actions .btn-primary:hover { box-shadow:0 4px 15px rgba(46,125,50,0.3); transform:translateY(-2px); }
        .wallet-actions .btn-outline { background:var(--white); color:var(--dark); border:1.5px solid var(--gray-light); }
        .wallet-actions .btn-outline:hover { border-color:var(--secondary); }
        .tx-item { display:flex; align-items:center; gap:0.75rem; padding:0.6rem 0; border-bottom:1px solid var(--gray-light); font-size:0.85rem; }
        .tx-item:last-child { border-bottom:none; }
        .tx-amount { margin-left:auto; font-weight:700; }
        .tx-amount.credit { color:#16a34a; }
        .tx-amount.debit { color:#dc2626; }
        .page-section { display:none; }
        .page-section.active { display:block; }
        .section-hidden { display:none !important; }
        .toast-container { position:fixed; top:1.5rem; right:1.5rem; z-index:9999; display:flex; flex-direction:column; gap:0.75rem; pointer-events:none; }
        .toast { pointer-events:auto; display:flex; align-items:center; gap:0.75rem; padding:1rem 1.25rem; border-radius:var(--radius-sm); background:var(--white); box-shadow:0 10px 40px rgba(0,0,0,0.15); min-width:320px; max-width:420px; animation:toastIn 0.4s cubic-bezier(0.4,0,0.2,1) forwards; border-left:4px solid; }
        .toast.removing { animation:toastOut 0.3s cubic-bezier(0.4,0,0.2,1) forwards; }
        @keyframes toastIn { from{opacity:0;transform:translateX(100%)scale(0.9)} to{opacity:1;transform:translateX(0)scale(1)} }
        @keyframes toastOut { from{opacity:1;transform:translateX(0)scale(1)} to{opacity:0;transform:translateX(100%)scale(0.9)} }
        .toast-icon { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.9rem; flex-shrink:0; }
        .toast-msg { flex:1; font-size:0.9rem; font-weight:500; color:var(--dark); }
        .toast-close { background:none; border:none; font-size:1.1rem; cursor:pointer; color:var(--gray); padding:0; line-height:1; transition:var(--transition); }
        .toast-close:hover { color:var(--dark); }
        .toast.error { border-left-color:#dc2626; }
        .toast.error .toast-icon { background:#fef2f2; color:#dc2626; }
        .toast.success { border-left-color:#16a34a; }
        .toast.success .toast-icon { background:#f0fdf4; color:#16a34a; }
        .toast.info { border-left-color:#2563eb; }
        .toast.info .toast-icon { background:#eff6ff; color:#2563eb; }
        .toast.warning { border-left-color:var(--accent-dark); }
        .toast.warning .toast-icon { background:#fffbeb; color:var(--accent-dark); }
        @media (max-width:480px) { .toast-container{top:1rem;right:1rem;left:1rem} .toast{min-width:auto;max-width:none} }
        @media (max-width:1024px) { .dashboard-grid{grid-template-columns:repeat(2,1fr)} .dashboard-grid.cols-4{grid-template-columns:repeat(2,1fr)} }
        @media (max-width:768px) { .sidebar{transform:translateX(-100%)} .sidebar.open{transform:translateX(0)} .mobile-menu-btn{display:flex} .main{margin-left:0} .dashboard-grid{grid-template-columns:1fr} .dashboard-grid.cols-2,.dashboard-grid.cols-4{grid-template-columns:1fr} .content{padding:1.25rem} }
        @media (max-width:480px) { .content{padding:1rem} }
        .entity-item { display:flex; align-items:center; gap:1rem; padding:0.85rem 1rem; border-bottom:1px solid var(--gray-light); border-radius:var(--radius-sm); margin-bottom:0.25rem; transition:all 0.2s ease; }
        .entity-item:hover { background:linear-gradient(135deg,rgba(46,125,50,0.03),rgba(255,179,0,0.03)); }
        .entity-item:last-child { border-bottom:none; margin-bottom:0; }
        .entity-avatar { width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg,var(--secondary),var(--primary)); color:var(--white); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.9rem; flex-shrink:0; box-shadow:0 2px 8px rgba(46,125,50,0.15); }
        .entity-info { flex:1; min-width:0; }
        .entity-name { font-weight:600; font-size:0.9rem; color:var(--dark); }
        .entity-detail { font-size:0.8rem; color:var(--gray); margin-top:0.1rem; }
        .btn-xs { padding:0.35rem 0.75rem; border-radius:50px; font-size:0.75rem; font-weight:600; border:none; cursor:pointer; font-family:inherit; transition:var(--transition); flex-shrink:0; }
        .btn-xs.green { background:rgba(46,125,50,0.12); color:var(--primary); }
        .btn-xs.green:hover { background:var(--primary); color:var(--white); }
        .btn-xs.amber { background:rgba(255,179,0,0.15); color:var(--accent-dark); }
        .btn-xs.amber:hover { background:var(--accent-dark); color:var(--white); }
        .btn-xs.red { background:rgba(239,68,68,0.1); color:#dc2626; }
        .btn-xs.red:hover { background:#dc2626; color:var(--white); }
        .btn-xs.gray { background:var(--gray-light); color:var(--gray); }
        .btn-xs.gray:hover { background:var(--gray); color:var(--white); }
        .status-badge { font-size:0.7rem; font-weight:700; padding:0.2rem 0.6rem; border-radius:50px; text-transform:capitalize; }
        .status-badge.pending { background:rgba(255,179,0,0.12); color:var(--accent-dark); }
        .status-badge.active { background:rgba(46,125,50,0.12); color:var(--primary); }
        .status-badge.rejected,.status-badge.cancelled { background:rgba(239,68,68,0.1); color:#dc2626; }
        .status-badge.delivered { background:rgba(34,197,94,0.1); color:#16a34a; }
        .status-badge.shipped { background:rgba(37,99,235,0.1); color:#2563eb; }
        .status-badge.confirmed { background:rgba(147,51,234,0.1); color:#7c3aed; }
        .entity-empty { text-align:center; padding:1.5rem; color:var(--gray); font-size:0.9rem; }
        .btn-loading { position:relative; pointer-events:none; opacity:0.8; }
        .btn-loading .btn-text { visibility:hidden; }
        .btn-loading::after { content:''; position:absolute; top:50%; left:50%; width:18px; height:18px; margin:-9px 0 0 -9px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin 0.6s linear infinite; }
        .btn-loading.btn-outline-s::after { border-color:rgba(0,0,0,0.1); border-top-color:var(--dark); }
        @keyframes spin { to{transform:rotate(360deg)} }
        .spinner { display:inline-block; width:16px; height:16px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin 0.6s linear infinite; vertical-align:middle; margin-right:6px; }
        .img-preview-wrap { display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.5rem; }
        .img-preview-wrap img { width:64px; height:64px; object-fit:cover; border-radius:var(--radius-sm); border:1px solid var(--gray-light); }
        .file-input-wrapper { position:relative; }
        .file-input-wrapper input[type="file"] { width:100%; padding:0.6rem 0.8rem; border:1.5px dashed var(--gray-light); border-radius:var(--radius-sm); font-family:inherit; font-size:0.85rem; cursor:pointer; background:var(--light); transition:var(--transition); }
        .file-input-wrapper input[type="file"]:hover { border-color:var(--secondary); background:rgba(46,125,50,0.03); }
    </style>
</head>
<body>

    <!-- Sidebar Overlay -->
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

    <!-- Sidebar -->
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
            <div class="sidebar-brand-icon">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 6c-3.3 0-6 2.7-6 6h12c0-3.3-2.7-6-6-6z"/><path d="M4 14c0 2 1.5 3 4 4l1 2M20 14c0 2-1.5 3-4 4l-1 2"/><path d="M8 18h8"/></svg>
            </div>
            <span>AgriConnect</span>
        </div>
        <nav class="sidebar-nav">
            <div class="sidebar-nav-label">Main</div>
            <button class="sidebar-link active" data-section="dashboard">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                Dashboard
            </button>
            <button class="sidebar-link" data-section="account">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                My Account
            </button>
            <button class="sidebar-link" data-section="wallet">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
                My Wallet
            </button>
            <button class="sidebar-link" data-section="connections">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Connections
                <span class="badge">12</span>
            </button>

            <div class="sidebar-nav-label">Marketplace</div>
            <button class="sidebar-link" data-section="products">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                Products
            </button>
            <button class="sidebar-link" data-section="agreements">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                Agreements
            </button>
            <button class="sidebar-link" data-section="forum">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Forum
            </button>

            <div class="sidebar-nav-label">Growth</div>
            <button class="sidebar-link" data-section="performance">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
                Performance
            </button>
            <button class="sidebar-link" data-section="linkages">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                Linkages
            </button>
            <button class="sidebar-link" data-section="chain">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 14 15 20 9"/><polyline points="14 9 20 9 20 15"/></svg>
                Chain
            </button>
        </nav>
        <div class="sidebar-footer">
            <button class="sidebar-link" id="logoutBtn">
                <svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Logout
            </button>
        </div>
    </aside>

    <!-- Mobile Menu Button -->
    <button class="mobile-menu-btn" id="mobileMenuToggle" aria-label="Toggle menu">☰</button>

    <!-- Main -->
    <div class="main">
        <div class="content">

            <!-- ==================== DASHBOARD ==================== -->
            <div class="page-section active" id="section-dashboard">
                <div class="page-header">
                    <h1>Dashboard</h1>
                    <p>Welcome back! Here's your organisation overview.</p>
                </div>
                <div class="dashboard-grid cols-4" style="margin-bottom:1.5rem">
                    <div class="stat-card">
                        <div class="stat-card-top">
                            <div class="stat-card-icon green">💰</div>
                            <span class="stat-card-change up">+12%</span>
                        </div>
                        <h4>$0.00</h4>
                        <p>Total Spend</p>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-top">
                            <div class="stat-card-icon amber">📦</div>
                            <span class="stat-card-change up">+3</span>
                        </div>
                        <h4>0</h4>
                        <p>Active Orders</p>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-top">
                            <div class="stat-card-icon blue">🔗</div>
                            <span class="stat-card-change up">+5</span>
                        </div>
                        <h4>0</h4>
                        <p>Connections</p>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-top">
                            <div class="stat-card-icon purple">⭐</div>
                            <span class="stat-card-change up">0.0</span>
                        </div>
                        <h4>5.0</h4>
                        <p>Rating</p>
                    </div>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header">
                            <h3>⚡ Recent Activity</h3>
                            <span style="font-size:0.8rem;color:var(--gray)">Today</span>
                        </div>
                        <div class="section-card-body">
                            <div class="info-row"><span class="info-label">Account created</span><span class="info-value">Just now</span></div>
                            <div class="info-row"><span class="info-label">Profile updated</span><span class="info-value">--</span></div>
                            <div class="info-row"><span class="info-label">First order</span><span class="info-value">--</span></div>
                            <div class="info-row" style="border:none;padding-bottom:0"><span class="info-label">Wallet funded</span><span class="info-value">--</span></div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>📋 Quick Actions</h3></div>
                        <div class="section-card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem">
                            <div style="padding:0.75rem;background:var(--light);border-radius:var(--radius-sm);text-align:center;cursor:pointer;transition:var(--transition)" onclick="switchSection('account')"><div style="font-size:1.3rem;margin-bottom:0.25rem">👤</div><div style="font-size:0.8rem;font-weight:600">My Account</div></div>
                            <div style="padding:0.75rem;background:var(--light);border-radius:var(--radius-sm);text-align:center;cursor:pointer;transition:var(--transition)" onclick="switchSection('wallet')"><div style="font-size:1.3rem;margin-bottom:0.25rem">💰</div><div style="font-size:0.8rem;font-weight:600">Wallet</div></div>
                            <div style="padding:0.75rem;background:var(--light);border-radius:var(--radius-sm);text-align:center;cursor:pointer;transition:var(--transition)" onclick="switchSection('connections')"><div style="font-size:1.3rem;margin-bottom:0.25rem">🔗</div><div style="font-size:0.8rem;font-weight:600">Connections</div></div>
                            <div style="padding:0.75rem;background:var(--light);border-radius:var(--radius-sm);text-align:center;cursor:pointer;transition:var(--transition)" onclick="switchSection('performance')"><div style="font-size:1.3rem;margin-bottom:0.25rem">📈</div><div style="font-size:0.8rem;font-weight:600">Performance</div></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== MY ACCOUNT ==================== -->
            <div class="page-section" id="section-account">
                <div class="page-header">
                    <h1>My Account</h1>
                    <p>Manage your organisation profile and preferences.</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header"><h3>👤 Profile Details</h3></div>
                        <div class="section-card-body">
                            <div class="info-row"><span class="info-label">Full Name</span><span class="info-value" id="acctName">--</span></div>
                            <div class="info-row"><span class="info-label">Email</span><span class="info-value" id="acctEmail">--</span></div>
                            <div class="info-row"><span class="info-label">Account Type</span><span class="info-value" id="acctRole">Organisation</span></div>
                            <div class="info-row" id="profileFields">
                                <div style="width:100%">
                                    <div style="font-size:0.85rem;font-weight:700;margin-bottom:0.75rem;color:var(--dark)">📋 Organisation Profile</div>
                                    <div id="profileForm"></div>
                                </div>
                            </div>
                            <div class="info-row"><span class="info-label">Member Since</span><span class="info-value">Today</span></div>
                            <div class="info-row" style="border:none;padding-bottom:0"><span class="info-label">Verification</span><span class="info-value" style="color:#16a34a">✓ Verified</span></div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>⚙️ Account Settings</h3></div>
                        <div class="section-card-body">
                            <div class="info-row"><span class="info-label">Notifications</span><span class="info-value" style="color:var(--secondary)">Email & Push</span></div>
                            <div class="info-row"><span class="info-label">Language</span><span class="info-value">English</span></div>
                            <div class="info-row"><span class="info-label">Timezone</span><span class="info-value">UTC</span></div>
                            <div class="info-row" style="border:none;padding-bottom:0"><span class="info-label">Two-Factor Auth</span><span class="info-value" style="color:var(--gray)">Disabled</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== MY WALLET ==================== -->
            <div class="page-section" id="section-wallet">
                <div class="page-header">
                    <h1>My Wallet</h1>
                    <p>Track your deposits, withdrawals, and transaction history.</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-body">
                            <div class="wallet-balance">
                                <div class="amount" id="walletBalance">Loading...</div>
                                <div class="label">Available Balance</div>
                                <div class="wallet-actions">
                                    <button class="btn btn-primary" onclick="openDepositModal()">Deposit</button>
                                    <button class="btn btn-outline" onclick="openWithdrawModal()">Withdraw</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>Wallet Summary</h3></div>
                        <div class="section-card-body">
                            <div class="info-row"><span class="info-label">Total Deposited</span><span class="info-value" id="walletTotalDeposited">Loading...</span></div>
                            <div class="info-row"><span class="info-label">Pending Withdrawal</span><span class="info-value" id="walletPending">Loading...</span></div>
                            <div class="info-row"><span class="info-label">Total Withdrawn</span><span class="info-value" id="walletWithdrawn">Loading...</span></div>
                            <div class="info-row" style="border:none;padding-bottom:0"><span class="info-label">Commission Rate</span><span class="info-value">5%</span></div>
                        </div>
                    </div>
                </div>
                <div class="section-card" style="margin-top:1.5rem">
                    <div class="section-card-header"><h3>Recent Transactions</h3></div>
                    <div class="section-card-body" id="walletTransactions"><div style="text-align:center;padding:24px;color:var(--gray)">Loading transactions...</div></div>
                </div>
            </div>

            <!-- Deposit Modal -->
            <div class="modal-overlay" id="depositModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center" onclick="if(event.target===this)closeDepositModal()">
                <div style="background:#fff;border-radius:16px;padding:32px;width:90%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,0.15)">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
                        <h2 style="margin:0;font-size:20px;color:#1a1a2e">Fund Your Wallet</h2>
                        <button onclick="closeDepositModal()" style="background:none;border:none;font-size:24px;cursor:pointer;color:#999;padding:0;line-height:1">&times;</button>
                    </div>
                    <p style="margin:0 0 20px;font-size:14px;color:#666">Enter the amount you'd like to deposit via Paystack.</p>
                    <div style="margin-bottom:20px">
                        <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px">Amount (GHS)</label>
                        <input type="number" id="depositAmount" min="1" step="0.01" placeholder="e.g. 100" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box;outline:none" oninput="document.getElementById('depositBtn').textContent='Deposit ₵' + (parseFloat(this.value)||0).toFixed(2)">
                    </div>
                    <button id="depositBtn" onclick="processDeposit()" class="btn btn-primary" style="width:100%;padding:14px;font-size:16px;border:none;cursor:pointer">Deposit</button>
                    <p style="margin:12px 0 0;font-size:12px;color:#8899aa;text-align:center">Secured by Paystack &bull; Funds credited instantly</p>
                </div>
            </div>

            <!-- Withdraw Modal -->
            <div class="modal-overlay" id="withdrawModal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center" onclick="if(event.target===this)closeWithdrawModal()">
                <div style="background:#fff;border-radius:16px;padding:32px;width:90%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,0.15)">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
                        <h2 style="margin:0;font-size:20px;color:#1a1a2e">Withdraw Funds</h2>
                        <button onclick="closeWithdrawModal()" style="background:none;border:none;font-size:24px;cursor:pointer;color:#999;padding:0;line-height:1">&times;</button>
                    </div>
                    <p style="margin:0 0 20px;font-size:14px;color:#666">Withdraw to your bank account. Minimum ₵10 (1% fee applies).</p>
                    <div style="margin-bottom:16px">
                        <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px">Bank</label>
                        <select id="withdrawBank" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;outline:none;background:#fff"><option value="">Select bank...</option></select>
                    </div>
                    <div style="margin-bottom:16px">
                        <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px">Account Number</label>
                        <input type="text" id="withdrawAccountNumber" maxlength="10" placeholder="e.g. 0123456789" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;outline:none">
                    </div>
                    <div style="margin-bottom:16px">
                        <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px">Account Name</label>
                        <input type="text" id="withdrawAccountName" placeholder="Full name on account" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;outline:none">
                    </div>
                    <div style="margin-bottom:20px">
                        <label style="display:block;font-size:13px;font-weight:600;color:#444;margin-bottom:6px">Amount (GHS)</label>
                        <input type="number" id="withdrawAmount" min="10" step="0.01" placeholder="e.g. 50" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box;outline:none">
                    </div>
                    <button onclick="processWithdraw()" class="btn btn-primary" style="width:100%;padding:14px;font-size:16px;border:none;cursor:pointer">Withdraw</button>
                </div>
            </div>

            <!-- ==================== CONNECTIONS ==================== -->
            <div class="page-section" id="section-connections">
                <div class="page-header">
                    <h1>My Connections</h1>
                    <p>Your network of farmers, buyers, suppliers, and partners.</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header"><h3>🔗 Active Connections</h3><span style="font-size:0.8rem;color:var(--gray)">0 total</span></div>
                        <div class="section-card-body">
                            <div class="connection-item">
                                <div class="connection-avatar">🌱</div>
                                <div class="connection-info"><div class="connection-name">No connections yet</div><div class="connection-role">Start building your network</div></div>
                                <span class="connection-status offline">--</span>
                            </div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>🤝 Pending Requests</h3><span style="font-size:0.8rem;color:var(--gray)">0 pending</span></div>
                        <div class="section-card-body"><div style="text-align:center;padding:1rem;color:var(--gray);font-size:0.9rem">No pending connection requests.</div></div>
                    </div>
                </div>
                <div class="section-card" style="margin-top:1.5rem">
                    <div class="section-card-header"><h3>👥 Find New Connections</h3></div>
                    <div class="section-card-body">
                        <div style="display:flex;gap:0.75rem;flex-wrap:wrap">
                            <span style="padding:0.4rem 0.8rem;background:var(--light);border-radius:50px;font-size:0.85rem;font-weight:500;cursor:pointer;transition:var(--transition)" onclick="showToast('Filter coming soon', 'info')">🌾 Farmers</span>
                            <span style="padding:0.4rem 0.8rem;background:var(--light);border-radius:50px;font-size:0.85rem;font-weight:500;cursor:pointer;transition:var(--transition)" onclick="showToast('Filter coming soon', 'info')">🏭 Industries</span>
                            <span style="padding:0.4rem 0.8rem;background:var(--light);border-radius:50px;font-size:0.85rem;font-weight:500;cursor:pointer;transition:var(--transition)" onclick="showToast('Filter coming soon', 'info')">🧪 Agro-Vets</span>
                            <span style="padding:0.4rem 0.8rem;background:var(--light);border-radius:50px;font-size:0.85rem;font-weight:500;cursor:pointer;transition:var(--transition)" onclick="showToast('Filter coming soon', 'info')">🛒 Consumers</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== PRODUCTS ==================== -->
            <div class="page-section" id="section-products">
                <div class="page-header">
                    <h1>🛒 Farmer Products</h1>
                    <p>Browse fresh produce from farmers, place orders, and track deliveries.</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header"><h3>🌾 Available Products</h3><span style="font-size:0.8rem;color:var(--gray)" id="productCount">0 available</span></div>
                        <div class="section-card-body" id="productListContainer"><div class="entity-empty">Loading products...</div></div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>📦 My Orders</h3><span style="font-size:0.8rem;color:var(--gray)" id="orderCount">0</span></div>
                        <div class="section-card-body" id="orderListContainer"><div class="entity-empty">Loading orders...</div></div>
                    </div>
                </div>
                <div class="section-card" style="margin-top:1.5rem">
                    <div class="section-card-header"><h3>ℹ️ How Ordering Works</h3></div>
                    <div class="section-card-body">
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem">
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm);text-align:center"><div style="font-size:1.5rem;margin-bottom:0.25rem">🛒</div><div style="font-weight:700;font-size:0.85rem">Browse Products</div><div style="font-size:0.75rem;color:var(--gray)">Find fresh products listed by farmers</div></div>
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm);text-align:center"><div style="font-size:1.5rem;margin-bottom:0.25rem">📝</div><div style="font-weight:700;font-size:0.85rem">Place Order</div><div style="font-size:0.75rem;color:var(--gray)">Enter quantity and submit your order</div></div>
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm);text-align:center"><div style="font-size:1.5rem;margin-bottom:0.25rem">🚚</div><div style="font-weight:700;font-size:0.85rem">Track Delivery</div><div style="font-size:0.75rem;color:var(--gray)">Monitor order status from farm to your door</div></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== AGREEMENTS ==================== -->
            <div class="page-section" id="section-agreements">
                <div class="page-header">
                    <h1>📜 Agreements</h1>
                    <p>Manage your partnership agreements with farmers.</p>
                </div>
                <div class="section-card">
                    <div class="section-card-header"><h3>🤝 All Agreements</h3><span style="font-size:0.8rem;color:var(--gray)" id="agrCount">0</span></div>
                    <div class="section-card-body" id="agrListContainer"><div class="entity-empty">Loading agreements...</div></div>
                </div>
            </div>

            <!-- ==================== FORUM ==================== -->
            <div class="page-section" id="section-forum">
                <div class="page-header">
                    <h1>📢 Forum</h1>
                    <p id="forumSubtitle">Post what products you need and receive replies from farmers</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card" id="orgRequestPanel">
                        <div class="section-card-header"><h3>📝 Post a Request</h3></div>
                        <div class="section-card-body">
                            <form id="requestForm">
                                <div class="form-group" style="margin-bottom:0.75rem">
                                    <label style="display:block;margin-bottom:0.3rem;font-weight:600;font-size:0.85rem">What do you need?</label>
                                    <input type="text" id="reqTitle" required placeholder="e.g. 500 kg of organic tomatoes" style="width:100%;padding:0.7rem 0.8rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem">
                                </div>
                                <div class="form-group" style="margin-bottom:0.75rem">
                                    <label style="display:block;margin-bottom:0.3rem;font-weight:600;font-size:0.85rem">Description</label>
                                    <textarea id="reqDesc" required placeholder="Describe what you're looking for — quality standards, quantity, delivery expectations..." style="width:100%;padding:0.7rem 0.8rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem;min-height:80px;resize:vertical"></textarea>
                                </div>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:0.75rem">
                                    <div>
                                        <label style="display:block;margin-bottom:0.3rem;font-weight:600;font-size:0.85rem">Quantity Needed</label>
                                        <input type="text" id="reqQty" placeholder="e.g. 500 kg weekly" style="width:100%;padding:0.7rem 0.8rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem">
                                    </div>
                                    <div>
                                        <label style="display:block;margin-bottom:0.3rem;font-weight:600;font-size:0.85rem">Location</label>
                                        <input type="text" id="reqLocation" placeholder="Delivery location" style="width:100%;padding:0.7rem 0.8rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.9rem">
                                    </div>
                                </div>
                                <button type="submit" style="padding:0.7rem 1.5rem;background:linear-gradient(135deg,var(--primary),var(--secondary));color:var(--white);border:none;border-radius:var(--radius-sm);font-size:0.9rem;font-weight:600;cursor:pointer;font-family:inherit">📢 Post Request</button>
                            </form>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>📋 Open Requests</h3><span style="font-size:0.8rem;color:var(--gray)" id="requestCount">0</span></div>
                        <div class="section-card-body" id="requestListContainer"><div class="entity-empty">Loading requests...</div></div>
                    </div>
                </div>
            </div>

            <!-- ==================== PERFORMANCE ==================== -->
            <div class="page-section" id="section-performance">
                <div class="page-header">
                    <h1>Performance</h1>
                    <p>Track your metrics, growth, and platform activity.</p>
                </div>
                <div class="dashboard-grid cols-4" style="margin-bottom:1.5rem">
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon green">📈</div></div><h4>0</h4><p>Total Spend</p></div>
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon amber">👁️</div></div><h4>0</h4><p>Profile Views</p></div>
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon blue">📋</div></div><h4>0</h4><p>Orders Placed</p></div>
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon purple">💬</div></div><h4>0</h4><p>Inquiries</p></div>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header"><h3>📊 Performance Metrics</h3></div>
                        <div class="section-card-body">
                            <div style="margin-bottom:1rem">
                                <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.25rem"><span>Profile Completion</span><span style="font-weight:700">30%</span></div>
                                <div class="perf-bar"><div class="perf-bar-fill" style="width:30%;background:linear-gradient(90deg,var(--secondary),var(--primary))"></div></div>
                            </div>
                            <div style="margin-bottom:1rem">
                                <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.25rem"><span>Engagement Score</span><span style="font-weight:700">0%</span></div>
                                <div class="perf-bar"><div class="perf-bar-fill" style="width:0%;background:linear-gradient(90deg,var(--accent),var(--accent-dark))"></div></div>
                            </div>
                            <div>
                                <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.25rem"><span>Trust Score</span><span style="font-weight:700">100%</span></div>
                                <div class="perf-bar"><div class="perf-bar-fill" style="width:100%;background:linear-gradient(90deg,#16a34a,#22c55e)"></div></div>
                            </div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>🏆 Achievements</h3></div>
                        <div class="section-card-body">
                            <div class="info-row"><span class="info-label">🎉 First Login</span><span class="info-value" style="color:#16a34a">Unlocked</span></div>
                            <div class="info-row"><span class="info-label">📝 First Order</span><span class="info-value" style="color:var(--gray)">Locked</span></div>
                            <div class="info-row"><span class="info-label">💰 First Agreement</span><span class="info-value" style="color:var(--gray)">Locked</span></div>
                            <div class="info-row" style="border:none;padding-bottom:0"><span class="info-label">🤝 First Connection</span><span class="info-value" style="color:var(--gray)">Locked</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== LINKAGES ==================== -->
            <div class="page-section" id="section-linkages">
                <div class="page-header">
                    <h1>Linkages</h1>
                    <p>Partnerships, collaborations, and supply chain links.</p>
                </div>
                <div class="dashboard-grid cols-2">
                    <div class="section-card">
                        <div class="section-card-header"><h3>🤝 Active Partnerships</h3><span style="font-size:0.8rem;color:var(--gray)">0 active</span></div>
                        <div class="section-card-body">
                            <div class="linkage-item">
                                <div class="linkage-icon" style="background:rgba(46,125,50,0.1)">🌾</div>
                                <div class="linkage-info"><div class="linkage-name">No partnerships yet</div><div class="linkage-desc">Link with farmers, suppliers, or buyers</div></div>
                            </div>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-card-header"><h3>📋 Pending Linkages</h3><span style="font-size:0.8rem;color:var(--gray)">0 pending</span></div>
                        <div class="section-card-body"><div style="text-align:center;padding:1rem;color:var(--gray);font-size:0.9rem">No pending linkage requests.</div></div>
                    </div>
                </div>
                <div class="section-card" style="margin-top:1.5rem">
                    <div class="section-card-header"><h3>🔗 Available Linkage Types</h3></div>
                    <div class="section-card-body">
                        <div class="dashboard-grid cols-2" style="margin-bottom:0">
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm)"><div style="font-weight:700;margin-bottom:0.25rem">🌾 Farmer → Consumer</div><div style="font-size:0.8rem;color:var(--gray)">Direct farm-to-table sales</div></div>
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm)"><div style="font-weight:700;margin-bottom:0.25rem">🏭 Industry → Farmer</div><div style="font-size:0.8rem;color:var(--gray)">Bulk raw material sourcing</div></div>
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm)"><div style="font-weight:700;margin-bottom:0.25rem">🧪 Agro-Vet → Farmer</div><div style="font-size:0.8rem;color:var(--gray)">Input supply partnership</div></div>
                            <div style="padding:1rem;background:var(--light);border-radius:var(--radius-sm)"><div style="font-weight:700;margin-bottom:0.25rem">🚚 Logistics Partner</div><div style="font-size:0.8rem;color:var(--gray)">Delivery and fulfillment</div></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ==================== CHAIN ==================== -->
            <div class="page-section" id="section-chain">
                <div class="page-header">
                    <h1>Chain</h1>
                    <p>End-to-end supply chain tracking from farm to consumer.</p>
                </div>
                <div class="dashboard-grid cols-2" style="margin-bottom:1.5rem">
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon green">⛓️</div></div><h4>0</h4><p>Active Chains</p></div>
                    <div class="stat-card"><div class="stat-card-top"><div class="stat-card-icon amber">✅</div></div><h4>0</h4><p>Completed</p></div>
                </div>
                <div class="section-card">
                    <div class="section-card-header"><h3>📋 Supply Chain Timeline</h3><span style="font-size:0.8rem;color:var(--gray)">No active chains</span></div>
                    <div class="section-card-body">
                        <div class="chain-item"><div class="chain-dot done">🌱</div><div class="chain-content"><h4>Farm Production</h4><p>Crops grown and harvested by farmers</p></div></div>
                        <div class="chain-item"><div class="chain-dot pending">📦</div><div class="chain-content"><h4>Processing & Packaging</h4><p>Goods prepared for distribution</p></div></div>
                        <div class="chain-item"><div class="chain-dot pending">🚚</div><div class="chain-content"><h4>Logistics & Transport</h4><p>Shipped to buyers or markets</p></div></div>
                        <div class="chain-item" style="padding-bottom:0"><div class="chain-dot pending">🛒</div><div class="chain-content"><h4>Delivery to Consumer</h4><p>Final mile delivery completed</p></div></div>
                    </div>
                </div>
                <div class="section-card" style="margin-top:1.5rem">
                    <div class="section-card-header"><h3>🔍 Chain Insights</h3></div>
                    <div class="section-card-body">
                        <div style="text-align:center;padding:1.5rem;color:var(--gray)"><div style="font-size:2rem;margin-bottom:0.5rem">📊</div><p style="font-size:0.9rem">No supply chain data yet. Start by creating listings and making connections.</p></div>
                    </div>
                </div>
            </div>

        </div>
    </div>

    <script>
        function showToast(message, type) {
            type = type || 'info';
            let container = document.getElementById('toastContainer');
            if (!container) {
                container = document.createElement('div');
                container.className = 'toast-container';
                container.id = 'toastContainer';
                document.body.appendChild(container);
            }
            const icons = { error: '✕', success: '✓', info: 'ℹ', warning: '⚠' };
            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.innerHTML =
                '<div class="toast-icon">' + (icons[type] || 'ℹ') + '</div>' +
                '<div class="toast-msg">' + message + '</div>' +
                '<button class="toast-close" onclick="this.parentElement.classList.add(\'removing\');setTimeout(()=>this.parentElement.remove(),300)">×</button>';
            container.appendChild(toast);
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.classList.add('removing');
                    setTimeout(() => toast.remove(), 300);
                }
            }, 4000);
        }

        const user = sessionStorage.getItem('user');
        const idToken = sessionStorage.getItem('idToken');
        if (!user || !idToken) {
            window.location.href = 'login';
        }
        let userData = {};
        try {
            userData = JSON.parse(user);
        } catch (e) {}
        const displayName = userData.displayName || 'User';
        const email = userData.email || '';

        document.getElementById('acctName').textContent = displayName;
        document.getElementById('acctEmail').textContent = email;

        const sidebarLinks = document.querySelectorAll('.sidebar-link[data-section]');
        const sections = document.querySelectorAll('.page-section');

        function switchSection(sectionId) {
            sections.forEach(s => s.classList.remove('active'));
            const target = document.getElementById('section-' + sectionId);
            if (target) target.classList.add('active');
            sidebarLinks.forEach(l => l.classList.remove('active'));
            const link = document.querySelector('.sidebar-link[data-section="' + sectionId + '"]');
            if (link) link.classList.add('active');
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarOverlay').classList.remove('open');
            if (sectionId === 'wallet') loadWallet();
        }

        sidebarLinks.forEach(link => {
            link.addEventListener('click', () => {
                const section = link.dataset.section;
                switchSection(section);
            });
        });

        window.closeSidebar = function() {
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarOverlay').classList.remove('open');
        };

        document.getElementById('mobileMenuToggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
            document.getElementById('sidebarOverlay').classList.toggle('open');
        });

        async function api(path, options) {
            const res = await fetch(path, {
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                ...options,
            });
            const data = await res.json();
            if (!res.ok) { showToast(data.error || 'Request failed', 'error'); throw new Error(data.error); }
            return data;
        }

        window.logout = function() {
            sessionStorage.removeItem('user');
            sessionStorage.removeItem('idToken');
            window.location.href = 'login';
        };
        document.getElementById('logoutBtn').addEventListener('click', window.logout);

        async function loadProducts() {
            const container = document.getElementById('productListContainer');
            try {
                const list = await api('/api/listings');
                document.getElementById('productCount').textContent = list.length + ' available';
                if (!list.length) {
                    container.innerHTML = '<div class="entity-empty">No products listed by farmers yet.</div>';
                    return;
                }
                container.innerHTML = list.map(l => {
                    return '<div class="entity-item">' +
                        '<div class="entity-avatar">🌾</div>' +
                        '<div class="entity-info">' +
                            '<div class="entity-name">' + (l.title || 'Untitled') + '</div>' +
                            '<div class="entity-detail">$' + (l.price || 0).toFixed(2) + ' — ' + (l.category || 'General') + '</div>' +
                        '</div>' +
                        '<button class="btn-xs green" onclick="placeOrder(\'' + l.id + '\',\'' + l.uid + '\',\'' + (l.title || '') + '\', this)">🛒 Order</button>' +
                    '</div>';
                }).join('');
            } catch (e) { container.innerHTML = '<div class="entity-empty">Failed to load products.</div>'; }
        }

        window.placeOrder = async function(listingId, farmerUid, title, btn) {
            const qty = prompt('Enter quantity for "' + title + '":', '1');
            if (!qty || isNaN(qty) || parseInt(qty) < 1) { showToast('Invalid quantity', 'error'); return; }
            if (btn) setLoading(btn, true);
            try {
                await api('/api/orders', { method: 'POST', body: JSON.stringify({ listingId, farmerUid, quantity: parseInt(qty), totalPrice: 0 }) });
                showToast('Order placed!', 'success');
                loadOrders();
            } catch (e) {} finally { if (btn) setLoading(btn, false); }
        };

        async function loadOrders() {
            const container = document.getElementById('orderListContainer');
            try {
                const list = await api('/api/orders');
                document.getElementById('orderCount').textContent = list.length;
                if (!list.length) {
                    container.innerHTML = '<div class="entity-empty">No orders yet. Browse products above to place one.</div>';
                    return;
                }
                container.innerHTML = list.map(o => {
                    let actions = '';
                    if (o.status === 'pending') {
                        actions += '<button class="btn-xs green" onclick="updateOrder(\'' + o.id + '\',\'confirmed\', this)">Confirm</button> ';
                        actions += '<button class="btn-xs red" onclick="updateOrder(\'' + o.id + '\',\'cancelled\', this)">Cancel</button>';
                    } else if (o.status === 'confirmed') {
                        actions += '<button class="btn-xs amber" onclick="updateOrder(\'' + o.id + '\',\'shipped\', this)">Mark Shipped</button>';
                    } else if (o.status === 'shipped') {
                        actions += '<button class="btn-xs green" onclick="updateOrder(\'' + o.id + '\',\'delivered\', this)">Mark Delivered</button>';
                    }
                    return '<div class="entity-item">' +
                        '<div class="entity-avatar">📦</div>' +
                        '<div class="entity-info">' +
                            '<div class="entity-name">Order #' + o.id.slice(-6) + '</div>' +
                            '<div class="entity-detail">Qty: ' + o.quantity + ' • ' + (o.totalPrice ? '$' + parseFloat(o.totalPrice).toFixed(2) : '') + '</div>' +
                        '</div>' +
                        '<span class="status-badge ' + o.status + '">' + o.status + '</span>' +
                        actions +
                    '</div>';
                }).join('');
            } catch (e) { container.innerHTML = '<div class="entity-empty">Failed to load orders.</div>'; }
        }

        window.updateOrder = async function(id, status, btn) {
            if (btn) setLoading(btn, true);
            try {
                const result = await api('/api/orders/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
                showToast(result.message, 'success');
                loadOrders();
            } catch (e) {} finally { if (btn) setLoading(btn, false); }
        };

        async function loadAllAgreements() {
            const container = document.getElementById('agrListContainer');
            try {
                const list = await api('/api/agreements');
                document.getElementById('agrCount').textContent = list.length;
                if (!list.length) {
                    container.innerHTML = '<div class="entity-empty">No agreements yet.</div>';
                    return;
                }
                container.innerHTML = list.map(a => {
                    let actions = '';
                    if (a.status === 'pending') {
                        actions += '<button class="btn-xs green" onclick="updateAgreement(\'' + a.id + '\',\'active\', this)">Accept</button> ';
                        actions += '<button class="btn-xs red" onclick="updateAgreement(\'' + a.id + '\',\'rejected\', this)">Reject</button>';
                    } else if (a.status === 'active') {
                        actions += '<button class="btn-xs red" onclick="updateAgreement(\'' + a.id + '\',\'cancelled\', this)">Terminate</button>';
                    }
                    return '<div class="entity-item">' +
                        '<div class="entity-avatar">🤝</div>' +
                        '<div class="entity-info">' +
                            '<div class="entity-name">' + (a.terms || 'Agreement') + '</div>' +
                            '<div class="entity-detail">Farmer ' + (a.farmerUid || '').slice(0,8) + '...</div>' +
                        '</div>' +
                        '<span class="status-badge ' + a.status + '">' + a.status + '</span>' +
                        actions +
                    '</div>';
                }).join('');
            } catch (e) { container.innerHTML = '<div class="entity-empty">Failed to load agreements.</div>'; }
        }

        window.updateAgreement = async function(id, status, btn) {
            if (btn) setLoading(btn, true);
            try {
                const result = await api('/api/agreements/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
                showToast(result.message, 'success');
                if (document.getElementById('agrListContainer')) loadAllAgreements();
            } catch (e) {} finally { if (btn) setLoading(btn, false); }
        };

        function initProfileForm() {
            const container = document.getElementById('profileForm');
            document.getElementById('profileFields').style.display = 'block';
            let html = '';
            html += '<div style="margin-bottom:0.5rem"><input id="pfBusinessName" placeholder="Organisation Name" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;margin-bottom:0.4rem"></div>';
            html += '<div style="margin-bottom:0.5rem"><input id="pfCategory" placeholder="Category (e.g. Food Processing)" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;margin-bottom:0.4rem"></div>';
            html += '<div style="margin-bottom:0.5rem"><textarea id="pfManufacture" placeholder="What do you manufacture/process?" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;min-height:40px"></textarea></div>';
            html += '<div style="margin-bottom:0.5rem"><input id="pfLocation" placeholder="Location" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;margin-bottom:0.4rem"></div>';
            html += '<div style="margin-bottom:0.5rem"><textarea id="pfImages" placeholder="Image URLs (one per line)" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;min-height:40px"></textarea></div>';
            html += '<div style="margin-bottom:0.5rem"><textarea id="pfBio" placeholder="Bio / About your organisation" style="width:100%;padding:0.5rem 0.6rem;border:1.5px solid var(--gray-light);border-radius:var(--radius-sm);font-family:inherit;font-size:0.8rem;min-height:40px"></textarea></div>';
            html += '<button onclick="saveProfile(this)" style="padding:0.4rem 0.8rem;background:linear-gradient(135deg,var(--primary),var(--secondary));color:var(--white);border:none;border-radius:var(--radius-sm);font-size:0.8rem;font-weight:600;cursor:pointer;font-family:inherit">💾 Save Profile</button>';
            container.innerHTML = html;
        }

        window.saveProfile = async function(btn) {
            const body = {};
            const bn = document.getElementById('pfBusinessName');
            if (bn) body.businessName = bn.value;
            const cat = document.getElementById('pfCategory');
            if (cat) body.category = cat.value;
            const mfg = document.getElementById('pfManufacture');
            if (mfg) body.manufacture = mfg.value;
            const loc = document.getElementById('pfLocation');
            if (loc) body.location = loc.value;
            const imgs = document.getElementById('pfImages');
            if (imgs) body.imageUrls = imgs.value.split('\\n').filter(s => s.trim()).map(s => s.trim());
            const bio = document.getElementById('pfBio');
            if (bio) body.bio = bio.value;
            if (btn) setLoading(btn, true);
            try {
                const result = await api('/api/users/profile', { method: 'PUT', body: JSON.stringify(body) });
                showToast('Profile saved!', 'success');
                userData = result;
            } catch (e) {} finally { if (btn) setLoading(btn, false); }
        };

        document.getElementById('requestForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button[type="submit"]');
            if (btn.classList.contains('btn-loading')) return;
            setLoading(btn, true);
            try {
                const title = document.getElementById('reqTitle').value.trim();
                const description = document.getElementById('reqDesc').value.trim();
                const quantity = document.getElementById('reqQty').value.trim();
                const location = document.getElementById('reqLocation').value.trim();
                if (!title || !description) { showToast('Title and description are required', 'error'); return; }
                await api('/api/requests', { method: 'POST', body: JSON.stringify({ title, description, quantity, location }) });
                showToast('Request posted!', 'success');
                document.getElementById('requestForm').reset();
                loadRequests();
            } catch (e) {} finally { setLoading(btn, false); }
        });

        async function loadRequests() {
            const container = document.getElementById('requestListContainer');
            if (!container) return;
            try {
                const list = await api('/api/requests');
                document.getElementById('requestCount').textContent = list.length;
                if (!list.length) {
                    container.innerHTML = '<div class="entity-empty">No open requests from organisations.</div>';
                    return;
                }
                container.innerHTML = list.map(r => {
                    const replies = r.replies ? Object.entries(r.replies).map(([, rp]) => rp) : [];
                    const repliesHtml = replies.length ? replies.map(rp =>
                        '<div style="padding:0.5rem 0.75rem;background:var(--light);border-radius:var(--radius-sm);margin-top:0.4rem;font-size:0.8rem">' +
                            '<strong>' + (rp.displayName || 'Unknown') + ':</strong> ' + (rp.message || '') +
                        '</div>'
                    ).join('') : '';
                    return '<div class="entity-item" style="flex-wrap:wrap;flex-direction:column;align-items:stretch">' +
                        '<div style="display:flex;align-items:center;gap:1rem;width:100%">' +
                            '<div class="entity-avatar">📢</div>' +
                            '<div class="entity-info" style="min-width:0;flex:1">' +
                                '<div class="entity-name">' + (r.title || '') + '</div>' +
                                '<div class="entity-detail">' + (r.description || '').substring(0, 200) + (r.description && r.description.length > 200 ? '...' : '') + '</div>' +
                                '<div style="font-size:0.75rem;color:var(--gray);margin-top:0.2rem">' +
                                    'Posted by ' + (r.displayName || 'Unknown') +
                                    (r.quantity ? ' • Qty: ' + r.quantity : '') +
                                    (r.location ? ' • 📍' + r.location : '') +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        (repliesHtml ? '<div style="padding-left:3.5rem;margin-top:0.25rem">' + repliesHtml + '</div>' : '') +
                    '</div>';
                }).join('');
            } catch (e) { container.innerHTML = '<div class="entity-empty">Failed to load requests.</div>'; }
        }

        document.getElementById('orgRequestPanel').style.display = 'block';
        document.getElementById('forumSubtitle').textContent = 'Post what products you need and receive replies from farmers';

        const origSwitch = switchSection;
        switchSection = function(sectionId) {
            origSwitch(sectionId);
            if (sectionId === 'account') {
                initProfileForm();
            }
            if (sectionId === 'agreements') {
                loadAllAgreements();
            }
            if (sectionId === 'products') {
                loadProducts();
                loadOrders();
            }
            if (sectionId === 'forum') {
                loadRequests();
            }
        };
        window.switchSection = switchSection;

        const iconSVGs = {
            '⚡': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg>',
            '📋': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
            '👤': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
            '⚙️': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
            '📊': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>',
            '🔗': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
            '🤝': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
            '👥': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
            '📦': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
            '🏆': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
            '💰': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
            '🔍': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            'ℹ️': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
            '➕': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
            '📝': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
            '📢': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
            '🔒': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
            '🔧': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
            '🛒': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
            '🚚': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
            '⛓️': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
            '✉️': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
            '🎉': '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
        };
        function replaceIcons(el) {
            if (!el || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
            if (el.childNodes && el.childNodes.length) {
                for (let i = 0; i < el.childNodes.length; i++) {
                    const node = el.childNodes[i];
                    if (node.nodeType === 3) {
                        let text = node.textContent;
                        let replaced = false;
                        for (const [emoji, svg] of Object.entries(iconSVGs)) {
                            if (text.includes(emoji)) {
                                text = text.replace(emoji, svg + ' ');
                                replaced = true;
                            }
                        }
                        if (replaced) {
                            const span = document.createElement('span');
                            span.innerHTML = text;
                            el.replaceChild(span, node);
                        }
                    } else if (node.nodeType === 1) {
                        replaceIcons(node);
                    }
                }
            }
        }
        document.addEventListener('DOMContentLoaded', () => {
            replaceIcons(document.body);
        });

        function setLoading(btn, loading) {
            if (loading) {
                btn.classList.add('btn-loading');
                if (!btn.querySelector('.btn-text')) {
                    const wrapper = document.createElement('span');
                    wrapper.className = 'btn-text';
                    while (btn.childNodes.length) wrapper.appendChild(btn.childNodes[0]);
                    btn.appendChild(wrapper);
                }
            } else {
                btn.classList.remove('btn-loading');
            }
        }
        function preventDoubleClick(btn, handler) {
            btn.addEventListener('click', async (e) => {
                if (btn.classList.contains('btn-loading')) return;
                e.preventDefault();
                setLoading(btn, true);
                try { await handler(e); }
                finally { setLoading(btn, false); }
            });
        }

        const PAYSTACK_PUBLIC_KEY = 'pk_test_d31d62ed4af6a8231514f3c6540ac1b7b523b7b1';
        let walletData = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, pendingWithdrawal: 0, transactions: [] };

        async function loadWallet() {
            try {
                const res = await fetch('/api/wallet', { headers: { 'Authorization': 'Bearer ' + idToken } });
                if (!res.ok) return;
                walletData = await res.json();
                updateWalletUI();
            } catch { walletData = { balance: 0, totalDeposited: 0, totalWithdrawn: 0, pendingWithdrawal: 0, transactions: [] }; }
        }

        function fmt(amount) {
            return '\u20B5' + Number(amount || 0).toFixed(2);
        }

        function updateWalletUI() {
            document.getElementById('walletBalance').textContent = fmt(walletData.balance);
            document.getElementById('walletTotalDeposited').textContent = fmt(walletData.totalDeposited);
            document.getElementById('walletPending').textContent = fmt(walletData.pendingWithdrawal);
            document.getElementById('walletWithdrawn').textContent = fmt(walletData.totalWithdrawn);
            const txs = document.getElementById('walletTransactions');
            const list = (walletData.transactions || []);
            if (!list.length) {
                txs.innerHTML = '<div style="text-align:center;padding:24px;color:var(--gray)">No transactions yet</div>';
                return;
            }
            txs.innerHTML = list.map(t => {
                const isCredit = t.type === 'deposit' || t.amount > 0;
                const icon = isCredit ? '&#x1F4B0;' : '&#x1F4B8;';
                const cls = isCredit ? 'credit' : '';
                return '<div class="tx-item"><span>' + icon + '</span><span>' + t.description + '</span><span class="tx-amount ' + cls + '">' + (isCredit ? '+' : '') + fmt(Math.abs(t.amount)) + '</span></div>';
            }).join('');
        }

        function openDepositModal() {
            document.getElementById('depositAmount').value = '';
            document.getElementById('depositBtn').textContent = 'Deposit';
            document.getElementById('depositModal').style.display = 'flex';
        }

        function closeDepositModal() {
            document.getElementById('depositModal').style.display = 'none';
        }

        async function processDeposit() {
            const amount = parseFloat(document.getElementById('depositAmount').value);
            if (!amount || amount < 1) { showToast('Enter at least \u20B51', 'warning'); return; }
            const btn = document.getElementById('depositBtn');
            btn.disabled = true; btn.textContent = 'Processing...';
            try {
                const res = await fetch('/api/wallet/deposit/initialize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                    body: JSON.stringify({ amount }),
                });
                const data = await res.json();
                if (!res.ok) { showToast(data.error || 'Failed to initiate deposit', 'error'); btn.disabled = false; btn.textContent = 'Deposit'; return; }
                closeDepositModal();
                const handler = PaystackPop.setup({
                    key: PAYSTACK_PUBLIC_KEY,
                    email: email,
                    amount: Math.round(amount * 100),
                    currency: 'GHS',
                    ref: data.reference,
                    onClose: function() { showToast('Payment cancelled', 'info'); },
                    callback: function(response) {
                        verifyDeposit(response.reference);
                    }
                });
                handler.openIframe();
            } catch (e) { showToast('Failed to initiate deposit', 'error'); }
            btn.disabled = false; btn.textContent = 'Deposit';
        }

        async function verifyDeposit(reference) {
            showToast('Verifying payment...', 'info');
            try {
                const res = await fetch('/api/wallet/deposit/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                    body: JSON.stringify({ reference }),
                });
                const data = await res.json();
                if (data.already) { showToast('Already credited', 'info'); } else if (res.ok) {
                    showToast('\u20B5' + data.amount.toFixed(2) + ' deposited successfully!', 'success');
                    await loadWallet();
                } else { showToast(data.error || 'Verification failed', 'error'); }
            } catch (e) { showToast('Verification failed', 'error'); }
        }

        function openWithdrawModal() {
            document.getElementById('withdrawBank').innerHTML = '<option value="">Loading banks...</option>';
            document.getElementById('withdrawAccountNumber').value = '';
            document.getElementById('withdrawAccountName').value = '';
            document.getElementById('withdrawAmount').value = '';
            document.getElementById('withdrawModal').style.display = 'flex';
            fetch('/api/paystack/banks', { headers: { 'Authorization': 'Bearer ' + idToken } })
                .then(r => r.json()).then(banks => {
                    const sel = document.getElementById('withdrawBank');
                    sel.innerHTML = '<option value="">Select bank...</option>'
                        + (Array.isArray(banks) ? banks.map(b => '<option value="' + b.code + '">' + b.name + '</option>').join('') : '');
                }).catch(() => { document.getElementById('withdrawBank').innerHTML = '<option value="">Failed to load banks</option>'; });
        }

        function closeWithdrawModal() {
            document.getElementById('withdrawModal').style.display = 'none';
        }

        async function processWithdraw() {
            const bankCode = document.getElementById('withdrawBank').value;
            const accountNumber = document.getElementById('withdrawAccountNumber').value.trim();
            const accountName = document.getElementById('withdrawAccountName').value.trim();
            const amount = parseFloat(document.getElementById('withdrawAmount').value);
            if (!bankCode) { showToast('Select a bank', 'warning'); return; }
            if (!accountNumber || accountNumber.length < 10) { showToast('Enter a valid 10-digit account number', 'warning'); return; }
            if (!accountName) { showToast('Enter account name', 'warning'); return; }
            if (!amount || amount < 10) { showToast('Minimum withdrawal is \u20B510', 'warning'); return; }
            if (amount > walletData.balance) { showToast('Insufficient balance', 'error'); return; }
            const btn = document.querySelector('#withdrawModal .btn-primary');
            btn.disabled = true; btn.textContent = 'Processing...';
            try {
                const res = await fetch('/api/wallet/withdraw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                    body: JSON.stringify({ amount, bankCode, accountNumber, accountName }),
                });
                const data = await res.json();
                if (!res.ok) { showToast(data.error || 'Withdrawal failed', 'error'); btn.disabled = false; btn.textContent = 'Withdraw'; return; }
                showToast('Withdrawal initiated! Funds sent within 1-3 business days.', 'success');
                closeWithdrawModal();
                await loadWallet();
            } catch (e) { showToast('Withdrawal failed', 'error'); }
            btn.disabled = false; btn.textContent = 'Withdraw';
        }

        loadWallet();

        (function() {
            const s = document.createElement('script');
            s.src = 'https://js.paystack.co/v1/inline.js';
            s.onload = function() {};
            document.head.appendChild(s);
        })();
    </script>
</body>
</html>'''

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'Written {len(content)} bytes to {path}')
