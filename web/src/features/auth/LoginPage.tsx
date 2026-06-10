import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, LogIn, Settings } from "lucide-react";
import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { getSavedApiBase, makeApiBaseFromHostPort, setSavedApiBase } from "../../config/backend-endpoint";
import { resetUserBoundary } from "../../app/session-boundary";
import { BrandMark } from "../../components/AvatarMark";
import { useAuthStore } from "../../store/auth-store";

function parseSavedHost(savedApiBase: string) {
  try {
    const url = new URL(savedApiBase, window.location.origin);
    return { host: url.hostname, port: url.port };
  } catch {
    return { host: "", port: "" };
  }
}

export function LoginPage() {
  const setSession = useAuthStore((state) => state.setSession);
  const previousUserId = useAuthStore((state) => state.user?.id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const initialApiBase = getSavedApiBase();
  const parsedDefault = parseSavedHost(initialApiBase);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverHost, setServerHost] = useState(parsedDefault.host);
  const [serverPort, setServerPort] = useState(parsedDefault.port || "");
  const [backendSaveState, setBackendSaveState] = useState<"idle" | "saved">("idle");
  const searchParams = new URLSearchParams(location.search);
  const mobileMode = location.pathname.startsWith("/mobile") || searchParams.get("agenthubMobile") === "1";
  const from = typeof location.state === "object" && location.state && "from" in location.state
    ? String(location.state.from)
    : searchParams.get("from") || (mobileMode ? "/mobile/messages" : "/messages");

  const login = useMutation({
    mutationFn: () => api.login(username, password, mobileMode ? "app" : "web"),
    onSuccess: ({ user }) => {
      resetUserBoundary(queryClient, previousUserId);
      setSession({ user });
      navigate(from, { replace: true });
    }
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate();
  };

  const saveBackendAddress = () => {
    const next = makeApiBaseFromHostPort(serverHost, serverPort);
    setSavedApiBase(next);
    setBackendSaveState("saved");
    window.setTimeout(() => setBackendSaveState("idle"), 1_200);
    setSettingsOpen(false);
  };

  return (
    <main className={`login-page ${mobileMode ? "mobile-login-page" : ""}`}>
      <section className="login-panel">
        <div className="login-brand">
          <BrandMark />
          <div>
            <h1>AgentHub</h1>
            <p>多 Agent 协作工作台</p>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>账号</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="输入用户 ID / 昵称 / 邮箱"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入密码"
              type="password"
            />
          </label>
          <button type="submit" disabled={login.isPending || !username.trim() || !password}>
            {login.isPending ? <Bot size={17} /> : <LogIn size={17} />}
            登录
          </button>
          {login.isError ? <p className="form-error">{login.error instanceof Error ? login.error.message : "登录失败"}</p> : null}
        </form>
        <button
          className="login-quick-setting"
          type="button"
          onClick={() => setSettingsOpen((current) => !current)}
          title="设置后端 IP 与端口"
        >
          <Settings size={15} />
          网络设置
        </button>
      </section>
      {settingsOpen ? (
        <section className="login-backend-modal">
          <h3>后端连接设置</h3>
          <p>配置后端服务的 IP 与端口（不填写将使用默认编译地址）。</p>
          <label>
            <span>IP / Host</span>
            <input value={serverHost} onChange={(event) => setServerHost(event.target.value)} placeholder="192.168.1.2" />
          </label>
          <label>
            <span>端口</span>
            <input value={serverPort} onChange={(event) => setServerPort(event.target.value)} placeholder="3100" />
          </label>
          <div className="login-backend-actions">
            <button type="button" className="secondary-button" onClick={() => setSettingsOpen(false)}>取消</button>
            <button type="button" onClick={saveBackendAddress}>
              保存并关闭
            </button>
          </div>
          {backendSaveState === "saved" ? <p className="settings-message">已保存后端地址</p> : null}
        </section>
      ) : null}
    </main>
  );
}
