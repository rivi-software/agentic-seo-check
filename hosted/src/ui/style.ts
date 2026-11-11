/**
 * The stylesheet of every page on both hostnames, inlined in each: RIVI Software's look as
 * rivi.software has it. Dark only, set in Geist and Geist Mono, with its tokens (the ink ground,
 * hairlines in white, the signal green), its glow behind the hero, its windows with a catch of
 * light on the top edge, and its pills and buttons. The parts are split by what they style.
 */

/** Where both hostnames serve the fonts (ui/fonts.ts). */
export const FONT_PATHS = {
  sans: "/fonts/geist-latin.woff2",
  mono: "/fonts/geist-mono-latin.woff2",
} as const;

/** rivi.software's tokens, and the severity colours of its status page. */
const TOKENS = `
@font-face{font-family:"Geist";font-style:normal;font-weight:100 900;font-display:swap;src:url("${FONT_PATHS.sans}") format("woff2")}
@font-face{font-family:"Geist Mono";font-style:normal;font-weight:100 900;font-display:swap;src:url("${FONT_PATHS.mono}") format("woff2")}
:root{color-scheme:dark;--bg:#08090a;--bg-raised:#0f1011;--bg-raised-2:#141517;--bg-inset:#0b0c0d;--bg-hover:#ffffff0a;--line-faint:#ffffff0d;--line:#ffffff14;--line-strong:#ffffff29;--text:#f7f8f8;--text-body:#d0d6e0;--text-muted:#8a8f98;--text-faint:#7b8089;--signal:#3be08a;--signal-text:#5ee89f;--signal-cue:#0e9f55;--signal-soft:#3be08a24;--error:#f0675f;--error-text:#f28b82;--error-soft:#f0675f1f;--warning:#f2a33a;--warning-text:#f5b866;--warning-soft:#f2a33a1f;--info:#6aa6f5;--info-text:#8dbaf7;--info-soft:#6aa6f51f;--btn-bg:#e9eaeb;--btn-bg-hover:#fff;--btn-text:#08090a;--logo-tile:#f7f8f8;--logo-bars:#08090a;--radius-btn:8px;--radius-card:12px;--radius-window:14px;--shadow-panel:0 24px 60px -28px #000c;--shadow-window:0 40px 120px -40px #000000d9;--ease:cubic-bezier(.2,.7,.2,1);--ease-out:cubic-bezier(.16,1,.3,1);--header-h:64px;--section:104px;--sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
`;

const BASE = `
*,::before,::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--header-h) + 24px);scrollbar-color:#2a2c30 transparent}
body{margin:0;background:var(--bg);color:var(--text-body);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-x:clip}
::selection{color:#fff;background:#3be08a47}
h1,h2,h3,h4{margin:0;color:var(--text);font-weight:500;text-wrap:balance}
h1{font-size:clamp(2.6rem,6.2vw,4.6rem);line-height:1.03;letter-spacing:-.035em}
h2{font-size:clamp(1.9rem,3.6vw,2.8rem);line-height:1.08;letter-spacing:-.028em}
h3{font-size:1.125rem;line-height:1.35;letter-spacing:-.01em}
h4{font-size:.75rem;line-height:1.4;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint)}
p{margin:0}
ul,ol{margin:0;padding:0}
a{color:var(--text);text-decoration:underline;text-decoration-color:var(--line-strong);text-decoration-thickness:1px;text-underline-offset:4px;transition:text-decoration-color .16s,color .16s}
a:hover{text-decoration-color:var(--signal)}
:focus-visible{outline:2px solid var(--signal);outline-offset:3px}
strong{color:var(--text);font-weight:600}
code,pre{font-family:var(--mono)}
code{font-size:.86em;color:var(--text);background:var(--bg-raised-2);border:1px solid var(--line);border-radius:6px;padding:.08em .38em;overflow-wrap:anywhere}
pre{margin:0;padding:14px 16px;background:var(--bg-inset);border:1px solid var(--line);border-radius:10px;font-size:.8125rem;line-height:1.65;color:var(--text-body);white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:auto;scrollbar-width:thin}
pre code{font-size:inherit;color:inherit;background:none;border:0;border-radius:0;padding:0;overflow-wrap:inherit}
table{width:100%;border-collapse:collapse}
.wrap{width:100%;max-width:1200px;margin-inline:auto;padding-inline:24px}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip-link{position:fixed;top:12px;left:12px;z-index:100;padding:10px 14px;border-radius:var(--radius-btn);background:var(--text);color:var(--bg);font-size:.875rem;font-weight:500;text-decoration:none;transform:translateY(-160%)}
.skip-link:focus{transform:none}
.icon{width:16px;height:16px;flex:none}
main:focus{outline:0}
`;

const HEADER = `
.site-header{position:sticky;top:0;z-index:50;background:#08090ac7;-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);border-bottom:1px solid var(--line-faint)}
.header-inner{display:flex;align-items:center;gap:20px;height:var(--header-h)}
.site-logo{display:inline-flex;align-items:center;gap:10px;min-height:44px;color:var(--text);font-size:1rem;font-weight:600;letter-spacing:-.02em;line-height:1;white-space:nowrap;text-decoration:none}
.site-logo svg{flex:none;width:28px;height:28px}
.nav{display:flex;gap:2px}
.nav a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:var(--radius-btn);color:var(--text-muted);font-size:.875rem;font-weight:500;text-decoration:none;transition:color .16s,background-color .16s}
.nav a:hover{color:var(--text);background:var(--bg-hover)}
.nav a[aria-current=page]{color:var(--text);background:#ffffff0d}
.header-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.menu{position:relative;display:none}
.menu>summary{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line);border-radius:var(--radius-btn);color:var(--text);cursor:pointer;list-style:none}
.menu>summary::-webkit-details-marker{display:none}
.menu-lines,.menu-lines::before,.menu-lines::after{display:block;width:16px;height:1.5px;border-radius:1px;background:currentColor;transition:transform .2s var(--ease),background-color .2s}
.menu-lines{position:relative}
.menu-lines::before,.menu-lines::after{content:"";position:absolute;left:0}
.menu-lines::before{top:-5px}
.menu-lines::after{top:5px}
.menu[open] .menu-lines{background:transparent}
.menu[open] .menu-lines::before{transform:translateY(5px) rotate(45deg)}
.menu[open] .menu-lines::after{transform:translateY(-5px) rotate(-45deg)}
.menu-panel{position:absolute;top:calc(100% + 10px);right:0;display:grid;gap:2px;width:min(300px,calc(100vw - 32px));padding:8px;border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--bg-raised);box-shadow:var(--shadow-panel)}
.menu-panel a{display:block;padding:10px 12px;border-radius:var(--radius-btn);color:var(--text-body);font-weight:500;text-decoration:none}
.menu-panel a:hover,.menu-panel a[aria-current=page]{color:var(--text);background:var(--bg-hover)}
`;

