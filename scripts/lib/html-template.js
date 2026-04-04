export const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ozon Pilot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Surfaces — cool neutral palette */
      --s0: #F8F9FA;
      --s1: #FFFFFF;
      --s2: #F1F3F5;
      --s3: #E9ECEF;
      --s4: #DEE2E6;
      --glass: rgba(255,255,255,0.88);

      /* Sidebar */
      --nav-bg: #1E293B;
      --nav-hover: #334155;
      --nav-text: #94A3B8;
      --nav-active: #FFFFFF;

      /* Edges */
      --edge: #E5E7EB;
      --edge-hi: #D1D5DB;
      --edge-glow: rgba(5,150,105,0.08);

      /* Text — deep navy hierarchy */
      --t0: #111827;
      --t1: #4B5563;
      --t2: #9CA3AF;
      --t3: #D1D5DB;

      /* Accents */
      --accent: #059669;
      --accent-dim: rgba(5,150,105,0.06);
      --accent-light: #d1fae5;
      --accent-ring: rgba(5,150,105,0.15);
      --accent-glow: rgba(5,150,105,0.1);
      --ok: #059669;
      --ok-bg: #ecfdf5;
      --ok-ring: rgba(5,150,105,0.2);
      --warn: #d97706;
      --warn-bg: #fffbeb;
      --warn-ring: rgba(217,119,6,0.2);
      --info: #6366f1;
      --info-bg: #EEF2FF;
      --info-ring: rgba(99,102,241,0.2);
      --err: #dc2626;
      --err-bg: #fef2f2;
      --err-ring: rgba(220,38,38,0.2);
      --off: #94a3b8;

      /* System */
      --sans: 'DM Sans', system-ui, -apple-system, sans-serif;
      --display: 'DM Sans', system-ui, -apple-system, sans-serif;
      --mono: 'JetBrains Mono', 'Consolas', monospace;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
      --ease-snappy: cubic-bezier(0.16, 1, 0.3, 1);
      --r: 12px;
      --r-lg: 16px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.03);
      --shadow-md: 0 2px 8px rgba(0,0,0,0.06);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.09);
      --shadow-glow: 0 0 0 3px var(--accent-ring);
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--sans);
      background: var(--s0);
      color: var(--t0);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: 1.55;
    }

    /* ── Staggered section load animation ── */
    @keyframes section-enter {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .stats-bar { animation: section-enter 500ms var(--ease) both; animation-delay: 0ms; }
    .collapse-header { animation: section-enter 500ms var(--ease) both; animation-delay: 80ms; }
    .collapse-body { animation: section-enter 500ms var(--ease) both; animation-delay: 120ms; }
    .sec { animation: section-enter 500ms var(--ease) both; }
    .tile { animation: section-enter 500ms var(--ease) both; }

    /* ── header ── */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 48px;
      padding: 0 24px;
      background: var(--s1);
      border-bottom: 1px solid var(--edge);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    /* No glow line — clean shadow instead */
    header::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 1px;
      background: transparent;
    }
    .hdr-left { display: flex; align-items: center; gap: 14px; }
    .hdr-logo {
      width: 30px; height: 30px;
      background: var(--accent);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.02em;
      flex-shrink: 0;
    }
    .hdr-dot {
      width: 8px; height: 8px;
      background: var(--ok);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--ok-ring);
      animation: dot-pulse 3s ease-in-out infinite;
    }
    @keyframes dot-pulse {
      0%,100% { opacity: .5; box-shadow: 0 0 6px var(--ok-ring); }
      50% { opacity: 1; box-shadow: 0 0 12px var(--ok-ring); }
    }
    .hdr-name {
      font-family: var(--sans);
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.01em;
      color: var(--t0);
    }
    .hdr-name em {
      font-style: normal;
      font-family: var(--sans);
      font-weight: 400;
      color: var(--t2);
      font-size: 13px;
      margin-left: 10px;
    }
    .hdr-ver {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--t2);
      background: var(--s2);
      padding: 3px 8px;
      border-radius: 6px;
      letter-spacing: 0.03em;
      border: 1px solid var(--edge);
    }
    .hdr-right { display: flex; align-items: center; gap: 14px; }
    .hdr-time {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--t2);
      letter-spacing: 0.02em;
    }

    /* ── layout: sidebar + main ── */
    .app-layout {
      min-height: calc(100vh - 48px);
    }

    /* ── floating nav ── */
    .tab-nav {
      position: fixed;
      left: 0;
      top: 48px;
      width: 180px;
      height: calc(100vh - 48px);
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      border-right: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 16px 10px;
      z-index: 200;
    }
    .tab-btn {
      font-family: var(--sans);
      font-weight: 500;
      font-size: 13px;
      padding: 10px 8px;
      border: none;
      border-radius: 8px;
      background: none;
      color: var(--nav-text);
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      transition: all 150ms var(--ease);
      border-left: 2px solid transparent;
      width: 100%;
      display: flex;
      align-items: center;
      border-radius: 0 8px 8px 0;
    }
    .tab-btn:hover { color: var(--nav-active); background: rgba(255,255,255,0.06); }
    .tab-btn.active { color: var(--nav-active); background: rgba(255,255,255,0.08); font-weight: 600; border-left-color: var(--accent); }
    .tab-btn.active::after { display: none; }
    .tab-btn .tab-icon { display: inline-block; width: 24px; text-align: center; flex-shrink: 0; font-size: 15px; }
    .tab-btn .tab-text { margin-left: 6px; }
    .app-main {
      margin-left: 180px;
      min-width: 0;
    }
    .tab-btn .tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 6px;
      height: 6px;
      padding: 0;
      margin-left: 6px;
      border-radius: 50%;
      font-size: 0;
      font-weight: 700;
      font-family: var(--mono);
      background: var(--accent);
      color: transparent;
      vertical-align: middle;
    }
    .tab-btn.active .tab-badge {
      background: var(--accent);
      color: transparent;
    }
    .tab-content { display: none; opacity: 0; transition: opacity 200ms var(--ease); }
    .tab-content.active { display: block; opacity: 1; animation: tab-fade-in 200ms var(--ease); }
    @keyframes tab-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* ── main ── */
    .wrap {
      max-width: 920px;
      margin: 0 auto;
      padding: 36px 24px 64px;
    }

    /* ── stats bar ── */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: 12px;
      padding: 20px 18px;
      text-align: center;
      position: relative;
      transition: all 300ms var(--ease);
      overflow: hidden;
    }
    .stat-card:hover {
      border-color: var(--edge-hi);
      box-shadow: var(--shadow-md);
    }
    .stat-icon {
      font-size: 18px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      margin-left: auto;
      margin-right: auto;
      background: var(--s0);
      border-radius: 10px;
      opacity: 0.9;
    }
    .stat-val {
      font-family: var(--sans);
      font-size: 28px;
      font-weight: 700;
      color: var(--t0);
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .stat-val.ok { color: var(--ok); }
    .stat-val.warn { color: var(--warn); }
    .stat-val.info { color: var(--info); }
    .stat-val.info.pulse-ready {
      animation: ready-pulse 2.5s ease-in-out infinite;
    }
    @keyframes ready-pulse {
      0%,100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    .stat-label {
      font-family: var(--sans);
      font-size: 12px;
      color: var(--t2);
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 500;
    }

    /* ── section titles ── */
    .sec {
      font-family: var(--sans);
      font-style: normal;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--t2);
      margin-bottom: 16px;
      padding-left: 0;
      border-left: none;
    }

    /* ── collapsible section ── */
    .collapse-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
      margin-bottom: 12px;
    }
    .collapse-header .sec { margin-bottom: 0; }
    .collapse-arrow {
      font-size: 10px;
      color: var(--t2);
      transition: transform 250ms var(--ease);
    }
    .collapse-header.collapsed .collapse-arrow { transform: rotate(-90deg); }
    .collapse-body { overflow: hidden; transition: max-height 350ms var(--ease-snappy); }
    .collapse-body.collapsed { max-height: 0 !important; }

    /* ── platform row ── */
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }
    .row-full {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
      margin-bottom: 32px;
    }
    .tile {
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: 12px;
      padding: 24px 22px;
      position: relative;
      transition: all 200ms var(--ease);
      overflow: hidden;
    }
    .tile:hover {
      border-color: var(--edge-hi);
      box-shadow: var(--shadow-md);
    }
    /* No top accent strip — clean flat cards */
    .tile::after {
      content: '';
      position: absolute;
      inset: -1px -1px auto -1px;
      height: 0;
      background: transparent;
    }
    .tile.live::after, .tile.expiring::after,
    .tile.plat-1688::after, .tile.plat-1688.live::after,
    .tile.plat-pdd::after, .tile.plat-pdd.live::after,
    .tile.plat-yiwugo::after, .tile.plat-yiwugo.live::after,
    .tile.plat-ozon::after, .tile.plat-ozon.live::after {
      background: transparent; height: 0;
    }
    /* platform watermark */
    .tile .tile-watermark {
      position: absolute;
      right: 14px;
      bottom: 10px;
      font-size: 48px;
      opacity: 0.04;
      pointer-events: none;
      user-select: none;
      line-height: 1;
    }

    .tile-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .tile-label {
      font-family: var(--sans);
      font-weight: 600;
      font-size: 14px;
      letter-spacing: -0.01em;
      color: var(--t0);
    }
    .tile-sub {
      font-size: 12px;
      color: var(--t2);
      margin-top: 3px;
    }

    /* ── status pill ── */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 99px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
      border: none;
    }
    .pill i {
      width: 6px; height: 6px;
      border-radius: 50%;
      display: block;
    }
    .pill-ok { background: var(--ok-bg); color: var(--ok); }
    .pill-ok i { background: var(--ok); }
    .pill-warn { background: var(--warn-bg); color: var(--warn); }
    .pill-warn i { background: var(--warn); animation: dot-pulse-warn 2s ease-in-out infinite; }
    @keyframes dot-pulse-warn {
      0%,100% { opacity: .5; }
      50% { opacity: 1; }
    }
    .pill-off { background: var(--s2); color: var(--t3); }
    .pill-off i { background: var(--t3); }
    .pill-info { background: var(--info-bg); color: var(--info); }
    .pill-info i { background: var(--info); }
    .pill-err { background: var(--err-bg); color: var(--err); }
    .pill-err i { background: var(--err); }

    /* ── kv pairs ── */
    .kv { margin-bottom: 16px; }
    .kv-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 7px 0;
    }
    .kv-row + .kv-row { border-top: 1px solid var(--edge); }
    .kv-k { font-size: 13px; color: var(--t1); }
    .kv-v { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--t0); }

    /* ── buttons ── */
    .act {
      font-family: var(--sans);
      font-weight: 500;
      font-size: 13px;
      padding: 8px 18px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      transition: all 200ms ease;
      letter-spacing: 0;
    }
    .act-go {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 99px;
      padding: 7px 16px;
    }
    .act-go:hover {
      background: #047857;
      box-shadow: var(--shadow-sm);
    }
    .act-info {
      background: var(--info);
      color: #fff;
      border: none;
    }
    .act-info:hover {
      background: #4338ca;
      box-shadow: 0 0 0 3px var(--info-ring), var(--shadow-sm);
    }
    .act-warn {
      background: var(--warn);
      color: #fff;
      border: none;
    }
    .act-warn:hover {
      background: #b45309;
      box-shadow: 0 0 0 3px var(--warn-ring), var(--shadow-sm);
    }
    .act-dl {
      background: var(--ok-bg);
      color: var(--ok);
      border: 1px solid var(--edge);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .act-dl:hover {
      background: var(--accent-light);
      border-color: var(--ok);
    }
    .act-dl::before {
      content: '\\2193';
      font-size: 14px;
      font-weight: 700;
    }
    .act:disabled { opacity: 0.35; cursor: not-allowed; filter: saturate(0.3); }

    /* ── launch buttons ── */
    .launch {
      width: 100%;
      padding: 14px;
      font-family: var(--sans);
      font-weight: 600;
      font-size: 14px;
      letter-spacing: 0;
      border: none;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      transition: all 200ms ease;
      position: relative;
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .launch::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
      transform: translateX(-100%);
      transition: transform 600ms var(--ease);
    }
    .launch:hover:not(:disabled)::before { transform: translateX(100%); }
    .launch:hover:not(:disabled) {
      background: #047857;
      box-shadow: var(--shadow-md);
    }
    .launch:active:not(:disabled) { transform: translateY(0); }
    .launch:disabled {
      background: var(--s3);
      color: var(--t3);
      cursor: not-allowed;
      box-shadow: none;
    }
    .launch-info {
      background: var(--s1);
      color: var(--info);
      border: 1px solid var(--edge);
    }
    .launch-info::before {
      background: linear-gradient(90deg, transparent, rgba(99,102,241,0.04), transparent);
    }
    .launch-info:hover:not(:disabled) {
      background: var(--info-bg);
      border-color: var(--info);
      box-shadow: none;
    }

    /* ── log — DARK terminal contrast ── */
    .log-wrap {
      margin-top: 14px;
      border: none;
      border-radius: 12px;
      overflow: hidden;
      display: none;
      box-shadow: var(--shadow-lg);
    }
    .log-wrap.open {
      display: block;
      animation: reveal 400ms var(--ease-snappy);
    }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .log-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 16px;
      background: #161B22;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-size: 11px;
      color: #8B949E;
    }
    /* macOS-style dots */
    .log-bar::before {
      content: '';
      display: inline-flex;
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 14px 0 0 #f59e0b, 28px 0 0 #10b981;
      margin-right: 16px;
      flex-shrink: 0;
    }
    .log-out {
      padding: 16px 18px;
      background: #0D1117;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.85;
      color: #7EE787;
      max-height: 340px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-out::-webkit-scrollbar { width: 4px; }
    .log-out::-webkit-scrollbar-track { background: transparent; }
    .log-out::-webkit-scrollbar-thumb { background: #30363D; border-radius: 4px; }

    /* ── search box ── */
    .search-box {
      width: 100%;
      padding: 12px 16px;
      font-family: var(--sans);
      font-size: 13px;
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      color: var(--t0);
      outline: none;
      transition: all 250ms var(--ease);
      margin-bottom: 16px;
    }
    .search-box::placeholder { color: var(--t3); }
    .search-box:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }

    /* ── product table ── */
    .ptable {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .ptable th {
      text-align: left;
      padding: 10px 14px;
      font-family: var(--sans);
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--t2);
      border-bottom: 1px solid var(--edge);
      background: var(--s0);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .ptable td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--s2);
      color: var(--t1);
      vertical-align: top;
    }
    .ptable tbody tr:nth-child(even):not(.pdetail-row) { background: #F9FAFB; }
    .ptable tr.prow {
      cursor: pointer;
      transition: all 180ms var(--ease);
    }
    .ptable tr.prow:hover {
      background: var(--s2);
    }
    .ptable tr.prow.expanded { background: var(--s2); }
    .ptable .pname {
      color: var(--t0);
      font-weight: 500;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ptable .pscore {
      font-family: var(--mono);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      position: relative;
    }
    .score-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .score-dot-hi { background: var(--ok); }
    .score-dot-mid { background: var(--warn); }
    .score-dot-lo { background: var(--off); }
    .score-hi { color: var(--ok); }
    .score-mid { color: var(--warn); }
    .score-lo { color: var(--off); }
    .ptable th.sortable {
      cursor: pointer;
      user-select: none;
      transition: color 150ms var(--ease);
    }
    .ptable th.sortable:hover { color: var(--t0); }
    .ptable th .sort-arrow {
      font-size: 9px;
      margin-left: 4px;
      opacity: 0.3;
    }
    .ptable th.sort-active .sort-arrow { opacity: 1; color: var(--accent); }

    /* ── product detail row ── */
    .pdetail-row td {
      padding: 0;
      border-bottom: 1px solid var(--edge);
    }
    .pdetail {
      padding: 18px 22px;
      background: var(--s2);
      animation: reveal 300ms var(--ease-snappy);
    }
    .pdetail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px 28px;
    }
    .pdetail-section { margin-bottom: 12px; }
    .pdetail-section-title {
      font-family: var(--sans);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--t2);
      margin-bottom: 6px;
    }
    .pdetail p { font-size: 13px; color: var(--t1); line-height: 1.65; }
    .pdetail a {
      color: var(--info);
      text-decoration: none;
      font-size: 12px;
      font-family: var(--mono);
      transition: color 150ms var(--ease);
    }
    .pdetail a:hover { text-decoration: underline; color: #4338ca; }
    .score-breakdown { display: flex; flex-wrap: wrap; gap: 6px; }
    .score-chip {
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 6px;
      background: var(--s1);
      color: var(--t1);
      border: 1px solid var(--edge);
    }
    .score-chip strong { color: var(--t0); }

    /* stage pills */
    .stage-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 3px 10px;
      border-radius: 6px;
    }
    .stage-approved { background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok-ring); }
    .stage-evaluated { background: var(--info-bg); color: var(--info); border: 1px solid var(--info-ring); }
    .stage-draft { background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-ring); }
    .stage-other { background: var(--s2); color: var(--t2); border: 1px solid var(--edge); }

    /* ── product table wrapper ── */
    .ptable-wrap {
      border: 1px solid var(--edge);
      border-radius: 12px;
      overflow: auto;
      max-height: 600px;
      background: var(--s1);
      box-shadow: var(--shadow-sm);
    }
    .ptable-wrap::-webkit-scrollbar { width: 4px; }
    .ptable-wrap::-webkit-scrollbar-track { background: transparent; }
    .ptable-wrap::-webkit-scrollbar-thumb { background: var(--t3); border-radius: 4px; }

    .products-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .products-count {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--info);
      background: var(--info-bg);
      padding: 5px 12px;
      border-radius: 12px;
      border: none;
    }
    .empty-state {
      text-align: center;
      padding: 56px 28px;
      color: var(--t3);
      font-size: 14px;
    }
    .empty-state-icon {
      font-size: 40px;
      margin-bottom: 14px;
      opacity: 0.4;
      display: block;
    }

    /* ── config inputs ── */
    .cfg-row {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      align-items: center;
    }
    .cfg-input {
      flex: 1;
      padding: 12px 16px;
      font-family: var(--mono);
      font-size: 14px;
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      color: var(--t0);
      outline: none;
      transition: all 250ms var(--ease);
    }
    .cfg-input::placeholder { color: var(--t3); }
    .cfg-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .cfg-label {
      font-size: 12px;
      color: var(--t2);
      min-width: 80px;
      text-align: right;
      font-weight: 500;
    }
    /* config save checkmark animation */
    .cfg-saved-check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--ok);
      font-size: 13px;
      font-weight: 600;
      animation: check-pop 500ms var(--ease-snappy);
    }
    @keyframes check-pop {
      0% { transform: scale(0.5); opacity: 0; }
      60% { transform: scale(1.15); }
      100% { transform: scale(1); opacity: 1; }
    }
    .cfg-btn-row {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      align-items: center;
    }
    .cfg-status {
      font-family: var(--mono);
      font-size: 12px;
      margin-top: 8px;
    }
    .cfg-status.connected { color: var(--ok); }
    .cfg-status.disconnected { color: var(--t3); }

    /* ── config meta row ── */
    .cfg-meta {
      display: flex;
      gap: 20px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--edge);
      flex-wrap: wrap;
    }
    .cfg-meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--t2);
    }
    .cfg-meta-item strong {
      font-family: var(--mono);
      color: var(--t1);
      font-weight: 500;
    }
    .cfg-meta-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      opacity: 0.6;
    }

    /* ── upload section ── */
    .upload-stats {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
    }
    .upload-stat {
      font-size: 13px;
      color: var(--t1);
    }
    .upload-stat strong {
      font-family: var(--mono);
      color: var(--ok);
    }
    .upload-result {
      display: flex;
      gap: 16px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .upload-result .pill { font-size: 12px; }

    /* ── progress bar ── */
    .progress-wrap {
      width: 100%;
      height: 6px;
      background: var(--s3);
      border-radius: 3px;
      overflow: hidden;
      margin: 14px 0;
      display: none;
      position: relative;
    }
    .progress-wrap.active { display: block; }
    /* No outer glow in light theme */
    .progress-wrap.active::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 3px;
      pointer-events: none;
    }
    .progress-bar {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent), #047857, var(--accent));
      background-size: 200% 100%;
      transition: width 300ms var(--ease);
      position: relative;
    }
    .progress-bar.animate {
      animation: progress-shimmer 1.5s linear infinite;
    }
    @keyframes progress-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
    .progress-text {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--t1);
      margin-top: 4px;
    }

    /* ── upload results table ── */
    .result-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 14px;
    }
    .result-table th {
      text-align: left;
      padding: 9px 12px;
      font-family: var(--sans);
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--t2);
      border-bottom: 1px solid var(--edge);
      background: var(--s0);
    }
    .result-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--edge);
      color: var(--t1);
      font-family: var(--mono);
    }
    .result-table tbody tr:nth-child(even) { background: #F9FAFB; }
    .result-table tbody tr:hover { background: var(--s2); }
    .result-table .r-ok { color: var(--ok); }
    .result-table .r-err { color: var(--err); }

    /* ── orders section ── */
    .order-card {
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: 12px;
      padding: 18px 22px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 200ms var(--ease);
    }
    .order-card:hover {
      border-color: var(--edge-hi);
      box-shadow: var(--shadow-md);
    }
    .order-card + .order-card { border-top: none; }
    .orders-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .orders-last-update {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--t3);
    }
    .order-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }
    .order-id {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--t0);
      font-weight: 500;
    }
    .order-detail {
      font-size: 12px;
      color: var(--t2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .order-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 3px 10px;
      border-radius: 6px;
    }
    .os-awaiting { background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-ring); }
    .os-delivering { background: var(--info-bg); color: var(--info); border: 1px solid var(--info-ring); }
    .os-delivered { background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok-ring); }
    .os-other { background: var(--s2); color: var(--t2); border: 1px solid var(--edge); }
    .order-actions { display: flex; gap: 8px; flex-shrink: 0; margin-left: 12px; }
    .order-total {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--t0);
      font-weight: 600;
      white-space: nowrap;
    }

    /* ── footer ── */
    footer {
      margin-top: 56px;
      text-align: center;
      font-size: 11px;
      color: var(--t2);
      padding: 24px 0;
      border-top: none;
    }
    footer .footer-brand {
      font-family: var(--sans);
      font-style: normal;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--t2);
      -webkit-background-clip: unset;
      -webkit-text-fill-color: unset;
      background-clip: unset;
      background: none;
    }

    /* ── loading spinner ── */
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid var(--edge-hi);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Global selection color ── */
    ::selection {
      background: rgba(5,150,105,0.15);
      color: var(--t0);
    }

    /* ── Smooth scrollbar everywhere ── */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--s4); border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--t2); }

    @media (max-width: 600px) {
      .row { grid-template-columns: 1fr; }
      .stats-bar { grid-template-columns: 1fr 1fr; }
      .pdetail-grid { grid-template-columns: 1fr; }
      .tab-btn { padding: 10px 14px; font-size: 12px; }
      .app-layout { flex-direction: column; }
      .tab-nav {
        position: fixed; bottom: 0; top: auto; left: 0; right: 0;
        width: 100%; height: 52px; flex-direction: row; justify-content: center;
        border-right: none; border-top: 1px solid rgba(255,255,255,0.1);
        padding: 4px 8px; backdrop-filter: blur(20px);
        background: rgba(15, 23, 42, 0.85);
      }
      .tab-btn { border-left: none; border-radius: 8px; }
      .tab-btn .tab-text { display: none; }
      .tab-btn { padding: 10px 16px; }
      .app-main { margin-left: 0; margin-bottom: 52px; }
      header { height: 48px; padding: 0 16px; }
      .wrap { padding: 24px 16px 48px; }
      .order-card { flex-direction: column; gap: 10px; align-items: flex-start; }
      .order-actions { margin-left: 0; }
      .cfg-row { flex-direction: column; gap: 6px; }
      .cfg-label { text-align: left; min-width: auto; }
      .cfg-meta { flex-direction: column; gap: 8px; }
      .cfg-btn-row { flex-wrap: wrap; }
      .orders-meta { flex-direction: column; align-items: flex-start; gap: 8px; }
      .stat-card { padding: 16px 14px; }
      .stat-val { font-size: 24px; }
    }
  </style>
