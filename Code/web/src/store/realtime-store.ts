import { create } from "zustand";

interface RealtimeState {
  activeConversationId: string | null;
  activeWorkspaceId: string | null;
  setActiveConversationId: (conversationId: string | null) => void;
  setActiveWorkspaceId: (workspaceId: string | null) => void;
  reset: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  activeConversationId: null,
  activeWorkspaceId: null,
  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),
  setActiveWorkspaceId: (activeWorkspaceId) => set({ activeWorkspaceId }),
  reset: () => set({ activeConversationId: null, activeWorkspaceId: null })
}));