const CONTROLS = `
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border:1px solid transparent;border-radius:var(--radius-btn);font:500 .9375rem/1 var(--sans);white-space:nowrap;text-decoration:none;cursor:pointer;transition:background-color .16s,border-color .16s,color .16s,transform .2s var(--ease)}
.btn .arrow{transition:transform .2s var(--ease)}
.btn:hover .arrow{transform:translateX(2px)}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.75;cursor:progress}
.btn-primary{background:var(--btn-bg);color:var(--btn-text);box-shadow:inset 0 1px #ffffffb3,0 1px 2px #0006}
.btn-primary:hover{background:var(--btn-bg-hover)}
.btn-secondary{background:#ffffff0f;border-color:var(--line);color:var(--text)}
.btn-secondary:hover{background:#ffffff1a;border-color:var(--line-strong)}
.btn-sm{height:34px;padding:0 12px;font-size:.875rem}
.btn-lg{height:52px;padding:0 22px;font-size:1rem}
.btn.is-busy .arrow{display:none}
.btn.is-busy::after{content:"";width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(1turn)}}
.pill{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 12px 0 10px;border:1px solid var(--line);border-radius:999px;background:#ffffff08;color:var(--text-body);font-size:.8125rem;font-weight:500;line-height:1;white-space:nowrap}
.dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 3px var(--signal-soft)}
.kicker{display:inline-flex;align-items:center;gap:10px;color:var(--text-muted);font-family:var(--mono);font-size:.75rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase}
.kicker::before{content:"";width:14px;height:3px;border-radius:2px;background:var(--signal);box-shadow:0 0 10px #3be08a80}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:#ffffff08;color:var(--text-muted);font-size:.75rem;font-weight:500;line-height:1;white-space:nowrap}
.chip .icon{width:13px;height:13px}
.badge{display:inline-flex;align-items:stretch;height:30px;border:1px solid var(--line-strong);border-radius:var(--radius-btn);overflow:hidden;font-size:.8125rem;font-weight:500;line-height:1;white-space:nowrap;text-decoration:none;transition:border-color .16s}
.badge:hover{border-color:var(--signal)}
.badge>span{display:inline-flex;align-items:center;gap:6px;padding:0 10px}
.badge-key{background:#ffffff0f;color:var(--text)}
.badge-value{background:var(--signal-soft);color:var(--signal-text)}
.badge .icon{width:14px;height:14px}
.label{font-size:.6875rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-faint)}
.link-arrow{display:inline-flex;align-items:center;gap:6px;min-height:36px;color:var(--text);font-size:.9375rem;font-weight:500;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:5px}
.link-arrow:hover{text-decoration-color:var(--signal)}
.link-arrow .arrow{transition:transform .2s var(--ease)}
.link-arrow:hover .arrow{transform:translateX(3px)}
.install{position:relative;display:flex;align-items:baseline;gap:10px;min-width:0;padding:13px 52px 13px 16px;border:1px solid var(--line);border-radius:var(--radius-btn);background:var(--bg-inset);font-family:var(--mono);font-size:.8125rem;line-height:1.5}
.install code{flex:1;min-width:0;overflow-wrap:anywhere;font-size:inherit;color:var(--text);background:none;border:0;padding:0}
.prompt{color:var(--text-faint);user-select:none}
.copyable{position:relative}
.copyable>pre{padding-right:52px}
.copy{position:absolute;top:7px;right:7px;display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--bg-raised-2);color:var(--text-muted);cursor:pointer;transition:color .16s,border-color .16s}
.copy:hover{color:var(--text);border-color:var(--line-strong)}
.copy.is-copied{color:var(--signal);border-color:#3be08a66}
.install>.copy{top:7px}
.window{position:relative;overflow:hidden;background:var(--bg-raised);border:1px solid var(--line);border-radius:var(--radius-window);box-shadow:var(--shadow-window);color:var(--text-body)}
.window::before{content:"";position:absolute;inset:0 0 auto;z-index:1;height:1px;background:linear-gradient(90deg,#0000,#ffffff38,#0000);pointer-events:none}
.window-bar{display:flex;align-items:center;gap:12px;min-height:46px;padding:0 14px;border-bottom:1px solid var(--line);background:#ffffff05;color:var(--text-muted);font-size:.8125rem}
.window-address{display:inline-flex;align-items:center;gap:8px;min-width:0;height:28px;padding:0 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text-body);font-family:var(--mono);font-size:.75rem;white-space:nowrap;overflow:hidden}
.window-address .icon{width:13px;height:13px;color:var(--text-faint)}
.window-title{font-family:var(--mono);font-size:.75rem;color:var(--text-muted)}
.window-actions{display:flex;gap:6px;margin-left:auto}
.json .j-key{color:var(--text)}
.json .j-str{color:var(--signal-text)}
.json .j-lit{color:var(--warning-text)}
.json .j-punc{color:var(--text-faint)}
`;

