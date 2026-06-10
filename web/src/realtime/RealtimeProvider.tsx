import { useEffect, useRef, type ReactNode } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, ChatMessageAction, ConversationSummary, OrchestratorRun, RuntimeEvent, RuntimeScopeKind } from "@agenthub/shared";
import { api } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAuthStore } from "../store/auth-store";
import { useRealtimeStore } from "../store/realtime-store";
import { readSeqStore, scopeKey, writeSeqStore, type SeqStore } from "./seq-store";
import { resolveRealtimeBase } from "../config/backend-endpoint";

interface ScopeSubscription {
  scopeKind: RuntimeScopeKind;
  scopeId: string;
}

interface ServerEnvelope {
  type: "connected" | "event" | "error" | "pong";
  event?: RuntimeEvent;
  error?: string;
}

const INITIAL_RECONNECT_DELAY_MS = 800;
const MAX_RECONNECT_DELAY_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_PENDING_SCOPES = 50;
const MAX_PENDING_EVENTS_PER_SCOPE = 500;
const MAX_PROCESSED_EVENT_IDS = 2_000;

function setConversationReadInCache(queryClient: QueryClient, userId: string, conversationId: string) {
  queryClient.setQueriesData<{ conversations: ConversationSummary[] }>({ queryKey: queryKeys.conversationRoot(userId) }, (current) => {
    if (!current) return current;
    return {
      conversations: current.conversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation
      )
    };
  });
}

function appendMessage(queryClient: QueryClient, userId: string, conversationId: string, message: ChatMessage) {
  queryClient.setQueryData<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(
    queryKeys.messages(userId, conversationId),
    (current) => {
    if (!current) return { messages: [message] };
    if (current.messages.some((item) => item.id === message.id)) return current;
    const incomingText = firstMarkdownText(message);
    const withoutOptimisticCopy = current.messages.filter((item) => {
      if (!item.id.startsWith("local-")) return true;
      return item.sender.id !== message.sender.id || firstMarkdownText(item) !== incomingText;
    });
    return { ...current, messages: [...withoutOptimisticCopy, message] };
  });
}

function updateMessage(queryClient: QueryClient, userId: string, conversationId: string, message: ChatMessage) {
  queryClient.setQueryData<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(
    queryKeys.messages(userId, conversationId),
    (current) => {
      if (!current) return { messages: [message] };
      let found = false;
      const messages = current.messages.map((item) => {
        if (item.id !== message.id) return item;
        found = true;
        return message;
      });
      return { ...current, messages: found ? messages : [...messages, message] };
    }
  );
}

function upsertMessageAction(queryClient: QueryClient, userId: string, conversationId: string, action: ChatMessageAction) {
  queryClient.setQueryData<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(
    queryKeys.messages(userId, conversationId),
    (current) => {
    if (!current) return current;
    return {
      ...current,
      messages: current.messages.map((message) => {
        if (message.id !== action.messageId) return message;
        const actions = message.actions ?? [];
        if (actions.some((item) => item.id === action.id)) return message;
        return { ...message, actions: [...actions, action] };
      })
    };
    }
  );
}

function removeMessageAction(queryClient: QueryClient, userId: string, conversationId: string, messageId: string, actionId: string) {
  queryClient.setQueryData<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(
    queryKeys.messages(userId, conversationId),
    (current) => {
      if (!current) return current;
      return {
        ...current,
        messages: current.messages.map((message) => {
          if (message.id !== messageId) return message;
          return { ...message, actions: (message.actions ?? []).filter((action) => action.id !== actionId) };
        })
      };
    }
  );
}

function firstMarkdownText(message: ChatMessage) {
  const first = message.blocks[0];
  return first?.type === "markdown" ? first.payload.text : "";
}

function upsertRun(queryClient: QueryClient, userId: string, conversationId: string, run: OrchestratorRun) {
  queryClient.setQueryData<{ runs: OrchestratorRun[] }>(queryKeys.runs(userId, conversationId), (current) => {
    if (!current) return { runs: [run] };
    const withoutCurrent = current.runs.filter((item) => item.id !== run.id);
    return { runs: [run, ...withoutCurrent] };
  });
}

