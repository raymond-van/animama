import { app, BrowserWindow, nativeTheme } from "electron";
import { randomBytes } from "node:crypto";
// esbuild inlines both as data URLs (see scripts/build.mjs).
import dmSans from "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2";
import mark from "../../../assets/startup-mark.png";
import en from "../../locales/en.json" with { type: "json" };
import type { ShellKey, ShellStrings } from "../locale/shell-locale.js";
import type { RuntimeIpcCallers } from "./ipc.js";

/** Runtime error codes with their own advice; other codes show the generic text. */
const ADVICE_CODES = Object.keys(en.startup.advice);
/** Errors that Retry in the same process cannot clear. */
const NO_RETRY_CODES = [
  "update_install_timeout",
  "owned_services_stop_failed",
  "database_schema_mismatch",
  "data_path_too_long",
  "administrator_launch_unsupported",
];

/**
 * Every text the page shows, in the shell locale. The page script runs in the
 * renderer, so main chooses the platform's wording here.
 */
function pageText({ text }: ShellStrings, platform: NodeJS.Platform) {
  const system =
    platform === "win32" ? "windows" : platform === "linux" ? "linux" : "macos";
  // Development profiles only: macOS has an archiving helper; on Windows and
  // Linux the data folder is renamed by hand, which keeps everything in it.
  const freshProfile = text(`startup.freshProfile.${system}`);
  const advice: Record<string, string> = {
    secure_storage_unavailable: text(`startup.secureStorage.${system}`),
  };
  for (const code of ADVICE_CODES)
    advice[code] = text(`startup.advice.${code}` as ShellKey, {
      freshProfile,
    });
  return {
    title: {
      error: text("startup.title.error"),
      consent: text("startup.title.consent"),
      updating: text("startup.title.updating"),
      stopping: text("startup.title.stopping"),
    },
    status: {
      preparing: text("startup.status.preparing"),
      ready: text("startup.status.ready"),
      updating: text("startup.status.updating"),
      stopping: text("startup.status.stopping"),
    },
    stages: {
      validating: text("startup.stages.validating"),
      vault: text("startup.stages.vault"),
      application: text("startup.stages.application"),
      database: text("startup.stages.database"),
      migrations: text("startup.stages.migrations"),
      backend: text("startup.stages.backend"),
    },
    actions: {
      retry: text("startup.actions.retry"),
      continue: text("startup.actions.continue"),
      openLogs: text("startup.actions.openLogs"),
      openBackups: text("startup.actions.openBackups"),
      quit: text("startup.actions.quit"),
    },
    // The page fills in the path itself, so normalize spacing a translation
    // may add inside the placeholder.
    snapshot: text("startup.snapshot").replace(
      /\{\{\s*path\s*\}\}/g,
      "{{path}}",
    ),
    actionFailed: text("startup.actionFailed"),
    genericError: text("startup.genericError"),
    advice,
  };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character]!);
/** JSON that cannot close the inline script element it is embedded in. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</gu, "\\u003c");

/**
 * Theme tokens the startup page uses, mirrored from product-ui's `theme.css`
 * (light `:root` and `.dark`); a desktop test keeps them in sync. The page is
 * a self-contained data URL, so it cannot load the app's stylesheet.
 */
export const STARTUP_THEME = {
  light: {
    background: "hsl(48 33.3333% 97.0588%)",
    foreground: "hsl(0 0% 20%)",
    muted: "hsl(50.2 27.4% 87.1%)",
    "muted-foreground": "hsl(0 0% 43.1373%)",
    primary: "hsl(197.4 71.4286% 72.549%)",
    "primary-foreground": "hsl(0 0% 0%)",
    accent: "#e3f2fb",
    "accent-foreground": "#333333",
    border: "hsl(0 0% 83.1373%)",
    ring: "hsl(199 80% 42%)",
  },
  dark: {
    background: "#21252e",
    foreground: "hsl(0 0% 89.8039%)",
    muted: "hsl(0 0% 26.6667%)",
    "muted-foreground": "hsl(0 0% 63.9216%)",
    primary: "hsl(330 100% 80%)",
    "primary-foreground": "hsl(0 0% 0%)",
    accent: "#6d5a96",
    "accent-foreground": "#e5e5e5",
    border: "hsl(0 0% 26.6667%)",
    ring: "hsl(330 100% 80%)",
  },
} as const;