const LAYOUT = `
.hero{position:relative;isolation:isolate;padding:96px 0 80px}
.hero-glow{overflow-x:clip}
.hero-glow::before{content:"";position:absolute;left:50%;top:calc(-1 * var(--header-h));z-index:-1;width:min(1400px,140vw);height:720px;transform:translateX(-50%);background:radial-gradient(50% 60% at 50% 0,#3be08a1f,#0000 70%);pointer-events:none}
.hero-glow::after{content:"";position:absolute;inset:calc(-1 * var(--header-h)) 0 0;z-index:-2;background-image:radial-gradient(#ffffff14 1px,#0000 1.4px);background-size:28px 28px;-webkit-mask-image:radial-gradient(60% 55% at 50% 0,#000 10%,#0000 72%);mask-image:radial-gradient(60% 55% at 50% 0,#000 10%,#0000 72%);pointer-events:none}
.hero-copy{display:grid;justify-items:center;gap:24px;max-width:1120px;margin-inline:auto;text-align:center}
.hero-accent{display:block;color:var(--text-muted)}
.lede{max-width:40rem;font-size:1.1875rem;line-height:1.55;color:var(--text-body)}
.hero-split{padding-bottom:64px}
.hero-split .wrap{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);align-items:end;gap:24px 64px}
.hero-split .hero-copy{justify-items:start;margin:0;text-align:left}
.hero-split .lede{font-size:1.125rem}
@media (min-width:721px){.nowrap{white-space:nowrap}}
.section{position:relative;padding:var(--section) 0}
.section-tight{padding-top:0}
.section-head{display:grid;justify-items:start;gap:16px;max-width:46rem;margin-bottom:48px}
.section-head>p:not(.kicker){font-size:1.0625rem;color:var(--text-body)}
.section-head.center{justify-items:center;margin-inline:auto;text-align:center}
.split{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);align-items:center;gap:64px}
.split-top{align-items:start}
.split-copy{display:grid;justify-items:start;align-content:start;gap:20px}
.split-copy>p{color:var(--text-body)}
.cards{display:grid;gap:16px;list-style:none}
.card{position:relative;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:12px;padding:24px;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--bg-raised)}
.card>p{color:var(--text-muted);font-size:.9375rem}
.card-icon{display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line-strong);border-radius:10px;background:var(--bg-raised-2);color:var(--text)}
.card-icon .icon{width:18px;height:18px}
.rows{display:grid;border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);gap:16px 64px;padding:44px 0;border-bottom:1px solid var(--line);scroll-margin-top:var(--header-h)}
.row>h2,.row>h3{font-size:1.5rem;line-height:1.2;letter-spacing:-.02em}
.row-body{display:grid;align-content:start;gap:16px;max-width:44rem}
.row-body>ul{display:grid;gap:10px;padding-left:1.1rem}
.facts-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--line);list-style:none}
.facts-strip li{display:grid;align-content:start;gap:10px;padding:20px;background:var(--bg-raised);color:var(--text-muted);font-size:.875rem}
.facts-strip .icon{width:18px;height:18px;color:var(--signal)}
.facts-strip strong{display:block;font-size:.9375rem;font-weight:500}
`;

const HOME = `
.audit{position:relative;width:100%;max-width:760px;margin:44px auto 0;text-align:left}
.audit-box{position:relative;padding:8px;border:1px solid var(--line-strong);border-radius:16px;background:linear-gradient(180deg,#ffffff0b,#ffffff03);box-shadow:var(--shadow-panel),0 0 0 6px #ffffff05}
.audit-box::before{content:"";position:absolute;top:-1px;left:12%;right:12%;height:1px;background:linear-gradient(90deg,#0000,#3be08aa6,#0000)}
.audit-row{display:flex;gap:8px}
.audit-field{display:flex;flex:1;align-items:center;gap:10px;min-width:0;height:52px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);transition:border-color .16s,box-shadow .16s}
.audit-field:focus-within{border-color:#3be08a80;box-shadow:0 0 0 3px var(--signal-soft)}
.audit-field .icon{width:18px;height:18px;color:var(--text-faint)}
.audit-field input{flex:1;min-width:0;height:100%;padding:0;border:0;background:none;color:var(--text);font:400 1rem/1 var(--sans);outline:0}
.audit-field input::placeholder{color:var(--text-faint)}
.audit-facts{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 20px;margin-top:16px;color:var(--text-muted);font-size:.8125rem;list-style:none}
.audit-facts li{display:inline-flex;align-items:center;gap:6px}
.audit-facts .icon{width:14px;height:14px;color:var(--signal)}
.audit-off .audit-box{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:20px}
.cf-turnstile:not(:empty){display:flex;justify-content:center;margin-top:12px}
.notice{display:flex;align-items:flex-start;gap:10px;margin-top:12px;padding:12px 14px;border:1px solid #f0675f47;border-radius:10px;background:var(--error-soft);color:var(--text);font-size:.9375rem}
.notice .icon{margin-top:3px;color:var(--error-text)}
.stage{position:relative;margin-top:72px;perspective:1600px}
.stage::before{content:"";position:absolute;left:50%;top:-120px;width:80%;height:440px;transform:translateX(-50%);background:radial-gradient(50% 50%,#3be08a47,#0000 70%);filter:blur(24px);pointer-events:none}
.stage-window{position:relative;transform-origin:50% 0;transform:rotateX(5deg);-webkit-mask-image:linear-gradient(#000 64%,#0000);mask-image:linear-gradient(#000 64%,#0000)}
.stage-window.fade-late{-webkit-mask-image:linear-gradient(#000 86%,#0000);mask-image:linear-gradient(#000 86%,#0000)}
.preview{font-size:.8125rem}
.preview-body{display:grid;grid-template-columns:270px minmax(0,1fr)}
.preview-side{display:grid;align-content:start;gap:12px;padding:20px;border-right:1px solid var(--line)}
.preview-main{display:grid;align-content:start;gap:8px;padding:20px 20px 32px}
.mini-score{display:flex;align-items:center;gap:14px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg-inset)}
.mini-score p{color:var(--text-muted);font-size:.75rem}
.mini-score .score-name{color:var(--text);font-size:.9375rem;font-weight:500}
.preview-list{display:grid;gap:8px;margin-top:4px;padding-top:14px;border-top:1px solid var(--line);list-style:none;color:var(--text-muted);font-size:.75rem}
.preview-list li{display:flex;align-items:center;justify-content:space-between;gap:8px}
.preview-list b{color:var(--text);font-weight:500}
.preview-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#ffffff03;box-shadow:inset 2px 0 0 var(--c)}
.preview-row code{font-size:.72rem;color:var(--text-body)}
.preview-row .msg{flex:1 1 12rem;min-width:0;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.preview-row.is-open{background:#ffffff07;border-color:var(--line-strong)}
.preview-row .diff{flex-basis:100%}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;list-style:none}
.step{display:grid;align-content:start;gap:12px;padding:12px 12px 26px;border:1px solid var(--line);border-radius:16px;background:var(--bg-raised)}
.step>:not(.fig){margin-inline:12px}
.step p{color:var(--text-muted);font-size:.9375rem}
.step-index{color:var(--text-faint);font-family:var(--mono);font-size:.75rem}
.fig{position:relative;display:grid;place-items:center;height:148px;margin-bottom:10px;overflow:hidden;border:1px solid var(--line);border-radius:11px;background:radial-gradient(80% 90% at 50% 0,#3be08a14,#0000 70%),var(--bg-inset)}
.fig-input{display:flex;align-items:center;gap:8px;width:78%;padding:6px 6px 6px 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--bg);color:var(--text-body);font-family:var(--mono);font-size:.75rem}
.fig-input .icon{width:13px;height:13px;color:var(--text-faint)}
.fig-input span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fig-input b{padding:6px 10px;border-radius:6px;background:var(--btn-bg);color:var(--btn-text);font-family:var(--sans);font-weight:500}
.fig-diff{display:grid;gap:6px;width:84%;font-family:var(--mono);font-size:.72rem}
.fig-diff span{padding:7px 10px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fig-diff .del{background:#f0675f14;color:var(--error-text)}
.fig-diff .add{background:#3be08a14;color:var(--signal-text)}
.fig-diff em{font-style:normal;color:var(--text);background:#ffffff14;border-radius:4px;padding:0 3px}
.fig-again{display:flex;align-items:center;gap:18px;color:var(--text-faint)}
.fig-again .icon{width:22px;height:22px}
.audits{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.panel-body{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:28px 64px}
.levels.levels-2{display:block;columns:2;column-gap:64px}
.levels-2 li{break-inside:avoid}
.audit-panel{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:24px;padding:28px;border:1px solid var(--line);border-radius:16px;background:var(--bg-raised)}
.audit-panel::before{content:"";position:absolute;top:-170px;right:-130px;width:440px;height:380px;background:radial-gradient(#3be08a1c,#0000 65%);pointer-events:none}
.panel-head{position:relative;display:flex;align-items:flex-start;gap:16px}
.panel-icon{display:grid;flex:none;place-items:center;width:44px;height:44px;border:1px solid var(--line-strong);border-radius:11px;background:var(--bg-raised-2);color:var(--signal)}
.panel-icon .icon{width:20px;height:20px}
.panel-head h3{font-size:1.25rem}
.panel-head div>p{max-width:44rem;margin-top:4px;color:var(--text-muted);font-size:.9375rem}
.panel-count{display:grid;justify-items:end;flex:none;margin-left:auto;color:var(--text);font-size:2.4rem;font-weight:500;line-height:1;letter-spacing:-.04em}
.panel-count small{color:var(--text-faint);font-size:.75rem;font-weight:400;letter-spacing:0}
.levels{position:relative;display:grid;gap:2px;list-style:none}
.levels a{display:grid;grid-template-columns:minmax(0,13rem) minmax(0,1fr) 2rem;align-items:center;gap:16px;min-height:34px;margin:0 -10px;padding:0 10px;border-radius:7px;color:var(--text-body);font-size:.875rem;text-decoration:none;transition:background-color .16s,color .16s}
.levels a:hover{background:var(--bg-hover);color:var(--text)}
.level-bar{position:relative;height:6px;overflow:hidden;border-radius:3px;background:#ffffff0d}
.level-bar i{position:absolute;inset:0 auto 0 0;width:calc(var(--v) * 100%);border-radius:3px;background:linear-gradient(90deg,var(--signal-cue),var(--signal))}
.level-count{color:var(--text-muted);font-family:var(--mono);font-size:.8125rem;text-align:right}
.bots{position:relative;display:grid;gap:14px}
.bots-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.bots-head p{color:var(--text-body);font-size:.875rem}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;color:var(--text-muted);font-size:.75rem}
.legend li,.bot-chip{display:inline-flex;align-items:center;gap:6px}
.bot-chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none}
.bot-chip{height:26px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:#ffffff05;color:var(--text-body);font-family:var(--mono);font-size:.72rem}
.purpose{flex:none;width:6px;height:6px;border-radius:50%}
.purpose-search{background:var(--signal)}
.purpose-answer{background:var(--info)}
.purpose-training{background:var(--text-faint)}
.routes{grid-template-columns:repeat(3,minmax(0,1fr))}
.routes .card{grid-template-rows:auto auto 1fr auto auto}
.route-featured{border-color:#3be08a3d;background:linear-gradient(180deg,#3be08a0f,var(--bg-raised) 45%)}
.route-featured .card-icon{color:var(--signal)}
.card .corner{position:absolute;top:24px;right:24px}
.keeps{grid-template-columns:repeat(2,minmax(0,1fr))}
.keeps .card:last-child:nth-child(odd){grid-column:1/-1}
.keeps .card{gap:10px;padding:20px}
.keeps h3{font-size:1rem}
.keep-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:9px;background:var(--signal-soft);color:var(--signal)}
.keep-icon .icon{width:18px;height:18px}
.cta-card{position:relative;overflow:hidden;display:grid;justify-items:center;gap:22px;padding:80px 32px;border:1px solid var(--line);border-radius:20px;background:var(--bg-raised);text-align:center}
.cta-card::before{content:"";position:absolute;left:50%;bottom:-260px;width:min(960px,160%);height:520px;transform:translateX(-50%);background:radial-gradient(50% 50%,#3be08a33,#0000 70%);pointer-events:none}
.cta-card>*{position:relative}
.cta-card h2{max-width:20ch}
.cta-card>p:not(.pill){max-width:36rem;font-size:1.0625rem}
.cta-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
`;