function realtimeEndpoint() {
  const configuredBase = resolveRealtimeBase();
  if (configuredBase) return configuredBase;

  const baseUrl = new URL(window.location.origin);
  baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/realtime`;
  baseUrl.search = "";
  return baseUrl.toString();
}

function parseServerEnvelope(data: unknown): ServerEnvelope | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Partial<ServerEnvelope>;
    if (!parsed || typeof parsed.type !== "string") return null;
    return parsed as ServerEnvelope;
  } catch {
    return null;
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((state) => state.user?.id);
  const activeConversationId = useRealtimeStore((state) => state.activeConversationId);
  const activeWorkspaceId = useRealtimeStore((state) => state.activeWorkspaceId);
  const socketRef = useRef<WebSocket | null>(null);
  const subscribedScopesRef = useRef<Set<string>>(new Set());
  const activeConversationRef = useRef<string | null>(activeConversationId);
  const activeWorkspaceRef = useRef<string | null>(activeWorkspaceId);
  const seqStoreRef = useRef<SeqStore>({});
  const pendingEventsRef = useRef<Map<string, Map<number, RuntimeEvent>>>(new Map());
  const gapFetchesRef = useRef<Set<string>>(new Set());
  const processedEventIdsRef = useRef<Set<string>>(new Set());
  const processedEventIdQueueRef = useRef<string[]>([]);

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!currentUserId) return;

    let disposed = false;
    let connectTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let heartbeatTimeoutTimer: number | undefined;
    let reconnectAttempt = 0;
    seqStoreRef.current = readSeqStore(currentUserId);
    pendingEventsRef.current = new Map();
    gapFetchesRef.current = new Set();
    processedEventIdsRef.current = new Set();
    processedEventIdQueueRef.current = [];

    const persistSeq = (key: string, seq: number) => {
      seqStoreRef.current = { ...seqStoreRef.current, [key]: seq };
      writeSeqStore(currentUserId, seqStoreRef.current);
    };

    const sendSubscribe = (scopes: ScopeSubscription[]) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || scopes.length === 0) return;
      socket.send(
        JSON.stringify({
          type: "subscribe",
          scopes: scopes.map((scope) => ({
            ...scope,
            lastSeq: seqStoreRef.current[scopeKey(scope.scopeKind, scope.scopeId)] ?? 0
          }))
        })
      );
    };

    const subscribeScope = (scope: ScopeSubscription) => {
      const key = scopeKey(scope.scopeKind, scope.scopeId);
      if (subscribedScopesRef.current.has(key)) return;
      subscribedScopesRef.current.add(key);
      sendSubscribe([scope]);
    };

    const applyRuntimeEvent = (event: RuntimeEvent) => {
      const activeId = activeConversationRef.current;

      if (event.type === "message.created" && event.scopeKind === "conversation") {
        const conversationId = event.scopeId;
        const message = event.payload.message as ChatMessage | undefined;
        if (message && conversationId === activeId) {
          appendMessage(queryClient, currentUserId, conversationId, message);
          void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
          setConversationReadInCache(queryClient, currentUserId, conversationId);
          return;
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
        return;
      }

      if (event.type === "message.updated" && event.scopeKind === "conversation") {
        const conversationId = event.scopeId;
        const message = event.payload.message as ChatMessage | undefined;
        if (message) updateMessage(queryClient, currentUserId, conversationId, message);
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
        return;
      }

      if (event.type === "message.action.created" && event.scopeKind === "conversation") {
        const conversationId = event.scopeId;
        const action = event.payload.action as ChatMessageAction | undefined;
        if (action) upsertMessageAction(queryClient, currentUserId, conversationId, action);
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationMemory(currentUserId, conversationId) });
        return;
      }

      if (event.type === "message.action.deleted" && event.scopeKind === "conversation") {
        const conversationId = event.scopeId;
        const messageId = String(event.payload.messageId ?? "");
        const actionId = String(event.payload.actionId ?? "");
        if (messageId && actionId) removeMessageAction(queryClient, currentUserId, conversationId, messageId, actionId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationMemory(currentUserId, conversationId) });
        return;
      }

      if (event.type === "conversation.updated" || event.type === "conversation.read") {
        const conversationId = String(event.payload.conversationId ?? "");
        if (!conversationId) return;
        if (conversationId === activeId) {
          setConversationReadInCache(queryClient, currentUserId, conversationId);
        } else {
          void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
        }
        return;
      }

      if (event.type === "messages.cleared") {
        const conversationId = String(event.payload.conversationId ?? event.scopeId);
        queryClient.setQueryData<{ messages: ChatMessage[]; pageInfo?: { hasMore: boolean; nextBeforeSeq?: number } }>(queryKeys.messages(currentUserId, conversationId), {
          messages: [],
          pageInfo: { hasMore: false }
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(currentUserId) });
        return;
      }

      if ((event.type === "workspace.file.changed" || event.type === "workspace.asset.created") && event.scopeKind === "workspace") {
        const workspaceId = event.scopeId;
        const payload = event.payload as Record<string, unknown>;
        const path = typeof payload.path === "string" ? payload.path : "";
        const previousPath = typeof payload.previousPath === "string" ? payload.previousPath : "";
        const assetId = typeof payload.assetId === "string" ? payload.assetId : "";
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(currentUserId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(currentUserId, workspaceId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.assets(currentUserId, workspaceId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGit(currentUserId, workspaceId) });
        if (path) void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile(currentUserId, workspaceId, path) });
        if (path.startsWith("Code/")) void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGitDiff(currentUserId, workspaceId, path.slice(5)) });
        if (previousPath && previousPath !== path) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile(currentUserId, workspaceId, previousPath) });
          if (previousPath.startsWith("Code/")) void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGitDiff(currentUserId, workspaceId, previousPath.slice(5)) });
        }
        if (assetId) void queryClient.invalidateQueries({ queryKey: queryKeys.assetVersions(currentUserId, workspaceId, assetId) });
        return;
      }

      if (event.type.startsWith("run.")) {
        const run = (event.payload as { run?: OrchestratorRun }).run;
        const conversationId = run?.conversationId ?? activeId;
        if (run && conversationId) upsertRun(queryClient, currentUserId, conversationId, run);
        if (conversationId) void queryClient.invalidateQueries({ queryKey: queryKeys.runs(currentUserId, conversationId) });
      }
    };

    const rememberProcessedEventId = (eventId: string) => {
      if (processedEventIdsRef.current.has(eventId)) return;
      processedEventIdsRef.current.add(eventId);
      processedEventIdQueueRef.current.push(eventId);
      while (processedEventIdQueueRef.current.length > MAX_PROCESSED_EVENT_IDS) {
        const oldest = processedEventIdQueueRef.current.shift();
        if (oldest) processedEventIdsRef.current.delete(oldest);
      }
    };

    const processReadyEvents = (key: string) => {
      const pending = pendingEventsRef.current.get(key);
      if (!pending) return;
      let lastSeq = seqStoreRef.current[key] ?? 0;
      while (pending.has(lastSeq + 1)) {
        const event = pending.get(lastSeq + 1)!;
        pending.delete(lastSeq + 1);
        if (!processedEventIdsRef.current.has(event.eventId)) {
          rememberProcessedEventId(event.eventId);
          applyRuntimeEvent(event);
        }
        lastSeq = event.seq;
        persistSeq(key, lastSeq);
      }
    };

    let enqueueEvent: (event: RuntimeEvent) => void = () => undefined;

    const fetchGap = (scopeKind: RuntimeScopeKind, scopeId: string, afterSeq: number) => {
      const key = scopeKey(scopeKind, scopeId);
      const fetchKey = `${key}:${afterSeq}`;
      if (gapFetchesRef.current.has(fetchKey)) return;
      gapFetchesRef.current.add(fetchKey);
      void api.runtimeEvents(scopeKind, scopeId, afterSeq)
        .then(({ events }) => {
          for (const event of events) enqueueEvent(event);
        })
        .finally(() => {
          gapFetchesRef.current.delete(fetchKey);
          processReadyEvents(key);
        });
    };

    const ensurePendingScope = (key: string) => {
      let pending = pendingEventsRef.current.get(key);
      if (pending) return pending;
      while (pendingEventsRef.current.size >= MAX_PENDING_SCOPES) {
        const oldestKey = pendingEventsRef.current.keys().next().value as string | undefined;
        if (!oldestKey) break;
        pendingEventsRef.current.delete(oldestKey);
      }
      pending = new Map();
      pendingEventsRef.current.set(key, pending);
      return pending;
    };

    const addPendingEvent = (pending: Map<number, RuntimeEvent>, event: RuntimeEvent) => {
      if (pending.has(event.seq)) return;
      if (pending.size >= MAX_PENDING_EVENTS_PER_SCOPE) {
        const highestSeq = Math.max(...pending.keys());
        if (event.seq > highestSeq) return;
        pending.delete(highestSeq);
      }
      pending.set(event.seq, event);
    };

    const recoverStaleCursorEvent = (event: RuntimeEvent, lastSeq: number) => {
      if (event.seq > lastSeq || processedEventIdsRef.current.has(event.eventId)) return false;
      const activeId = activeConversationRef.current;
      const activeConversationEvent = event.scopeKind === "conversation" && event.scopeId === activeId;
      const activeWorkspaceEvent = event.scopeKind === "workspace" && event.scopeId === activeWorkspaceRef.current;
      const currentUserEvent = event.scopeKind === "user" && event.scopeId === currentUserId;
      if (!activeConversationEvent && !activeWorkspaceEvent && !currentUserEvent) return false;
      rememberProcessedEventId(event.eventId);
      applyRuntimeEvent(event);
      return true;
    };

    enqueueEvent = (event: RuntimeEvent) => {
      const key = scopeKey(event.scopeKind, event.scopeId);
      const lastSeq = seqStoreRef.current[key] ?? 0;
      if (event.seq <= lastSeq || processedEventIdsRef.current.has(event.eventId)) {
        if (recoverStaleCursorEvent(event, lastSeq)) return;
        return;
      }
      const pending = ensurePendingScope(key);
      addPendingEvent(pending, event);
      if (event.seq > lastSeq + 1) {
        fetchGap(event.scopeKind, event.scopeId, lastSeq);
        return;
      }
      processReadyEvents(key);
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (heartbeatTimeoutTimer) {
        window.clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = undefined;
      }
    };

    const sendHeartbeat = () => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "ping", clientTime: new Date().toISOString() }));
      if (heartbeatTimeoutTimer) window.clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = window.setTimeout(() => {
        socket.close();
      }, HEARTBEAT_TIMEOUT_MS);
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      heartbeatTimer = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || (typeof navigator !== "undefined" && !navigator.onLine)) return;
      const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      const jitter = Math.round(baseDelay * 0.2 * Math.random());
      reconnectTimer = window.setTimeout(connect, baseDelay + jitter);
    };

    const handleMessage = (raw: MessageEvent) => {
      const envelope = parseServerEnvelope(raw.data);
      if (!envelope) return;
      if (envelope.type === "pong") {
        if (heartbeatTimeoutTimer) {
          window.clearTimeout(heartbeatTimeoutTimer);
          heartbeatTimeoutTimer = undefined;
        }
        return;
      }
      if (envelope.type === "connected") {
        reconnectAttempt = 0;
        subscribedScopesRef.current.clear();
        subscribeScope({ scopeKind: "user", scopeId: currentUserId });
        if (activeConversationRef.current) subscribeScope({ scopeKind: "conversation", scopeId: activeConversationRef.current });
        if (activeWorkspaceRef.current) subscribeScope({ scopeKind: "workspace", scopeId: activeWorkspaceRef.current });
        return;
      }
      if (envelope.type === "event" && envelope.event) enqueueEvent(envelope.event);
    };

    const connect = () => {
      if (disposed) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        scheduleReconnect();
        return;
      }
      const socket = new WebSocket(realtimeEndpoint());
      socketRef.current = socket;
      socket.addEventListener("open", startHeartbeat);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", () => {
        if (disposed) return;
        clearHeartbeat();
        socketRef.current = null;
        subscribedScopesRef.current.clear();
        scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    const handleOnline = () => {
      if (disposed || socketRef.current) return;
      reconnectAttempt = 0;
      connect();
    };

    const handleOffline = () => {
      clearHeartbeat();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
      subscribedScopesRef.current.clear();
    };

    connectTimer = window.setTimeout(connect, 0);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      disposed = true;
      if (connectTimer) window.clearTimeout(connectTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      clearHeartbeat();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      socketRef.current?.close();
      socketRef.current = null;
      subscribedScopesRef.current.clear();
      pendingEventsRef.current.clear();
      gapFetchesRef.current.clear();
    };
  }, [currentUserId, queryClient]);

  useEffect(() => {
    if (!currentUserId || !activeConversationId) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const key = scopeKey("conversation", activeConversationId);
    if (subscribedScopesRef.current.has(key)) return;
    subscribedScopesRef.current.add(key);
    socket.send(
      JSON.stringify({
        type: "subscribe",
        scopes: [{ scopeKind: "conversation", scopeId: activeConversationId, lastSeq: seqStoreRef.current[key] ?? 0 }]
      })
    );
  }, [activeConversationId, currentUserId]);

  useEffect(() => {
    if (!currentUserId || !activeWorkspaceId) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const key = scopeKey("workspace", activeWorkspaceId);
    if (subscribedScopesRef.current.has(key)) return;
    subscribedScopesRef.current.add(key);
    socket.send(
      JSON.stringify({
        type: "subscribe",
        scopes: [{ scopeKind: "workspace", scopeId: activeWorkspaceId, lastSeq: seqStoreRef.current[key] ?? 0 }]
      })
    );
  }, [activeWorkspaceId, currentUserId]);

  return children;
}
