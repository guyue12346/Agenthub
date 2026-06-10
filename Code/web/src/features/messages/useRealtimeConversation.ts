import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary } from "@agenthub/shared";
import { api } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { useAuthStore } from "../../store/auth-store";
import { useRealtimeStore } from "../../store/realtime-store";

function setConversationReadInCache(queryClient: ReturnType<typeof useQueryClient>, userId: string, conversationId: string) {
  queryClient.setQueriesData<{ conversations: ConversationSummary[] }>({ queryKey: queryKeys.conversationRoot(userId) }, (current) => {
    if (!current) return current;
    return {
      conversations: current.conversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation
      )
    };
  });
}

export function useRealtimeConversation(conversationId: string, unreadCount = 0, readSignal = "") {
  const queryClient = useQueryClient();
  const setActiveConversationId = useRealtimeStore((state) => state.setActiveConversationId);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const pendingReadRef = useRef<string | null>(null);
  const lastReadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversationId || !currentUserId) {
      setActiveConversationId(null);
      return;
    }
    setActiveConversationId(conversationId);
    return () => {
      setActiveConversationId(null);
    };
  }, [conversationId, currentUserId, queryClient, setActiveConversationId]);

  useEffect(() => {
    if (!conversationId || !currentUserId) return;
    const readKey = `${currentUserId}:${conversationId}:${unreadCount}:${readSignal}`;
    if (pendingReadRef.current === readKey || lastReadRef.current === readKey) return;
    if (unreadCount <= 0 && lastReadRef.current?.startsWith(`${currentUserId}:${conversationId}:`)) return;
    pendingReadRef.current = readKey;
    setConversationReadInCache(queryClient, currentUserId, conversationId);
    void api.markMessagesRead(conversationId)
      .then(() => {
        lastReadRef.current = readKey;
        setConversationReadInCache(queryClient, currentUserId, conversationId);
      })
      .finally(() => {
        if (pendingReadRef.current === readKey) pendingReadRef.current = null;
      });
  }, [conversationId, currentUserId, queryClient, readSignal, unreadCount]);
}