const REPORT = `
.report{padding:8px 0 var(--section);scroll-margin-top:calc(var(--header-h) + 16px)}
.report-window{box-shadow:var(--shadow-panel);overflow:clip}
.report-bar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px;padding:18px 22px;border-bottom:1px solid var(--line);background:#ffffff04}
.report-title{display:grid;flex:1 1 20rem;gap:6px;min-width:0}
.report-title h2{font-size:1.375rem;letter-spacing:-.02em}
.report-url{display:flex;align-items:center;gap:8px;min-width:0;color:var(--text-muted);font-family:var(--mono);font-size:.8125rem;overflow-wrap:anywhere}
.report-url .icon{width:14px;height:14px;color:var(--text-faint)}
.report-actions{display:flex;flex-wrap:wrap;gap:8px}
.report-body{display:grid;gap:48px;padding:28px}
.scores{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.score-card{display:flex;align-items:center;gap:22px;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--bg-inset);color:inherit;text-decoration:none;transition:border-color .16s,background-color .16s}
.score-card:hover{border-color:var(--line-strong);background:#ffffff05}
.score-text{display:grid;flex:1;gap:10px;min-width:0}
.score-name{color:var(--text);font-size:1.0625rem;font-weight:500}
.ring{position:relative;display:grid;flex:none;place-items:center;width:92px;height:92px}
.ring svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);overflow:visible}
.ring-track{fill:none;stroke:#ffffff12;stroke:color-mix(in srgb,var(--band) 18%,transparent);stroke-width:5}
.ring-fill{fill:none;stroke:var(--band);stroke-width:5;stroke-linecap:round;filter:drop-shadow(0 0 6px var(--band-glow))}
.ring-value{color:var(--text);font-size:1.75rem;font-weight:500;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.ring-sm{width:56px;height:56px}
.ring-sm .ring-value{font-size:1.0625rem;letter-spacing:-.02em}
.band-good{--band:var(--signal);--band-glow:#3be08a66}
.band-fair{--band:var(--warning);--band-glow:#f2a33a59}
.band-poor{--band:var(--error);--band-glow:#f0675f59}
.counts{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--text-muted);font-size:.8125rem}
.counts span{display:inline-flex;align-items:center;gap:6px}
.counts span::before{content:"";width:7px;height:7px;border-radius:2px;background:var(--c)}
.sev-bar{display:flex;gap:2px;height:5px;overflow:hidden;border-radius:3px;background:#ffffff0d}
.sev-bar i{flex:var(--n) 1 0;background:var(--c)}
.is-error{--c:var(--error)}
.is-warning{--c:var(--warning)}
.is-info{--c:var(--info)}
.is-clear{--c:var(--signal)}
.report-tabs{position:sticky;top:var(--header-h);z-index:10;display:flex;gap:2px;margin:-16px -28px;padding:0 16px;border-block:1px solid var(--line);background:#0f1011f2;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);overflow-x:auto;scrollbar-width:none}
.report-tabs a{position:relative;display:inline-flex;flex:none;align-items:center;gap:8px;height:48px;padding:0 12px;color:var(--text-muted);font-size:.875rem;font-weight:500;text-decoration:none;white-space:nowrap;transition:color .16s}
.report-tabs a:hover{color:var(--text)}
.report-tabs a:focus-visible{outline-offset:-6px;border-radius:10px}
.report-tabs a::after{content:"";position:absolute;right:12px;bottom:0;left:12px;height:2px;border-radius:2px 2px 0 0;background:var(--signal);box-shadow:0 0 10px #3be08a80;opacity:0;transition:opacity .16s}
.report-tabs a[aria-selected=true]{color:var(--text)}
.report-tabs a[aria-selected=true]::after{opacity:1}
.tab-count{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 6px;border-radius:999px;background:#ffffff0f;color:var(--text-muted);font-family:var(--mono);font-size:.6875rem;font-weight:500;font-variant-numeric:tabular-nums}
.tab-count.has-errors{background:var(--error-soft);color:var(--error-text)}
.report-panels{display:grid;gap:56px}
.has-tabs .report-panels{display:block}
.report-panels,.report-panel,.report-part,.finding-group,.finding-part{scroll-margin-top:42px}
.report-section{display:grid;gap:18px}
.report-part{display:grid;gap:12px}
.report-part+.report-part{margin-top:14px}
.report-part>.report-sub{margin-top:0}
.section-index{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:12px}
.index-col{display:grid;align-content:start;gap:4px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg-inset)}
.index-title{padding:0 8px 6px;color:var(--text);font-size:.9375rem;font-weight:500}
.index-col ul{display:grid;gap:1px;list-style:none}
.index-col a{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 14px;min-height:36px;padding:6px 8px;border-radius:7px;color:var(--text-body);font-size:.875rem;text-decoration:none;transition:background-color .16s,color .16s}
.index-col a:hover{background:var(--bg-hover);color:var(--text)}
.index-col .counts{gap:4px 12px;font-size:.75rem}
.index-sub{padding:10px 8px 4px;color:var(--text-faint);font-size:.6875rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.index-empty{display:flex;align-items:center;gap:8px;padding:6px 8px;color:var(--text-muted);font-size:.875rem}
.index-empty .icon{color:var(--signal)}
.finding-groups{display:grid;gap:32px}
.finding-group{display:grid;gap:10px}
.finding-part{display:grid;gap:24px}
.finding-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding-bottom:10px;border-bottom:1px solid var(--line-faint)}
.finding-group-head h4,.finding-group-head h5{margin:0;color:var(--text);font-size:1.0625rem;font-weight:500;letter-spacing:-.01em;text-transform:none}
.finding-group-head h5{font-size:.9375rem;color:var(--text-body)}
.finding-group-head .counts{margin-left:auto;font-size:.75rem}
.finding-part-head{padding-bottom:0;border-bottom:0}
.report-section-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}
.report-section-head h3{font-size:1.375rem;letter-spacing:-.02em}
.facts{display:grid;gap:8px;margin:0}
.facts-text{grid-template-columns:minmax(0,1fr);gap:0;overflow:hidden;border:1px solid var(--line);border-radius:12px}
.facts-text .fact{grid-template-columns:9rem minmax(0,1fr);gap:16px;padding:11px 16px;border-bottom:1px solid var(--line)}
.facts-text .fact:last-child{border-bottom:0}
.facts-tiles{grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))}
.facts-tiles .fact{align-content:start;gap:6px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg-inset)}
.fact{display:grid}
.fact dt{color:var(--text-faint);font-size:.75rem;font-weight:500;letter-spacing:.04em;text-transform:uppercase}
.facts-text .fact dt{padding-top:2px}
.fact dd{display:flex;align-items:center;gap:8px;min-width:0;margin:0;color:var(--text);font-size:.9375rem;overflow-wrap:anywhere}
.tone{flex:none;width:7px;height:7px;border-radius:50%;background:var(--text-faint)}
.tone-good{background:var(--signal);box-shadow:0 0 0 3px var(--signal-soft)}
.tone-warn{background:var(--warning);box-shadow:0 0 0 3px var(--warning-soft)}
.tone-bad{background:var(--error);box-shadow:0 0 0 3px var(--error-soft)}
.findings{display:grid;gap:8px}
.finding{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--bg-inset);box-shadow:inset 3px 0 0 var(--c);transition:border-color .16s}
.finding[open]{border-color:var(--line-strong);background:var(--bg-raised-2)}
.finding>summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;padding:12px 14px 12px 16px;cursor:pointer;list-style:none}
.finding>summary::-webkit-details-marker{display:none}
.finding>summary:hover{background:#ffffff05}
.finding>summary code{font-size:.75rem;color:var(--text-body);background:#ffffff08}
.msg{flex:1 1 16rem;min-width:0;color:var(--text)}
.chev{margin-left:auto;color:var(--text-faint);transition:transform .2s var(--ease)}
.finding[open] .chev{transform:rotate(180deg)}
.sev{display:inline-flex;flex:none;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;background:var(--c-soft);color:var(--c-text);font-size:.6875rem;font-weight:600;letter-spacing:.05em;line-height:1;text-transform:uppercase}
.sev .icon{width:13px;height:13px}
.sev-error{--c:var(--error);--c-text:var(--error-text);--c-soft:var(--error-soft)}
.sev-warning{--c:var(--warning);--c-text:var(--warning-text);--c-soft:var(--warning-soft)}
.sev-info{--c:var(--info);--c-text:var(--info-text);--c-soft:var(--info-soft)}
.finding-body{display:grid;gap:16px;padding:16px 16px 18px 19px;border-top:1px solid var(--line)}
.todo{display:grid;gap:6px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#ffffff05}
.where{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:.875rem}
.edits{display:grid;gap:16px;list-style:none}
.edit{display:grid;gap:8px}
.edit-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:10px;color:var(--text-body);font-size:.875rem}
.edit-step{display:grid;flex:none;place-items:center;width:20px;height:20px;border-radius:50%;background:#ffffff12;color:var(--text);font-size:.6875rem;font-weight:600}
.diff{overflow:hidden;border:1px solid var(--line);border-radius:10px}
.diff-label{display:block;padding:6px 12px;font-size:.6875rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.diff pre{padding-top:10px;border:0;border-radius:0}
.diff-del{border-color:#f0675f38}
.diff-del .diff-label{background:#f0675f14;color:var(--error-text)}
.diff-del pre{background:#f0675f0a}
.diff-add{border-color:#3be08a38}
.diff-add .diff-label{background:#3be08a14;color:var(--signal-text)}
.diff-add pre{background:#3be08a0a}
.edit-write{display:flex;align-items:flex-start;gap:8px;color:var(--text-muted);font-size:.875rem}
.edit-write .icon{margin-top:3px}
.evidence>summary{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);font-size:.875rem;cursor:pointer}
.evidence[open]>summary .icon{transform:rotate(180deg)}
.evidence pre{max-height:18rem;margin-top:8px;overflow:auto}
.empty{display:flex;align-items:center;gap:10px;padding:16px;border:1px solid #3be08a38;border-radius:12px;background:#3be08a0a;color:var(--text)}
.empty .icon{color:var(--signal)}
.crawler-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.crawler-group{display:grid;align-content:start;gap:10px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--bg-inset)}
.crawler-group ul{display:grid;gap:8px;list-style:none}
.crawler{display:flex;align-items:center;gap:10px;font-size:.8125rem}
.crawler code{font-size:.72rem}
.crawler-op{color:var(--text-faint)}
.crawler-state{display:inline-flex;flex:none;align-items:center;gap:4px;margin-left:auto;font-size:.75rem;font-weight:500}
.crawler-state .icon{width:13px;height:13px}
.is-allowed .crawler-state{color:var(--signal-text)}
.is-blocked .crawler-state{color:var(--error-text)}
.is-training .is-blocked .crawler-state{color:var(--text-muted)}
.report-note{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border:1px dashed var(--line-strong);border-radius:12px;color:var(--text-muted);font-size:.9375rem}
.report-note .icon{margin-top:4px;color:var(--info-text)}
.report-sub{margin-top:6px;color:var(--text-body);font-size:.9375rem;font-weight:500}
.report-lede{color:var(--text-muted);font-size:.9375rem}
.examples{display:grid;gap:8px}
.examples ul{display:grid;gap:6px;list-style:none}
.page-link{font-family:var(--mono);font-size:.8125rem;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--bg-inset)}
.pages-table{min-width:520px}
.pages-table th,.pages-table td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;font-size:.875rem}
.pages-table tr:last-child>*{border-bottom:0}
.pages-table thead th{background:#ffffff04;color:var(--text-faint);font-size:.6875rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.pages-table tbody th{font-weight:400}
.pages-table td{white-space:nowrap}
.pages-table td .tone{display:inline-block;margin-right:8px}
.score-num{color:var(--band);font-weight:500;font-variant-numeric:tabular-nums}
.crawl-progress{padding:8px 0 var(--section);scroll-margin-top:calc(var(--header-h) + 16px)}
.crawl-progress:has(~.report){display:none}
.progress-body{gap:18px}
.progress-title{display:flex;align-items:center;gap:12px}
.progress-title::after{content:"";flex:none;width:16px;height:16px;border:2px solid var(--signal);border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
.crawl-progress:has(.notice) .progress-title::after{display:none}
.progress-lines{display:grid;gap:6px;list-style:none;color:var(--text-muted);font-size:.8125rem;line-height:1.5}
.progress-lines li{display:grid;grid-template-columns:2rem minmax(0,1fr);align-items:start;gap:10px;min-width:0}
.progress-lines code{padding:0;border:0;background:none;color:var(--text-body);font-size:.75rem}
.progress-count{display:flex;align-items:center;justify-content:flex-end;height:1.5em;color:var(--signal-text);font-family:var(--mono);font-variant-numeric:tabular-nums}
.progress-count .icon{width:13px;height:13px;transform:rotate(-90deg)}
`;

