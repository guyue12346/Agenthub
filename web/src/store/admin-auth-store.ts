import { create } from "zustand";
import type { AgentHubUser } from "@agenthub/shared";

interface AdminAuthState {
  user: AgentHubUser | null;
  setSession: (session: { user: AgentHubUser }) => void;
  logout: () => void;
}

export const useAdminAuthStore = create<AdminAuthState>((set) => ({
  user: null,
  setSession: ({ user }) => {
    set({ user });
  },
  logout: () => {
    set({ user: null });
  }
}));
