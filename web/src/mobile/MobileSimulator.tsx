import { ExternalLink, RefreshCw, Smartphone, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export function MobileSimulator() {
  const [frameKey, setFrameKey] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [sessionError, setSessionError] = useState("");

  useEffect(() => {
    document.body.classList.add("mobile-simulator-body");
    return () => document.body.classList.remove("mobile-simulator-body");
  }, []);

  const mobileUrl = useMemo(() => {
    const url = new URL("/mobile/messages", window.location.origin);
    url.searchParams.set("agenthubMobile", "1");
    url.searchParams.set("agenthubApiBase", "/api");
    return url.toString();
  }, []);

  const prepareSession = useCallback(async () => {
    setSessionReady(false);
    setFrameLoaded(false);
    setSessionError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "lin", password: "lin", clientType: "app" })
      });
      if (!response.ok) throw new Error(await response.text());
      setSessionReady(true);
      setFrameKey((current) => current + 1);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void prepareSession();
  }, [prepareSession]);

  const loadingText = sessionError
    ? "移动端连接失败"
    : sessionReady && !frameLoaded
      ? "正在加载真实移动端 App..."
      : "正在准备移动端登录态...";

  return (
    <main className="mobile-simulator-page">
      <section className="mobile-simulator-controls">
        <div className="mobile-simulator-brand">
          <span>
            <Smartphone size={22} />
          </span>
          <div>
            <strong>手机 App 模拟器</strong>
            <small>浏览器内运行真实移动端 App</small>
          </div>
        </div>
        <div className="mobile-simulator-url">
          <Wifi size={15} />
          <span>{mobileUrl}</span>
        </div>
        <p className="mobile-simulator-note">
          已固定使用本机 Web 代理和 lin 移动端账号；这里加载的是完整移动端页面，可以正常进入会话、发送和接收消息。
        </p>
        {sessionError ? <p className="mobile-simulator-note mobile-simulator-error">{sessionError}</p> : null}
        <div className="mobile-simulator-actions">
          <button type="button" onClick={() => void prepareSession()}>
            <RefreshCw size={16} />
            刷新真实 App
          </button>
          <a href={mobileUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            新窗口打开
          </a>
        </div>
      </section>
      <section className="mobile-simulator-device" aria-label="手机预览">
        <div className="mobile-device-frame">
          <div className="mobile-device-speaker" />
          {sessionReady ? (
            <iframe
              key={frameKey}
              title="AgentHub mobile app"
              src={mobileUrl}
              onLoad={() => setFrameLoaded(true)}
            />
          ) : null}
          {!sessionReady || !frameLoaded || sessionError ? <div className="mobile-simulator-loading">{loadingText}</div> : null}
          <div className="mobile-device-homebar" />
        </div>
      </section>
    </main>
  );
}