/**
 * The report's Share menu, whose panel hangs from the report's bar so it stays on a phone's
 * screen wherever the button wraps to, and the page a share link opens.
 */
const SHARE = `
.share-menu>summary{list-style:none}
.share-menu>summary::-webkit-details-marker{display:none}
.share-menu[open]>summary{background:#ffffff1a;border-color:var(--line-strong)}
.share-panel{position:absolute;top:calc(100% - 6px);right:16px;z-index:20;display:grid;gap:2px;width:min(340px,calc(100% - 32px));padding:8px;border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--bg-raised);box-shadow:var(--shadow-panel)}
.share-panel-head{padding:6px 12px 8px;color:var(--text-faint);font-size:.6875rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.share-panel>a,.share-native{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:10px 12px;border:0;border-radius:var(--radius-btn);background:none;color:var(--text-body);font:500 .9375rem/1.2 var(--sans);text-align:left;text-decoration:none;cursor:pointer}
.share-panel>a:hover,.share-native:hover{color:var(--text);background:var(--bg-hover)}
.share-panel>a .icon,.share-native .icon{width:14px;height:14px;color:var(--text-faint)}
.share-native[hidden]{display:none}
.share-url{margin:6px 4px 2px;padding-block:10px;font-size:.75rem}
.share-url code{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
.share-panel-note{padding:6px 12px 4px;color:var(--text-muted);font-size:.8125rem;line-height:1.5}
.share-title{max-width:100%;font-size:clamp(2.2rem,5.4vw,4rem);overflow-wrap:anywhere}
.share-scores{width:100%;max-width:760px;margin:48px auto 0}
.share-actions{margin-top:32px}
.share-note{display:flex;align-items:flex-start;gap:10px;max-width:40rem;margin:32px auto 0;color:var(--text-muted);font-size:.875rem;text-align:left}
.share-note .icon{margin-top:3px;color:var(--info-text)}
.share-meaning{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:960px){.share-meaning{grid-template-columns:minmax(0,1fr)}}
`;

