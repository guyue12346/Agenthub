import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogIn, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { resetUserBoundary } from "../../app/session-boundary";
import { BrandMark } from "../../components/AvatarMark";
import { useAdminAuthStore } from "../../store/admin-auth-store";

export function AdminLoginPage() {
  const setSession = useAdminAuthStore((state) => state.setSession);
  const previousUserId = useAdminAuthStore((state) => state.user?.id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api.adminLogin(username, password),
    onSuccess: ({ user }) => {
      resetUserBoundary(queryClient, previousUserId);
      setSession({ user });
      navigate("/admin/monitor", { replace: true });
    }
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate();
  };

  return (
    <main className="login-page admin-login-page">
      <section className="login-panel">
        <div className="login-brand">
          <BrandMark />
          <div>
            <h1>后台管理登录</h1>
            <p>管理员独立登录态，不复用工作台账号 session。</p>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>管理员账号</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="输入管理员 ID / 昵称 / 邮箱"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入管理员密码"
              type="password"
            />
          </label>
          <button type="submit" disabled={login.isPending || !username.trim() || !password}>
            {login.isPending ? <ShieldCheck size={17} /> : <LogIn size={17} />}
            登录后台
          </button>
          {login.isError ? <p className="form-error">{login.error instanceof Error ? login.error.message : "登录失败"}</p> : null}
        </form>
      </section>
    </main>
  );
}
