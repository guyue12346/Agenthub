import type { QueryClient } from "@tanstack/react-query";
import { clearRealtimeSeqStore } from "../realtime/seq-store";
import { useRealtimeStore } from "../store/realtime-store";
import { useUiStore } from "../store/ui-store";

export function resetUserBoundary(queryClient: QueryClient, userId?: string) {
  queryClient.clear();
  clearRealtimeSeqStore(userId);
  useRealtimeStore.getState().reset();
  useUiStore.getState().reset();
}