const RULES = `
.rules-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:56px;padding-bottom:var(--section)}
.rules-toc{position:sticky;top:calc(var(--header-h) + 24px);align-self:start;max-height:calc(100vh - var(--header-h) - 48px);overflow:auto;scrollbar-width:thin}
.rules-toc h2{margin-bottom:12px;color:var(--text-faint);font-size:.75rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.rules-toc ul{display:grid;gap:1px;list-style:none}
.rules-toc a{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;border-radius:7px;color:var(--text-muted);font-size:.875rem;text-decoration:none;transition:color .16s,background-color .16s}
.rules-toc a:hover,.rules-toc a[aria-current]{background:var(--bg-hover);color:var(--text)}
.rules-toc a span{color:var(--text-faint);font-family:var(--mono);font-size:.75rem}
.rules-toc li[hidden],.rule-group[hidden],.rule[hidden],.rules-filter[hidden]{display:none}
.rules-filter{display:grid;gap:8px;margin-bottom:32px}
.rules-filter .audit-field{height:46px}
.rules-count{min-height:1.2em;color:var(--text-faint);font-size:.8125rem}
.rules-count:empty{display:none}
.rule-group{margin-bottom:40px;padding-bottom:40px;border-bottom:1px solid var(--line-faint);scroll-margin-top:calc(var(--header-h) + 16px)}
.rule-group:last-child{margin-bottom:0;border-bottom:0}
.rule-group-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;margin-bottom:16px}
.rule-group-head h2{font-size:1.625rem}
.rule-list{display:grid;gap:6px}
.rule{overflow:hidden;border:1px solid var(--line);border-radius:10px;background:var(--bg-raised);box-shadow:inset 3px 0 0 var(--c);scroll-margin-top:calc(var(--header-h) + 16px);transition:border-color .16s}
.rule[open]{border-color:var(--line-strong);background:var(--bg-raised-2)}
.rule:target{border-color:#3be08a66;box-shadow:inset 3px 0 0 var(--c),0 0 0 3px var(--signal-soft)}
.rule>summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:11px 16px 12px 18px;cursor:pointer;list-style:none}
.rule>summary::-webkit-details-marker{display:none}
.rule>summary:hover{background:#ffffff05}
.rule[open] .chev{transform:rotate(180deg)}
.rule h3{font-size:1rem;letter-spacing:0}
.rule h3 code{padding:0;border:0;background:none;color:var(--text);font-size:.875rem}
.rule-desc{flex-basis:100%;color:var(--text-muted);font-size:.875rem}
.rule-body{display:grid;justify-items:start;gap:8px;padding:14px 16px 14px 18px;border-top:1px solid var(--line)}
.rule .rule-todo{color:var(--text-body);font-size:.9375rem}
.rule .rule-when{color:var(--text-faint);font-size:.8125rem}
.rule .link-arrow{min-height:28px;font-size:.875rem}
`;