</head>
<body>
  <!-- ─── Auth Overlay ─── -->
  <div id="auth-overlay" style="display:none; position:fixed; inset:0; z-index:9999; background:rgba(15,23,42,0.5); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); align-items:center; justify-content:center;">
    <div style="background:var(--s1); border-radius:16px; padding:40px; box-shadow:0 20px 60px rgba(0,0,0,0.15); width:380px; max-width:90vw;">
      <div style="text-align:center; margin-bottom:24px;">
        <div style="display:inline-flex; align-items:center; gap:8px; font-family:var(--sans); font-size:22px; font-weight:700; color:var(--t0);">
          <span style="background:var(--accent); color:#fff; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-family:var(--sans); font-size:12px; font-weight:700;">OP</span>
          Ozon Pilot
        </div>
      </div>
      <div id="auth-error" style="display:none; background:var(--err-bg); color:var(--err); padding:10px 14px; border-radius:8px; margin-bottom:16px; font-size:13px;"></div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        <input id="auth-email" type="email" placeholder="邮箱" style="padding:10px 14px; border:1px solid var(--edge-hi); border-radius:8px; font-size:14px; font-family:var(--sans); outline:none; transition:border 200ms;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--edge-hi)'" />
        <input id="auth-pass" type="password" placeholder="密码" style="padding:10px 14px; border:1px solid var(--edge-hi); border-radius:8px; font-size:14px; font-family:var(--sans); outline:none; transition:border 200ms;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--edge-hi)'" />
        <button id="auth-login-btn" onclick="doAuth('login')" style="padding:10px; background:var(--accent); color:#fff; border:none; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; font-family:var(--sans);">登录</button>
        <button id="auth-reg-btn" onclick="doAuth('register')" style="padding:10px; background:var(--s1); color:var(--t1); border:1px solid var(--edge); border-radius:10px; font-size:14px; font-weight:500; cursor:pointer; font-family:var(--sans);">注册新账号</button>
      </div>
      <div style="text-align:center; margin-top:16px; font-size:12px; color:var(--t2);">首次使用请先注册</div>
    </div>
  </div>

  <!-- 设置引导弹窗（登录后、未完成配置时显示）-->
  <div id="setup-overlay" style="display:none; position:fixed; inset:0; z-index:9998; background:rgba(15,23,42,0.5); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); align-items:center; justify-content:center;">
    <div style="background:#fff; border-radius:16px; padding:32px 36px; width:420px; max-width:90vw; box-shadow:0 20px 60px rgba(0,0,0,0.15);">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:28px; margin-bottom:8px;">&#9881;</div>
        <div style="font-size:18px; font-weight:600;">完成设置</div>
        <div style="font-size:13px; color:var(--t2); margin-top:4px;">请完成以下步骤后开始使用</div>
      </div>
      <div id="setup-steps" style="font-size:14px; line-height:2.2;"></div>
      <div style="text-align:center; margin-top:20px;">
        <button onclick="checkSetupGuide()" style="padding:8px 24px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:13px; cursor:pointer;">刷新状态</button>
      </div>
    </div>
  </div>

  <script>
    // ─── Auth bootstrap ───
    const _origFetch = window.fetch;
    window.fetch = function(url, opts = {}) {
      const token = localStorage.getItem('oz_token');
      if (token && typeof url === 'string' && url.startsWith('/api/')) {
        opts.headers = opts.headers || {};
        if (opts.headers instanceof Headers) {
          if (!opts.headers.has('Authorization')) opts.headers.set('Authorization', 'Bearer ' + token);
        } else {
          if (!opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ' + token;
        }
      }
      return _origFetch.call(this, url, opts);
    };

    async function doAuth(action) {
      const email = document.getElementById('auth-email').value.trim();
      const pass = document.getElementById('auth-pass').value;
      const errEl = document.getElementById('auth-error');
      errEl.style.display = 'none';
      if (!email || !pass) { errEl.textContent = '请填写邮箱和密码'; errEl.style.display = 'block'; return; }
      try {
        const res = await _origFetch('/api/auth/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pass }),
        });
        const data = await res.json();
        if (!res.ok || !data.token) {
          errEl.textContent = data.error || '操作失败';
          errEl.style.display = 'block';
          return;
        }
        localStorage.setItem('oz_token', data.token);
        localStorage.setItem('oz_user', JSON.stringify(data.user));
        document.getElementById('auth-overlay').style.display = 'none';
        // 管理员显示管理tab
        if (data.user?.is_admin) {
          const adminBtn = document.getElementById('admin-tab-btn');
          if (adminBtn) adminBtn.style.display = '';
        }
        if (typeof initApp === 'function') initApp();
      } catch (e) {
        errEl.textContent = '网络错误: ' + e.message;
        errEl.style.display = 'block';
      }
    }

    function doLogout() {
      localStorage.removeItem('oz_token');
      localStorage.removeItem('oz_user');
      location.reload();
    }

    // Check auth on page load
    (async function checkAuth() {
      const token = localStorage.getItem('oz_token');
      const overlay = document.getElementById('auth-overlay');
      if (!token) { overlay.style.display = 'flex'; return; }
      try {
        const res = await _origFetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!res.ok) { overlay.style.display = 'flex'; localStorage.removeItem('oz_token'); return; }
        const data = await res.json();
        localStorage.setItem('oz_user', JSON.stringify(data.user));
        overlay.style.display = 'none';
        // 管理员显示管理tab
        if (data.user?.is_admin) {
          const adminBtn = document.getElementById('admin-tab-btn');
          if (adminBtn) adminBtn.style.display = '';
        }
      } catch {
        overlay.style.display = 'flex';
      }
    })();

    // Enter key submits login
    document.addEventListener('DOMContentLoaded', () => {
      const passInput = document.getElementById('auth-pass');
      if (passInput) passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
    });
  </script>

  <header>
    <div class="hdr-left">
      <div class="hdr-logo">OP</div>
      <div class="hdr-dot"></div>
      <div class="hdr-name">Ozon Pilot<em>管理控制台</em></div>
      <span class="hdr-ver">v1.0</span>
    </div>
    <div class="hdr-right">
      <div class="hdr-time" id="clock"></div>
      <span id="hdr-user" style="font-size:12px; color:var(--t2); margin-left:12px;"></span>
      <button onclick="doLogout()" style="margin-left:8px; padding:4px 12px; background:transparent; border:1px solid var(--edge); border-radius:6px; font-size:12px; color:var(--t2); cursor:pointer; font-family:var(--sans);">退出</button>
    </div>
  </header>
  <script>
    // Show user email in header
    try {
      const u = JSON.parse(localStorage.getItem('oz_user') || '{}');
      if (u.email) document.getElementById('hdr-user').textContent = u.email;
    } catch {}
  </script>

  <div class="app-layout">
  <nav class="tab-nav">
    <button class="tab-btn active" onclick="switchTab('console')"><span class="tab-icon">&#9881;</span><span class="tab-text">控制台</span></button>
    <button class="tab-btn" onclick="switchTab('products')"><span class="tab-icon">&#128230;</span><span class="tab-text">产品库</span></button>
    <button class="tab-btn" onclick="switchTab('orders')"><span class="tab-icon">&#128666;</span><span class="tab-text">订单</span><span class="tab-badge" id="orders-badge" style="display:none;">0</span></button>
    <button class="tab-btn" onclick="switchTab('admin')" id="admin-tab-btn" style="display:none;"><span class="tab-icon">&#128272;</span><span class="tab-text">管理</span></button>
  </nav>
  <div class="app-main">

  <!-- TAB: 控制台 -->
  <div class="tab-content active" id="tab-console">
    <div class="wrap">
      <!-- 设置引导（内联占位，实际用悬浮弹窗） -->

      <!-- stats bar -->
      <div class="stats-bar" id="stats-bar">
        <div class="stat-card"><span class="stat-icon">&#128230;</span><div class="stat-val" id="stat-products">--</div><div class="stat-label">产品总数</div></div>
        <div class="stat-card"><span class="stat-icon">&#128176;</span><div class="stat-val" id="stat-revenue" style="color:var(--accent);">--</div><div class="stat-label">销售额(₽)</div></div>
        <div class="stat-card"><span class="stat-icon">&#128200;</span><div class="stat-val" id="stat-profit" style="color:var(--ok);">--</div><div class="stat-label">利润(₽)</div></div>
        <div class="stat-card"><span class="stat-icon">&#128273;</span><div class="stat-val warn" id="stat-keywords">--</div><div class="stat-label">词库</div></div>
      </div>

      <!-- 利润概览 -->
      <div id="profit-overview" style="display:none;margin-bottom:20px;">
        <div class="sec">利润概览</div>
        <div class="tile" style="padding:16px;">
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;">
            <div style="flex:1;min-width:120px;"><span style="font-size:11px;color:var(--t3);">平均利润率</span><div id="profit-avg-margin" style="font-size:20px;font-weight:600;">--%</div></div>
            <div style="flex:1;min-width:120px;"><span style="font-size:11px;color:var(--t3);">盈利产品</span><div id="profit-positive" style="font-size:20px;font-weight:600;color:var(--ok);">0</div></div>
            <div style="flex:1;min-width:120px;"><span style="font-size:11px;color:var(--t3);">亏损产品</span><div id="profit-negative" style="font-size:20px;font-weight:600;color:var(--err);">0</div></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="act act-go" onclick="syncFinance()">同步财务数据</button>
            <span id="finance-sync-status" style="font-size:12px;color:var(--t3);line-height:32px;"></span>
          </div>
        </div>
      </div>

      <!-- Ozon API Config (collapsible) -->
      <div class="collapse-header" id="cfg-collapse-hdr" onclick="toggleCollapse('cfg')">
        <div class="sec" style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;opacity:0.6;">&#128272;</span> Ozon API 配置
        </div>
        <span class="collapse-arrow">&#9660;</span>
      </div>
      <div class="collapse-body" id="cfg-collapse-body" style="max-height:600px;">
        <div class="tile" id="ozon-cfg-tile" style="margin-bottom:28px;">
          <div class="tile-head">
            <div><div class="tile-label">Ozon Seller API</div><div class="tile-sub">api-seller.ozon.ru</div></div>
            <span class="pill pill-off" id="ozon-cfg-pill"><i></i>未配置</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-label">Client-Id</span>
            <input class="cfg-input" id="ozon-client-id" type="text" placeholder="输入 Ozon Client-Id (纯数字)" autocomplete="new-password" data-lpignore="true" data-form-type="other">
          </div>
          <div class="cfg-row">
            <span class="cfg-label">Api-Key</span>
            <input class="cfg-input" id="ozon-api-key" type="text" placeholder="输入 Ozon Api-Key" autocomplete="new-password" data-lpignore="true" data-form-type="other">
          </div>
          <div class="cfg-btn-row">
            <button class="act act-go" onclick="saveOzonConfig()">保存</button>
            <button class="act act-info" onclick="testOzonConnection()">测试连接</button>
            <button class="act act-warn" onclick="window.open('https://seller.ozon.ru/app/settings/api-keys','_blank')">打开API Key管理页</button>
            <span id="cfg-save-check"></span>
          </div>
          <div class="cfg-status disconnected" id="ozon-cfg-status"></div>
          <div class="cfg-meta" id="ozon-cfg-meta" style="display:none;">
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#9881;</span> 仓库: <strong id="cfg-wh-id">--</strong></div>
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#128176;</span> 货币: <strong id="cfg-currency">CNY</strong></div>
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#127981;</span> 仓库名: <strong id="cfg-wh-name">--</strong></div>
          </div>
        </div>
      </div>

      <div class="sec">数据源</div>
      <div id="platforms"></div>

      <div class="sec">链接导入</div>
      <div class="tile" style="margin-bottom:16px;">
        <div class="tile-head">
          <div>
            <div class="tile-label">粘贴链接，自动上架</div>
            <div class="tile-sub">支持 1688 / 淘宝 / 速卖通链接 — 自动抓取并上架到 Ozon</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px;">
          <input class="cfg-input" id="import-url" type="text" placeholder="粘贴商品链接 (任意平台)" style="flex:1;" onkeydown="if(event.key==='Enter')runSmartImport()">
          <button class="act act-go" onclick="runSmartImport()">导入</button>
        </div>
        <div class="log-wrap" id="import-log-panel">
          <div class="log-bar">
            <span>导入日志</span>
            <span id="import-log-status"></span>
          </div>
          <div class="log-out" id="import-log"></div>
        </div>
      </div>

      <div class="sec">自动选品上架</div>
      <div class="tile" style="margin-bottom:16px;">
        <div class="tile-head">
          <div>
            <div class="tile-label">自动循环：选词 → 采集 → 评分 → AI推理 → 上架 → 淘汰低效</div>
            <div class="tile-sub">每20分钟一轮，每轮4件，自动运行</div>
          </div>
          <span class="pill pill-off" id="cycle-pill"><i></i>待命</span>
        </div>

        <!-- 循环控制 -->
        <div style="display:flex;gap:10px;margin-top:12px;align-items:center;">
          <button class="act act-go" id="cycle-start-btn" onclick="cycleStart()">启动循环</button>
          <button class="act act-warn" id="cycle-stop-btn" onclick="cycleStop()" style="display:none;">停止循环</button>
          <button class="act act-info" onclick="cycleRefresh()">刷新状态</button>
          <span id="cycle-info" style="font-size:12px;color:var(--t3);margin-left:8px;"></span>
        </div>

        <!-- 循环状态 -->
        <div id="cycle-stats" style="margin-top:12px;font-size:12px;"></div>

        <!-- 实时日志 -->
        <div class="log-wrap" id="cycle-log-panel" style="margin-top:8px;">
          <div class="log-bar">
            <span>循环日志</span>
            <span id="cycle-log-status"></span>
          </div>
          <div class="log-out" id="cycle-log" style="max-height:300px;"></div>
        </div>

        <!-- 单次手动运行 -->
        <div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;">
          <button class="launch" id="pipeline-btn" onclick="runPipeline()" style="font-size:12px;padding:8px 16px;">手动跑一轮</button>
        </div>
        <div class="log-wrap" id="log-panel">
          <div class="log-bar">
            <span>手动运行日志</span>
            <span id="log-status"></span>
          </div>
          <div class="log-out" id="pipeline-log"></div>
        </div>
      </div>

      <!-- 错误检查 & 修复 -->
      <div class="sec" style="margin-top:32px;">商品健康检查</div>
      <div class="tile">
        <div class="tile-head">
          <div>
            <div class="tile-label">Ozon 错误扫描</div>
            <div class="tile-sub">检查已上架商品的严重/非严重错误</div>
          </div>
          <span class="pill pill-off" id="error-check-pill"><i></i>未检查</span>
        </div>
        <div id="error-summary" style="margin:12px 0;font-size:13px;color:var(--t1);"></div>
        <div style="display:flex;gap:10px;">
          <button class="act act-info" onclick="checkErrors()">扫描错误</button>
          <button class="act act-go" id="fix-btn" onclick="runAutoFix()" style="display:none;">一键修复</button>
        </div>
        <div id="error-list" style="margin-top:12px;max-height:300px;overflow-y:auto;"></div>
        <div class="log-wrap" id="fix-log-panel">
          <div class="log-bar">
            <span>修复日志</span>
            <span id="fix-log-status"></span>
          </div>
          <div class="log-out" id="fix-log"></div>
        </div>
      </div>

      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <!-- TAB: 产品库 -->
  <div class="tab-content" id="tab-products">
    <div class="wrap">
      <div class="sec">产品库</div>
      <div class="products-header">
        <input class="search-box" id="product-search" type="text" placeholder="搜索产品名称、品类..." oninput="filterProducts()" style="max-width:360px;margin-bottom:0;">
        <span class="products-count" id="products-count"></span>
      </div>
      <div class="ptable-wrap">
        <table class="ptable">
          <thead>
            <tr>
              <th class="sortable" onclick="sortProducts('name')">名称 <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('category')">品类 <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('price_rub')">售价 (RUB) <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('price_cny')">供货价 (CNY) <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('profit')">利润 <span class="sort-arrow">&#9660;</span></th>
              <th class="sortable sort-active" onclick="sortProducts('score')">评分 <span class="sort-arrow">&#9660;</span></th>
              <th>阶段</th>
            </tr>
          </thead>
          <tbody id="products-tbody"></tbody>
        </table>
      </div>
      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <!-- TAB: 订单 -->
  <div class="tab-content" id="tab-orders">
    <div class="wrap">
      <div class="sec">订单监控</div>
      <div class="orders-meta">
        <span style="font-size:13px;color:var(--t1);">待处理订单: <strong style="font-family:var(--mono);color:var(--ok);" id="orders-count-tab">--</strong></span>
        <button class="act act-info" onclick="refreshOrders()" id="orders-refresh-btn">&#8635; 刷新</button>
        <select class="cfg-input" id="order-status-filter" style="flex:0;width:auto;min-width:160px;" onchange="refreshOrders()">
          <option value="awaiting_packaging">待打包</option>
          <option value="awaiting_deliver">待发货</option>
          <option value="delivering">配送中</option>
          <option value="delivered">已送达</option>
          <option value="">全部</option>
        </select>
        <span class="orders-last-update" id="orders-last-update"></span>
      </div>
      <div id="orders-list-tab"></div>
      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <!-- TAB: 管理后台 (仅管理员可见) -->
  <div class="tab-content" id="tab-admin">
    <div class="wrap">
      <div class="sec">管理后台</div>

      <!-- 统计概览 -->
      <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;" id="admin-stats"></div>

      <!-- 邀请码管理 -->
      <div class="tile" style="margin-bottom:20px;">
        <div class="tile-head"><div><div class="tile-label">邀请码管理</div><div class="tile-sub">创建邀请码给内测用户</div></div></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <select id="invite-plan" class="cfg-input" style="width:120px;">
            <option value="basic">基础版 (100)</option>
            <option value="pro">专业版 (500)</option>
            <option value="vip">VIP (无限)</option>
          </select>
          <input id="invite-max" class="cfg-input" type="number" value="10" min="1" style="width:80px;" placeholder="次数">
          <button class="act act-go" onclick="createInvite()">生成邀请码</button>
        </div>
        <div id="invite-result" style="margin-top:10px;font-family:var(--mono);font-size:13px;"></div>
        <div id="invite-list" style="margin-top:12px;"></div>
      </div>

      <!-- 用户列表 -->
      <div class="tile">
        <div class="tile-head"><div><div class="tile-label">用户列表</div><div class="tile-sub">查看所有账号的用量和配额</div></div></div>
        <table class="product-table" style="margin-top:12px;">
          <thead><tr>
            <th>ID</th><th>邮箱</th><th>套餐</th><th>配额</th><th>已用</th><th>API调用</th><th>LLM Token</th><th>注册时间</th><th>操作</th>
          </tr></thead>
          <tbody id="admin-users-tbody"></tbody>
        </table>
      </div>

      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 管理后台</footer>
    </div>
  </div>

  <script>
    /* === State === */
    const platforms = ['1688', 'pdd'];
    const NAMES = { '1688': '1688', 'pdd': '拼多多' };
    const SUBS = { '1688': '阿里巴巴批发平台 · 采集货源', 'pdd': '趋势发现 · 选品参考' };
    const WATERMARKS = { '1688': '&#127981;', 'pdd': '&#128200;' };
    let allProducts = [];
    let expandedSlug = null;
    let lastOrderCount = 0;
    let currentSort = { field: 'score', dir: 'desc' };
    let ordersLastRefresh = null;

    /* === Clock === */
    function tickClock() {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      document.getElementById('clock').textContent =
        d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
        '  ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    tickClock(); setInterval(tickClock, 1000);

    /* === Tabs === */
    const tabScrollPos = { console: 0, products: 0, orders: 0 };
    let currentTab = 'console';

    function switchTab(name) {
      tabScrollPos[currentTab] = window.scrollY;

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      const target = document.getElementById('tab-' + name);
      if (target) target.classList.add('active');

      // 用 onclick 内容匹配按钮
      document.querySelectorAll('.tab-btn').forEach(b => {
        if (b.getAttribute('onclick')?.includes("'" + name + "'")) b.classList.add('active');
      });

      currentTab = name;
      requestAnimationFrame(() => window.scrollTo(0, tabScrollPos[name] || 0));

      if (name === 'products') loadProducts();
      if (name === 'orders') refreshOrders();
      if (name === 'admin') loadAdminPanel();
    }

    /* === Collapse === */
    function toggleCollapse(id) {
      const hdr = document.getElementById(id + '-collapse-hdr');
      const body = document.getElementById(id + '-collapse-body');
      hdr.classList.toggle('collapsed');
      body.classList.toggle('collapsed');
    }

    /* === API helper === */
    async function api(path, method = 'GET') {
      const res = await fetch('/api' + path, { method });
      return res.json();
    }

    /* === Pills === */
    function pillHtml(status) {
      if (status.valid) {
        const d = status.daysUntilExpiry;
        if (d > 7) return '<span class="pill pill-ok"><i></i>' + d + '天</span>';
        if (d > 0) return '<span class="pill pill-warn"><i></i>' + d + '天</span>';
        return '<span class="pill pill-ok"><i></i>在线</span>';
      }
      // 有cookie但关键cookie不足
      if (status.validCookies > 0 && status.missingKeys?.length > 0) {
        return '<span class="pill pill-err"><i></i>需重新登录</span>';
      }
      return '<span class="pill pill-off"><i></i>离线</span>';
    }

    const STAGE_CN = {
      'approved_for_listing': '可上架',
      'supplier_contacted_waiting_reply': '等待回复',
      'human_review_pending': '待审核',
      'supplier_compare_blocked': '比价受阻',
      'supplier_research_pending': '待调研',
      'knowledge_base_ready': '数据就绪',
      'supplier_compare_pending': '比价中',
      'draft_generated': '草稿已生成',
      'listed': '已上架',
      'scraped': '已采集',
      'inferred': '已推理',
      'draft_ready': '草稿就绪',
    };
    function stagePill(stage, errors) {
      if (!stage) return '<span class="stage-pill stage-other">未知</span>';
      if (stage === '有错误') return '<span class="stage-pill" style="background:var(--err-bg);color:var(--err);border:1px solid var(--err-ring);">有错误</span>';
      if (stage === '有警告') return '<span class="stage-pill" style="background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-ring);">有警告</span>';
      const label = STAGE_CN[stage] || stage.replace(/_/g, ' ');
      if (stage === '已上架') return '<span class="stage-pill stage-approved">' + label + '</span>';
      if (stage === '待上架' || stage === '已推理') return '<span class="stage-pill stage-draft">' + label + '</span>';
      if (stage === '已采集') return '<span class="stage-pill stage-evaluated">' + label + '</span>';
      return '<span class="stage-pill stage-other">' + label + '</span>';
    }

    function scoreClass(s) {
      if (s >= 70) return 'score-hi';
      if (s >= 50) return 'score-mid';
      return 'score-lo';
    }

    function orderStatusPill(status) {
      const map = {
        awaiting_packaging: ['os-awaiting', '待打包'],
        awaiting_deliver: ['os-awaiting', '待发货'],
        delivering: ['os-delivering', '配送中'],
        delivered: ['os-delivered', '已送达'],
      };
      const [cls, label] = map[status] || ['os-other', status || '未知'];
      return '<span class="order-status-pill ' + cls + '">' + label + '</span>';
    }

    /* === Stats === */
    async function refreshStats() {
      try {
        const [prods, kw, profit] = await Promise.all([api('/products'), api('/keywords'), api('/ozon/profit').catch(() => null)]);
        document.getElementById('stat-products').textContent = prods.length;

        // 利润数据
        if (profit && profit.total_revenue > 0) {
          document.getElementById('stat-revenue').textContent = profit.total_revenue.toLocaleString();
          const profitEl = document.getElementById('stat-profit');
          profitEl.textContent = profit.total_profit.toLocaleString();
          profitEl.style.color = profit.total_profit >= 0 ? 'var(--ok)' : 'var(--err)';

          // 利润概览
          document.getElementById('profit-overview').style.display = '';
          document.getElementById('profit-avg-margin').textContent = profit.avg_margin + '%';
          document.getElementById('profit-avg-margin').style.color = profit.avg_margin >= 20 ? 'var(--ok)' : profit.avg_margin >= 0 ? 'var(--warn)' : 'var(--err)';
          const pos = (profit.products || []).filter(p => p.actual_profit_rub > 0).length;
          const neg = (profit.products || []).filter(p => p.actual_profit_rub < 0).length;
          document.getElementById('profit-positive').textContent = pos;
          document.getElementById('profit-negative').textContent = neg;
        } else {
          document.getElementById('stat-revenue').textContent = '--';
          document.getElementById('stat-profit').textContent = '--';
        }

        document.getElementById('stat-keywords').textContent = kw.remaining + '/' + kw.total;
      } catch (e) { console.warn('stats:', e.message); }
    }

    async function syncFinance() {
      const statusEl = document.getElementById('finance-sync-status');
      statusEl.textContent = '同步中...';
      try {
        const r = await fetch('/api/ozon/sync-finance', { method: 'POST' });
        const d = await r.json();
        if (d.error) { statusEl.textContent = '失败: ' + d.error; return; }
        statusEl.textContent = '已同步 ' + d.synced + ' 个产品 (' + d.orders + ' 笔订单)';
        refreshStats();
      } catch (e) {
        statusEl.textContent = '失败: ' + e.message;
      }
    }

    /* === Platform refresh === */
    const NO_LOGIN_PLATFORMS = new Set([]);

    function buildTile(p, status, session, ozonCfg) {
      const isNoLogin = NO_LOGIN_PLATFORMS.has(p);
      const tileCls = isNoLogin ? 'live' : (status.valid ? (status.daysUntilExpiry > 7 ? 'live' : 'expiring') : '');
      let h = '<div class="tile plat-' + p + ' ' + tileCls + '">';
      h += '<span class="tile-watermark">' + (WATERMARKS[p] || '') + '</span>';
      h += '<div class="tile-head">';
      h += '<div><div class="tile-label">' + NAMES[p] + '</div><div class="tile-sub">' + SUBS[p] + '</div></div>';

      // 义乌购永远在线（免登录）
      if (isNoLogin) {
        h += '<span class="pill pill-ok"><i></i>免登录</span>';
      } else {
        h += pillHtml(status);
      }
      h += '</div>';

      h += '<div class="kv">';
      if (isNoLogin) {
        h += '<div class="kv-row"><span class="kv-k">模式</span><span class="kv-v" style="color:var(--ok);">纯HTTP · 无需Cookie</span></div>';
        h += '<div class="kv-row"><span class="kv-k">数据源</span><span class="kv-v">en.yiwugo.com (英文站SSR)</span></div>';
        h += '<div class="kv-row"><span class="kv-k">MOQ</span><span class="kv-v">1件起</span></div>';
      } else if (p === 'pdd') {
        if (status.valid) {
          h += '<div class="kv-row"><span class="kv-k">有效令牌</span><span class="kv-v">' + status.validCookies + '</span></div>';
        } else {
          h += '<div class="kv-row"><span class="kv-k">状态</span><span class="kv-v" style="color:var(--t2)">需要授权</span></div>';
        }
        h += '<div class="kv-row"><span class="kv-k">用途</span><span class="kv-v" style="color:var(--info);">趋势发现 · 非采购</span></div>';
      } else if (status.valid) {
        h += '<div class="kv-row"><span class="kv-k">有效令牌</span><span class="kv-v">' + status.validCookies + '</span></div>';
        if (status.daysUntilExpiry > 0) h += '<div class="kv-row"><span class="kv-k">剩余天数</span><span class="kv-v">' + status.daysUntilExpiry + '</span></div>';
      } else if (status.validCookies > 0 && status.missingKeys?.length > 0) {
        h += '<div class="kv-row"><span class="kv-k">状态</span><span class="kv-v" style="color:var(--err);">关键cookie已过期</span></div>';
        h += '<div class="kv-row"><span class="kv-k">缺失</span><span class="kv-v" style="color:var(--err);font-size:11px;">' + status.missingKeys.join(', ') + '</span></div>';
      } else {
        h += '<div class="kv-row"><span class="kv-k">状态</span><span class="kv-v" style="color:var(--t2)">需要授权</span></div>';
      }

      // Ozon额外信息
      if (p === 'ozon' && ozonCfg) {
        if (ozonCfg.clientId) {
          h += '<div class="kv-row"><span class="kv-k">Client-Id</span><span class="kv-v">' + ozonCfg.clientId + '</span></div>';
          h += '<div class="kv-row"><span class="kv-k">API Key</span><span class="kv-v" style="color:var(--ok);">' + (ozonCfg.apiKeyMasked || '已配置') + '</span></div>';
          if (ozonCfg.warehouseName) h += '<div class="kv-row"><span class="kv-k">仓库</span><span class="kv-v">' + ozonCfg.warehouseName + '</span></div>';
        } else {
          h += '<div class="kv-row"><span class="kv-k">API</span><span class="kv-v" style="color:var(--t2);">登录后自动获取</span></div>';
        }
      }
      h += '</div>';

      // 按钮
      if (isNoLogin) {
        h += '<button class="act act-go" onclick="window.open(\\'https://en.yiwugo.com\\',\\'_blank\\')" style="opacity:0.8;">浏览义乌购</button>';
      } else if (session.status === 'waiting_login') {
        h += '<button class="act act-go" onclick="login(\\'' + p + '\\')" style="opacity:0.6">' + (p === 'ozon' ? '登录中...' : '扫码中...') + '</button>';
      } else if (p === 'ozon') {
        h += '<button class="act act-go" onclick="login(\\'ozon\\')">' + (status.valid ? '重新登录' : '登录 Ozon') + '</button>';
      } else {
        h += '<button class="act act-go" onclick="login(\\'' + p + '\\')">' + (status.valid ? '重新授权' : '扫码登录') + '</button>';
      }
      h += '</div>';
      return h;
    }

    async function refresh() {
      const container = document.getElementById('platforms');
      const [s1688, sYiwugo, sPdd, sOzon] = await Promise.all([
        api('/status/1688'), Promise.resolve({valid:true,validCookies:0,daysUntilExpiry:-1}),
        api('/status/pdd'), api('/status/ozon'),
      ]);
      const [e1688, eYiwugo, ePdd, eOzon] = await Promise.all([
        api('/session/1688'), Promise.resolve({}),
        api('/session/pdd'), api('/session/ozon'),
      ]);
      let ozonCfg = null;
      try { ozonCfg = await api('/ozon/config'); } catch {}

      // 数据源: 只显示1688和拼多多
      let html = '<div class="row">';
      html += buildTile('1688', s1688, e1688);
      html += buildTile('pdd', sPdd, ePdd);
      html += '</div>';

      // 只在内容变化时更新DOM（避免闪烁）
      if (container._lastHtml !== html) {
        container.innerHTML = html;
        container._lastHtml = html;
      }
      document.getElementById('pipeline-btn').disabled = !s1688.valid;
    }

    /* === Login === */
    async function login(platform) {
      await api('/login/' + platform, 'POST');
      refresh();
      // 登录期间每3秒轮询状态，完成或超时后停止
      let pollCount = 0;
      const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > 100) { clearInterval(interval); return; } // 5分钟超时
        try {
          const session = await api('/session/' + platform);
          // 只更新这个平台的tile，不替换整个DOM
          if (!session.status || session.status === 'cookie_saved' || session.status === 'error' || session.status === 'timeout') {
            clearInterval(interval);
            refresh(); // 最后刷一次确认最终状态
          }
        } catch { clearInterval(interval); }
      }, 3000);
    }

    /* === 循环控制 === */
    let cycleRefreshTimer = null;

    async function cycleStart() {
      // 前置检查
      try {
        const cfg = await api('/ozon/config');
        if (!cfg.clientId) { alert('请先配置 Ozon API Key 再启动循环'); return; }
      } catch {}
      await fetch('/api/cycle/start', { method: 'POST' });
      cycleRefresh();
      if (!cycleRefreshTimer) cycleRefreshTimer = setInterval(cycleRefresh, 10000);
    }

    async function cycleStop() {
      await fetch('/api/cycle/stop', { method: 'POST' });
      cycleRefresh();
      if (cycleRefreshTimer) { clearInterval(cycleRefreshTimer); cycleRefreshTimer = null; }
    }

    async function cycleRefresh() {
      try {
        const r = await fetch('/api/cycle/status');
        const d = await r.json();
        const pill = document.getElementById('cycle-pill');
        const startBtn = document.getElementById('cycle-start-btn');
        const stopBtn = document.getElementById('cycle-stop-btn');
        const info = document.getElementById('cycle-info');
        const stats = document.getElementById('cycle-stats');
        const logEl = document.getElementById('cycle-log');

        if (d.enabled) {
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>' + (d.running ? '运行中' : '等待下轮');
          startBtn.style.display = 'none';
          stopBtn.style.display = '';
          if (!cycleRefreshTimer) cycleRefreshTimer = setInterval(cycleRefresh, 10000);
        } else {
          pill.className = 'pill pill-off';
          pill.innerHTML = '<i></i>已停止';
          startBtn.style.display = '';
          stopBtn.style.display = 'none';
        }

        info.textContent = '已完成 ' + d.count + ' 轮 | 间隔 ' + d.interval_min + '分钟';
        if (d.last_run) {
          const ago = Math.round((Date.now() - new Date(d.last_run).getTime()) / 60000);
          info.textContent += ' | 上轮 ' + ago + '分钟前';
        }

        // 日志
        if (d.log?.length) {
          logEl.textContent = d.log.join('\\n');
          logEl.scrollTop = logEl.scrollHeight;
          logEl.parentElement.classList.add('open');
        }
      } catch {}
    }

    // 页面加载时检查循环状态
    cycleRefresh();

    /* === Pipeline === */
    async function runPipeline() {
      const panel = document.getElementById('log-panel');
      const logEl = document.getElementById('pipeline-log');
      const statusEl = document.getElementById('log-status');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.innerHTML = '<span class="spinner"></span>running';
      document.getElementById('pipeline-btn').disabled = true;

      try {
        const res = await fetch('/api/pipeline', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logEl.textContent += decoder.decode(value);
          logEl.scrollTop = logEl.scrollHeight;
        }
        statusEl.textContent = 'done';
      } catch (err) {
        logEl.textContent += '\\n错误: ' + err.message;
        statusEl.textContent = 'error';
      }

      statusEl.textContent = 'done';
      document.getElementById('pipeline-btn').disabled = false;
      refresh();
      refreshStats();
    }

    /* === Products === */
    async function loadProducts() {
      try {
        allProducts = await api('/products');
        renderProducts(allProducts);
      } catch {}
    }

    function filterProducts() {
      const q = document.getElementById('product-search').value.toLowerCase().trim();
      if (!q) { renderProducts(allProducts); return; }
      const filtered = allProducts.filter(p => {
        const prod = p.product || {};
        return (prod.name || '').toLowerCase().includes(q) ||
               (prod.category || '').toLowerCase().includes(q) ||
               (p.slug || '').toLowerCase().includes(q);
      });
      renderProducts(filtered);
    }

    function sortProducts(field) {
      if (currentSort.field === field) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.field = field;
        currentSort.dir = field === 'score' ? 'desc' : 'asc';
      }
      // Update header visual
      document.querySelectorAll('.ptable th.sortable').forEach(th => {
        th.classList.remove('sort-active');
        th.querySelector('.sort-arrow').innerHTML = '&#9650;';
      });
      const idx = { name: 0, category: 1, price_rub: 2, price_cny: 3, score: 4 }[field] || 0;
      const ths = document.querySelectorAll('.ptable th.sortable');
      if (ths[idx]) {
        ths[idx].classList.add('sort-active');
        ths[idx].querySelector('.sort-arrow').innerHTML = currentSort.dir === 'asc' ? '&#9650;' : '&#9660;';
      }
      // Sort
      const sorted = [...allProducts].sort((a, b) => {
        const pa = a.product || {}, pb = b.product || {};
        let va, vb;
        switch (field) {
          case 'name': va = (pa.name || ''); vb = (pb.name || ''); break;
          case 'category': va = (pa.category || ''); vb = (pb.category || ''); break;
          case 'price_rub': va = pa.target_price_rub ?? 0; vb = pb.target_price_rub ?? 0; break;
          case 'price_cny': va = pa.supply_price_cny ?? 0; vb = pb.supply_price_cny ?? 0; break;
          case 'score': va = pa.total_score ?? 0; vb = pb.total_score ?? 0; break;
          default: va = 0; vb = 0;
        }
        if (typeof va === 'string') {
          const cmp = va.localeCompare(vb, 'zh-CN');
          return currentSort.dir === 'asc' ? cmp : -cmp;
        }
        return currentSort.dir === 'asc' ? va - vb : vb - va;
      });
      renderProducts(sorted);
    }

    function renderProducts(list) {
      const tbody = document.getElementById('products-tbody');
      document.getElementById('products-count').textContent = list.length + ' 件产品';
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><span class="empty-state-icon">&#128230;</span>暂无产品数据<br><span style="font-size:12px;color:var(--t3);">运行选品后产品将显示在这里</span></div></td></tr>';
        return;
      }
      let html = '';
      for (const item of list) {
        const prod = item.product || {};
        const stage = item.workflow?.current_stage || '未知';
        const score = prod.total_score ?? '--';
        const sc = typeof score === 'number' ? scoreClass(score) : '';
        const slug = item.slug || '';
        const isExpanded = slug === expandedSlug;

        html += '<tr class="prow' + (isExpanded ? ' expanded' : '') + '" onclick="toggleProduct(\\'' + slug + '\\')">';
        html += '<td class="pname">' + (prod.name || slug) + '</td>';
        html += '<td>' + (prod.category || '--') + '</td>';
        html += '<td style="font-family:var(--mono);">' + (prod.target_price_rub ?? '--') + '</td>';
        html += '<td style="font-family:var(--mono);">' + (prod.supply_price_cny ?? '--') + '</td>';
        const profitVal = item.financials?.actual_profit_rub;
        const profitColor = profitVal > 0 ? 'var(--ok)' : profitVal < 0 ? 'var(--err)' : 'var(--t3)';
        html += '<td style="font-family:var(--mono);color:' + profitColor + ';">' + (profitVal != null ? Math.round(profitVal) + '₽' : '--') + '</td>';
        const dotCls = typeof score === 'number' ? (score >= 70 ? 'score-dot-hi' : score >= 50 ? 'score-dot-mid' : 'score-dot-lo') : '';
        html += '<td class="pscore ' + sc + '">' + (dotCls ? '<span class="score-dot ' + dotCls + '"></span>' : '') + score + '</td>';
        html += '<td>' + stagePill(stage, item.errors) + '</td>';
        html += '</tr>';

        // 错误详情行
        if (item.errors && (item.errors.severe?.length || item.errors.warn?.length)) {
          html += '<tr style="background:' + (item.errors.severe?.length ? 'var(--err-bg)' : 'var(--warn-bg)') + ';"><td colspan="7" style="padding:4px 12px;font-size:11px;">';
          if (item.errors.severe?.length) html += '<span style="color:var(--err);">严重: ' + item.errors.severe.join(', ') + '</span> ';
          if (item.errors.warn?.length) html += '<span style="color:var(--warn);">警告: ' + item.errors.warn.join(', ') + '</span>';
          html += '</td></tr>';
        }

        if (isExpanded) {
          html += '<tr class="pdetail-row"><td colspan="7"><div class="pdetail">';
          html += '<div class="pdetail-grid">';

          html += '<div>';
          if (prod.why_it_can_sell) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">卖点分析</div>';
            html += '<p>' + prod.why_it_can_sell + '</p></div>';
          }
          if (prod.source_url) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">来源</div>';
            html += '<a href="' + prod.source_url + '" target="_blank">' + prod.source_url.slice(0, 60) + '...</a></div>';
          }
          if (prod.risk_notes?.length) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">风险备注</div>';
            html += '<p>' + prod.risk_notes.join('; ') + '</p></div>';
          }
          if (prod.issue_summary?.length) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">问题</div>';
            html += '<p>' + prod.issue_summary.join('; ') + '</p></div>';
          }
          html += '</div>';

          html += '<div>';
          if (prod.score_breakdown) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">评分明细</div>';
            html += '<div class="score-breakdown">';
            for (const [k, v] of Object.entries(prod.score_breakdown)) {
              html += '<span class="score-chip">' + k.replace(/_/g, ' ') + ': <strong>' + v + '</strong></span>';
            }
            html += '</div></div>';
          }

          const extras = ['est_weight_kg', 'fragility', 'certification_risk', 'return_risk', 'competition_level', 'seasonality'];
          const extraLabels = { est_weight_kg: '重量(kg)', fragility: '易碎度', certification_risk: '认证风险', return_risk: '退货风险', competition_level: '竞争度', seasonality: '季节性' };
          html += '<div class="pdetail-section"><div class="pdetail-section-title">属性</div><div class="kv">';
          for (const k of extras) {
            if (prod[k] != null) {
              html += '<div class="kv-row"><span class="kv-k">' + (extraLabels[k] || k) + '</span><span class="kv-v">' + prod[k] + '</span></div>';
            }
          }
          html += '</div></div>';
          html += '</div>';

          html += '</div></div></td></tr>';
        }
      }
      tbody.innerHTML = html;
    }

    function toggleProduct(slug) {
      expandedSlug = expandedSlug === slug ? null : slug;
      filterProducts();
    }

    /* === Ozon API Config === */
    async function loadOzonConfig() {
      try {
        const res = await fetch('/api/ozon/config');
        const cfg = await res.json();
        if (cfg.clientId) {
          document.getElementById('ozon-client-id').value = cfg.clientId;
          document.getElementById('ozon-api-key').placeholder = cfg.apiKeyMasked || '已保存';
          const pill = document.getElementById('ozon-cfg-pill');
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>已配置';
          const tile = document.getElementById('ozon-cfg-tile');
          tile.classList.add('live');
          document.getElementById('ozon-cfg-status').textContent = '';
          document.getElementById('ozon-cfg-status').className = 'cfg-status connected';
          // Show meta if available
          if (cfg.warehouseId) {
            const meta = document.getElementById('ozon-cfg-meta');
            meta.style.display = 'flex';
            document.getElementById('cfg-wh-id').textContent = cfg.warehouseId;
            document.getElementById('cfg-wh-name').textContent = cfg.warehouseName || '--';
            document.getElementById('cfg-currency').textContent = cfg.currency || 'CNY';
          }
        }
      } catch {}
    }

    async function saveOzonConfig() {
      const clientId = document.getElementById('ozon-client-id').value.trim();
      const apiKey = document.getElementById('ozon-api-key').value.trim();
      if (!clientId) { alert('请输入 Client-Id'); return; }
      const body = { clientId };
      if (apiKey) body.apiKey = apiKey;
      try {
        const res = await fetch('/api/ozon/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const r = await res.json();
        if (r.ok) {
          document.getElementById('ozon-cfg-status').textContent = '配置已保存';
          document.getElementById('ozon-cfg-status').className = 'cfg-status connected';
          const checkEl = document.getElementById('cfg-save-check');
          checkEl.innerHTML = '<span class="cfg-saved-check">&#10003; 已保存</span>';
          setTimeout(() => { checkEl.innerHTML = ''; }, 3000);
          loadOzonConfig();
          checkSetupGuide(); // 重新检查设置完成状态
        } else {
          document.getElementById('ozon-cfg-status').textContent = '保存失败: ' + (r.error || '未知错误');
          document.getElementById('ozon-cfg-status').className = 'cfg-status disconnected';
        }
      } catch (e) {
        document.getElementById('ozon-cfg-status').textContent = '保存失败: ' + e.message;
        document.getElementById('ozon-cfg-status').className = 'cfg-status disconnected';
      }
    }

    async function testOzonConnection() {
      const st = document.getElementById('ozon-cfg-status');
      st.innerHTML = '<span class="spinner"></span>测试连接中...';
      st.className = 'cfg-status';
      try {
        const res = await fetch('/api/ozon/check');
        const r = await res.json();
        if (r.ok) {
          st.textContent = '连接成功! 仓库: ' + r.warehouse_name + ' (' + r.warehouse_id + ')';
          st.className = 'cfg-status connected';
          const pill = document.getElementById('ozon-cfg-pill');
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>已连接';
          document.getElementById('ozon-cfg-tile').classList.add('live');
          // Update meta
          const meta = document.getElementById('ozon-cfg-meta');
          meta.style.display = 'flex';
          document.getElementById('cfg-wh-id').textContent = r.warehouse_id;
          document.getElementById('cfg-wh-name').textContent = r.warehouse_name || '--';
          document.getElementById('cfg-currency').textContent = r.currency || 'CNY';
        } else {
          st.textContent = '连接失败: ' + (r.error || '未知错误');
          st.className = 'cfg-status disconnected';
        }
      } catch (e) {
        st.textContent = '请求失败: ' + e.message;
        st.className = 'cfg-status disconnected';
      }
    }

    /* === Orders === */
    async function refreshOrders() {
      const filterEl = document.getElementById('order-status-filter');
      const statusFilter = filterEl ? filterEl.value : 'awaiting_packaging';
      ordersLastRefresh = Date.now();
      const updateEl = document.getElementById('orders-last-update');
      if (updateEl) updateEl.textContent = '刷新中...';
      try {
        // 加载1688溯源映射（offer_id → source_url）
        let orderSourceMap = {};
        try {
          const prods = await api('/products');
          for (const p of prods) {
            const slug = p.slug || '';
            const srcUrl = p.source?.detail_url || p.research?.outreach?.supplier_product_url || '';
            if (slug && srcUrl) orderSourceMap[slug] = srcUrl;
          }
        } catch {}

        const res = await fetch('/api/ozon/orders?status=' + encodeURIComponent(statusFilter));
        const r = await res.json();
        if (updateEl) updateEl.textContent = '最后更新: 刚刚';
        // Update both tab badge and in-tab count
        const countTabEl = document.getElementById('orders-count-tab');
        const badgeEl = document.getElementById('orders-badge');
        const listEl = document.getElementById('orders-list-tab');

        if (r.error) {
          countTabEl.textContent = '--';
          listEl.innerHTML = '<div style="font-size:13px;color:var(--t2);">' + r.error + '</div>';
          return;
        }
        const orders = r.orders || [];
        lastOrderCount = orders.length;
        countTabEl.textContent = orders.length;
        if (orders.length > 0) {
          badgeEl.textContent = orders.length;
          badgeEl.style.display = 'inline-flex';
        } else {
          badgeEl.style.display = 'none';
        }
        if (orders.length === 0) {
          listEl.innerHTML = '<div style="font-size:13px;color:var(--t2);">暂无订单</div>';
          return;
        }
        let html = '';
        for (const o of orders) {
          const pn = o.posting_number || '';
          const items = (o.products || []).map(p => p.name || p.offer_id).join(', ');
          const qty = (o.products || []).reduce((s, p) => s + (p.quantity || 0), 0);
          const created = o.created_at ? new Date(o.created_at).toLocaleString('zh-CN') : '';
          const st = o.status || '';
          const totalPrice = (o.products || []).reduce((s, p) => s + parseFloat(p.price || 0) * (p.quantity || 1), 0);

          html += '<div class="order-card">';
          html += '<div class="order-info">';
          html += '<div style="display:flex;gap:10px;align-items:center;">';
          html += '<div class="order-id">' + pn + '</div>';
          html += orderStatusPill(st);
          html += '</div>';
          html += '<div class="order-detail">' + items.slice(0, 80) + (items.length > 80 ? '...' : '') + ' (' + qty + '件)</div>';
          html += '<div class="order-detail">' + created + '</div>';
          // 采购按钮：每个商品显示货源链接
          const offerIds = (o.products || []).map(p => p.offer_id).filter(Boolean);
          for (const oid of offerIds) {
            const name = (o.products || []).find(p => p.offer_id === oid)?.name || oid;
            const sourceUrl = orderSourceMap[oid];
            // 1688直达链接
            if (sourceUrl) {
              html += '<div class="order-detail"><a href="' + sourceUrl + '" target="_blank" style="color:var(--accent);font-size:12px;font-weight:500;">🛒 去1688采购</a></div>';
            }
            // 搜索备选链接
            const searchName = encodeURIComponent(name.slice(0, 30));
            html += '<div class="order-detail" style="display:flex;gap:8px;">';
            if (!sourceUrl) {
              html += '<a href="https://s.1688.com/selloffer/offer_search.htm?keywords=' + searchName + '" target="_blank" style="color:var(--accent);font-size:11px;">1688搜索</a>';
            }
            html += '<a href="https://en.yiwugo.com/product/list.html?keyword=' + searchName + '" target="_blank" style="color:#f472b6;font-size:11px;">义乌购搜索</a>';
            html += '<button class="act" style="font-size:10px;padding:2px 8px;" onclick="goSource(\\'' + oid + '\\')">查货源</button>';
            html += '</div>';
          }
          html += '</div>';
          html += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">';
          if (totalPrice > 0) {
            html += '<div class="order-total">' + totalPrice.toFixed(2) + '</div>';
          }
          html += '<div class="order-actions">';
          if (st === 'awaiting_packaging' || st === 'awaiting_deliver') {
            html += '<button class="act act-dl" onclick="downloadLabel(\\'' + pn + '\\')">📄 面单</button>';
          }
          html += '</div>';
          html += '</div>';
          html += '</div>';
        }
        listEl.innerHTML = html;
      } catch (e) {
        document.getElementById('orders-count-tab').textContent = '--';
        document.getElementById('orders-list-tab').innerHTML = '<div style="font-size:13px;color:var(--t2);">加载失败: ' + e.message + '</div>';
      }
    }

    async function goSource(offerId) {
      try {
        const res = await fetch('/api/source/' + encodeURIComponent(offerId));
        const r = await res.json();
        if (r.source_url) {
          window.open(r.source_url, '_blank');
        } else if (r.search_url) {
          window.open(r.search_url, '_blank');
        } else {
          alert('未找到货源链接: ' + offerId);
        }
      } catch (e) {
        alert('查询失败: ' + e.message);
      }
    }

    function downloadLabel(postingNumber) {
      window.open('/api/ozon/label/' + encodeURIComponent(postingNumber), '_blank');
    }

    /* === Error Check & Fix === */
    async function checkErrors() {
      const pill = document.getElementById('error-check-pill');
      const summary = document.getElementById('error-summary');
      const list = document.getElementById('error-list');
      const fixBtn = document.getElementById('fix-btn');
      pill.className = 'pill pill-off';
      pill.innerHTML = '<i></i>扫描中...';
      summary.textContent = '';
      list.innerHTML = '';

      try {
        const res = await fetch('/api/ozon/errors');
        const r = await res.json();
        if (r.error) {
          pill.innerHTML = '<i></i>' + r.error;
          return;
        }

        const total = r.totalProducts || 0;
        const severe = r.totalSevere || 0;
        const warn = r.totalWarn || 0;
        const prods = r.products || [];

        if (severe === 0 && warn === 0) {
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>零错误';
          summary.innerHTML = '<span style="color:var(--ok);">' + total + ' 个产品全部通过检查</span>';
          fixBtn.style.display = 'none';
          return;
        }

        pill.className = severe > 0 ? 'pill pill-err' : 'pill pill-warn';
        pill.innerHTML = '<i></i>' + (severe > 0 ? severe + ' 严重' : '') + (warn > 0 ? ' ' + warn + ' 警告' : '');
        summary.innerHTML = total + ' 个已上架, <span style="color:var(--err);">' + severe + ' 严重错误</span>, <span style="color:var(--warn);">' + warn + ' 警告</span>';

        if (severe > 0) fixBtn.style.display = 'inline-flex';

        let html = '';
        for (const p of prods) {
          const icon = p.severe.length > 0 ? '<span style="color:var(--err);">&#9679;</span>' : '<span style="color:var(--warn);">&#9679;</span>';
          html += '<div style="padding:8px 0;border-bottom:1px solid var(--edge);font-size:12px;">';
          html += icon + ' <strong>' + p.offer_id + '</strong> (pid=' + p.product_id + ')';
          for (const e of p.severe) {
            html += '<div style="margin-left:16px;color:var(--err);">[严重] ' + e.code + (e.attr_name ? ' (' + e.attr_name + ')' : '') + '</div>';
            html += '<div style="margin-left:16px;color:var(--t2);font-size:11px;">' + e.desc + '</div>';
          }
          for (const e of p.warnings) {
            html += '<div style="margin-left:16px;color:var(--warn);">[警告] ' + e.code + (e.attr_name ? ' (' + e.attr_name + ')' : '') + '</div>';
            html += '<div style="margin-left:16px;color:var(--t2);font-size:11px;">' + e.desc + '</div>';
          }
          html += '</div>';
        }
        list.innerHTML = html;
      } catch (e) {
        pill.innerHTML = '<i></i>检查失败';
        summary.textContent = e.message;
      }
    }

    async function runAutoFix() {
      const panel = document.getElementById('fix-log-panel');
      const logEl = document.getElementById('fix-log');
      const statusEl = document.getElementById('fix-log-status');
      const btn = document.getElementById('fix-btn');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.textContent = 'running';
      btn.disabled = true;
      btn.textContent = '修复中...';

      try {
        const res = await fetch('/api/ozon/fix', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line.trim());
              if (msg.type === 'log' || msg.type === 'error') {
                logEl.textContent += (msg.message || '') + '\\n';
              } else if (msg.type === 'done') {
                logEl.textContent += '\\n' + msg.message + '\\n';
                statusEl.textContent = 'done';
              }
            } catch {
              logEl.textContent += line.trim() + '\\n';
            }
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
      } catch (e) {
        logEl.textContent += '错误: ' + e.message;
        statusEl.textContent = 'error';
      }

      btn.disabled = false;
      btn.textContent = '一键修复';
      // Re-check errors
      setTimeout(checkErrors, 2000);
    }

    /* === Smart Link Import === */
    async function runSmartImport() {
      const urlInput = document.getElementById('import-url');
      const url = urlInput.value.trim();
      if (!url) { alert('请粘贴商品链接'); return; }

      const panel = document.getElementById('import-log-panel');
      const logEl = document.getElementById('import-log');
      const statusEl = document.getElementById('import-log-status');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.textContent = 'running';

      try {
        const res = await fetch('/api/smart-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logEl.textContent += decoder.decode(value);
          logEl.scrollTop = logEl.scrollHeight;
        }
        statusEl.textContent = 'done';
        urlInput.value = '';
        refreshStats();
      } catch (err) {
        logEl.textContent += '\\n错误: ' + err.message;
        statusEl.textContent = 'error';
      }
    }

    /* === Admin Panel === */
    async function loadAdminPanel() {
      try {
        const r = await api('/admin/users');
        if (r.error) return;

        // 统计卡片
        const s = r.stats || {};
        document.getElementById('admin-stats').innerHTML = [
          ['用户总数', s.total_users, '#059669'],
          ['API调用', s.total_api_calls, '#3b82f6'],
          ['LLM Token', s.total_llm_tokens, '#8b5cf6'],
          ['今日活跃', s.active_today, '#f59e0b'],
        ].map(([label, val, color]) =>
          '<div class="stat-card" style="flex:1;min-width:120px;border-left:3px solid ' + color + '"><div class="stat-val">' + (val || 0) + '</div><div class="stat-label">' + label + '</div></div>'
        ).join('');

        // 用户表格
        const tbody = document.getElementById('admin-users-tbody');
        tbody.innerHTML = (r.users || []).map(u =>
          '<tr>' +
          '<td>' + u.id + '</td>' +
          '<td>' + u.email + (u.is_admin ? ' <span style="color:var(--accent);font-size:11px;">(管理员)</span>' : '') + '</td>' +
          '<td>' + u.plan + '</td>' +
          '<td>' + u.product_quota + '</td>' +
          '<td>' + u.products_used + '</td>' +
          '<td style="font-family:var(--mono);">' + (u.api_calls || 0) + '</td>' +
          '<td style="font-family:var(--mono);">' + (u.llm_tokens || 0) + '</td>' +
          '<td style="font-size:11px;color:var(--t3);">' + (u.created_at || '').slice(0, 10) + '</td>' +
          '<td><select onchange="changeUserPlan(' + u.id + ', this.value)" style="font-size:12px;padding:2px 4px;">' +
            '<option value="free:10"' + (u.plan === 'free' ? ' selected' : '') + '>free(10)</option>' +
            '<option value="basic:100"' + (u.plan === 'basic' ? ' selected' : '') + '>basic(100)</option>' +
            '<option value="pro:500"' + (u.plan === 'pro' ? ' selected' : '') + '>pro(500)</option>' +
            '<option value="vip:9999"' + (u.plan === 'vip' ? ' selected' : '') + '>vip(无限)</option>' +
          '</select></td>' +
          '</tr>'
        ).join('');

        // 邀请码列表
        const invR = await api('/admin/invites');
        if (invR.codes?.length) {
          document.getElementById('invite-list').innerHTML =
            '<div style="font-size:12px;color:var(--t3);margin-bottom:6px;">已有邀请码:</div>' +
            invR.codes.map(c =>
              '<div style="display:flex;gap:8px;align-items:center;margin:4px 0;font-size:12px;">' +
              '<code style="background:var(--s2);padding:2px 8px;border-radius:4px;font-family:var(--mono);">' + c.code + '</code>' +
              '<span>' + c.plan + '(' + c.quota + ')</span>' +
              '<span style="color:var(--t3);">用' + c.used_count + '/' + c.max_uses + '</span>' +
              '</div>'
            ).join('');
        }
      } catch (e) { console.warn('admin load fail:', e); }
    }

    async function createInvite() {
      const planMap = { basic: 100, pro: 500, vip: 9999 };
      const plan = document.getElementById('invite-plan').value;
      const maxUses = parseInt(document.getElementById('invite-max').value) || 10;
      const r = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, quota: planMap[plan] || 100, maxUses }),
      }).then(r => r.json());
      if (r.code) {
        document.getElementById('invite-result').innerHTML =
          '<span style="color:var(--accent);">邀请码: <strong>' + r.code + '</strong> (' + r.plan + ', ' + r.quota + '配额, ' + maxUses + '次)</span>';
        loadAdminPanel(); // 刷新列表
      }
    }

    async function changeUserPlan(userId, val) {
      const [plan, quota] = val.split(':');
      await fetch('/api/admin/user/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, plan, quota: parseInt(quota) }),
      });
      loadAdminPanel();
    }

    /* === Setup Guide === */
    async function checkSetupGuide() {
      const overlay = document.getElementById('setup-overlay');
      const steps = document.getElementById('setup-steps');
      const issues = [];

      // 1. Ozon API
      try {
        const cfg = await api('/ozon/config');
        if (!cfg.clientId) issues.push({ text: '配置 Ozon API Key', action: "document.getElementById('setup-overlay').style.display='none';document.getElementById('cfg-collapse-body').style.maxHeight='600px';document.getElementById('ozon-client-id').focus();document.getElementById('ozon-client-id').scrollIntoView({behavior:'smooth',block:'center'})", done: false });
        else issues.push({ text: 'Ozon API 已配置', done: true });
      } catch { issues.push({ text: '配置 Ozon API Key', done: false }); }

      // 2. 1688 登录
      const login1688Action = "document.getElementById('setup-overlay').style.display='none';alert('即将打开1688登录窗口，请用手机扫码登录');setTimeout(function(){login('1688');},800)";
      try {
        const r = await fetch('/api/session-status');
        const d = await r.json();
        const s1688 = d['1688'];
        if (s1688?.valid) issues.push({ text: '1688 已登录', done: true });
        else issues.push({ text: '登录 1688 采集账号', action: login1688Action, done: false });
      } catch { issues.push({ text: '登录 1688 采集账号', action: login1688Action, done: false }); }

      const incomplete = issues.filter(i => !i.done);
      if (incomplete.length === 0) {
        overlay.style.display = 'none';
      } else {
        overlay.style.display = 'flex';
        steps.innerHTML = issues.map(i => {
          const icon = i.done ? '<span style="color:var(--ok);">&#10003;</span>' : '<span style="color:var(--warn);">&#9679;</span>';
          const link = !i.done && i.action ? ' <a href="javascript:void(0)" onclick="' + i.action + '" style="color:var(--accent);font-size:13px;font-weight:500;">去设置 &rarr;</a>' : '';
          const style = i.done ? 'color:var(--t3);text-decoration:line-through;' : 'font-weight:500;';
          return '<div style="' + style + '">' + icon + ' ' + i.text + link + '</div>';
        }).join('');
      }
    }

    /* === Init === */
    refresh();
    refreshStats();
    loadOzonConfig();
    refreshOrders();
    checkSetupGuide();
    // 数据源只在页面首次加载时刷一次，不自动轮询（避免闪烁）
    // 统计和订单低频刷新
    setInterval(refreshStats, 60000);  // 统计: 60秒
    setInterval(refreshOrders, 120000); // 订单: 2分钟
    // Update orders "last updated" display
    setInterval(() => {
      if (!ordersLastRefresh) return;
      const secs = Math.round((Date.now() - ordersLastRefresh) / 1000);
      const el = document.getElementById('orders-last-update');
      if (el) {
        if (secs < 5) el.textContent = '最后更新: 刚刚';
        else if (secs < 60) el.textContent = '最后更新: ' + secs + ' 秒前';
        else el.textContent = '最后更新: ' + Math.round(secs / 60) + ' 分钟前';
      }
    }, 5000);
  </script>
  </div><!-- .app-main -->
  </div><!-- .app-layout -->
</body>
</html>`;
