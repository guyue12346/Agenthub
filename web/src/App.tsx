import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { api } from "./api/client";
import { queryKeys } from "./api/query-keys";
import { AppShell } from "./components/AppShell";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import { useAdminAuthStore } from "./store/admin-auth-store";
import { useAuthStore } from "./store/auth-store";

const AdminLoginPage = lazy(() => import("./features/auth/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const LoginPage = lazy(() => import("./features/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const MessagesPage = lazy(() => import("./features/messages/MessagesPage").then((module) => ({ default: module.MessagesPage })));
const ContactsPage = lazy(() => import("./features/contacts/ContactsPage").then((module) => ({ default: module.ContactsPage })));
const HubPage = lazy(() => import("./features/hubs/HubPage").then((module) => ({ default: module.HubPage })));
const KnowledgePage = lazy(() => import("./features/knowledge/KnowledgePage").then((module) => ({ default: module.KnowledgePage })));
const WorkspacesPage = lazy(() => import("./features/workspaces/WorkspacesPage").then((module) => ({ default: module.WorkspacesPage })));
const MonitorPage = lazy(() => import("./features/monitor/MonitorPage").then((module) => ({ default: module.MonitorPage })));
const MobileApp = lazy(() => import("./mobile/MobileApp").then((module) => ({ default: module.MobileApp })));
const MobileSimulator = lazy(() => import("./mobile/MobileSimulator").then((module) => ({ default: module.MobileSimulator })));

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin/monitor" element={<ProtectedAdminMonitor />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mobile/login" element={<LoginPage />} />
        <Route path="/mobile-simulator" element={<MobileSimulator />} />
        <Route path="/mobile/*" element={<ProtectedMobileWorkspace />} />
        <Route path="/*" element={<ProtectedWorkspace />} />
      </Routes>
    </Suspense>
  );
}

function ProtectedAdminMonitor() {
  const setSession = useAdminAuthStore((state) => state.setSession);
  const logout = useAdminAuthStore((state) => state.logout);
  const session = useQuery({
    queryKey: queryKeys.adminAuthMe,
    queryFn: api.adminMe,
    retry: false
  });

  useEffect(() => {
    if (session.data?.user) setSession({ user: session.data.user });
  }, [session.data?.user, setSession]);

  useEffect(() => {
    if (session.isError || (session.data?.user && session.data.user.role !== "admin")) logout();
  }, [logout, session.data?.user, session.isError]);

  if (session.isError) return <Navigate to="/admin/login" replace />;
  if (session.isLoading || !session.data?.user) return <div className="auth-loading">正在验证后台管理员登录状态...</div>;
  if (session.data.user.role !== "admin") return <Navigate to="/admin/login" replace />;
  return <MonitorPage />;
}

function ProtectedMobileWorkspace() {
  const currentUser = useAuthStore((state) => state.user);
  const setSession = useAuthStore((state) => state.setSession);
  const logout = useAuthStore((state) => state.logout);
  const location = useLocation();
  const session = useQuery({
    queryKey: queryKeys.authMe,
    queryFn: api.me,
    retry: false
  });

  useEffect(() => {
    if (session.data?.user) setSession({ user: session.data.user });
  }, [session.data?.user, setSession]);

  useEffect(() => {
    if (session.isError) logout();
  }, [logout, session.isError]);

  if (session.isError) return <Navigate to="/mobile/login" replace state={{ from: location.pathname }} />;
  if (session.isLoading || !session.data?.user || currentUser?.id !== session.data.user.id) return <div className="auth-loading">正在验证登录状态...</div>;
  return (
    <RealtimeProvider>
      <MobileApp />
    </RealtimeProvider>
  );
}

function ProtectedWorkspace() {
  const setSession = useAuthStore((state) => state.setSession);
  const logout = useAuthStore((state) => state.logout);
  const location = useLocation();
  const session = useQuery({
    queryKey: queryKeys.authMe,
    queryFn: api.me,
    retry: false
  });

  useEffect(() => {
    if (session.data?.user) setSession({ user: session.data.user });
  }, [session.data?.user, setSession]);

  useEffect(() => {
    if (session.isError) logout();
  }, [logout, session.isError]);

  if (session.isError) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.isLoading || !session.data?.user) return <div className="auth-loading">正在验证登录状态...</div>;
  return (
    <RealtimeProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/messages" replace />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/messages/:conversationId" element={<MessagesPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/teams/:teamId" element={<ContactsPage />} />
          <Route path="/contacts/agents/:agentId" element={<ContactsPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/:workspaceId" element={<WorkspacesPage />} />
          <Route path="/agenthub" element={<HubPage kind="agent" />} />
          <Route path="/toolhub" element={<HubPage kind="tool" />} />
          <Route path="/skillhub" element={<HubPage kind="skill" />} />
          <Route path="/knowledgehub" element={<KnowledgePage />} />
          <Route path="/settings" element={<HubPage kind="settings" />} />
        </Routes>
      </AppShell>
    </RealtimeProvider>
  );
}

function RouteFallback() {
  return <div className="auth-loading">正在加载页面...</div>;
}