const SERVER = `
.endpoint{display:grid;grid-template-columns:minmax(0,1fr);justify-items:center;gap:14px;width:100%;max-width:660px;margin:44px auto 0}
.endpoint-label{color:var(--text-muted);font-size:.8125rem}
.endpoint .install{align-items:center;width:100%;min-height:62px;padding:10px 60px 10px 20px;border-color:var(--line-strong);border-radius:14px;background:linear-gradient(180deg,#ffffff0b,#ffffff03);box-shadow:var(--shadow-panel),0 0 0 6px #ffffff05;font-size:1rem}
.endpoint .install>.copy{top:50%;right:12px;transform:translateY(-50%)}
.endpoint-facts{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;list-style:none}
.endpoint-facts .icon{color:var(--signal)}
.chat{display:grid;gap:14px;padding:26px 28px 40px;font-size:.875rem}
.chat-user{justify-self:end;max-width:min(78%,34rem);padding:11px 15px;border-radius:14px 14px 4px 14px;background:#ffffff12;color:var(--text)}
.chat-tool{display:flex;align-items:center;gap:10px;max-width:34rem;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg-inset);color:var(--text-muted);font-family:var(--mono);font-size:.75rem}
.chat-tool .icon{color:var(--text-faint)}
.chat-tool b{color:var(--text);font-weight:500}
.chat-tool .ok{margin-left:auto;color:var(--signal)}
.chat-reply{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:40rem;color:var(--text-body)}
.chat-scores{display:flex;flex-wrap:wrap;gap:10px}
.chat-scores .mini-score{padding:10px 14px 10px 10px}
.chat-fixes{display:grid;gap:8px;list-style:none}
.chat-fixes li{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:10px}
.chat-fixes .icon{margin-top:3px;color:var(--signal)}
.chat-fixes code{font-size:.72rem}
.clients{grid-template-columns:repeat(2,minmax(0,1fr))}
.tools{grid-template-columns:repeat(4,minmax(0,1fr))}
.tools h3 code{padding:0;border:0;background:none;color:var(--text);font-size:.9375rem}
.spec{overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--bg-raised)}
.spec th,.spec td{padding:15px 20px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:.9375rem}
.spec tr:last-child>*{border-bottom:0}
.spec thead th{padding-block:11px;background:#ffffff04;color:var(--text-faint);font-size:.75rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.spec tbody th{width:46%;color:var(--text-muted);font-weight:400}
.spec td{color:var(--text)}
.compare-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--bg-raised)}
.compare{min-width:540px}
.compare th,.compare td{padding:14px 20px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;font-size:.9375rem}
.compare tr:last-child>*{border-bottom:0}
.compare thead th{background:#ffffff04;color:var(--text-faint);font-size:.75rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.compare thead th:not(:first-child),.compare td{width:136px;text-align:center}
.compare tbody th{color:var(--text-body);font-weight:400}
.compare .icon{width:18px;height:18px}
.yes{color:var(--signal)}
.no{color:var(--text-faint)}
.local-run{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-width:640px;margin-top:28px}
.local-run p{color:var(--text-muted);font-size:.9375rem}
.blocks{display:grid;gap:12px;list-style:none}
.blocks .card{gap:10px;padding:20px}
.blocks h3{font-size:1rem}
.notfound .hero-copy{gap:20px}
.notfound-code{color:var(--signal-text);font-family:var(--mono);font-size:.875rem;letter-spacing:.1em}
`;

