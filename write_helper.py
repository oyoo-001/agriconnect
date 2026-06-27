import sys

def main():
    with open(sys.argv[1], 'w', encoding='utf-8') as f:
        f.write('''<!DOCTYPE html>
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
            margin-left:auto; background:linear-gradient(135deg,var(--accent),var(--accent-dark));
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
            content:''''; position:absolute; bottom:0; left:0; width:60px; height:3px;
            background:linear-gradient(90deg,var(--primary),var(--accent)); border-radius:2px;
        }
        .page-header h1 { font-size:1.6rem; font-weight:800; color:var(--dark); letter-spacing:-0.02em; }
        .page-header p { color:var(--gray); font-size:0.95rem; margin-top:0.35rem; }
        .dashboard-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1.5rem; margin-bottom:2rem; }
        .dashboard-grid.cols-2 { grid-template-columns:repeat(2,1fr); }
        .dashboard-grid.cols-4 { grid-template-columns:repeat(4,1fr); }
''')
        f.write(open(sys.argv[2], 'r', encoding='utf-8').read())

if __name__ == '__main__':
    main()
