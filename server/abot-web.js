#!/usr/bin/env node
"use strict";

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// Host roster for the dashboard host switcher. Loaded from a JSON file so a
// deployment is not tied to any specific tailnet or set of machines. Format:
//   [ { "label": "host1", "href": "https://host1.<tailnet>.ts.net:9443/",
//       "publicHref": "https://host1.<tailnet>.ts.net:8443/" }, ... ]
// Priority: ABOT_HOSTS_FILE -> ~/.abot/hosts.json -> single self host from env.
// publicHref is optional; pickHostHref() falls back to href when it is absent.
function loadHostRoster() {
  const file = process.env.ABOT_HOSTS_FILE || path.join(os.homedir(), ".abot", "hosts.json");
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(arr)) {
      const roster = arr
        .map((h) => ({
          label: String(h.label || "host"),
          href: String(h.href || h.url || ""),
          publicHref: h.publicHref ? String(h.publicHref) : undefined,
        }))
        .filter((h) => h.href);
      if (roster.length) return roster;
    }
  } catch {}
  // Fallback: advertise only this host, from env (no switcher if unset).
  const selfUrl = process.env.ABOT_SELF_URL || "";
  if (!selfUrl) return [];
  return [
    {
      label: process.env.ABOT_HOST_ALIAS || "host1",
      href: selfUrl,
      publicHref: process.env.ABOT_SELF_PUBLIC_URL || undefined,
    },
  ];
}

const CONFIG = {
  hostAlias: process.env.ABOT_HOST_ALIAS || "host1",
  webPort: Number(process.env.ABOT_WEB_PORT || 17900),
  ttydPort: Number(process.env.ABOT_TTYD_PORT || 17880),
  ttydBasePath: process.env.ABOT_TTYD_BASE_PATH || "/term",
  ttydTmuxSession: process.env.ABOT_TTYD_TMUX_SESSION || "abot-ttyd",
  webTmuxSession: process.env.ABOT_WEB_TMUX_SESSION || "abot-web",
  defaultTmuxSession: process.env.ABOT_TMUX_SESSION || "abot",
  sessionMode: process.env.ABOT_SESSION_MODE || "all",
  visibleSessions: (process.env.ABOT_VISIBLE_SESSIONS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  hostLinks: loadHostRoster(),
};

function loadAuthFromFile() {
  const file = process.env.ABOT_AUTH_FILE || path.join(os.homedir(), ".abot-auth");
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return { user: "", pass: "" };
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      return { user: String(parsed.user || ""), pass: String(parsed.pass || "") };
    }
    const idx = raw.indexOf(":");
    if (idx < 0) return { user: "", pass: "" };
    return { user: raw.slice(0, idx).trim(), pass: raw.slice(idx + 1).trim() };
  } catch {
    return { user: "", pass: "" };
  }
}

const fileAuth = loadAuthFromFile();
const AUTH = {
  user: process.env.ABOT_AUTH_USER || fileAuth.user,
  pass: process.env.ABOT_AUTH_PASS || fileAuth.pass,
};
const AUTH_ENABLED = Boolean(AUTH.user && AUTH.pass);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const userOk = safeEqual(decoded.slice(0, idx), AUTH.user);
  const passOk = safeEqual(decoded.slice(idx + 1), AUTH.pass);
  return userOk && passOk;
}

// --- Form login + signed session cookie -------------------------------------
// Basic Auth (above) stays for curl/API. Browsers use a form login so Google
// Password Manager can save/autofill/sync credentials (it ignores the native
// Basic Auth dialog).
const SESSION_COOKIE = "abot_session";
const SESSION_TTL_MS = Number(process.env.ABOT_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function loadSessionSecret() {
  const file =
    process.env.ABOT_SESSION_SECRET_FILE || path.join(os.homedir(), ".abot-session-secret");
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) return raw;
  } catch {}
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {}
  return secret;
}

