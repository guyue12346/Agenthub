import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";
const APP_NAME = "AgentHub";
const DEFAULT_WEB_URL =
  process.env.AGENTHUB_WEB_URL || process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";
const DEFAULT_API_BASE = process.env.AGENTHUB_API_BASE || "";
const CONNECTION_CONFIG_FILE = "desktop-connection.json";
const windowConnectionState = new WeakMap();

function createApplicationMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Services", role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          }
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { type: "separator" },
        { role: "selectAll", label: "全选" }
      ]
    },
    ...(isMac
      ? [
          {
            role: "window",
            submenu: [{ role: "minimize" }, { role: "close" }, { role: "zoom" }]
          }
        ]
      : [
          {
            label: "窗口",
            submenu: [{ role: "minimize" }, { role: "close" }, { role: "togglefullscreen" }]
          }
        ]),
    {
      role: "help",
      submenu: [
        {
          label: "连接设置",
          click: () => {
            const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (window) void showConnectionSettings(window);
          }
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "reload" }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

function configPath() {
  return path.join(app.getPath("userData"), CONNECTION_CONFIG_FILE);
}

function ensureProtocol(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function sanitizePort(value, fallback) {
  const port = String(value ?? "").trim();
  if (!port) return fallback;
  return /^\d{1,5}$/.test(port) ? port : fallback;
}

function normalizeApiBase(raw) {
  const url = new URL(ensureProtocol(raw));
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api";
  } else if (!/\/api\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api`;
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeConnectionConfig(input) {
  const fallbackWebUrl = new URL(DEFAULT_WEB_URL);
  const hostInput = String(input?.host ?? input?.webUrl ?? fallbackWebUrl.hostname).trim();
  const hostUrl = new URL(ensureProtocol(hostInput || fallbackWebUrl.hostname));
  const protocol = hostUrl.protocol === "https:" ? "https:" : "http:";
  const host = hostUrl.hostname || fallbackWebUrl.hostname;
  const webPort = sanitizePort(input?.webPort ?? hostUrl.port, fallbackWebUrl.port || "5173");
  const apiPort = sanitizePort(input?.apiPort, "");
  const webUrl = new URL(`${protocol}//${host}`);
  webUrl.port = webPort;
  webUrl.pathname = "/";
  const apiBase = input?.apiBase
    ? normalizeApiBase(input.apiBase)
    : apiPort
      ? normalizeApiBase(`${protocol}//${host}:${apiPort}/api`)
      : "";

  return {
    host,
    webPort,
    apiPort,
    webUrl: webUrl.toString(),
    apiBase
  };
}

async function readConnectionConfig() {
  if (process.env.AGENTHUB_WEB_URL || process.env.ELECTRON_START_URL) {
    return normalizeConnectionConfig({
      webUrl: DEFAULT_WEB_URL,
      apiBase: DEFAULT_API_BASE
    });
  }

  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return normalizeConnectionConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeConnectionConfig(config) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function buildDesktopWebUrl(config) {
  const url = new URL(config.webUrl);
  url.searchParams.set("agenthubDesktop", "1");
  if (config.apiBase) {
    url.searchParams.set("agenthubApiBase", config.apiBase);
  }
  return url.toString();
}

async function loadWebApp(window) {
  const config = await readConnectionConfig();
  if (!config) {
    await showConnectionSettings(window);
    return;
  }
  await loadRemoteWebApp(window, config);
}

async function loadRemoteWebApp(window, config) {
  const url = buildDesktopWebUrl(config);
  windowConnectionState.set(window, { config, showingSettings: false });
  const reachable = await checkWebReachable(config.webUrl);
  if (!reachable.ok) {
    await showConnectionSettings(window, config, `当前地址无法访问：${reachable.message}。请重新输入 IP 与端口。`);
    return;
  }
  try {
    await window.loadURL(url);
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[agenthub-desktop] load remote web failed (${url}): ${String(error)}`);
    }
    await showConnectionSettings(window, config, "无法连接到 Web 服务，请检查 IP 与端口。");
  }
}

async function checkWebReachable(webUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(webUrl, {
      method: "GET",
      signal: controller.signal
    });
    return {
      ok: response.status >= 200 && response.status < 500,
      message: `HTTP ${response.status}`
    };
  } catch (error) {
    const message = error instanceof Error
      ? error.name === "AbortError"
        ? "连接超时"
        : error.message
      : String(error);
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function showConnectionSettings(window, currentConfig, errorMessage = "") {
  const config = currentConfig ?? (await readConnectionConfig()) ?? normalizeConnectionConfig({});
  windowConnectionState.set(window, { config, showingSettings: true });
  const html = renderConnectionSettingsHtml(config, errorMessage);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function renderConnectionSettingsHtml(config, errorMessage) {
  const safeConfig = JSON.stringify(config).replace(/</g, "\\u003c");
  const safeError = JSON.stringify(errorMessage || "").replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentHub 连接设置</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f7f9fc;
      color: #111827;
    }
    main {
      width: min(430px, calc(100vw - 40px));
      padding: 28px;
      border: 1px solid #e6ebf2;
      border-radius: 18px;
      background: #fff;
      box-shadow: 0 18px 60px rgba(15, 23, 42, 0.08);
    }
    h1 { margin: 0 0 6px; font-size: 22px; }
    p { margin: 0 0 22px; color: #667085; line-height: 1.6; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 8px; font-size: 13px; font-weight: 700; }
    input {
      height: 42px;
      border: 1px solid #d8e0eb;
      border-radius: 12px;
      padding: 0 12px;
      outline: none;
      font: inherit;
    }
    input:focus { border-color: #93c5fd; box-shadow: 0 0 0 4px #dbeafe; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .error { margin: 0 0 14px; color: #dc2626; font-weight: 700; }
    button {
      height: 42px;
      border: 0;
      border-radius: 12px;
      background: #3b82f6;
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    small { display: block; margin-top: 14px; color: #98a2b3; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>AgentHub 连接设置</h1>
    <p>填写或重新输入服务所在机器的地址。桌面端会加载该机器上的 Web 服务；API 端口留空时使用 Web 服务自己的 /api 代理。</p>
    <p id="error" class="error" hidden></p>
    <form id="form">
      <label>
        <span>IP / Host</span>
        <input id="host" placeholder="192.168.1.2" autocomplete="off" />
      </label>
      <div class="grid">
        <label>
          <span>Web 端口</span>
          <input id="webPort" placeholder="5173" autocomplete="off" />
        </label>
        <label>
          <span>API 端口</span>
          <input id="apiPort" placeholder="留空使用 /api" autocomplete="off" />
        </label>
      </div>
      <button type="submit">保存并连接</button>
    </form>
    <small>本地开发通常只需要填 Host 和 Web 端口 5173。只有在前端没有 /api 代理时才填写 API 端口。</small>
  </main>
  <script>
    const config = ${safeConfig};
    const errorMessage = ${safeError};
    const form = document.getElementById("form");
    const error = document.getElementById("error");
    document.getElementById("host").value = config.host || "127.0.0.1";
    document.getElementById("webPort").value = config.webPort || "5173";
    document.getElementById("apiPort").value = config.apiPort || "";
    if (errorMessage) {
      error.textContent = errorMessage;
      error.hidden = false;
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = {
        host: document.getElementById("host").value,
        webPort: document.getElementById("webPort").value,
        apiPort: document.getElementById("apiPort").value
      };
      window.location.href = "agenthub://desktop-config/save?payload=" + encodeURIComponent(JSON.stringify(payload));
    });
  </script>
</body>
</html>`;
}

async function handleAgentHubUrl(window, targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "agenthub:") return false;
  if (parsed.hostname !== "desktop-config") return true;

  if (parsed.pathname === "/save") {
    const payload = parsed.searchParams.get("payload");
    if (!payload) {
      await showConnectionSettings(window, undefined, "连接配置为空。");
      return true;
    }
    try {
      const config = normalizeConnectionConfig(JSON.parse(payload));
      await writeConnectionConfig(config);
      await loadRemoteWebApp(window, config);
    } catch (error) {
      await showConnectionSettings(window, undefined, `连接配置无效：${String(error)}`);
    }
    return true;
  }

  await showConnectionSettings(window);
  return true;
}

function createWindow() {
  const iconPath = path.join(__dirname, "..", "assets", "icon.icns");
  const hasIcon = existsSync(iconPath);

  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    title: "AgentHub",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    titleBarOverlay: isMac ? false : true,
    vibrancy: isMac ? "under-window" : undefined,
    ...(!isMac && hasIcon ? { icon: iconPath } : {}),
    backgroundColor: "#f8fafc",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void handleAgentHubUrl(window, url);
    if (url.startsWith("agenthub:")) return { action: "deny" };
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("agenthub:")) return;
    event.preventDefault();
    void handleAgentHubUrl(window, url);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const state = windowConnectionState.get(window);
    if (state?.showingSettings || !validatedURL?.startsWith("http")) return;
    void showConnectionSettings(window, state?.config, `当前地址无法访问：${errorDescription || "网络连接失败"}。请重新输入 IP 与端口。`);
  });

  window.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const state = windowConnectionState.get(window);
    if (state?.showingSettings || !validatedURL?.startsWith("http")) return;
    void showConnectionSettings(window, state?.config, `当前地址无法访问：${errorDescription || "网络连接失败"}。请重新输入 IP 与端口。`);
  });

  if (process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }

  if (isMac) {
    if (typeof window.setWindowButtonVisibility === "function") {
      window.setWindowButtonVisibility(true);
    }
    if (typeof window.setTrafficLightPosition === "function") {
      window.setTrafficLightPosition({ x: 14, y: 10 });
    }
  }

  void loadWebApp(window);
  return window;
}

app.on("ready", () => {
  app.setName(APP_NAME);
  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: "AgentHub"
    });
  }
  Menu.setApplicationMenu(createApplicationMenu());
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
