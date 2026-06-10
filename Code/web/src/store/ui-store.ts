import { create } from "zustand";
import type { OrchestratorRun, WorkspaceAsset } from "@agenthub/shared";

type DetailPanel =
  | { kind: "none" }
  | { kind: "agent"; agentId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "person"; person: { id: string; type: "user" | "system"; name: string; avatar: string; subtitle?: string } }
  | { kind: "run"; run: OrchestratorRun }
  | { kind: "asset"; asset: WorkspaceAsset }
  | { kind: "preview"; title: string; url: string };

interface UiState {
  detail: DetailPanel;
  toast: { id: number; message: string; tone?: "info" | "success" | "warning" } | null;
  setDetail: (detail: DetailPanel) => void;
  closeDetail: () => void;
  reset: () => void;
  showToast: (message: string, tone?: "info" | "success" | "warning") => void;
  clearToast: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  detail: { kind: "none" },
  toast: null,
  setDetail: (detail) => set({ detail }),
  closeDetail: () => set({ detail: { kind: "none" } }),
  reset: () => set({ detail: { kind: "none" }, toast: null }),
  showToast: (message, tone = "info") => set({ toast: { id: Date.now(), message, tone } }),
  clearToast: () => set({ toast: null })
}));