const SESSION_SECRET = process.env.ABOT_SESSION_SECRET || loadSessionSecret();

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input) {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

function signSessionToken(user, expMs) {
  const payload = `${base64url(user)}.${expMs}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function makeSessionToken() {
  return signSessionToken(AUTH.user, Date.now() + SESSION_TTL_MS);
}

function verifySessionToken(token) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const sigBuf = Buffer.from(parts[2]);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let user = "";
  try {
    user = base64urlDecode(parts[0]);
  } catch {
    return false;
  }
  return safeEqual(user, AUTH.user);
}

function getCookie(req, name) {
  const header = req.headers["cookie"] || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

function hasValidSession(req) {
  return verifySessionToken(getCookie(req, SESSION_COOKIE));
}

// Allowed via valid session cookie (browser) OR Basic Auth header (curl/API).
function isRequestAllowed(req) {
  if (!AUTH_ENABLED) return true;
  return hasValidSession(req) || isAuthorized(req);
}

function loginOk(user, pass) {
  return (
    AUTH_ENABLED &&
    safeEqual(String(user || ""), AUTH.user) &&
    safeEqual(String(pass || ""), AUTH.pass)
  );
}

function setSessionCookie(res) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${makeSessionToken()}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function redirectTo(res, location) {
  res.writeHead(302, { Location: location, "cache-control": "no-store" });
  res.end();
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      const params = new URLSearchParams(data);
      const obj = {};
      for (const [key, value] of params) obj[key] = value;
      resolve(obj);
    });
    req.on("error", reject);
  });
}

function renderLoginHtml(hasError) {
  const err = hasError ? '<p class="err">아이디 또는 비밀번호가 올바르지 않습니다.</p>' : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>abot 로그인</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f172a; color:#e2e8f0; padding:24px; }
  form.login { width:100%; max-width:360px; background:#1e293b; border:1px solid #334155;
    border-radius:14px; padding:24px; display:flex; flex-direction:column; gap:14px;
    box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { margin:0 0 4px; font-size:22px; text-align:center; letter-spacing:.5px; }
  input { width:100%; padding:13px 14px; font-size:16px; border-radius:10px;
    border:1px solid #475569; background:#0f172a; color:#e2e8f0; }
  input:focus { outline:2px solid #38bdf8; border-color:#38bdf8; }
  button { width:100%; padding:13px 14px; font-size:16px; font-weight:600; border:0;
    border-radius:10px; background:#38bdf8; color:#03263a; cursor:pointer; }
  button:active { transform:translateY(1px); }
  .err { margin:0; color:#fca5a5; font-size:14px; text-align:center; }
  .hint { margin:0; color:#94a3b8; font-size:12px; text-align:center; }
</style>
</head>
<body>
<form class="login" method="POST" action="/login">
  <h1>abot</h1>
  ${err}
  <input type="text" name="username" placeholder="아이디" autocomplete="username"
    autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
  <input type="password" name="password" placeholder="비밀번호" autocomplete="current-password" required>
  <button type="submit">로그인</button>
  <p class="hint">인증된 사용자만 접근할 수 있습니다.</p>
</form>
</body>
</html>`;
}

function sendLoginHtml(res, hasError) {
  const body = renderLoginHtml(hasError);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendAuthChallenge(res) {
  const body = "authentication required";
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="abot", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

let currentSession = CONFIG.defaultTmuxSession;
let ttydStartedAt = 0;

const TTYD_FONT_SIZES = [12, 14, 18];
const TTYD_THEMES = {
  light: { background: "#ffffff", foreground: "#1b1f27", cursor: "#1b1f27", selectionBackground: "#b9d6ff" },
  dark: { background: "#101418", foreground: "#e6e8ec", cursor: "#e6e8ec", selectionBackground: "#33415a" },
  high: { background: "#000000", foreground: "#ffe14d", cursor: "#ffe14d", selectionBackground: "#5a4b00" },
};

let ttydFontSize = TTYD_FONT_SIZES.includes(Number(process.env.ABOT_TTYD_FONT_SIZE))
  ? Number(process.env.ABOT_TTYD_FONT_SIZE)
  : 14;
let ttydTheme = TTYD_THEMES[process.env.ABOT_TTYD_THEME] ? process.env.ABOT_TTYD_THEME : "dark";

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnInputP(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = require("child_process").spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} exited with ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin.end(input);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmux(args) {
  const { stdout } = await execFileP("tmux", args);
  return stdout;
}

async function hasTmuxSession(name) {
  try {
    await tmux(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

async function listSessions() {
  let sessions = await listVisibleSessions();
  if (!sessions.length) {
    const allSessions = await listAllSessions();
    const fallback = allSessions.find(
      (session) => session.name === CONFIG.defaultTmuxSession && !isManagedSession(session.name)
    );
    if (fallback) {
      sessions = [fallback];
    }
  }
  const panes = await listPanes().catch(() => []);
  for (const session of sessions) {
    session.panes = panes.filter((pane) => pane.session === session.name);
  }
  return sessions;
}

async function listAllSessions() {
  const stdout = await tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_attached}\t#{session_windows}",
  ]);
  const sessions = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, attached, windows] = line.split("\t");
      return {
        name,
        attached: Number(attached || 0),
        windows: Number(windows || 0),
      };
    });
  return sessions;
}

async function listVisibleSessions() {
  return (await listAllSessions()).filter(isVisibleSession);
}

function isManagedSession(name) {
  return name === CONFIG.ttydTmuxSession || name === CONFIG.webTmuxSession;
}

function isVisibleSession(session) {
  if (isManagedSession(session.name)) {
    return false;
  }
  if (CONFIG.visibleSessions.length) {
    return CONFIG.visibleSessions.includes(session.name);
  }
  if (CONFIG.sessionMode === "all") {
    return true;
  }
  return session.attached > 0;
}

async function chooseInitialSession() {
  const sessions = await listVisibleSessions().catch(() => []);
  const defaultVisible = sessions.find((session) => session.name === CONFIG.defaultTmuxSession);
  if (defaultVisible) {
    return defaultVisible.name;
  }
  if (sessions.length) {
    return sessions[0].name;
  }
  return CONFIG.defaultTmuxSession;
}

async function listPanes() {
  const stdout = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}\t#{pane_title}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [session, windowIndex, windowName, paneIndex, paneId, active, command, title] =
        line.split("\t");
      return {
        session,
        windowIndex: Number(windowIndex || 0),
        windowName,
        paneIndex: Number(paneIndex || 0),
        paneId,
        active: active === "1",
        command,
        title,
      };
    });
}

async function listClients() {
  const stdout = await tmux([
    "list-clients",
    "-F",
    "#{client_name}\t#{client_session}\t#{client_tty}\t#{client_pid}\t#{client_created}\t#{client_activity}\t#{client_width}\t#{client_height}",
  ]).catch(() => "");
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, session, tty, pid, created, activity, width, height] = line.split("\t");
      return {
        name,
        session,
        tty,
        pid: Number(pid || 0),
        created: Number(created || 0),
        activity: Number(activity || 0),
        width: Number(width || 0),
        height: Number(height || 0),
      };
    });
}

async function getTargetPane(sessionName) {
  const panes = await listPanes();
  const activePane = panes.find((pane) => pane.session === sessionName && pane.active);
  if (!activePane) {
    const error = new Error(`no active pane for session: ${sessionName}`);
    error.statusCode = 404;
    throw error;
  }
  return activePane;
}