/** The page background as hex, so the window paints it before the page loads. */
export const STARTUP_BACKGROUND = { light: "#faf9f5", dark: "#21252e" };

const tokens = (theme: Record<string, string>) =>
  Object.entries(theme)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");

// Mirrors the app's 18px root, DM Sans and shadcn Button variants.
const styles = `@font-face{font-family:"DM Sans Variable";font-style:normal;font-display:block;font-weight:100 1000;src:url(${dmSans}) format("woff2")}
:root{color-scheme:light dark;--radius:0.5rem;${tokens(STARTUP_THEME.light)}}
@media (prefers-color-scheme:dark){:root{${tokens(STARTUP_THEME.dark)}}}
html{font-size:18px}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--background);color:var(--foreground);font-family:"DM Sans Variable",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none}
main{box-sizing:border-box;width:100%;max-width:28rem;padding:2rem 1.5rem;display:flex;flex-direction:column;align-items:center;text-align:center}
.mark{width:4rem;height:4rem}
h1{margin:1rem 0 0;font-size:1.25rem;line-height:1.75rem;font-weight:600}
p{margin:.375rem 0 0;font-size:.875rem;line-height:1.25rem;color:var(--muted-foreground)}
body[data-state=error] #message{color:var(--foreground)}
.bar{width:10rem;height:.25rem;margin-top:1.25rem;border-radius:9999px;background:var(--muted);overflow:hidden}
.bar span{display:block;width:40%;height:100%;border-radius:inherit;background:var(--primary);animation:slide 1.4s ease-in-out infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.bar span{animation:none;width:100%;opacity:.6}}
.detail{margin-top:.75rem;font:.75rem/1rem ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted-foreground);overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
#title,#message{-webkit-user-select:text;user-select:text}
.actions{display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem;margin-top:1.5rem}
button{font:inherit;font-size:.875rem;font-weight:500;height:2.25rem;padding:0 1rem;border-radius:calc(var(--radius) - 2px);border:1px solid transparent;background:transparent;color:var(--foreground);cursor:pointer;transition:background-color .15s,color .15s}
button.primary{background:var(--primary);color:var(--primary-foreground)}
button.primary:hover{background:color-mix(in oklab,var(--primary) 90%,transparent)}
button.outline{border-color:var(--border);background:var(--background)}
button.outline:hover,button.ghost:hover{background:var(--accent);color:var(--accent-foreground)}
button:focus-visible{outline:2px solid var(--foreground);outline-offset:2px}
button:disabled{opacity:.5;pointer-events:none}
[hidden]{display:none!important}`;

/**
 * The desktop startup and recovery page: the logo, one status line and a
 * progress bar while local services start; the error advice with Retry,
 * Open Logs, Open Backups and Quit when startup fails. Open Logs and Quit
 * also appear when startup takes unusually long. No app bundle, provider key,
 * error detail, or backend URL is needed. All text comes from `strings`, the
 * shell locale's table, which also sets the document's `lang` and `dir`.
 */
