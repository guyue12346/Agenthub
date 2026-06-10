import { NavLink, useLocation } from "react-router-dom";
import {
  BookUser,
  Bot,
  Database,
  FolderOpen,
  MessageCircle,
  MonitorCog,
  Settings,
  Sparkles,
  Wrench
} from "lucide-react";
import { lazy, Suspense, useEffect, type PropsWithChildren } from "react";
import { BrandMark } from "./AvatarMark";
import { useUiStore } from "../store/ui-store";
import { useAuthStore } from "../store/auth-store";

const DetailPanel = lazy(() => import("./DetailPanel").then((module) => ({ default: module.DetailPanel })));

const navItems = [
  { to: "/messages", label: "消息", icon: MessageCircle },
  { to: "/contacts", label: "通讯录", icon: BookUser },
  { to: "/workspaces", label: "工作空间", icon: FolderOpen },
  { to: "/agenthub", label: "AgentHub", icon: Bot },
  { to: "/toolhub", label: "ToolHub", icon: Wrench },
  { to: "/skillhub", label: "SkillHub", icon: Sparkles },
  { to: "/knowledgehub", label: "KnowledgeHub", icon: Database },
  { to: "/admin/monitor", label: "监控", icon: MonitorCog }
];

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const toast = useUiStore((state) => state.toast);
  const detailKind = useUiStore((state) => state.detail.kind);
  const clearToast = useUiStore((state) => state.clearToast);
  const user = useAuthStore((state) => state.user);
  const isHub = ["/workspaces", "/agenthub", "/toolhub", "/skillhub", "/knowledgehub", "/admin/monitor"].some((path) =>
    location.pathname.startsWith(path)
  );
  const visibleNavItems = user?.role === "admin" ? navItems : navItems.filter((item) => item.to !== "/admin/monitor");
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(clearToast, 2400);
    return () => window.clearTimeout(timer);
  }, [clearToast, toast]);

  return (
    <div className="app-shell">
      <aside className="global-rail" aria-label="全局导航">
        <BrandMark />
        <nav className="rail-nav">
          {visibleNavItems.map((item) => (
            <NavLink key={item.to} to={item.to} className="rail-item" title={item.label}>
              <item.icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <NavLink to="/settings" className="rail-item rail-settings" title="设置">
          <Settings size={20} />
          <span>设置</span>
        </NavLink>
      </aside>
      <main className={isHub ? "app-main app-main-wide" : "app-main"}>{children}</main>
      {detailKind !== "none" ? (
        <Suspense fallback={null}>
          <DetailPanel />
        </Suspense>
      ) : null}
      {toast ? (
        <button className={`app-toast ${toast.tone ?? "info"}`} type="button" onClick={clearToast}>
          {toast.message}
        </button>
      ) : null}
    </div>
  );
}
