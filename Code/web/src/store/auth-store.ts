import { create } from "zustand";
import type { AgentHubUser } from "@agenthub/shared";

interface AuthState {
  user: AgentHubUser | null;
  setSession: (session: { user: AgentHubUser }) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setSession: ({ user }) => {
    set({ user });
  },
  logout: () => {
    set({ user: null });
  }
}));