export function createRuntimePage(
  strings: ShellStrings,
  platform: NodeJS.Platform = process.platform,
): string {
  const nonce = randomBytes(18).toString("base64");
  const text = pageText(strings, platform);
  // Electron keeps a refused macOS Keychain answer until the app restarts.
  const noRetry =
    platform === "darwin"
      ? [...NO_RETRY_CODES, "secure_storage_unavailable"]
      : NO_RETRY_CODES;
  return `<!doctype html><html lang="${strings.locale}" dir="${strings.dir}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Animama</title>
<style>${styles}</style></head><body data-state="starting"><main><img class="mark" src="${mark}" alt=""><h1 id="title">Animama</h1><p id="message" role="status">${escapeHtml(text.status.preparing)}</p><div class="bar" id="bar" aria-hidden="true"><span></span></div><p class="detail" id="detail" hidden><span id="code"></span><br><span id="backup"></span></p><div class="actions" id="actions" hidden><button id="retry" class="primary" hidden>${escapeHtml(text.actions.retry)}</button><button id="continue" class="primary" hidden>${escapeHtml(text.actions.continue)}</button><button id="logs" class="outline">${escapeHtml(text.actions.openLogs)}</button><button id="backups" class="outline" hidden>${escapeHtml(text.actions.openBackups)}</button><button id="quit" class="ghost">${escapeHtml(text.actions.quit)}</button></div></main>
<script nonce="${nonce}">
const runtime=window.animamaDesktop?.runtime;
const $=(id)=>document.getElementById(id);
const text=${scriptJson(text)};
const noRetry=${scriptJson(noRetry)};
// A question, not a failure: Linux without a secret store asks before saving keys.
const CONSENT='unprotected_storage_consent_required';
// Startup normally finishes well within this; past it, offer Logs and Quit.
const STALL_MS=20000;
let state='starting',stalled=false,stallTimer;
// Each start (first launch, a restart or Retry) gets its own stall window.
function watchStall(){clearTimeout(stallTimer);stalled=false;stallTimer=setTimeout(()=>{stalled=true;if(state==='starting')$('actions').hidden=false;},STALL_MS);}
watchStall();
function render(value){if(value.state==='starting'&&state!=='starting')watchStall();state=value.state;const error=value.state==='error';const asking=error&&value.code===CONSENT;document.body.dataset.state=value.state;$('title').textContent=asking?text.title.consent:error?text.title.error:value.state==='updating'?text.title.updating:value.state==='stopping'?text.title.stopping:'Animama';$('message').textContent=error?(Object.hasOwn(text.advice,value.code)?text.advice[value.code]:text.genericError):value.state==='starting'?text.stages[value.stage]:value.state==='ready'?text.status.ready:value.state==='updating'?text.status.updating:value.state==='stopping'?text.status.stopping:text.status.preparing;$('bar').hidden=error;$('code').textContent=error?value.code:'';$('backup').textContent=error&&value.backup?text.snapshot.replace('{{path}}',()=>value.backup):'';$('detail').hidden=!error||asking;$('backups').hidden=!(error&&value.backup);$('retry').hidden=!error||asking||noRetry.includes(value.code);$('continue').hidden=!asking;$('logs').hidden=asking;$('actions').hidden=!(error||(stalled&&value.state==='starting'));}
async function invoke(action){try{await runtime[action]();}catch{$('message').textContent=text.actionFailed;$('actions').hidden=false;}}
for(const [id,action] of [['retry','retry'],['continue','acceptUnprotectedStorage'],['logs','openLogs'],['backups','openBackups'],['quit','quit']])$(id).onclick=()=>invoke(action);
if(runtime){runtime.onStatus(render);runtime.status().then(render).catch(()=>{});}
</script></body></html>`;
}

const pageUrl = (html: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

/** Independent data URL works when the application listener is unavailable. */
export async function createRecoveryWindow(
  preload: string,
  html: string,
  callers: RuntimeIpcCallers,
): Promise<BrowserWindow> {
  const url = pageUrl(html);
  const window = new BrowserWindow({
    width: 640,
    height: 480,
    title: "Animama",
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? STARTUP_BACKGROUND.dark
      : STARTUP_BACKGROUND.light,
    webPreferences: {
      preload,
      additionalArguments: ["--animama-window-role=recovery"],
      partition: "animama-recovery",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Packaged builds open no DevTools.
      devTools: !app.isPackaged,
    },
  });
  callers.register(window, "recovery", url);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await window.loadURL(url);
  return window;
}

/**
 * Show a rebuilt page, such as one in a newly applied locale, in the existing
 * recovery window. Recovery IPC authority moves to the new page's exact URL.
 */
export async function reloadRecoveryWindow(
  window: BrowserWindow,
  html: string,
  callers: RuntimeIpcCallers,
): Promise<void> {
  const url = pageUrl(html);
  callers.register(window, "recovery", url);
  await window.loadURL(url);
}
