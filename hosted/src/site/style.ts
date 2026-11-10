/**
 * The website's stylesheet, inlined in every page. RIVI Software's colours as src/brand.ts and the
 * hosted server's pages have them: ink, paper and the signal green, light and dark. Headings are
 * set as the lockup is (assets/README.md): Bricolage Grotesque at weight 600, tracked -0.02em.
 */

export const FONT_PATH = "/fonts/bricolage-grotesque-600.woff2";

export const STYLE = `
@font-face{font-family:"Bricolage Grotesque";font-weight:600;font-style:normal;font-display:swap;src:url("${FONT_PATH}") format("woff2")}
:root{color-scheme:light dark;--ink:#15171a;--paper:#fbfbfa;--surface:#fff;--muted:#5b6068;--line:#dcdfe3;--green:#0e9f55;--green-ink:#0a7a41;--on-green:#fff;--code:#f0f2f4;--tile:#15171a;--bars:#f5f6f7;--signal:#3be08a;--error:#b3261e;--warning:#8a5a00;--info:#4a5568;--error-bg:#fdecea;--warning-bg:#fff4d6;--info-bg:#eef0f3;--add:#e6f6ec;--del:#fdecea}
@media (prefers-color-scheme:dark){:root{--ink:#eceef1;--paper:#111315;--surface:#181b1e;--muted:#a3a9b1;--line:#2c3036;--green:#3be08a;--green-ink:#3be08a;--on-green:#0b1f14;--code:#1b1e22;--tile:#f5f6f7;--bars:#15171a;--signal:#0e9f55;--error:#ff8a80;--warning:#f2c04d;--info:#a3a9b1;--error-bg:#3a1c1a;--warning-bg:#33290f;--info-bg:#22262b;--add:#12301f;--del:#3a1c1a}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:68rem;margin:0 auto;padding:0 1.25rem}
.prose{max-width:46rem}
a{color:var(--green-ink)}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--green);outline-offset:2px}
h1,h2,h3,.brand{font-family:"Bricolage Grotesque",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:600;letter-spacing:-.02em}
h1{font-size:clamp(2.1rem,5vw,3.4rem);line-height:1.08;margin:0 0 1rem}
h2{font-size:clamp(1.5rem,3vw,2rem);line-height:1.2;margin:0 0 .75rem}
h3{font-size:1.15rem;line-height:1.3;margin:1.5rem 0 .35rem}
p{margin:0 0 1rem}
code,pre{font:14.5px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
code{background:var(--code);border-radius:5px;padding:.1rem .3rem;overflow-wrap:anywhere}
pre{background:var(--code);border-radius:8px;padding:.75rem 1rem;margin:0 0 1rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{background:none;padding:0}
.site-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;padding-top:1.1rem;padding-bottom:1.1rem}
.brand{display:flex;align-items:center;gap:10px;font-size:20px;line-height:1;color:var(--ink);text-decoration:none}
.brand svg{flex:none}
.site-nav{display:flex;gap:1.25rem;flex-wrap:wrap;font-size:.98rem}
.site-nav a{color:var(--ink);text-decoration:none}
.site-nav a:hover,.site-nav a[aria-current]{text-decoration:underline;text-decoration-color:var(--green);text-decoration-thickness:2px;text-underline-offset:5px}
.hero{padding:3.5rem 0 2.5rem}
.eyebrow{display:inline-flex;align-items:center;gap:.5rem;margin:0 0 1rem;font-size:.9rem;color:var(--muted)}
.eyebrow::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:var(--green)}
.lead{font-size:1.2rem;color:var(--muted);max-width:42rem}
.audit-card{margin-top:2rem;padding:1.25rem;background:var(--surface);border:1px solid var(--line);border-radius:14px;max-width:46rem}
.audit-card label{display:block;font-weight:600;margin-bottom:.5rem}
.audit-row{display:flex;gap:.6rem;flex-wrap:wrap}
.audit-row input{flex:1 1 16rem;min-width:0;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:.7rem .85rem}
.button{font:inherit;font-weight:600;color:var(--on-green);background:var(--green);border:0;border-radius:9px;padding:.7rem 1.2rem;cursor:pointer}
.button:disabled{opacity:.65;cursor:progress}
.button.quiet{color:var(--ink);background:none;border:1px solid var(--line);font-weight:500;padding:.45rem .8rem;font-size:.95rem}
.hint{margin:.75rem 0 0;font-size:.92rem;color:var(--muted)}
.notice{margin:1rem 0 0;padding:.75rem 1rem;border-radius:9px;background:var(--error-bg);color:var(--ink);border-left:4px solid var(--error)}
.band{padding:3rem 0;border-top:1px solid var(--line)}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));margin:1.5rem 0 0;padding:0;list-style:none}
.card{padding:1.1rem 1.2rem;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.card h3{margin-top:0}
.card p:last-child,.card pre:last-child{margin-bottom:0}
.count{color:var(--muted);font-size:.92rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem}
th,td{text-align:left;vertical-align:top;padding:.45rem .6rem .45rem 0;border-bottom:1px solid var(--line)}
th{font-size:.9rem;color:var(--muted);font-weight:600}
.table-scroll{overflow-x:auto}
.report{padding-bottom:3rem}
.report-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem}
.report-head p{margin:0;color:var(--muted);overflow-wrap:anywhere}
.report-actions{display:flex;gap:.5rem;flex-wrap:wrap}
.scores{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));margin-bottom:2rem}
.score{display:flex;align-items:center;gap:1rem;color:var(--ink);text-decoration:none}
.score-number{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:600;font-size:2.6rem;line-height:1;letter-spacing:-.02em;min-width:4.2rem}
.score-number small{font-size:1rem;color:var(--muted);letter-spacing:0}
.score-name{font-weight:600;margin:0}
.score-counts{margin:0;color:var(--muted);font-size:.95rem}
.facts{display:grid;grid-template-columns:minmax(7rem,max-content) 1fr;gap:.3rem 1rem;margin:0 0 1.5rem}
.facts dt{color:var(--muted)}
.facts dd{margin:0;overflow-wrap:anywhere}
.findings{display:grid;gap:.6rem;margin:0 0 2.5rem}
.finding{background:var(--surface);border:1px solid var(--line);border-radius:10px;border-left-width:4px}
.finding.sev-error{border-left-color:var(--error)}
.finding.sev-warning{border-left-color:var(--warning)}
.finding.sev-info{border-left-color:var(--info)}
.finding>summary{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;padding:.7rem .9rem;cursor:pointer;list-style:none}
.finding>summary::-webkit-details-marker{display:none}
.finding>summary .msg{flex:1 1 18rem}
.sev{flex:none;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:5px;padding:.1rem .45rem}
.sev-error .sev{color:var(--error);background:var(--error-bg)}
.sev-warning .sev{color:var(--warning);background:var(--warning-bg)}
.sev-info .sev{color:var(--info);background:var(--info-bg)}
.finding-body{padding:0 .9rem .9rem;border-top:1px solid var(--line);padding-top:.8rem}
.finding-body>:last-child{margin-bottom:0}
.edits{margin:0 0 1rem;padding-left:1.2rem}
.edits li{margin-bottom:.75rem}
.edit-head{margin:0 0 .35rem;font-size:.95rem}
.edit-label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:.15rem}
pre.current{background:var(--del)}
pre.code{background:var(--add)}
.edits pre{margin-bottom:.5rem}
.evidence summary{cursor:pointer;color:var(--muted);font-size:.95rem}
.evidence pre{margin-top:.5rem;max-height:18rem;overflow:auto}
.rule{padding:1rem 0;border-bottom:1px solid var(--line)}
.rule h3{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:0 0 .35rem;font-family:inherit;letter-spacing:0;font-size:1rem}
.rule p{margin:0 0 .35rem}
.toc{columns:3 12rem;padding:0;list-style:none;margin:1rem 0 0}
.toc li{margin-bottom:.3rem}
.site-footer{margin-top:1rem;padding:1.75rem 0 2.5rem;border-top:1px solid var(--line);color:var(--muted);font-size:.95rem}
.site-footer p{max-width:52rem}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.button{transition:opacity .15s}}
`;