const FOOTER = `
.site-footer{border-top:1px solid var(--line)}
.footer-grid{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr));gap:32px;padding:56px 0 40px}
.footer-brand{display:grid;justify-items:start;align-content:start;gap:14px}
.footer-brand p{max-width:300px;color:var(--text-muted);font-size:.875rem}
.footer-col{display:grid;align-content:start;gap:12px}
.footer-heading{color:var(--text);font-size:.8125rem;font-weight:500}
.footer-col ul{display:grid;gap:2px;list-style:none}
.footer-col a{display:inline-flex;align-items:center;min-height:30px;color:var(--text-muted);font-size:.875rem;text-decoration:none;transition:color .16s}
.footer-col a:hover{color:var(--text)}
.footer-bottom{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 32px;padding:20px 0 56px;border-top:1px solid var(--line);color:var(--text-faint);font-size:.8125rem}
.footer-bottom p{max-width:52rem}
.footer-bottom a{color:var(--text-muted)}
.footer-links{display:flex;flex-wrap:wrap;gap:8px 20px}
.footer-consent{padding:0;border:0;background:none;color:var(--text-muted);font:inherit;text-decoration:underline;text-decoration-color:var(--line-strong);text-decoration-thickness:1px;text-underline-offset:4px;cursor:pointer}
.footer-consent:hover{color:var(--text)}
.footer-consent[hidden]{display:none}
`;

/** The cookie banner (issue #57): a card in a corner that covers nothing it has to. */
const CONSENT = `
.consent{position:fixed;right:16px;bottom:16px;left:16px;z-index:60;display:grid;gap:12px;max-width:420px;margin-left:auto;padding:18px 20px;border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--bg-raised);box-shadow:var(--shadow-panel);font-size:.875rem}
.consent[hidden]{display:none}
.consent p{margin:0}
.consent-title{color:var(--text);font-weight:500}
.consent-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
`;

const RESPONSIVE = `
@media (max-width:1060px){.nav,.header-github{display:none}.menu{display:block}.tools{grid-template-columns:repeat(2,minmax(0,1fr))}.facts-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:960px){.split,.hero-split .wrap{grid-template-columns:minmax(0,1fr)}.split{gap:40px}.rules-layout{grid-template-columns:minmax(0,1fr);gap:8px}.rules-toc{top:var(--header-h);z-index:10;max-height:none;margin:0 -24px 24px;padding:10px 24px;overflow:visible;border-bottom:1px solid var(--line-faint);background:#08090ae6;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}.rules-toc h2{position:absolute;width:1px;height:1px;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.rules-toc ul{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}.rules-toc li{flex:none}.rules-toc a{border:1px solid var(--line);white-space:nowrap}.rule-group,.rule{scroll-margin-top:64px}.audits,.routes,.steps{grid-template-columns:minmax(0,1fr)}.footer-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.footer-brand{grid-column:1/-1}.preview-body{grid-template-columns:minmax(0,1fr)}.preview-side{grid-template-columns:repeat(2,minmax(0,1fr));border-right:0;border-bottom:1px solid var(--line)}.preview-list{display:none}.crawler-groups,.section-index{grid-template-columns:minmax(0,1fr)}.panel-body{grid-template-columns:minmax(0,1fr)}.levels.levels-2{columns:1}}
@media (max-width:720px){:root{--section:76px}.hero{padding:60px 0 56px}.audit-row{flex-direction:column}.audit-field{flex:none}.audit .btn-lg{width:100%}.stage{margin-top:48px}.stage-window{transform:none}.scores,.keeps{grid-template-columns:minmax(0,1fr)}.row{grid-template-columns:minmax(0,1fr);padding:32px 0}.header-cta{display:none}.footer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.report-body{gap:40px;padding:20px}.report-tabs{margin:-12px -20px;padding:0 8px}.report-bar{padding:16px 20px}.levels a{grid-template-columns:minmax(0,1fr) 4.5rem 1.6rem;gap:12px}.facts-text .fact{grid-template-columns:minmax(0,1fr);gap:2px}.cta-card{padding:56px 24px}}
@media (max-width:520px){.wrap{padding-inline:16px}.rules-toc{margin-inline:-16px;padding-inline:16px}.lede{font-size:1.0625rem}.tools,.clients,.facts-strip{grid-template-columns:minmax(0,1fr)}.preview-side{grid-template-columns:minmax(0,1fr)}.preview-main{padding:16px}.window-actions{display:none}.score-card{gap:16px;padding:16px}.score-card .ring{width:76px;height:76px}.score-card .ring-value{font-size:1.5rem}.audit-facts{flex-direction:column;align-items:flex-start;padding-inline:6px}.panel-count{display:none}.audit-panel{padding:22px}.panel-count{font-size:2rem}.compare{min-width:0}.compare th,.compare td{padding:12px 14px}.pages-table{min-width:0}.pages-table th,.pages-table td{padding:10px 8px}.pages-table th:first-child,.pages-table td:first-child{padding-left:12px}.compare thead th:not(:first-child),.compare td{width:64px;padding-inline:8px}.chat{padding:20px 18px 32px}.chat-user{max-width:92%}}
`;

/** Entrances as rivi.software has them, for those who have not asked for less motion. */
const MOTION = `
@media (prefers-reduced-motion:no-preference){
html{scroll-behavior:smooth}
.rise{animation:land .7s var(--ease-out) var(--d,0s) backwards}
.hero-title.rise,.lede.rise{animation-name:focus-in}
.stage{animation:stage-in 1.2s var(--ease-out) var(--d,0s) backwards}
.stage::before{animation:bloom 1.6s var(--ease-out) calc(var(--d,0s) + .5s) backwards}
.stage-window{animation:window-settle 1.4s var(--ease-out) var(--d,0s) backwards}
.window::before{animation:catch-light 1s var(--ease-out) 1s backwards}
.ring-fill{animation:ring-in 1.3s var(--ease-out) .35s backwards}
.level-bar i,.sev-bar i{animation:bar-fill 1.1s var(--ease-out) .25s backwards}
.dot{animation:dot-on .8s var(--ease-out) .6s backwards}
}
@keyframes land{from{opacity:0;translate:0 14px}}
@keyframes focus-in{from{opacity:0;filter:blur(8px);translate:0 10px}}
@keyframes stage-in{from{opacity:0;translate:0 48px}}
@keyframes window-settle{from{transform:rotateX(18deg)}}
@keyframes bloom{from{opacity:0;scale:.6}}
@keyframes catch-light{from{opacity:0;scale:.2 1}}
@keyframes ring-in{from{stroke-dasharray:0 100}}
@keyframes bar-fill{from{clip-path:inset(0 100% 0 0)}}
@keyframes dot-on{0%{background-color:var(--text-faint);box-shadow:0 0 #3be08a00}40%{background-color:var(--signal);box-shadow:0 0 0 5px #3be08a47}}
`;

export const STYLE = [
  TOKENS,
  BASE,
  HEADER,
  CONTROLS,
  LAYOUT,
  HOME,
  REPORT,
  SHARE,
  RULES,
  SERVER,
  FOOTER,
  CONSENT,
  RESPONSIVE,
  MOTION,
]
  .join("")
  .replaceAll("\n", "");
