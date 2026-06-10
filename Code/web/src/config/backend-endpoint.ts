const API_BASE_STORAGE_KEY = "agenthub_backend_api_base";
const API_BASE_QUERY_PARAM = "agenthubApiBase";
const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").trim();
const DEFAULT_REALTIME_BASE = (import.meta.env.VITE_REALTIME_BASE ?? "").trim();

interface ParsedHostInput {
  host: string;
  port?: string;
}

function ensureProtocol(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;
  return `http://${value}`;
}

function normalizeToApiBase(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("/")) {
    if (value === "/") return "/api";
    const path = value.replace(/\/+$/, "");
    if (/\/api$/.test(path)) return path;
    return `${path}/api`;
  }

  const withProtocol = ensureProtocol(value);
  const parsed = new URL(withProtocol);

  const pathname = parsed.pathname.trim();
  if (!pathname || pathname === "/") {
    parsed.pathname = "/api";
  } else if (!/\/api\/?$/.test(pathname)) {
    parsed.pathname = `${pathname.replace(/\/+$/, "")}/api`;
  }

  if (parsed.pathname.length > 4 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString().replace(/\/$/, "");
}

export function getSavedApiBase(): string {
  if (typeof window === "undefined") return DEFAULT_API_BASE;
  const queryApiBase = getApiBaseFromQuery();
  if (queryApiBase) return queryApiBase;
  const raw = window.localStorage.getItem(API_BASE_STORAGE_KEY);
  if (!raw) return DEFAULT_API_BASE;
  const normalized = normalizeToApiBase(raw);
  return normalized || DEFAULT_API_BASE;
}

function getApiBaseFromQuery(): string {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get(API_BASE_QUERY_PARAM);
    if (!raw) return "";
    const normalized = normalizeToApiBase(raw);
    if (normalized) window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
    return normalized;
  } catch {
    return "";
  }
}

export function setSavedApiBase(raw: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeToApiBase(raw);
  if (!normalized) {
    window.localStorage.removeItem(API_BASE_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
}

export function clearSavedApiBase(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(API_BASE_STORAGE_KEY);
}

export function parseBackendAddressInput(host: string, port: string): ParsedHostInput {
  const safeHost = host.trim();
  const safePort = port.trim();
  if (!safePort) return { host: safeHost };
  return { host: safeHost, port: safePort };
}

export function makeApiBaseFromHostPort(hostInput: string, portInput: string): string {
  const { host, port } = parseBackendAddressInput(hostInput, portInput);
  if (!host) return DEFAULT_API_BASE;

  const baseHost = ensureProtocol(host);
  const url = new URL(baseHost);
  if (port) url.port = port;
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api";
  } else if (!/\/api\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api`;
  }

  return url.toString().replace(/\/$/, "");
}

export function resolveWebAppApiBase(): string {
  const saved = getSavedApiBase();
  return saved;
}

export function resolveRealtimeBase(): string {
  const saved = getSavedApiBase();
  const raw = DEFAULT_REALTIME_BASE || saved;
  if (!raw) return "";

  const base = new URL(raw, window.location.origin);
  const pathname = base.pathname.replace(/\/$/, "");
  if (pathname.endsWith("/api")) {
    base.pathname = pathname.slice(0, -4) || "/";
  } else if (!pathname) {
    base.pathname = "/";
  } else if (pathname.endsWith("/")) {
    base.pathname = pathname;
  }

  base.pathname = `${base.pathname.replace(/\/$/, "")}/realtime`;
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.search = "";
  return base.toString();
}