async function pasteToSession(sessionName, text, enter) {
  const pane = await getTargetPane(sessionName);
  const bufferName = `abot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await spawnInputP("tmux", ["load-buffer", "-b", bufferName, "-"], text);
  try {
    await tmux(["paste-buffer", "-b", bufferName, "-t", pane.paneId]);
  } finally {
    await tmux(["delete-buffer", "-b", bufferName]).catch(() => {});
  }
  if (enter) {
    await delay(120);
    await tmux(["send-keys", "-t", pane.paneId, "C-m"]);
  }
  return pane;
}

async function captureSessionText(sessionName) {
  const pane = await getTargetPane(sessionName);
  const stdout = await tmux(["capture-pane", "-p", "-J", "-S", "-2000", "-t", pane.paneId]);
  return {
    pane,
    text: stdout.replace(/\n+$/g, ""),
  };
}

async function sendSafeKey(sessionName, keyName) {
  const keyMap = {
    stop: "C-c",
    escape: "Escape",
    clearLine: "C-u",
    tab: "Tab",
  };
  const tmuxKey = keyMap[keyName];
  if (!tmuxKey) {
    const error = new Error(`unsupported key: ${keyName}`);
    error.statusCode = 400;
    throw error;
  }
  const pane = await getTargetPane(sessionName);
  await tmux(["send-keys", "-t", pane.paneId, tmuxKey]);
  return { pane, tmuxKey };
}

async function restartTtyd(sessionName) {
  if (!(await hasTmuxSession(sessionName))) {
    const error = new Error(`tmux session not found: ${sessionName}`);
    error.statusCode = 404;
    throw error;
  }

  if (await hasTmuxSession(CONFIG.ttydTmuxSession)) {
    await tmux(["kill-session", "-t", CONFIG.ttydTmuxSession]).catch(() => {});
  }

  const command = [
    "ttyd",
    "-b",
    CONFIG.ttydBasePath,
    "-i",
    "127.0.0.1",
    "-p",
    String(CONFIG.ttydPort),
    "-W",
    "-t",
    `fontSize=${ttydFontSize}`,
    "-t",
    "cursorBlink=true",
    "-t",
    "scrollback=10000",
    "-t",
    "disableLeaveAlert=true",
    "-t",
    `theme=${JSON.stringify(TTYD_THEMES[ttydTheme] || TTYD_THEMES.dark)}`,
    "tmux",
    "attach",
    "-t",
    sessionName,
  ]
    .map(shellQuote)
    .join(" ");

  await tmux(["new-session", "-d", "-s", CONFIG.ttydTmuxSession, command]);
  currentSession = sessionName;
  ttydStartedAt = Math.floor(Date.now() / 1000);
  await waitForTtydListening(1500);
}

async function waitForTtydListening(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.connect(CONFIG.ttydPort, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await delay(80);
  }
}

async function detachCurrentWebClient(sessionName) {
  const clients = (await listClients()).filter((client) => client.session === sessionName);
  if (!clients.length) {
    const error = new Error(`no attached tmux client for session: ${sessionName}`);
    error.statusCode = 404;
    throw error;
  }

  const candidates = clients.filter((client) => client.created >= ttydStartedAt - 2);
  if (!candidates.length) {
    const error = new Error("no web terminal client found to detach");
    error.statusCode = 409;
    throw error;
  }
  candidates.sort((a, b) => b.created - a.created || b.activity - a.activity);
  const target = candidates[0];

  await tmux(["detach-client", "-t", target.tty]);
  return target;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res) {
  const body = renderHtml();
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/status") {
    sendJson(res, 200, {
      hostAlias: CONFIG.hostAlias,
      currentSession,
      ttydPort: CONFIG.ttydPort,
      webPort: CONFIG.webPort,
      hostLinks: CONFIG.hostLinks,
      fontSize: ttydFontSize,
      theme: ttydTheme,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/tmux/sessions") {
    sendJson(res, 200, {
      currentSession,
      sessions: await listSessions(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/tmux/clients") {
    sendJson(res, 200, {
      currentSession,
      clients: await listClients(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/terminal/select") {
    const body = await readJson(req);
    const session = String(body.session || "").trim();
    if (!session) {
      sendJson(res, 400, { error: "session is required" });
      return;
    }
    await restartTtyd(session);
    sendJson(res, 200, { ok: true, currentSession });
    return;
  }

  if (req.method === "POST" && pathname === "/api/terminal/background") {
    const body = await readJson(req);
    const session = String(body.session || currentSession).trim();
    const detached = await detachCurrentWebClient(session);
    sendJson(res, 200, { ok: true, detached });
    return;
  }

  if (req.method === "POST" && pathname === "/api/terminal/preset") {
    const body = await readJson(req);
    let changed = false;
    if (body.fontSize !== undefined) {
      const size = Number(body.fontSize);
      if (!TTYD_FONT_SIZES.includes(size)) {
        sendJson(res, 400, { error: "unsupported fontSize" });
        return;
      }
      ttydFontSize = size;
      changed = true;
    }
    if (body.theme !== undefined) {
      const theme = String(body.theme);
      if (!TTYD_THEMES[theme]) {
        sendJson(res, 400, { error: "unsupported theme" });
        return;
      }
      ttydTheme = theme;
      changed = true;
    }
    if (!changed) {
      sendJson(res, 400, { error: "fontSize or theme is required" });
      return;
    }
    await restartTtyd(currentSession);
    sendJson(res, 200, { ok: true, fontSize: ttydFontSize, theme: ttydTheme, currentSession });
    return;
  }

  if (req.method === "POST" && pathname === "/api/tmux/send") {
    const body = await readJson(req);
    const session = String(body.session || currentSession).trim();
    const text = String(body.text || "");
    const enter = Boolean(body.enter);
    if (!session) {
      sendJson(res, 400, { error: "session is required" });
      return;
    }
    if (!text.length && !enter) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const pane = text.length ? await pasteToSession(session, text, enter) : await getTargetPane(session);
    if (!text.length && enter) {
      await tmux(["send-keys", "-t", pane.paneId, "C-m"]);
    }
    sendJson(res, 200, { ok: true, session, paneId: pane.paneId, enter });
    return;
  }

  if (req.method === "POST" && pathname === "/api/tmux/capture") {
    const body = await readJson(req);
    const session = String(body.session || currentSession).trim();
    if (!session) {
      sendJson(res, 400, { error: "session is required" });
      return;
    }
    const result = await captureSessionText(session);
    sendJson(res, 200, {
      ok: true,
      session,
      paneId: result.pane.paneId,
      text: result.text,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/tmux/key") {
    const body = await readJson(req);
    const session = String(body.session || currentSession).trim();
    const key = String(body.key || "").trim();
    if (!session || !key) {
      sendJson(res, 400, { error: "session and key are required" });
      return;
    }
    const result = await sendSafeKey(session, key);
    sendJson(res, 200, {
      ok: true,
      session,
      paneId: result.pane.paneId,
      key,
      tmuxKey: result.tmuxKey,
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function proxyHttp(req, res) {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: CONFIG.ttydPort,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${CONFIG.ttydPort}`,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    sendJson(res, 502, { error: `terminal proxy failed: ${error.message}` });
  });

  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  if (!isRequestAllowed(req)) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        'WWW-Authenticate: Basic realm="abot"\r\n' +
        "Connection: close\r\n\r\n"
    );
    socket.destroy();
    return;
  }
  if (!req.url || !req.url.startsWith(CONFIG.ttydBasePath)) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(CONFIG.ttydPort, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(`${name}: ${item}`);
        }
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
    if (head.length) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function renderHtml() {
  const hostLinksJson = JSON.stringify(CONFIG.hostLinks);
  const hostLinksHtml = CONFIG.hostLinks
    .map((host) => {
      const href = String(host.href).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const label = String(host.label)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<a class="host" href="${href}">${label}</a>`;
    })
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Abot</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dde5;
      --text: #151922;
      --muted: #647085;
      --accent: #176b5b;
      --accent-2: #2457a6;
      --danger: #a33a32;
      --button: #eef2f7;
      --button-active: #d8eee8;
      --shadow: 0 1px 2px rgba(20, 30, 45, 0.12);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { background: var(--bg); color: var(--text); overflow: hidden; }
    .app {
      display: grid;
      grid-template-rows: auto 1fr auto auto;
      height: 100%;
      min-width: 320px;
    }
    .bar {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr);
      grid-template-areas:
        "brand hosts actions"
        "sessions sessions sessions";
      align-items: center;
      gap: 3px 8px;
      padding: 3px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .brand {
      display: flex;
      align-items: center;
      min-width: 70px;
      font-weight: 750;
      letter-spacing: 0;
      color: var(--accent);
    }
    .brand { grid-area: brand; }
    .hosts { grid-area: hosts; }
    .sessions { grid-area: sessions; }
    .actions { grid-area: actions; }
    .hosts, .sessions, .actions {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .hosts, .actions {
      overflow-x: auto;
      scrollbar-width: none;
    }
    .hosts::-webkit-scrollbar,
    .actions::-webkit-scrollbar,
    .sessions::-webkit-scrollbar {
      display: none;
    }
    .sessions {
      overflow-x: auto;
      padding-bottom: 1px;
      scrollbar-width: none;
    }
    .hosts::before,
    .sessions::before,
    .actions::before {
      flex: 0 0 auto;
      min-width: 34px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .hosts::before { content: "Mac"; }
    .sessions::before { content: "Work"; }
    .actions::before { content: "Fn"; }
    button, a.host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 26px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--button);
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
    }
    a.host {
      border-radius: 999px;
      padding: 0 12px;
      background: #f8fbfd;
      border-color: #bfc9d6;
    }
    .actions button,
    .composer-actions button {
      border-radius: 4px;
      min-width: 44px;
    }
    button.session {
      min-height: 26px;
      border-radius: 3px;
      border-left: 5px solid #9aa6b5;
      background: #ffffff;
      box-shadow: inset 0 -1px 0 rgba(20, 30, 45, 0.05);
    }
    button.session.active {
      border-color: var(--accent);
      border-left-color: #0d4d41;
      background: var(--accent);
      color: #ffffff;
      font-weight: 750;
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.38);
    }
    button:hover, a.host:hover { border-color: #aab4c3; }
    button.active:not(.session), a.host.active {
      background: var(--button-active);
      border-color: #8bc4b6;
      color: #0d4d41;
    }
    button.action {
      background: #e8eef8;
      border-color: #b9c9e4;
      color: var(--accent-2);
    }
    button.danger {
      background: #f7e9e7;
      border-color: #e4b9b5;
      color: var(--danger);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    .main {
      min-height: 0;
      background: #101418;
      position: relative;
      overflow: hidden;
    }
    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #101418;
    }
    .touch-scroll {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 2;
      display: flex;
      justify-content: center;
      width: 34px;
      height: 100%;
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: linear-gradient(90deg, rgba(16, 20, 24, 0), rgba(16, 20, 24, 0.46));
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: ns-resize;
    }
    .touch-scroll::before {
      content: "";
      align-self: center;
      width: 6px;
      height: min(160px, 34%);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.42);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.22);
    }
    .touch-scroll.active {
      background: linear-gradient(90deg, rgba(16, 20, 24, 0.08), rgba(23, 107, 91, 0.62));
    }
    .touch-scroll.active::before {
      background: rgba(255, 255, 255, 0.78);
    }
    .copy-panel {
      position: absolute;
      inset: 0;
      z-index: 4;
      display: none;
      grid-template-rows: auto 1fr;
      background: #ffffff;
      color: var(--text);
    }
    .copy-panel.open {
      display: grid;
    }
    .manual-panel {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: none;
      grid-template-rows: auto 1fr;
      background: #ffffff;
      color: var(--text);
    }
    .manual-panel.open {
      display: grid;
    }
    .copy-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .copy-info {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .copy-text {
      margin: 0;
      padding: 12px;
      overflow: auto;
      white-space: pre-wrap;
      user-select: text;
      -webkit-user-select: text;
      color: #111827;
      background: #ffffff;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    .manual-text {
      overflow: auto;
      padding: 14px 16px 20px;
      color: #172033;
      background: #ffffff;
      font-size: 14px;
      line-height: 1.48;
      user-select: text;
      -webkit-user-select: text;
    }
    .manual-text h2,
    .manual-text h3 {
      margin: 0 0 8px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .manual-text h2 {
      font-size: 18px;
      color: var(--accent);
    }
    .manual-text h3 {
      margin-top: 16px;
      font-size: 15px;
      color: #24324a;
    }
    .manual-text p {
      margin: 0 0 8px;
    }
    .manual-text ul {
      margin: 0;
      padding-left: 18px;
    }
    .manual-text li {
      margin: 4px 0;
    }
    .status {
      display: flex;
      align-items: center;
      min-height: 32px;
      padding: 0 12px;
      border-top: 1px solid var(--line);
      background: var(--panel);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 10px;
      padding: 10px 12px;
      border-top: 1px solid var(--line);
      background: var(--panel);
    }
    textarea {
      width: 100%;
      min-height: 58px;
      max-height: 14vh;
      resize: vertical;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      font: 15px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: #fff;
    }
    .composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: start;
      align-content: start;
    }
    .composer.composer-collapsed {
      display: none;
    }
    .composer-controls {
      margin-left: auto;
    }
    .presets {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 18px;
      padding: 6px 12px;
      border-top: 1px solid var(--line);
      background: var(--panel);
    }
    .preset-group {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .preset-label {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    button.preset {
      min-height: 26px;
      min-width: 42px;
      padding: 0 10px;
    }
    button.preset[data-font] {
      background: #e0f2fe;
      border-color: #7dd3fc;
      color: #075985;
    }
    button.preset[data-theme] {
      background: #ede9fe;
      border-color: #c4b5fd;
      color: #5b21b6;
    }
    button.preset.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
      font-weight: 750;
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.32);
    }
    #sendEnter {
      background: #dcfce7;
      border-color: #86efac;
      color: #166534;
    }
    #toggleComposer {
      background: #fef3c7;
      border-color: #fcd34d;
      color: #92400e;
    }
    @media (max-width: 720px) {
      .bar {
        grid-template-columns: auto auto minmax(0, 1fr);
        grid-template-areas:
          "brand hosts actions"
          "sessions sessions sessions";
        gap: 6px;
      }
      .brand { min-width: 46px; }
      .hosts {
        justify-content: flex-start;
      }
      .actions { padding-bottom: 1px; }
      button, a.host { min-height: 26px; padding: 0 9px; font-size: 12px; }
      .hosts::before,
      .sessions::before,
      .actions::before {
        min-width: 30px;
        font-size: 10px;
      }
      .composer {
        grid-template-columns: 1fr;
      }
      .composer-actions {
        flex-wrap: nowrap;
      }
      .composer-actions button {
        flex: 1;
      }
      .touch-scroll {
        width: 42px;
      }
      .copy-toolbar {
        flex-wrap: wrap;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="bar">
      <div class="brand">Abot</div>
      <nav class="hosts" id="hosts">${hostLinksHtml}</nav>
      <nav class="sessions" id="sessions"></nav>
      <div class="actions">
        <button class="action" id="focusComposer" type="button">Input</button>
        <button class="danger" id="interrupt" type="button">Stop</button>
        <button id="escape" type="button">Esc</button>
        <button id="clearLine" type="button" title="Clear current input line">C-U</button>
        <button id="openCopy" type="button">Text</button>
        <button id="openHelp" type="button">Help</button>
        <button id="tabKey" type="button" title="Tab (자동완성/추천 선택)">Tab</button>
        <button class="action" id="reload" type="button">Reload</button>
        <button class="danger" id="background" type="button" title="Detach web terminal">Bg</button>
      </div>
    </header>
    <main class="main">
      <iframe id="terminal" title="terminal" src="/term/"></iframe>
      <div class="touch-scroll" id="touchScroll" aria-hidden="true"></div>
      <section class="copy-panel" id="copyPanel" aria-label="copy text">
        <div class="copy-toolbar">
          <div class="copy-info" id="copyInfo">Visible terminal text</div>
          <button class="action" id="copyAll" type="button">Copy</button>
          <button id="closeCopy" type="button">Close</button>
        </div>
        <pre class="copy-text" id="copyView" tabindex="0"></pre>
      </section>
      <section class="manual-panel" id="manualPanel" aria-label="manual">
        <div class="copy-toolbar">
          <div class="copy-info">Abot manual</div>
          <button id="closeHelp" type="button">Close</button>
        </div>
        <div class="manual-text" id="manualView" tabindex="0">
          <h2>Abot manual</h2>
          <h3>Host / Work</h3>
          <ul>
            <li><strong>호스트 버튼</strong>: 접속할 PC(호스트)를 바꿉니다.</li>
            <li><strong>Work</strong>: 현재 호스트의 tmux 작업을 선택합니다.</li>
          </ul>
          <h3>Input</h3>
          <ul>
            <li>아래 입력창에 한글, 음성 입력, 긴 문장을 넣습니다.</li>
            <li><strong>Send</strong>: 입력창 내용을 붙여넣고 엔터까지 보냅니다.</li>
            <li><strong>Shift+Enter</strong>: Send와 같습니다.</li>
            <li><strong>Hide/Show</strong>: 아래 입력창을 접거나 폅니다. (Input 버튼을 누르면 자동으로 펼쳐집니다.)</li>
          </ul>
          <h3>Fn</h3>
          <ul>
            <li><strong>Stop</strong>: 실행 중인 명령을 중단합니다.</li>
            <li><strong>Esc</strong>: Escape 키를 보냅니다.</li>
            <li><strong>C-U</strong>: 현재 입력 줄을 지웁니다.</li>
            <li><strong>Text</strong>: 현재 보이는 터미널 내용을 복사용 텍스트로 엽니다.</li>
            <li><strong>Up / Down</strong>: 터미널 화면 기록을 위아래로 이동합니다.</li>
            <li><strong>Bg</strong>: 웹 터미널 접속만 백그라운드로 보냅니다.</li>
          </ul>
          <h3>Scroll / Copy</h3>
          <ul>
            <li>오른쪽 세로 스크롤 영역을 손으로 밀면 화면 기록을 움직입니다.</li>
            <li>복사할 내용이 있으면 먼저 원하는 위치로 스크롤한 뒤 Text를 누릅니다.</li>
          </ul>
        </div>
      </section>
    </main>
    <section class="composer composer-collapsed" id="composerBox" aria-label="composer">
      <textarea id="composer" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="한글/음성 입력"></textarea>
    </section>
    <section class="presets" id="presets" aria-label="terminal presets">
      <div class="preset-group">
        <button class="preset" data-font="12" type="button">작게</button>
        <button class="preset" data-font="14" type="button">보통</button>
        <button class="preset" data-font="18" type="button">크게</button>
      </div>
      <div class="preset-group">
        <button class="preset" data-theme="light" type="button">라이트</button>
        <button class="preset" data-theme="dark" type="button">다크</button>
        <button class="preset" data-theme="high" type="button">고대비</button>
      </div>
      <div class="composer-actions composer-controls">
        <button class="action" id="sendEnter" type="button">Send</button>
        <button id="toggleComposer" type="button" title="입력창 접기/펼치기">Show</button>
      </div>
    </section>
  </div>
  <script>
    const hostLinks = ${hostLinksJson};
    const hostAlias = ${JSON.stringify(CONFIG.hostAlias)};
    let currentSession = ${JSON.stringify(currentSession)};
    const terminal = document.getElementById("terminal");
    const touchScroll = document.getElementById("touchScroll");
    const copyPanel = document.getElementById("copyPanel");
    const copyInfo = document.getElementById("copyInfo");
    const copyView = document.getElementById("copyView");
    const manualPanel = document.getElementById("manualPanel");
    const manualView = document.getElementById("manualView");
    const statusEl = document.getElementById("status");
    const sessionsEl = document.getElementById("sessions");
    const hostsEl = document.getElementById("hosts");
    const buttons = {
      reload: document.getElementById("reload"),
      background: document.getElementById("background"),
      focusComposer: document.getElementById("focusComposer"),
      interrupt: document.getElementById("interrupt"),
      escape: document.getElementById("escape"),
      clearLine: document.getElementById("clearLine"),
      openCopy: document.getElementById("openCopy"),
      openHelp: document.getElementById("openHelp"),
      tabKey: document.getElementById("tabKey"),
      copyAll: document.getElementById("copyAll"),
      closeCopy: document.getElementById("closeCopy"),
      closeHelp: document.getElementById("closeHelp"),
      sendEnter: document.getElementById("sendEnter"),
      toggleComposer: document.getElementById("toggleComposer"),
    };
    const composer = document.getElementById("composer");
    const composerBox = document.getElementById("composerBox");
    const presetsEl = document.getElementById("presets");
    let currentFontSize = ${ttydFontSize};
    let currentTheme = ${JSON.stringify(ttydTheme)};

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    function renderPresetActive() {
      for (const button of presetsEl.querySelectorAll("button.preset")) {
        const isFont = button.dataset.font !== undefined && Number(button.dataset.font) === currentFontSize;
        const isTheme = button.dataset.theme !== undefined && button.dataset.theme === currentTheme;
        button.classList.toggle("active", isFont || isTheme);
      }
    }

    function setBusy(value) {
      buttons.reload.disabled = value;
      buttons.background.disabled = value;
      buttons.focusComposer.disabled = value;
      buttons.interrupt.disabled = value;
      buttons.escape.disabled = value;
      buttons.clearLine.disabled = value;
      buttons.openCopy.disabled = value;
      buttons.openHelp.disabled = value;
      buttons.tabKey.disabled = value;
      buttons.sendEnter.disabled = value;
      for (const button of sessionsEl.querySelectorAll("button")) button.disabled = value;
      for (const button of presetsEl.querySelectorAll("button")) button.disabled = value;
    }

    async function api(path, options) {
      const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    function reloadTerminal() {
      closeCopyPanel(false);
      closeHelpPanel(false);
      terminal.src = "/term/?r=" + Date.now();
    }

    function pickHostHref(host) {
      // tailnet Serve uses :9443. Any other port (public Funnel :8443/:10000,
      // or local dev) picks the public URL so cross-host links stay reachable.
      const isTailnet = window.location.port === "9443";
      return (!isTailnet && host.publicHref) ? host.publicHref : host.href;
    }

    function renderHosts() {
      const currentHost = window.location.hostname;
      hostsEl.replaceChildren(
        ...hostLinks.map((host) => {
          const href = pickHostHref(host);
          const link = document.createElement("a");
          link.className = "host" + (new URL(href).hostname === currentHost ? " active" : "");
          link.href = href;
          link.textContent = host.label;
          return link;
        })
      );
    }

    function renderSessions(sessions) {
      sessionsEl.replaceChildren(
        ...sessions.map((session) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "session" + (session.name === currentSession ? " active" : "");
          const primaryPane = (session.panes || [])[0];
          const suffix = primaryPane ? " · " + primaryPane.command : "";
          button.textContent = session.name + suffix;
          button.title = session.name + " attached=" + session.attached;
          button.addEventListener("click", () => selectSession(session.name));
          return button;
        })
      );
    }

    async function refresh() {
      const data = await api("/api/tmux/sessions");
      const previousSession = currentSession;
      currentSession = data.currentSession;
      // Collapse the input area whenever the active session changes — including
      // when another tab/window triggered the switch (detected via polling).
      if (currentSession !== previousSession) setComposerHidden(true);
      renderSessions(data.sessions);
      setStatus(hostAlias + " · " + currentSession + " · " + new Date().toLocaleTimeString());
    }

    async function selectSession(session) {
      if (session === currentSession) return;
      closeCopyPanel(false);
      closeHelpPanel(false);
      setBusy(true);
      setStatus("Switching to " + session);
      try {
        await api("/api/terminal/select", {
          method: "POST",
          body: JSON.stringify({ session }),
        });
        currentSession = session;
        await refresh();
        reloadTerminal();
        setComposerHidden(true);
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function background() {
      closeCopyPanel(false);
      closeHelpPanel(false);
      setBusy(true);
      setStatus("Detaching " + currentSession);
      try {
        await api("/api/terminal/background", {
          method: "POST",
          body: JSON.stringify({ session: currentSession }),
        });
        setStatus(currentSession + " detached");
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function sendComposer(enter) {
      closeCopyPanel(false);
      closeHelpPanel(false);
      const text = composer.value;
      if (!text && !enter) {
        composer.focus();
        return;
      }
      setBusy(true);
      setStatus(enter ? "Sending" : "Pasting");
      try {
        await api("/api/tmux/send", {
          method: "POST",
          body: JSON.stringify({ session: currentSession, text, enter }),
        });
        composer.value = "";
        setStatus("sent to " + currentSession);
        focusComposer();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function setComposerHidden(hidden) {
      composerBox.classList.toggle("composer-collapsed", hidden);
      buttons.toggleComposer.textContent = hidden ? "Show" : "Hide";
      buttons.toggleComposer.setAttribute("aria-pressed", String(hidden));
    }

    function focusComposer() {
      closeCopyPanel(false);
      closeHelpPanel(false);
      setComposerHidden(false);
      composer.focus({ preventScroll: true });
      composer.setSelectionRange(composer.value.length, composer.value.length);
      setStatus("input ready · " + currentSession);
    }

    async function applyPreset(payload, label) {
      closeCopyPanel(false);
      closeHelpPanel(false);
      setBusy(true);
      setStatus(label + " 적용 중");
      try {
        const data = await api("/api/terminal/preset", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        currentFontSize = data.fontSize;
        currentTheme = data.theme;
        renderPresetActive();
        reloadTerminal();
        setStatus(label + " 적용됨");
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function getTerminalScrollContext() {
      let doc;
      let win;
      try {
        win = terminal.contentWindow;
        doc = terminal.contentDocument || win?.document;
      } catch (error) {
        setStatus("terminal frame is not accessible");
        return null;
      }
      const viewport = doc?.querySelector(".xterm-viewport");
      const eventTarget =
        doc?.querySelector(".xterm") ||
        doc?.querySelector(".terminal") ||
        viewport ||
        doc?.body;
      if (!viewport) {
        setStatus("terminal scroll area not ready");
        return null;
      }
      return { viewport, eventTarget, win };
    }

    function scrollTerminalBy(delta, statusText) {
      const context = getTerminalScrollContext();
      if (!context) return false;
      const { viewport, eventTarget, win } = context;
      const before = viewport.scrollTop;
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, viewport.scrollTop + delta));
      try {
        eventTarget?.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: delta,
            bubbles: true,
            cancelable: true,
            view: win,
          })
        );
      } catch {
        // Direct scrollTop above is the primary path.
      }
      if (viewport.scrollTop === before && delta > 0) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      if (statusText) setStatus(statusText);
      return true;
    }

    function scrollTerminal(direction) {
      const context = getTerminalScrollContext();
      if (!context) return;
      const amount = Math.max(160, Math.floor(context.viewport.clientHeight * 0.85));
      scrollTerminalBy(direction * amount, direction < 0 ? "scrolled up" : "scrolled down");
    }

    function getTerminalTextSnapshot() {
      const context = getTerminalScrollContext();
      if (!context) return { text: "", label: "No terminal text" };
      const doc = context.viewport.ownerDocument;
      const selected =
        context.win?.getSelection?.().toString() ||
        doc?.getSelection?.().toString() ||
        "";
      if (selected.trim()) {
        return { text: selected, label: "Selected terminal text" };
      }
      const rows = Array.from(doc.querySelectorAll(".xterm-rows > div"));
      const text = rows
        .map((row) => (row.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+$/g, ""))
        .join("\\n")
        .replace(/\\n+$/g, "");
      return { text, label: "Visible terminal text" };
    }

    async function writeClipboard(text) {
      if (!text.trim()) {
        throw new Error("no text to copy");
      }
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      helper.style.top = "0";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      if (!copied) {
        throw new Error("clipboard copy failed");
      }
    }

    async function loadCopyText() {
      const snapshot = getTerminalTextSnapshot();
      if (snapshot.label === "Selected terminal text" && snapshot.text.trim()) {
        return snapshot;
      }
      const data = await api("/api/tmux/capture", {
        method: "POST",
        body: JSON.stringify({ session: currentSession }),
      });
      return {
        text: data.text || "",
        label: "Current tmux screen text",
      };
    }

    async function openCopyPanel() {
      closeHelpPanel(false);
      copyPanel.classList.add("open");
      buttons.openCopy.classList.add("active");
      copyInfo.textContent = "Loading terminal text";
      copyView.textContent = "Loading...";
      copyView.focus({ preventScroll: true });
      setStatus("text loading");
      try {
        const snapshot = await loadCopyText();
        if (!snapshot.text.trim()) {
          copyInfo.textContent = "No terminal text";
          copyView.textContent = "No terminal text is available yet.";
          setStatus("no terminal text to copy");
          return;
        }
        copyInfo.textContent = snapshot.label + " · drag/select or Copy";
        copyView.textContent = snapshot.text;
        copyView.focus({ preventScroll: true });
        copyView.scrollTop = copyView.scrollHeight;
        setStatus("text view ready");
      } catch (error) {
        copyInfo.textContent = "Text failed";
        copyView.textContent = error.message;
        setStatus(error.message);
      }
    }

    function closeCopyPanel(refocus) {
      copyPanel.classList.remove("open");
      buttons.openCopy.classList.remove("active");
      if (refocus) focusComposer();
    }

    function openHelpPanel() {
      closeCopyPanel(false);
      manualPanel.classList.add("open");
      manualView.focus({ preventScroll: true });
      setStatus("manual ready");
    }

    function closeHelpPanel(refocus) {
      manualPanel.classList.remove("open");
      if (refocus) focusComposer();
    }

    async function copyPanelText() {
      try {
        await writeClipboard(copyView.textContent || "");
        setStatus("copied text");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function initTouchScroll() {
      let drag = null;

      touchScroll.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        drag = {
          pointerId: event.pointerId,
          lastY: event.clientY,
          lastStatusAt: 0,
        };
        touchScroll.classList.add("active");
        touchScroll.setPointerCapture?.(event.pointerId);
        setStatus("scroll handle ready");
      });

      touchScroll.addEventListener("pointermove", (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const delta = (drag.lastY - event.clientY) * 1.5;
        drag.lastY = event.clientY;
        if (Math.abs(delta) < 1) return;
        const now = Date.now();
        const showStatus = now - drag.lastStatusAt > 160;
        if (scrollTerminalBy(delta, showStatus ? "touch scrolling" : "")) {
          drag.lastStatusAt = now;
        }
      });

      function endDrag(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        touchScroll.releasePointerCapture?.(event.pointerId);
        touchScroll.classList.remove("active");
        drag = null;
        setStatus("scroll handle done");
      }

      touchScroll.addEventListener("pointerup", endDrag);
      touchScroll.addEventListener("pointercancel", endDrag);
      touchScroll.addEventListener("wheel", (event) => {
        event.preventDefault();
        scrollTerminalBy(event.deltaY, event.deltaY < 0 ? "scrolled up" : "scrolled down");
      }, { passive: false });
    }

    async function sendSafeKey(key, label) {
      closeCopyPanel(false);
      closeHelpPanel(false);
      setBusy(true);
      setStatus(label + " -> " + currentSession);
      try {
        await api("/api/tmux/key", {
          method: "POST",
          body: JSON.stringify({ session: currentSession, key }),
        });
        setStatus(label + " sent to " + currentSession);
        focusComposer();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    buttons.reload.addEventListener("click", () => {
      reloadTerminal();
      refresh().catch((error) => setStatus(error.message));
    });
    buttons.background.addEventListener("click", background);
    buttons.focusComposer.addEventListener("click", focusComposer);
    buttons.interrupt.addEventListener("click", () => sendSafeKey("stop", "Stop"));
    buttons.escape.addEventListener("click", () => sendSafeKey("escape", "Esc"));
    buttons.clearLine.addEventListener("click", () => sendSafeKey("clearLine", "Clear Line"));
    buttons.openCopy.addEventListener("click", openCopyPanel);
    buttons.openHelp.addEventListener("click", openHelpPanel);
    buttons.tabKey.addEventListener("click", () => sendSafeKey("tab", "Tab"));
    buttons.copyAll.addEventListener("click", copyPanelText);
    buttons.closeCopy.addEventListener("click", () => closeCopyPanel(true));
    buttons.closeHelp.addEventListener("click", () => closeHelpPanel(true));
    buttons.sendEnter.addEventListener("click", () => sendComposer(true));
    buttons.toggleComposer.addEventListener("click", () => {
      const willHide = !composerBox.classList.contains("composer-collapsed");
      setComposerHidden(willHide);
      if (!willHide) focusComposer();
    });
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendComposer(true);
      }
    });
    copyView.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCopyPanel(true);
      }
    });
    manualView.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHelpPanel(true);
      }
    });

    presetsEl.addEventListener("click", (event) => {
      const button = event.target.closest("button.preset");
      if (!button || button.disabled) return;
      if (button.dataset.font !== undefined) {
        applyPreset({ fontSize: Number(button.dataset.font) }, "글자 " + button.textContent);
      } else if (button.dataset.theme !== undefined) {
        applyPreset({ theme: button.dataset.theme }, "테마 " + button.textContent);
      }
    });

    // --- Foreground gate: no data when the tab is not in the foreground -------
    // A backgrounded/forgotten tab keeps a ttyd WebSocket open and keeps polling,
    // which drains mobile/tethering data even while nobody is looking. When the
    // tab goes hidden we drop the terminal WebSocket (blank the iframe) and stop
    // polling, then reconnect automatically when it returns to the foreground.
    let pollTimer = null;
    function startPolling() {
      if (pollTimer) return;
      refresh().catch((error) => setStatus(error.message));
      pollTimer = setInterval(() => refresh().catch(() => {}), 6000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    let bgSuspended = false;
    let hideTimer = null;
    function suspendForBackground() {
      if (bgSuspended) return;
      bgSuspended = true;
      stopPolling();
      terminal.src = "about:blank"; // closes the ttyd WebSocket -> zero data
      setStatus(hostAlias + " · ⏸ 백그라운드(데이터 절약) — 복귀 시 재연결");
    }
    function resumeFromBackground() {
      if (!bgSuspended) return;
      bgSuspended = false;
      terminal.src = "/term/?r=" + Date.now(); // reopen ttyd WebSocket
      startPolling();
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // brief tab switches shouldn't churn reconnects; wait a few seconds
        if (!hideTimer) {
          hideTimer = setTimeout(() => { hideTimer = null; suspendForBackground(); }, 3000);
        }
      } else {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        resumeFromBackground();
      }
    });
    // bfcache restore on mobile: make sure we are connected again
    window.addEventListener("pageshow", () => { if (!document.hidden) resumeFromBackground(); });

    renderPresetActive();
    renderHosts();
    initTouchScroll();
    startPolling();
    if (document.hidden) suspendForBackground();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Login / logout endpoints are reachable without an existing session.
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        if (hasValidSession(req)) {
          redirectTo(res, "/");
        } else {
          sendLoginHtml(res, url.searchParams.get("error"));
        }
        return;
      }
      if (req.method === "POST") {
        const form = await readForm(req);
        if (!AUTH_ENABLED || loginOk(form.username, form.password)) {
          setSessionCookie(res);
          redirectTo(res, "/");
        } else {
          redirectTo(res, "/login?error=1");
        }
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/logout") {
      clearSessionCookie(res);
      redirectTo(res, "/login");
      return;
    }

    if (!isRequestAllowed(req)) {
      // API / terminal proxy → 401 (keeps curl -u and browser cookie flows working);
      // top-level navigation → redirect to the login form.
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith(CONFIG.ttydBasePath)) {
        sendAuthChallenge(res);
      } else {
        redirectTo(res, "/login");
      }
      return;
    }

    if (url.pathname.startsWith(CONFIG.ttydBasePath)) {
      proxyHttp(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      sendHtml(res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "internal error" });
  }
});

server.on("upgrade", proxyUpgrade);

chooseInitialSession()
  .then((session) => {
    currentSession = session;
    return restartTtyd(currentSession);
  })
  .catch((error) => {
    console.error(`failed to start ttyd: ${error.message}`);
  })
  .finally(() => {
    server.listen(CONFIG.webPort, "127.0.0.1", () => {
      console.log(`abot-web listening on http://127.0.0.1:${CONFIG.webPort}/`);
      console.log(`terminal proxy at ${CONFIG.ttydBasePath}/ -> 127.0.0.1:${CONFIG.ttydPort}`);
    });
  });
