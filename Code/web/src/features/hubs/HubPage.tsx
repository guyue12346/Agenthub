import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Bot, CheckCircle2, Copy, CopyPlus, Database, GitFork, Heart, Info, KeyRound, LogOut, MessageCircle, PackagePlus, Pencil, RefreshCw, Rocket, Send, Settings, ShieldCheck, Sparkles, Trash2, UserRound, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isUserVisibleAgent, type AgentDefinition, type WorkspaceAsset } from "@agenthub/shared";
import { api, type AgentBuilderChecklistItem, type AgentBuilderPayload, type AgentConfigView, type AgentSandboxTestView, type CreatePersonalToolPayload, type ExecutableRuntimeToolId, type HubAssetScope, type HubKind, type HubTextAssetPayload, type ToolDefinition } from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { resetUserBoundary } from "../../app/session-boundary";
import { AvatarMark } from "../../components/AvatarMark";
import { HubAssetLogo, HubAssetLogoPicker, normalizeHubLogo, normalizeHubLogoColor } from "../../components/HubAssetLogo";
import { useAuthStore } from "../../store/auth-store";
import { useUiStore } from "../../store/ui-store";

const config = {
  agent: { title: "AgentHub", subtitle: "管理 private、team 和 public Agent。", icon: Bot },
  tool: { title: "ToolHub", subtitle: "查看内置工具、权限风险和 Agent 绑定能力。", icon: Wrench },
  skill: { title: "SkillHub", subtitle: "沉淀可绑定到 Agent 的协作 Skill。", icon: Sparkles },
  knowledge: { title: "KnowledgeHub", subtitle: "管理知识库、文件摘要和 Agent 检索入口。", icon: Database },
  settings: { title: "设置", subtitle: "", icon: Settings }
};

const agentAvatarOptions = Array.from({ length: 27 }, (_, index) => `/avatars/agents/agent-v2-${String(index + 1).padStart(2, "0")}.png`);

const userAvatarOptions = [
  "/avatars/users/user-01.jpg",
  "/avatars/users/user-02.jpeg",
  "/avatars/users/user-03.png",
  "/avatars/users/user-05.webp",
  "/avatars/users/user-06.jpg",
  "/avatars/users/user-07.jpg",
  "/avatars/users/user-08.webp",
  "/avatars/users/user-09.jpg"
];

type HubMode = "personal" | "subscribed" | "fork" | "published" | "public" | "create" | "chat";

export function HubPage({ kind }: { kind: keyof typeof config }) {
  const [hubMode, setHubMode] = useState<HubMode>("personal");
  const scope = hubMode === "public" ? "public" : "personal";
  const assetScope: HubAssetScope = hubMode === "public" ? "public" : "personal";
  const [settingsSection, setSettingsSection] = useState<"account" | "security" | "archive">("account");
  const [agentBuilderPrompt, setAgentBuilderPrompt] = useState("");
  const [agentDraft, setAgentDraft] = useState(createEmptyAgentDraft);
  const [agentBuilderChatInput, setAgentBuilderChatInput] = useState("");
  const [agentBuilderChatMessages, setAgentBuilderChatMessages] = useState<AgentBuilderChatMessage[]>(createInitialAgentBuilderChatMessages);
  const [agentBuilderChecklist, setAgentBuilderChecklist] = useState<AgentBuilderChecklistItem[]>(createInitialAgentBuilderChecklist);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedHubDetail, setSelectedHubDetail] = useState<HubDetail | null>(null);
  const [editingHubAsset, setEditingHubAsset] = useState<{ kind: "skill" | "knowledge"; id: string } | null>(null);
  const [agentTestMessage, setAgentTestMessage] = useState("请用一句话说明你的能力和适合的任务。");
  const [assetDraft, setAssetDraft] = useState(createEmptyAssetDraft);
  const [toolDraft, setToolDraft] = useState(createEmptyToolDraft);
  const [userIdCopyState, setUserIdCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [profileAvatarDraft, setProfileAvatarDraft] = useState("");
  const logout = useAuthStore((state) => state.logout);
  const setSession = useAuthStore((state) => state.setSession);
  const user = useAuthStore((state) => state.user);
  const showToast = useUiStore((state) => state.showToast);
  const queryClient = useQueryClient();
  const userId = user?.id ?? "";
  useEffect(() => {
    if (kind !== "agent" && hubMode === "chat") setHubMode("personal");
  }, [kind, hubMode]);
  useEffect(() => {
    setProfileAvatarDraft(user?.avatar ?? "");
  }, [user?.avatar]);
  const agents = useQuery({
    queryKey: userId ? queryKeys.agents(userId, scope) : ["agents", scope],
    queryFn: () => api.agents(scope),
    enabled: kind === "agent" && Boolean(user)
  });
  const tools = useQuery({
    queryKey: userId ? queryKeys.tools(userId, scope) : ["tools", scope],
    queryFn: () => api.tools(scope),
    enabled: kind === "tool" && Boolean(user)
  });
  const hubAssets = useQuery({
    queryKey: userId && (kind === "skill" || kind === "knowledge") ? queryKeys.hubAssets(userId, kind, assetScope) : ["hub-assets", kind, assetScope],
    queryFn: () => api.hubAssets(kind === "skill" ? "skill" : "knowledge", assetScope),
    enabled: (kind === "skill" || kind === "knowledge") && Boolean(user)
  });
  const agentBuilderTools = useQuery({
    queryKey: userId ? ["user", userId, "agent-builder-tools"] : ["agent-builder-tools"],
    queryFn: () => api.tools("personal"),
    enabled: kind === "agent" && Boolean(user)
  });
  const agentBuilderSkills = useQuery({
    queryKey: userId ? ["user", userId, "agent-builder-skills"] : ["agent-builder-skills"],
    queryFn: () => api.hubAssets("skill", "personal"),
    enabled: kind === "agent" && Boolean(user)
  });
  const agentBuilderKnowledge = useQuery({
    queryKey: userId ? ["user", userId, "agent-builder-knowledge"] : ["agent-builder-knowledge"],
    queryFn: async () => {
      const result = await api.knowledgeList("mine");
      return {
        assets: result.items.map((asset) => ({
          id: asset.id,
          workspaceId: "",
          kind: "doc" as const,
          name: asset.name,
          path: `knowledge://${asset.id}`,
          summary: asset.description,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
          visibility: asset.visibility,
          ownerType: asset.ownerType,
          ownerId: asset.ownerId,
          logo: asset.logo,
          logoColor: asset.logoColor
        }))
      };
    },
    enabled: kind === "agent" && Boolean(user)
  });
  const archivedConversations = useQuery({
    queryKey: userId ? queryKeys.conversations(userId, undefined, true) : ["archived-conversations"],
    queryFn: () => api.conversations({ archived: true }),
    enabled: kind === "settings" && settingsSection === "archive" && Boolean(user)
  });
  const restoreArchivedConversation = useMutation({
    mutationFn: (conversationId: string) => api.unarchiveConversation(conversationId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations(userId, undefined, true) })
      ]);
    }
  });
  const updateProfile = useMutation({
    mutationFn: (payload: { avatar?: string }) => api.updateUserProfile(payload),
    onSuccess: async ({ user: updatedUser }) => {
      setSession({ user: updatedUser });
      setProfileAvatarDraft(updatedUser.avatar);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.authMe }),
        queryClient.invalidateQueries({ queryKey: queryKeys.users(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.friends(userId) })
      ]);
    }
  });
  const selectedAgentConfig = useQuery({
    queryKey: userId && selectedAgentId ? ["user", userId, "agent-config", selectedAgentId] : ["agent-config", selectedAgentId],
    queryFn: () => api.agentConfig(selectedAgentId!),
    enabled: kind === "agent" && Boolean(user) && Boolean(selectedAgentId)
  });
  const invalidateHubLifecycle = async (hubKind: HubKind) => {
    const tasks = [
      queryClient.invalidateQueries({ queryKey: queryKeys.hubSubscriptions(userId, hubKind) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.hubSubscriptions(userId) })
    ];
    if (hubKind === "tool") {
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId, scope) }));
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId, "personal") }));
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId, "public") }));
    } else {
      (["personal", "subscribed", "fork", "published", "public"] as const).forEach((item) => {
        tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.hubAssets(userId, hubKind, item) }));
      });
      tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(userId) }));
    }
    await Promise.all(tasks);
  };
  const subscribeHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: HubKind; assetId: string }) => api.subscribeHubAsset(hubKind, assetId),
    onSuccess: async (_result, variables) => {
      await invalidateHubLifecycle(variables.hubKind);
    }
  });
  const unsubscribeHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: HubKind; assetId: string }) => api.unsubscribeHubAsset(hubKind, assetId),
    onSuccess: async (_result, variables) => {
      await invalidateHubLifecycle(variables.hubKind);
    }
  });
  const syncHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId, confirmRiskChanges }: { hubKind: HubKind; assetId: string; confirmRiskChanges?: boolean }) =>
      api.syncHubAsset(hubKind, assetId, confirmRiskChanges ? { confirmRiskChanges } : undefined),
    onSuccess: async (_result, variables) => {
      await invalidateHubLifecycle(variables.hubKind);
    }
  });
  const syncWithConfirmation = (hubKind: HubKind, assetId: string, conflictStatus?: string | null) => {
    const confirmRiskChanges = Boolean(conflictStatus);
    if (confirmRiskChanges) {
      const accepted = window.confirm("该订阅更新涉及权限、风险等级或接口变化。确认后才会更新到当前空间。");
      if (!accepted) return;
    }
    syncHubAsset.mutate({ hubKind, assetId, confirmRiskChanges });
  };
  const forkHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: "skill" | "knowledge"; assetId: string }) => api.forkHubAsset(hubKind, assetId),
    onSuccess: async (_result, variables) => {
      await invalidateHubLifecycle(variables.hubKind);
      setHubMode("personal");
    }
  });
  const toggleHubAssetLike = useMutation({
    mutationFn: ({ hubKind, assetId, liked }: { hubKind: HubKind; assetId: string; liked: boolean }) =>
      liked ? api.unlikeHubAsset(hubKind, assetId) : api.likeHubAsset(hubKind, assetId),
    onSuccess: async (_result, variables) => {
      if (variables.hubKind === "skill" || variables.hubKind === "knowledge") {
        await invalidateHubLifecycle(variables.hubKind);
      }
    }
  });
  const deleteHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId }: { hubKind: "skill" | "knowledge"; assetId: string }) => api.deleteHubAsset(hubKind, assetId),
    onSuccess: async (_result, variables) => {
      setSelectedHubDetail((current) => current?.key === `${variables.hubKind}:${variables.assetId}` ? null : current);
      await invalidateHubLifecycle(variables.hubKind);
    }
  });
  const createAgent = useMutation({
    mutationFn: (payload: AgentBuilderPayload) => api.createAgent(payload),
    onSuccess: async () => {
      setAgentDraft(createEmptyAgentDraft());
      setEditingAgentId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentInstallations(userId) })
      ]);
      setHubMode("personal");
    }
  });
  const updateExistingAgent = useMutation({
    mutationFn: ({ agentId, payload }: { agentId: string; payload: AgentBuilderPayload }) => api.updateAgent(agentId, payload),
    onSuccess: async (_result, variables) => {
      setAgentDraft(createEmptyAgentDraft());
      setEditingAgentId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "public") }),
        queryClient.invalidateQueries({ queryKey: ["user", userId, "agent-config", variables.agentId] })
      ]);
      setHubMode("personal");
    }
  });
  const generateAgentDraft = useMutation({
    mutationFn: (message: string) => api.generateAgentDraft({ message, includePublicAssets: true }),
    onSuccess: (result) => {
      setEditingAgentId(null);
      setAgentDraft(agentPayloadToDraft(result.draft));
      setHubMode("create");
    }
  });
  const agentBuilderChat = useMutation({
    mutationFn: (payload: {
      messages: AgentBuilderChatMessage[];
      currentDraft: AgentDraft;
    }) => api.agentBuilderChat({
      messages: payload.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      currentDraft: { ...payload.currentDraft },
      includePublicAssets: true
    }),
    onSuccess: (result) => {
      setEditingAgentId(null);
      setAgentDraft(agentPayloadToDraft(result.draft));
      setAgentBuilderChecklist(result.checklist);
      setAgentBuilderChatMessages((current) => [
        ...current,
        createAgentBuilderChatMessage("assistant", result.assistantMessage)
      ]);
      if (result.readyToSave) {
        setHubMode("create");
      }
    },
    onError: (error) => {
      setAgentBuilderChatMessages((current) => [
        ...current,
        createAgentBuilderChatMessage("assistant", `Agent Builder 模型调用失败：${error instanceof Error ? error.message : String(error)}。请检查后台模型配置或稍后重试。`)
      ]);
    }
  });
  const publishAgent = useMutation({
    mutationFn: ({ agentId, confirmHighRiskPublish }: { agentId: string; confirmHighRiskPublish?: boolean }) =>
      api.publishAgent(agentId, confirmHighRiskPublish ? { confirmHighRiskPublish } : undefined),
    onSuccess: async () => {
      showToast("Agent 已发布到 public", "success");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "public") })
      ]);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "发布 Agent 失败", "warning");
    }
  });
  const deleteAgent = useMutation({
    mutationFn: (agentId: string) => api.deleteAgent(agentId),
    onSuccess: async (_result, agentId) => {
      showToast("Agent 已删除", "success");
      setSelectedAgentId((current) => current === agentId ? null : current);
      setSelectedHubDetail((current) => current?.key === `agent:${agentId}` ? null : current);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "public") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentInstallations(userId) })
      ]);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "删除 Agent 失败", "warning");
    }
  });
  const forkAgent = useMutation({
    mutationFn: (agentId: string) => api.forkAgent(agentId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "public") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentInstallations(userId) })
      ]);
      setHubMode("personal");
    }
  });
  const testAgent = useMutation({
    mutationFn: ({ agentId, message }: { agentId: string; message: string }) => api.testAgent(agentId, {
      message,
      writeMemory: false
    })
  });
  const openAgentChat = useMutation({
    mutationFn: (agentId: string) => api.openAgentConversation(agentId),
    onSuccess: ({ conversation }) => navigate(`/messages/${conversation.id}`)
  });
  const createHubAsset = useMutation({
    mutationFn: ({ hubKind, payload }: { hubKind: "skill" | "knowledge"; payload: HubTextAssetPayload }) => api.createHubAsset(hubKind, payload),
    onSuccess: async (_result, variables) => {
      setAssetDraft(createEmptyAssetDraft());
      setEditingHubAsset(null);
      await invalidateHubLifecycle(variables.hubKind);
      setHubMode("personal");
    }
  });
  const updateHubAsset = useMutation({
    mutationFn: ({ hubKind, assetId, payload }: { hubKind: "skill" | "knowledge"; assetId: string; payload: HubTextAssetPayload }) =>
      api.updateHubAsset(hubKind, assetId, payload),
    onSuccess: async (_result, variables) => {
      setAssetDraft(createEmptyAssetDraft());
      setEditingHubAsset(null);
      await invalidateHubLifecycle(variables.hubKind);
      setHubMode("personal");
    }
  });
  const createPersonalTool = useMutation({
    mutationFn: (payload: CreatePersonalToolPayload) => api.createPersonalTool(payload),
    onSuccess: async () => {
      setToolDraft(createEmptyToolDraft());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId) }),
        queryClient.invalidateQueries({ queryKey: ["user", userId, "agent-builder-tools"] })
      ]);
      setHubMode("personal");
    }
  });
  const deleteTool = useMutation({
    mutationFn: (toolId: string) => api.deleteTool(toolId),
    onSuccess: async (_result, toolId) => {
      showToast("Tool 已删除", "success");
      setSelectedHubDetail((current) => current?.key === `tool:${toolId}` ? null : current);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tools(userId) }),
        queryClient.invalidateQueries({ queryKey: ["user", userId, "agent-builder-tools"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.hubSubscriptions(userId, "tool") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.hubSubscriptions(userId) })
      ]);
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : "删除 Tool 失败", "warning");
    }
  });
  const installAgent = useMutation({
    mutationFn: (agentId: string) => api.installAgent(agentId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, scope) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentInstallations(userId) })
      ]);
    }
  });
  const syncAgentInstall = useMutation({
    mutationFn: ({ agentId, confirmRiskChanges }: { agentId: string; confirmRiskChanges?: boolean }) =>
      api.syncAgentInstall(agentId, confirmRiskChanges === undefined ? undefined : { confirmRiskChanges }),
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!variables.confirmRiskChanges && message.includes("需要确认")) {
        const accepted = window.confirm("该 Agent 更新涉及新增权限或工具。确认后同步到最新版本？");
        if (accepted) syncAgentInstall.mutate({ agentId: variables.agentId, confirmRiskChanges: true });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "personal") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents(userId, "public") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agentInstallations(userId) })
      ]);
    }
  });
  const navigate = useNavigate();
  const page = config[kind];
  const PageIcon = page.icon;
  const agentSubmitDisabled = !agentDraft.name.trim() || !agentDraft.description.trim() || createAgent.isPending || updateExistingAgent.isPending;
  const skillReleaseVersionValid = kind !== "skill" || isValidReleaseVersion(assetDraft.releaseVersion);
  const assetSubmitDisabled = !assetDraft.name.trim() || !assetDraft.content.trim() || !skillReleaseVersionValid || createHubAsset.isPending || updateHubAsset.isPending;
  const toolSubmitDisabled = !toolDraft.name.trim()
    || !toolDraft.description.trim()
    || (toolDraft.runtimeType === "function" && !toolDraft.functionSource.trim())
    || createPersonalTool.isPending;
  const agentBuilderPayload = useMemo(() => buildAgentPayload(agentDraft), [agentDraft]);
  const visibleAgents = useMemo(() => (agents.data?.agents ?? []).filter(isUserVisibleAgent), [agents.data?.agents]);
  const displayedAgents = useMemo(
    () => scope === "public" ? visibleAgents.filter((agent) => agent.custom && !agent.installed) : visibleAgents,
    [scope, visibleAgents]
  );
  const selectedAgent = useMemo(
    () => visibleAgents.find((agent) => agent.id === selectedAgentId),
    [selectedAgentId, visibleAgents]
  );
  const selectedBuilderSkills = useMemo(
    () => (agentBuilderSkills.data?.assets ?? []).filter((asset) => agentDraft.skillAssetIds.includes(asset.id)),
    [agentBuilderSkills.data?.assets, agentDraft.skillAssetIds]
  );
  const selectedBuilderKnowledge = useMemo(
    () => (agentBuilderKnowledge.data?.assets ?? []).filter((asset) => agentDraft.knowledgeAssetIds.includes(asset.id)),
    [agentBuilderKnowledge.data?.assets, agentDraft.knowledgeAssetIds]
  );
  const selectedBuilderTools = useMemo(
    () => (agentBuilderTools.data?.tools ?? []).filter((tool) => agentDraft.toolIds.includes(tool.id)),
    [agentBuilderTools.data?.tools, agentDraft.toolIds]
  );
  const enterCreateMode = () => {
    setHubMode("create");
    setSelectedAgentId(null);
    setSelectedHubDetail(null);
    if (kind === "agent") {
      setEditingAgentId(null);
      setAgentDraft(createEmptyAgentDraft());
      setAgentBuilderPrompt("");
      setAgentBuilderChecklist(createInitialAgentBuilderChecklist());
    } else if (kind === "tool") {
      setToolDraft(createEmptyToolDraft());
    } else if (kind === "skill" || kind === "knowledge") {
      setEditingHubAsset(null);
      setAssetDraft(createEmptyAssetDraft());
    }
  };

  const resetAgentBuilderChat = () => {
    setAgentBuilderChatInput("");
    setAgentBuilderChatMessages(createInitialAgentBuilderChatMessages());
    setAgentBuilderChecklist(createInitialAgentBuilderChecklist());
  };

  const submitAgentBuilderChat = (message: string) => {
    const text = message.trim();
    if (!text || agentBuilderChat.isPending) return;
    const userMessage = createAgentBuilderChatMessage("user", text);
    const nextMessages = [...agentBuilderChatMessages, userMessage];
    setAgentBuilderChatMessages(nextMessages);
    setAgentBuilderChatInput("");
    agentBuilderChat.mutate({
      messages: nextMessages,
      currentDraft: agentDraft
    });
  };

  const editHubTextAsset = async (hubKind: "skill" | "knowledge", asset: WorkspaceAsset) => {
    const sourceAssetId = asset.hubStatus === "forked" && asset.forkedAssetId ? asset.forkedAssetId : asset.sourceAssetId ?? asset.id;
    const fullAsset = await api.editableHubAsset(hubKind, sourceAssetId);
    const currentReleaseVersion = hubKind === "skill"
      ? asset.releaseVersion ?? stringValue(asset.details?.releaseVersion) ?? "v0.0.1"
      : undefined;
    setAssetDraft({
      name: asset.name,
      summary: asset.summary,
      content: fullAsset.asset.content ?? "",
      visibility: asset.visibility === "public" ? "public" : "private",
      logo: normalizeHubLogo(asset.logo),
      logoColor: normalizeHubLogoColor(asset.logoColor),
      ...(hubKind === "skill" ? { releaseVersion: nextPatchReleaseVersion(currentReleaseVersion) } : {})
    });
    setEditingHubAsset({ kind: hubKind, id: sourceAssetId });
    setSelectedHubDetail(null);
    setHubMode("create");
  };

  const openHubAssetDetail = async (hubKind: "skill" | "knowledge", asset: WorkspaceAsset) => {
    const baseDetail = buildAssetDetail(hubKind, asset);
    setSelectedHubDetail({ ...baseDetail, contentPending: true });
    try {
      const sourceAssetId = asset.hubStatus === "forked" && asset.forkedAssetId ? asset.forkedAssetId : asset.sourceAssetId ?? asset.id;
      const fullAsset = await api.editableHubAsset(hubKind, sourceAssetId);
      setSelectedHubDetail({
        ...baseDetail,
        content: fullAsset.asset.content ?? "",
        contentPending: false
      });
    } catch (error) {
      setSelectedHubDetail({
        ...baseDetail,
        content: `读取内容失败：${error instanceof Error ? error.message : String(error)}`,
        contentPending: false
      });
    }
  };

  if (kind === "settings") {
    const roleLabel = user?.role === "admin" ? "系统管理员" : user?.role === "owner" ? "项目负责人" : "成员";
    const settingsItems = [
      { id: "account" as const, title: "账号与身份", desc: user?.name ? `当前：${user.name}` : "未登录", icon: UserRound },
      { id: "archive" as const, title: "归档会话", desc: "查看并恢复已归档会话", icon: Archive },
      { id: "security" as const, title: "安全与会话", desc: "Token、缓存和退出", icon: ShieldCheck }
    ];

    return (
      <section className="settings-layout">
        <aside className="settings-sidebar" aria-label="设置分类">
          <div className="settings-sidebar-title">
            <h1>{page.title}</h1>
            {page.subtitle ? <p>{page.subtitle}</p> : null}
          </div>
          <nav className="settings-nav">
            {settingsItems.map((item) => {
              const ItemIcon = item.icon;
              return (
                <button
                  key={item.id}
                  className={settingsSection === item.id ? "settings-nav-item active" : "settings-nav-item"}
                  type="button"
                  onClick={() => setSettingsSection(item.id)}
                >
                  <ItemIcon size={18} />
                  <span>{item.title}</span>
                  <small>{item.desc}</small>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="settings-panel">
          {settingsSection === "account" ? (
            <section className="settings-section">
              <header className="settings-section-header">
                <h2>账号与身份</h2>
              </header>
              <div className="settings-card settings-profile">
                <AvatarMark className="settings-profile-avatar" kind="user" size="lg" value={user?.avatar ?? "U"} label={user?.name} />
                <div>
                  <h3>{user?.name ?? "未命名用户"}</h3>
                  <p>{roleLabel}</p>
                </div>
                <dl>
                  <div>
                    <dt>好友码</dt>
                    <dd className="settings-user-id-row">
                      <code>{user?.publicId ?? "未登录"}</code>
                      <button
                        type="button"
                        title="复制我的好友码"
                        disabled={!user?.publicId}
                        onClick={() => {
                          if (!user?.publicId) return;
                          void copyToClipboard(user.publicId)
                            .then(() => setUserIdCopyState("copied"))
                            .catch(() => setUserIdCopyState("failed"))
                            .finally(() => window.setTimeout(() => setUserIdCopyState("idle"), 1_500));
                        }}
                      >
                        <Copy size={14} />
                        <span>{userIdCopyState === "copied" ? "已复制" : userIdCopyState === "failed" ? "复制失败" : "复制"}</span>
                      </button>
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="settings-card settings-avatar-card">
                <div className="settings-avatar-preview-wrap">
                  <AvatarMark className="settings-avatar-preview" kind="user" size="xl" value={profileAvatarDraft || user?.avatar || "U"} label={user?.name} />
                </div>
                <div className="settings-avatar-editor">
                  <div className="settings-card-title">
                    <div className="settings-card-title-main">
                      <UserRound size={18} />
                      <div>
                        <h3>头像</h3>
                      </div>
                    </div>
                  </div>
                  <div className="settings-avatar-controls">
                    <AvatarOptionGrid
                      kind="user"
                      label="推荐头像"
                      hideLabel
                      options={userAvatarOptions}
                      value={profileAvatarDraft}
                      onChange={(value) => {
                        setProfileAvatarDraft(value);
                      }}
                    />
                    <button
                      className="primary-button compact settings-avatar-save-btn"
                      type="button"
                      disabled={!profileAvatarDraft.trim() || profileAvatarDraft.trim() === user?.avatar || updateProfile.isPending}
                      onClick={() => updateProfile.mutate({ avatar: profileAvatarDraft.trim() })}
                    >
                      保存
                    </button>
                  </div>
                  {updateProfile.error ? <p className="form-error">{(updateProfile.error as Error).message}</p> : null}
                </div>
              </div>
            </section>
          ) : null}

          {settingsSection === "security" ? (
            <section className="settings-section">
              <header className="settings-section-header">
                <h2>安全与会话</h2>
              </header>
              <div className="settings-list">
                <div className="settings-row">
                  <div>
                    <strong>认证方式</strong>
                    <p>前端不保存访问 token，请求依赖服务端签发的安全 Cookie。</p>
                  </div>
                  <span>HttpOnly Cookie</span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>本地状态</strong>
                    <p>切换账号时清理用户相关查询缓存，避免串号。</p>
                  </div>
                  <span>scoped cache</span>
                </div>
              </div>
              <div className="settings-card settings-danger-zone">
                <KeyRound size={18} />
                <div>
                  <h3>退出当前账号</h3>
                  <p>退出后会清空本地 session，并返回登录页。</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    void api.logout().finally(() => {
                      resetUserBoundary(queryClient, user?.id);
                      logout();
                      navigate("/login", { replace: true });
                    });
                  }}
                >
                  <LogOut size={16} /> 退出登录
                </button>
              </div>
            </section>
          ) : null}

          {settingsSection === "archive" ? (
            <section className="settings-section">
              <header className="settings-section-header">
                <h2>归档会话</h2>
              </header>
              <div className="settings-list">
                {archivedConversations.isLoading ? (
                  <div className="settings-empty-row">正在读取归档会话...</div>
                ) : null}
                {(archivedConversations.data?.conversations ?? []).map((conversation) => (
                  <div key={conversation.id} className="settings-row settings-archive-row">
                    <AvatarMark kind="conversation" value={conversation.avatar} label={conversation.title} variantKey={conversation.id} />
                    <div>
                      <strong>{conversation.title}</strong>
                      <p>
                        {conversation.lastMessage || "暂无最新消息"} ·{" "}
                        {conversation.archivedAt
                          ? new Date(conversation.archivedAt).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit"
                            })
                          : "已归档"}
                      </p>
                    </div>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={restoreArchivedConversation.isPending}
                      onClick={() => restoreArchivedConversation.mutate(conversation.id)}
                    >
                      <RefreshCw size={15} /> 恢复
                    </button>
                  </div>
                ))}
                {archivedConversations.isSuccess && archivedConversations.data.conversations.length === 0 ? (
                  <div className="settings-empty-row">暂无归档会话。</div>
                ) : null}
              </div>
            </section>
          ) : null}
        </main>
      </section>
    );
  }

  return (
    <section className="hub-layout">
      <div className="page-header inline">
        <div>
          <h1>{page.title}</h1>
        </div>
        <div className="hub-header-actions">
          <div className="segmented">
            {hubModeOptions(kind).map((item) => (
              <button key={item.id} className={hubMode === item.id ? "active" : ""} type="button" onClick={item.id === "create" ? enterCreateMode : () => setHubMode(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {kind === "agent" && hubMode === "chat" ? (
        <section className="agent-builder-chat-page">
          <AgentBuilderChatPanel
            messages={agentBuilderChatMessages}
            value={agentBuilderChatInput}
            checklist={agentBuilderChecklist}
            generating={agentBuilderChat.isPending || generateAgentDraft.isPending}
            onChange={setAgentBuilderChatInput}
            onClose={() => setHubMode("personal")}
            onReset={resetAgentBuilderChat}
            onSync={() => setHubMode("create")}
            onSubmit={submitAgentBuilderChat}
          />
        </section>
      ) : null}
      {kind === "agent" && hubMode === "create" ? (
        <section className="hub-builder-panel agent-builder-studio">
          {!editingAgentId ? (
            <div className="hub-builder-ai agent-builder-quick-draft">
              <label>
                快速生成草案
                <textarea
                  value={agentBuilderPrompt}
                  onChange={(event) => setAgentBuilderPrompt(event.target.value)}
                  placeholder="例如：帮我创建一个 UI Agent，负责审阅 AgentHub 的页面设计，长内容要写到 Doc，并能读取项目知识库。"
                />
              </label>
              <div className="hub-builder-ai-actions">
                <button
                  className="primary-button compact"
                  type="button"
                  disabled={!agentBuilderPrompt.trim() || generateAgentDraft.isPending}
                  onClick={() => generateAgentDraft.mutate(agentBuilderPrompt)}
                >
                  <Sparkles size={15} />
                  {generateAgentDraft.isPending ? "生成中" : "生成草案"}
                </button>
                {generateAgentDraft.data ? <span>{generateAgentDraft.data.rationale}</span> : null}
              </div>
              {generateAgentDraft.data ? (
                <div className="hub-builder-draft-notes">
                  {generateAgentDraft.data.recommendedBindings.skills.length > 0 ? (
                    <p>推荐 Skill：{generateAgentDraft.data.recommendedBindings.skills.map((item) => item.name).join("、")}</p>
                  ) : null}
                  {generateAgentDraft.data.recommendedBindings.tools.length > 0 ? (
                    <p>推荐 Tool：{generateAgentDraft.data.recommendedBindings.tools.map((item) => item.name).join("、")}</p>
                  ) : null}
                  {generateAgentDraft.data.recommendedBindings.knowledge.length > 0 ? (
                    <p>推荐 Knowledge：{generateAgentDraft.data.recommendedBindings.knowledge.map((item) => item.name).join("、")}</p>
                  ) : null}
                  {generateAgentDraft.data.safetyNotes.map((note) => <p key={note}>注意：{note}</p>)}
                </div>
              ) : null}
              {generateAgentDraft.error ? <p className="form-error">{(generateAgentDraft.error as Error).message}</p> : null}
            </div>
          ) : null}
          <div className="hub-builder-grid">
            <label>
              Agent 名称
              <input value={agentDraft.name} onChange={(event) => setAgentDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="例如：论文审阅助手" />
            </label>
            <AvatarOptionGrid
              kind="agent"
              label="内置 Agent 头像"
              options={agentAvatarOptions}
              value={agentDraft.avatar}
              onChange={(value) => setAgentDraft((draft) => ({ ...draft, avatar: value }))}
            />
            <label>
              Agent 类型
              <select value={agentDraft.type} onChange={(event) => setAgentDraft((draft) => ({ ...draft, type: event.target.value as AgentDraft["type"] }))}>
                <option value="product">Product Agent</option>
                <option value="ui">UI Agent</option>
                <option value="review">Review Agent</option>
              </select>
            </label>
            <label>
              分类
              <input value={agentDraft.category} onChange={(event) => setAgentDraft((draft) => ({ ...draft, category: event.target.value }))} placeholder="custom / writing / review / research" />
            </label>
            <label>
              能力标签
              <input value={agentDraft.capabilities} onChange={(event) => setAgentDraft((draft) => ({ ...draft, capabilities: event.target.value }))} placeholder="review, writing, research" />
            </label>
            <label className="span-2">
              简介
              <input value={agentDraft.description} onChange={(event) => setAgentDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="一句话描述这个 Agent 负责什么" />
            </label>
            <label className="span-2">
              角色提示词
              <textarea value={agentDraft.rolePrompt} onChange={(event) => setAgentDraft((draft) => ({ ...draft, rolePrompt: event.target.value }))} placeholder="描述它的角色、判断标准和协作方式" />
            </label>
            <label>
              目标
              <textarea value={agentDraft.goals} onChange={(event) => setAgentDraft((draft) => ({ ...draft, goals: event.target.value }))} placeholder="一行一条，例如：先形成可执行结论" />
            </label>
            <label>
              行为规则
              <textarea value={agentDraft.behaviorRules} onChange={(event) => setAgentDraft((draft) => ({ ...draft, behaviorRules: event.target.value }))} placeholder="一行一条，例如：先澄清再执行" />
            </label>
            <label>
              输出规则
              <textarea value={agentDraft.outputRules} onChange={(event) => setAgentDraft((draft) => ({ ...draft, outputRules: event.target.value }))} placeholder="一行一条，例如：长内容写入 Doc/*.md" />
            </label>
            <label>
              拒绝/降级规则
              <textarea value={agentDraft.refusalRules} onChange={(event) => setAgentDraft((draft) => ({ ...draft, refusalRules: event.target.value }))} placeholder="一行一条，例如：缺少权限时先说明原因" />
            </label>
          </div>
          <div className="hub-builder-grid">
            <label>
              模型 Provider
              <input value={agentDraft.modelProvider} onChange={(event) => setAgentDraft((draft) => ({ ...draft, modelProvider: event.target.value }))} placeholder="runtime_default / runapi" />
            </label>
            <label>
              模型
              <input value={agentDraft.modelName} onChange={(event) => setAgentDraft((draft) => ({ ...draft, modelName: event.target.value }))} placeholder="runtime_default / gpt-5.5" />
            </label>
            <label>
              Temperature
              <input type="number" min={0} max={2} step={0.1} value={agentDraft.temperature} onChange={(event) => setAgentDraft((draft) => ({ ...draft, temperature: event.target.value }))} placeholder="默认" />
            </label>
            <label>
              Reasoning Effort
              <select value={agentDraft.reasoningEffort} onChange={(event) => setAgentDraft((draft) => ({ ...draft, reasoningEffort: event.target.value as AgentDraft["reasoningEffort"] }))}>
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
            <label>
              Fallback Model
              <input value={agentDraft.fallbackModel} onChange={(event) => setAgentDraft((draft) => ({ ...draft, fallbackModel: event.target.value }))} placeholder="可选，例如 gpt-5-mini" />
            </label>
            <label>
              工作流模板
              <select value={agentDraft.workflowTemplate} onChange={(event) => setAgentDraft((draft) => ({ ...draft, workflowTemplate: event.target.value as AgentDraft["workflowTemplate"] }))}>
                <option value="tool_loop">工具循环</option>
                <option value="direct_answer">直接回答</option>
                <option value="artifact_generation">产物生成</option>
                <option value="review">审阅</option>
                <option value="human_approval">人工确认</option>
              </select>
            </label>
            <label>
              最大工具步数
              <input type="number" min={1} max={12} value={agentDraft.maxToolSteps} onChange={(event) => setAgentDraft((draft) => ({ ...draft, maxToolSteps: event.target.value }))} />
            </label>
            <label>
              最大运行秒数
              <input type="number" min={30} max={1800} value={agentDraft.maxRunSeconds} onChange={(event) => setAgentDraft((draft) => ({ ...draft, maxRunSeconds: event.target.value }))} />
            </label>
            <label className="hub-inline-check hub-field-check">
              <input
                type="checkbox"
                checked={agentDraft.streaming}
                onChange={(event) => setAgentDraft((draft) => ({ ...draft, streaming: event.target.checked }))}
              />
              启用流式输出
            </label>
          </div>
          <div className="hub-builder-grid">
            <label className="hub-inline-check hub-field-check">
              <input
                type="checkbox"
                checked={agentDraft.orchestratorCallable}
                onChange={(event) => setAgentDraft((draft) => ({ ...draft, orchestratorCallable: event.target.checked }))}
              />
              允许 Orchestrator 分派
            </label>
            <label className="hub-inline-check hub-field-check">
              <input
                type="checkbox"
                checked={agentDraft.acknowledgeOnAssignment}
                onChange={(event) => setAgentDraft((draft) => ({ ...draft, acknowledgeOnAssignment: event.target.checked }))}
              />
              被分派时先确认收到
            </label>
            <label>
              分派标签
              <textarea value={agentDraft.dispatchTags} onChange={(event) => setAgentDraft((draft) => ({ ...draft, dispatchTags: event.target.value }))} placeholder="一行一条，例如：ui / review / writing" />
            </label>
            <label>
              分派说明
              <textarea value={agentDraft.assignmentDescription} onChange={(event) => setAgentDraft((draft) => ({ ...draft, assignmentDescription: event.target.value }))} placeholder="Orchestrator 什么时候应该把任务交给这个 Agent" />
            </label>
          </div>
          <div className="hub-builder-section">
            <strong>工作空间权限</strong>
            <div className="hub-inline-check-group">
              <label className="hub-inline-check">
                <input type="checkbox" checked={agentDraft.docRead} onChange={(event) => setAgentDraft((draft) => ({ ...draft, docRead: event.target.checked }))} />
                读取 Doc
              </label>
              <label className="hub-inline-check">
                <input type="checkbox" checked={agentDraft.docWrite} onChange={(event) => setAgentDraft((draft) => ({ ...draft, docWrite: event.target.checked }))} />
                写入 Doc
              </label>
              <label className="hub-inline-check">
                <input type="checkbox" checked={agentDraft.codeRead} onChange={(event) => setAgentDraft((draft) => ({ ...draft, codeRead: event.target.checked }))} />
                读取 Code
              </label>
              <label className="hub-inline-check">
                <input type="checkbox" checked={agentDraft.codeWrite} onChange={(event) => setAgentDraft((draft) => ({ ...draft, codeWrite: event.target.checked }))} />
                写入 Code
              </label>
              <label className="hub-inline-check">
                <input type="checkbox" checked={agentDraft.assetCreate} onChange={(event) => setAgentDraft((draft) => ({ ...draft, assetCreate: event.target.checked }))} />
                创建附件/资产
              </label>
            </div>
          </div>
          <section className="hub-assembly-panel">
            <div className="hub-assembly-head">
              <div>
                <strong>组件装配</strong>
                <span>从 Skill、Tool、Knowledge 三类资产中选择能力，组合成这个 Agent 的工作方式。</span>
              </div>
              <div className="hub-assembly-counts" aria-label="当前装配数量">
                <span>{agentDraft.skillAssetIds.length} Skills</span>
                <span>{agentDraft.toolIds.length} Tools</span>
                <span>{agentDraft.knowledgeAssetIds.length} Knowledge</span>
              </div>
            </div>
            <div className="hub-assembly-layout">
              <div className="hub-assembly-columns">
                <div className="hub-assembly-column skills">
                  <header>
                    <Sparkles size={18} />
                    <div>
                      <strong>Skills</strong>
                      <span>注入协作规范和专业方法</span>
                    </div>
                  </header>
                  <div className="hub-component-list">
                    {(agentBuilderSkills.data?.assets ?? []).map((asset) => (
                      <label key={asset.id} className={agentDraft.skillAssetIds.includes(asset.id) ? "hub-component-card active" : "hub-component-card"}>
                        <input
                          type="checkbox"
                          checked={agentDraft.skillAssetIds.includes(asset.id)}
                          onChange={(event) => setAgentDraft((draft) => toggleListValue(draft, "skillAssetIds", asset.id, event.target.checked))}
                        />
                        <HubAssetLogo logo={asset.logo} color={asset.logoColor} />
                        <span>
                          <b>{asset.name}</b>
                          <small>{asset.summary || asset.path}</small>
                        </span>
                      </label>
                    ))}
                    {agentBuilderSkills.isSuccess && agentBuilderSkills.data.assets.length === 0 ? <p className="muted">暂无 private Skill，可先到 SkillHub 创建。</p> : null}
                  </div>
                </div>

                <div className="hub-assembly-column tools">
                  <header>
                    <Wrench size={18} />
                    <div>
                      <strong>Tools</strong>
                      <span>授予可调用函数和后端服务</span>
                    </div>
                  </header>
                  <div className="hub-component-list">
                    {(agentBuilderTools.data?.tools ?? []).filter((tool) => tool.risk !== "dangerous").map((tool) => (
                      <label key={tool.id} className={agentDraft.toolIds.includes(tool.id) ? "hub-component-card active" : "hub-component-card"}>
                        <input
                          type="checkbox"
                          checked={agentDraft.toolIds.includes(tool.id)}
                          onChange={(event) => setAgentDraft((draft) => toggleListValue(draft, "toolIds", tool.id, event.target.checked))}
                        />
                        <span className="hub-component-icon"><Wrench size={17} /></span>
                        <span>
                          <b>{tool.name}</b>
                          <small>{toolRuntimeTypeView(tool).label} · {tool.id} · {tool.risk}</small>
                        </span>
                      </label>
                    ))}
                    {agentBuilderTools.isSuccess && agentBuilderTools.data.tools.filter((tool) => tool.risk !== "dangerous").length === 0 ? <p className="muted">暂无可绑定工具，可先到 ToolHub 创建。</p> : null}
                  </div>
                </div>

                <div className="hub-assembly-column knowledge">
                  <header>
                    <Database size={18} />
                    <div>
                      <strong>Knowledge</strong>
                      <span>绑定查询或 RAG 强化资料</span>
                    </div>
                  </header>
                  <div className="hub-component-list">
                    {(agentBuilderKnowledge.data?.assets ?? []).map((asset) => (
                      <div key={asset.id} className={agentDraft.knowledgeAssetIds.includes(asset.id) ? "hub-component-card hub-knowledge-component active" : "hub-component-card hub-knowledge-component"}>
                        <label>
                          <input
                            type="checkbox"
                            checked={agentDraft.knowledgeAssetIds.includes(asset.id)}
                            onChange={(event) => setAgentDraft((draft) => {
                              const next = toggleListValue(draft, "knowledgeAssetIds", asset.id, event.target.checked);
                              return event.target.checked
                                ? { ...next, knowledgeModes: { ...next.knowledgeModes, [asset.id]: next.knowledgeModes[asset.id] ?? "rag" } }
                                : next;
                            })}
                          />
                          <HubAssetLogo logo={asset.logo} color={asset.logoColor} />
                          <span>
                            <b>{asset.name}</b>
                            <small>{asset.summary || asset.path}</small>
                          </span>
                        </label>
                        <select
                          aria-label={`${asset.name} 的知识接入模式`}
                          disabled={!agentDraft.knowledgeAssetIds.includes(asset.id)}
                          value={agentDraft.knowledgeModes[asset.id] ?? "rag"}
                          onChange={(event) => setAgentDraft((draft) => ({
                            ...draft,
                            knowledgeModes: {
                              ...draft.knowledgeModes,
                              [asset.id]: event.target.value === "query" ? "query" : "rag"
                            }
                          }))}
                        >
                          <option value="query">查询</option>
                          <option value="rag">RAG 强化</option>
                        </select>
                      </div>
                    ))}
                    {agentBuilderKnowledge.isSuccess && agentBuilderKnowledge.data.assets.length === 0 ? <p className="muted">暂无 private 知识资产，可先到 KnowledgeHub 创建。</p> : null}
                  </div>
                </div>
              </div>
              <aside className="hub-assembly-preview">
                <div className="hub-assembly-avatar">
                  <AvatarMark kind="agent" size="lg" value={agentDraft.avatar || agentDraft.name || "A"} label={agentDraft.name || "New Agent"} />
                  <div>
                    <strong>{agentDraft.name || "未命名 Agent"}</strong>
                    <span>{agentDraft.type} · {agentDraft.workflowTemplate}</span>
                  </div>
                </div>
                <AssemblySummary title="Skills" items={selectedBuilderSkills.map((asset) => asset.name)} empty="未绑定 Skill" />
                <AssemblySummary title="Tools" items={selectedBuilderTools.map((tool) => tool.name)} empty="未绑定 Tool" />
                <AssemblySummary
                  title="Knowledge"
                  items={selectedBuilderKnowledge.map((asset) => `${asset.name} · ${agentDraft.knowledgeModes[asset.id] === "query" ? "查询" : "RAG"}`)}
                  empty="未绑定知识库"
                />
                <div className="hub-assembly-memory">
                  <span>{agentDraft.useConversationMemory ? "会话记忆" : "不读会话记忆"}</span>
                  <span>{agentDraft.usePinnedMessages ? "Pin 注入" : "不注入 Pin"}</span>
                  <span>{agentDraft.writeBackPolicy}</span>
                </div>
              </aside>
            </div>
          </section>
          <div className="hub-builder-grid">
            <label>
              记忆写回策略
              <select value={agentDraft.writeBackPolicy} onChange={(event) => setAgentDraft((draft) => ({ ...draft, writeBackPolicy: event.target.value as AgentDraft["writeBackPolicy"] }))}>
                <option value="summary_only">只写摘要</option>
                <option value="confirmed_only">确认后写入</option>
                <option value="none">不写入</option>
              </select>
            </label>
            <label>
              输出格式
              <select value={agentDraft.defaultFormat} onChange={(event) => setAgentDraft((draft) => ({ ...draft, defaultFormat: event.target.value as AgentDraft["defaultFormat"] }))}>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
                <option value="artifact">Artifact</option>
              </select>
            </label>
            <div className="span-2 hub-builder-section compact hub-allowed-blocks">
              <strong>允许消息块</strong>
              <div className="hub-inline-check-group hub-block-chip-group">
                {agentAllowedBlockOptions.map((block) => (
                  <label key={block.value} className={agentDraft.allowedBlocks.includes(block.value) ? "hub-block-chip active" : "hub-block-chip"}>
                    <input
                      type="checkbox"
                      checked={agentDraft.allowedBlocks.includes(block.value)}
                      onChange={(event) => setAgentDraft((draft) => ({
                        ...draft,
                        allowedBlocks: toggleStringList(draft.allowedBlocks, block.value, event.target.checked)
                      }))}
                    />
                    <span>{block.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label>
              权限 Scopes
              <textarea value={agentDraft.permissionScopes} onChange={(event) => setAgentDraft((draft) => ({ ...draft, permissionScopes: event.target.value }))} placeholder="一行一条，例如：workspace:read" />
            </label>
            <label>
              需确认权限
              <textarea value={agentDraft.requireApprovalFor} onChange={(event) => setAgentDraft((draft) => ({ ...draft, requireApprovalFor: event.target.value }))} placeholder="一行一条，例如：workspace:write" />
            </label>
          </div>
          <div className="hub-builder-footer">
            <div className="hub-inline-check-group">
              <label className="hub-inline-check">
                <input
                  type="checkbox"
                  checked={agentDraft.useConversationMemory}
                  onChange={(event) => setAgentDraft((draft) => ({ ...draft, useConversationMemory: event.target.checked }))}
                />
                使用会话记忆
              </label>
              <label className="hub-inline-check">
                <input
                  type="checkbox"
                  checked={agentDraft.usePinnedMessages}
                  onChange={(event) => setAgentDraft((draft) => ({ ...draft, usePinnedMessages: event.target.checked }))}
                />
                注入 Pin 消息
              </label>
              <label className="hub-inline-check">
                <input
                  type="checkbox"
                  checked={agentDraft.usePersonalCrossConversationMemory}
                  onChange={(event) => setAgentDraft((draft) => ({ ...draft, usePersonalCrossConversationMemory: event.target.checked }))}
                />
                使用 private 跨对话记忆
              </label>
              <label className="hub-inline-check">
                <input
                  type="checkbox"
                  checked={agentDraft.visibility === "public"}
                  onChange={(event) => setAgentDraft((draft) => ({ ...draft, visibility: event.target.checked ? "public" : "private" }))}
                />
                保存后公开到 AgentHub
              </label>
            </div>
            <div className="hub-builder-grid span-2">
              <label>
                发布 License
                <input value={agentDraft.license} onChange={(event) => setAgentDraft((draft) => ({ ...draft, license: event.target.value }))} placeholder="可选，例如 MIT / CC BY-NC 4.0" />
              </label>
              <label>
                版本 Changelog
                <textarea value={agentDraft.changelog} onChange={(event) => setAgentDraft((draft) => ({ ...draft, changelog: event.target.value }))} placeholder="公开发布或保存新版本时的变更说明" />
              </label>
            </div>
            <button
              className="primary-button compact"
              type="button"
              disabled={agentSubmitDisabled}
              onClick={() => {
                if (editingAgentId) updateExistingAgent.mutate({ agentId: editingAgentId, payload: agentBuilderPayload });
                else createAgent.mutate(agentBuilderPayload);
              }}
            >
              <Bot size={15} />
              {editingAgentId ? "保存新版本" : "保存 Agent"}
            </button>
          </div>
        </section>
      ) : null}
      {kind === "agent" && selectedAgentId && hubMode !== "create" && hubMode !== "chat" ? (
        <section className="hub-inspector-panel">
          <div className="hub-builder-header">
            <div>
              <strong>{selectedAgent?.name ?? "Agent 配置"}</strong>
              <span>查看当前 AgentConfig，运行不会污染真实会话记忆的测试沙盒。</span>
            </div>
            <div className="hub-header-actions">
              <button
                className="secondary-button compact"
                type="button"
                disabled={!selectedAgentConfig.data || selectedAgent?.custom !== true}
                onClick={() => {
                  if (!selectedAgentConfig.data || !selectedAgentId) return;
                  setAgentDraft(agentConfigToDraft(selectedAgentConfig.data));
                  setEditingAgentId(selectedAgentId);
                  setHubMode("create");
                }}
              >
                <Settings size={15} />
                载入编辑
              </button>
              <button className="secondary-button compact" type="button" onClick={() => setSelectedAgentId(null)}>关闭</button>
            </div>
          </div>
          <div className="hub-inspector-grid">
            <article className="hub-inspector-card">
              <h3>配置摘要</h3>
              <p>版本：{selectedAgentConfig.data?.version ?? "未加载"}</p>
              <pre>{formatJson(selectedAgentConfig.data?.config)}</pre>
            </article>
            <article className="hub-inspector-card">
              <h3>测试沙盒</h3>
              <textarea value={agentTestMessage} onChange={(event) => setAgentTestMessage(event.target.value)} />
              <button
                className="primary-button compact"
                type="button"
                disabled={!selectedAgentId || !agentTestMessage.trim() || testAgent.isPending}
                onClick={() => {
                  if (selectedAgentId) testAgent.mutate({ agentId: selectedAgentId, message: agentTestMessage });
                }}
              >
                <Bot size={15} />
                运行测试
              </button>
              {testAgent.data ? (
                <AgentSandboxResultPanel result={testAgent.data} />
              ) : null}
              {testAgent.error ? <p className="form-error">{(testAgent.error as Error).message}</p> : null}
            </article>
          </div>
        </section>
      ) : null}
      {selectedHubDetail && hubMode !== "create" && hubMode !== "chat" ? (
        <HubDetailPanel detail={selectedHubDetail} onClose={() => setSelectedHubDetail(null)} />
      ) : null}
      {(kind === "skill" || kind === "knowledge") && hubMode === "create" ? (
        <section className="hub-builder-panel">
          <div className="hub-builder-header">
            <div>
              <strong>{editingHubAsset ? "编辑" : "创建"}{kind === "skill" ? " Skill" : "知识资产"}</strong>
              <span>{editingHubAsset ? "保存后会更新原资产并生成新版本。" : kind === "skill" ? "Skill 会作为 Agent 的专属协作规范注入。" : "知识资产保存摘要和路径，后续可作为检索入口。"}</span>
            </div>
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => {
                setEditingHubAsset(null);
                setAssetDraft(createEmptyAssetDraft());
                setHubMode("personal");
              }}
            >
              返回个人
            </button>
          </div>
          <div className="hub-builder-grid">
            <label>
              名称
              <input value={assetDraft.name} onChange={(event) => setAssetDraft((draft) => ({ ...draft, name: event.target.value }))} />
            </label>
            <label>
              摘要
              <input value={assetDraft.summary} onChange={(event) => setAssetDraft((draft) => ({ ...draft, summary: event.target.value }))} />
            </label>
            {kind === "skill" ? (
              <label>
                版本号
                <input
                  list="skill-release-version-options"
                  value={assetDraft.releaseVersion ?? ""}
                  onChange={(event) => setAssetDraft((draft) => ({ ...draft, releaseVersion: event.target.value }))}
                  placeholder="v0.0.1"
                />
                <datalist id="skill-release-version-options">
                  {skillVersionOptions(assetDraft.releaseVersion).map((version) => (
                    <option key={version} value={version} />
                  ))}
                </datalist>
                {!skillReleaseVersionValid ? <span className="field-hint error">格式应为 v0.0.1</span> : null}
              </label>
            ) : null}
            <label className="span-2">
              内容
              <textarea value={assetDraft.content} onChange={(event) => setAssetDraft((draft) => ({ ...draft, content: event.target.value }))} placeholder="写入 Markdown 内容" />
            </label>
            <div className="span-2">
              <HubAssetLogoPicker
                logo={assetDraft.logo ?? "sparkles"}
                color={assetDraft.logoColor ?? "#2563eb"}
                onLogoChange={(logo) => setAssetDraft((draft) => ({ ...draft, logo }))}
                onColorChange={(logoColor) => setAssetDraft((draft) => ({ ...draft, logoColor }))}
              />
            </div>
          </div>
          <div className="hub-builder-footer">
            <label className="hub-inline-check">
              <input
                type="checkbox"
                checked={assetDraft.visibility === "public"}
                onChange={(event) => setAssetDraft((draft) => ({ ...draft, visibility: event.target.checked ? "public" : "private" }))}
              />
              公开到 Hub
            </label>
            <button
              className="primary-button compact"
              type="button"
              disabled={assetSubmitDisabled}
              onClick={() => {
                const hubKind = kind === "skill" ? "skill" : "knowledge";
                if (editingHubAsset) updateHubAsset.mutate({ hubKind, assetId: editingHubAsset.id, payload: assetDraft });
                else createHubAsset.mutate({ hubKind, payload: assetDraft });
              }}
            >
              <Sparkles size={15} />
              {editingHubAsset ? "保存修改" : "保存资产"}
            </button>
          </div>
        </section>
      ) : null}
      {kind === "tool" && hubMode === "create" ? (
        <section className="hub-builder-panel">
          <div className="hub-builder-header">
            <div>
              <strong>创建 private 工具接口</strong>
              <span>支持映射官方 Runtime Tool，或创建受限纯函数工具。外部 API 与 MCP 服务由后端官方适配。</span>
            </div>
            <button className="secondary-button compact" type="button" onClick={() => setHubMode("personal")}>返回 private</button>
          </div>
          <div className="hub-builder-grid">
            <label>
              名称
              <input value={toolDraft.name} onChange={(event) => setToolDraft((draft) => ({ ...draft, name: event.target.value }))} />
            </label>
            <label>
              工具类型
              <select value={toolDraft.runtimeType} onChange={(event) => setToolDraft((draft) => {
                const runtimeType = event.target.value as ToolDraft["runtimeType"];
                return {
                  ...draft,
                  runtimeType,
                  category: runtimeType === "function" ? "function" : draft.category,
                  risk: runtimeType === "function" ? "read" : draft.risk,
                  permissionScopes: runtimeType === "function" ? "tool:function\nfunction:execute" : draft.permissionScopes
                };
              })}>
                <option value="builtin_alias">官方 Runtime Tool 别名</option>
                <option value="function">纯函数工具</option>
              </select>
            </label>
            {toolDraft.runtimeType === "builtin_alias" ? (
              <label>
                Runtime Tool
                <select value={toolDraft.runtimeToolId} onChange={(event) => setToolDraft((draft) => ({ ...draft, runtimeToolId: event.target.value as ToolDraft["runtimeToolId"] }))}>
                  <option value="read_file">读取文件 read_file</option>
                  <option value="write_file">写入文件 write_file</option>
                  <option value="search_files">搜索文件 search_files</option>
                  <option value="list_files">列出文件 list_files</option>
                  <option value="create_asset">创建资产 create_asset</option>
                  <option value="read_asset">读取资产 read_asset</option>
                  <option value="search_knowledge">知识库检索 search_knowledge</option>
                  <option value="api_fetch_json">官方 API 读取 api_fetch_json</option>
                  <option value="web_search">官方联网搜索 web_search</option>
                  <option value="diagram_draw">官方图表 MCP diagram_draw</option>
                </select>
              </label>
            ) : null}
            <label>
              风险等级
              <select value={toolDraft.risk} disabled={toolDraft.runtimeType === "function"} onChange={(event) => setToolDraft((draft) => ({ ...draft, risk: event.target.value as ToolDraft["risk"] }))}>
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="external">external</option>
              </select>
            </label>
            <label>
              分类
              <input value={toolDraft.category} onChange={(event) => setToolDraft((draft) => ({ ...draft, category: event.target.value }))} />
            </label>
            <label className="span-2">
              描述
              <textarea value={toolDraft.description} onChange={(event) => setToolDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="说明这个工具应该在什么场景下被 Agent 使用" />
            </label>
            {toolDraft.runtimeType === "function" ? (
              <>
                <label className="span-2">
                  函数源码
                  <textarea
                    value={toolDraft.functionSource}
                    onChange={(event) => setToolDraft((draft) => ({ ...draft, functionSource: event.target.value }))}
                    placeholder={"function(input) {\n  return { result: String(input.text ?? \"\").trim() };\n}"}
                  />
                </label>
                <label>
                  超时 ms
                  <input
                    type="number"
                    min={50}
                    max={2000}
                    value={toolDraft.functionTimeoutMs}
                    onChange={(event) => setToolDraft((draft) => ({ ...draft, functionTimeoutMs: Number(event.target.value) }))}
                  />
                </label>
                <label>
                  内存 MB
                  <input
                    type="number"
                    min={4}
                    max={32}
                    value={toolDraft.functionMemoryMb}
                    onChange={(event) => setToolDraft((draft) => ({ ...draft, functionMemoryMb: Number(event.target.value) }))}
                  />
                </label>
                <label className="span-2">
                  函数规范
                  <textarea
                    value={"签名：function(input: Record<string, unknown>) => JSONValue\n约束：同步执行；只允许 JSON 输入输出；禁止网络、文件系统、子进程、环境变量；异常会写入 ToolRun 审计日志。"}
                    readOnly
                  />
                </label>
              </>
            ) : null}
            <label className="span-2">
              权限 Scope
              <textarea value={toolDraft.permissionScopes} onChange={(event) => setToolDraft((draft) => ({ ...draft, permissionScopes: event.target.value }))} placeholder={"每行一个，例如：\nworkspace:read\ntool:read_file"} />
            </label>
          </div>
          <div className="hub-builder-footer">
            <span className="muted">保存后只进入当前账号 private ToolHub，可在自建 Agent 中绑定。</span>
            <button
              className="primary-button compact"
              type="button"
              disabled={toolSubmitDisabled}
              onClick={() => createPersonalTool.mutate(buildPersonalToolPayload(toolDraft))}
            >
              <Wrench size={15} />
              保存工具
            </button>
          </div>
          {createPersonalTool.error ? <p className="form-error">{(createPersonalTool.error as Error).message}</p> : null}
        </section>
      ) : null}
      {hubMode !== "create" && hubMode !== "chat" ? <div className="hub-card-grid">
        {kind === "agent"
          ? displayedAgents.map((agent) => (
              <article key={agent.id} className="hub-card agent-hub-card">
                {scope === "public" ? null : <div className="hub-card-scope">{scopeTag(agent.visibility)}</div>}
                <header className="hub-card-head">
                  <AvatarMark className="hub-card-icon agent-avatar" kind="agent" size="lg" value={agent.avatar} label={agent.name} />
                  <div className="agent-hub-card-title-block">
                    <h3 className="hub-card-title">{agent.name}</h3>
                    <span>{agent.type}{agent.provider ? ` · ${agent.provider}` : ""}</span>
                  </div>
                </header>
                <p className="hub-card-description">{agent.description}</p>
                <div className="tag-row hub-card-tags">
                  {agent.capabilities.slice(0, 3).map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                  {agent.custom ? <span>自建</span> : null}
                  {scope === "public" && agent.forkable === false ? <span>仅订阅</span> : null}
                  {agent.updateAvailable ? <span>有更新</span> : null}
                  {agent.installedVersion ? <span>已订阅 {agent.installedVersion}</span> : null}
                </div>
                <div className="hub-card-actions">
                  <HubIconButton title="详情" active={selectedHubDetail?.key === `agent:${agent.id}`} onClick={() => setSelectedHubDetail(buildAgentDetail(agent))}>
                    <Info size={16} />
                  </HubIconButton>
                  <HubIconButton title="聊天" disabled={openAgentChat.isPending} onClick={() => openAgentChat.mutate(agent.id)}>
                    <MessageCircle size={16} />
                  </HubIconButton>
                  <HubIconButton title="配置 / 测试" active={selectedAgentId === agent.id} onClick={() => setSelectedAgentId((current) => current === agent.id ? null : agent.id)}>
                    <Settings size={16} />
                  </HubIconButton>
                  <HubIconButton
                    title={scope === "public" ? "订阅到 private 空间" : "已在当前空间可用"}
                    active={Boolean(agent.installed)}
                    disabled={scope !== "public" || installAgent.isPending}
                    onClick={() => {
                      if (scope === "public") installAgent.mutate(agent.id);
                    }}
                  >
                    {agent.installed ? <CheckCircle2 size={16} /> : <PackagePlus size={16} />}
                  </HubIconButton>
                  {agent.installed && agent.updateAvailable ? (
                    <HubIconButton title="同步更新" disabled={syncAgentInstall.isPending} onClick={() => syncAgentInstall.mutate({ agentId: agent.id })}>
                      <RefreshCw size={16} />
                    </HubIconButton>
                  ) : null}
                  {scope === "personal" && agent.custom && agent.visibility !== "public" ? (
                    <HubIconButton
                      title="发布到 public"
                      disabled={publishAgent.isPending}
                      onClick={() => {
                        const confirmed = window.confirm("发布到 public AgentHub 后，其他用户可以订阅或复制此 Agent。若该 Agent 绑定写入、外部访问或高风险工具，本次确认也代表允许这些能力随 public 配置发布。确认发布？");
                        if (confirmed) publishAgent.mutate({ agentId: agent.id, confirmHighRiskPublish: true });
                      }}
                    >
                      <Rocket size={16} />
                    </HubIconButton>
                  ) : null}
                  {scope === "personal" && agent.custom ? (
                    <HubIconButton
                      title="删除 Agent"
                      disabled={deleteAgent.isPending}
                      onClick={() => {
                        if (window.confirm(`删除 Agent「${agent.name}」？此操作会移除当前订阅和绑定关系。`)) {
                          deleteAgent.mutate(agent.id);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </HubIconButton>
                  ) : null}
                  {scope === "public" && agent.forkable !== false ? (
                    <HubIconButton title="Fork 到 private Agent" disabled={forkAgent.isPending} onClick={() => forkAgent.mutate(agent.id)}>
                      <CopyPlus size={16} />
                    </HubIconButton>
                  ) : null}
                </div>
              </article>
            ))
          : null}
        {kind === "tool"
          ? tools.data?.tools.map((tool) => (
              <article key={tool.id} className="hub-card">
                <div className="hub-card-scope">{toolScopeTag(tool, scope)}</div>
                <header className="hub-card-head">
                  <span className="hub-card-icon tool-icon">
                    <Wrench size={22} />
                  </span>
                  <h3 className="hub-card-title">{tool.name}</h3>
                </header>
                <p className="hub-card-description">{tool.description}</p>
                <div className="tag-row hub-card-tags">
                  <span>{tool.category}</span>
                  <span>{tool.risk}</span>
                  {tool.runtimeToolId && tool.runtimeToolId !== tool.id ? <span>runtime: {tool.runtimeToolId}</span> : null}
                  {tool.executable ? <span>可执行</span> : <span>接口定义</span>}
                  {tool.updateAvailable ? <span>有更新</span> : null}
                  {tool.conflictStatus ? <span>冲突</span> : null}
                </div>
	                <div className="hub-card-actions">
	                  <HubIconButton title="详情" active={selectedHubDetail?.key === `tool:${tool.id}`} onClick={() => setSelectedHubDetail(buildToolDetail(tool))}>
	                    <Info size={16} />
	                  </HubIconButton>
	                  <HubIconButton
                    title={tool.subscribed ? "已订阅，点击取消" : "订阅到 private 空间"}
                    active={Boolean(tool.subscribed)}
                    disabled={subscribeHubAsset.isPending || unsubscribeHubAsset.isPending}
                    onClick={() => {
                      if (tool.subscribed) unsubscribeHubAsset.mutate({ hubKind: "tool", assetId: tool.id });
                      else subscribeHubAsset.mutate({ hubKind: "tool", assetId: tool.id });
                    }}
                  >
                    {tool.subscribed ? <CheckCircle2 size={16} /> : <PackagePlus size={16} />}
                  </HubIconButton>
                  {tool.subscribed && tool.updateAvailable ? (
                    <HubIconButton title="更新订阅" disabled={syncHubAsset.isPending} onClick={() => syncWithConfirmation("tool", tool.id, tool.conflictStatus)}>
                      <RefreshCw size={16} />
                    </HubIconButton>
                  ) : null}
                  {scope === "personal" && tool.ownerType === "user" && tool.ownerId === userId ? (
                    <HubIconButton
                      title="删除 Tool"
                      disabled={deleteTool.isPending}
                      onClick={() => {
                        if (window.confirm(`删除 Tool「${tool.name}」？`)) {
                          deleteTool.mutate(tool.id);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </HubIconButton>
                  ) : null}
                </div>
              </article>
            ))
          : null}
        {kind !== "agent" && kind !== "tool"
          ? hubAssets.data?.assets.map((asset) => {
              const hubKind = kind === "skill" ? "skill" : "knowledge";
              const ownHubAsset = isOwnHubAsset(asset, userId);
              const activelySubscribed = Boolean(asset.subscribed) && asset.hubStatus === "active";
              const showLifecycleActions = kind === "skill" ? hubMode === "public" || activelySubscribed : scope === "public" || activelySubscribed;
              const showLikeAction = kind === "skill" && (hubMode === "public" || (hubMode === "personal" && ownHubAsset && asset.visibility === "public"));
              return (
                <article key={asset.id} className="hub-card">
                  {hubMode === "public" ? null : <div className="hub-card-scope">{assetScopeTag(kind, hubMode, asset, userId)}</div>}
                  <header className="hub-card-head">
                    <HubAssetLogo logo={asset.logo} color={asset.logoColor} />
                    <h3 className="hub-card-title">{asset.name}</h3>
                  </header>
                  <p className="hub-card-description">{asset.summary}</p>
                  <div className="tag-row hub-card-tags">
                    <span>{asset.kind}</span>
                    {asset.updateAvailable ? <span>有更新</span> : null}
                    {asset.conflictStatus ? <span>冲突</span> : null}
                  </div>
                  <div className="hub-card-actions">
                    <HubIconButton title="详情" active={selectedHubDetail?.key === `${hubKind}:${asset.id}`} onClick={() => void openHubAssetDetail(hubKind, asset)}>
                      <Info size={16} />
                    </HubIconButton>
                    {canEditHubAsset(hubMode, asset, userId) ? (
                      <HubIconButton title="编辑" disabled={updateHubAsset.isPending} onClick={() => void editHubTextAsset(hubKind, asset)}>
                        <Pencil size={16} />
                      </HubIconButton>
                    ) : null}
                    {ownHubAsset && hubMode === "personal" ? (
                      <HubIconButton
                        title="删除"
                        disabled={deleteHubAsset.isPending}
                        onClick={() => {
                          if (window.confirm(`删除 private 资产「${asset.name}」？`)) {
                            deleteHubAsset.mutate({ hubKind, assetId: asset.id });
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </HubIconButton>
                    ) : null}
                    {!ownHubAsset && showLifecycleActions ? (
                      <HubIconButton
                        title={activelySubscribed ? "已订阅，点击取消" : "订阅到 private 空间"}
                        active={activelySubscribed}
                        disabled={subscribeHubAsset.isPending || unsubscribeHubAsset.isPending}
                        onClick={() => {
                          if (activelySubscribed) unsubscribeHubAsset.mutate({ hubKind, assetId: asset.id });
                          else subscribeHubAsset.mutate({ hubKind, assetId: asset.id });
                        }}
                      >
                        {activelySubscribed ? <CheckCircle2 size={16} /> : <PackagePlus size={16} />}
                      </HubIconButton>
                    ) : null}
                    {!ownHubAsset && activelySubscribed && asset.updateAvailable ? (
                      <HubIconButton title={asset.conflictStatus ? "查看冲突" : "更新订阅"} disabled={syncHubAsset.isPending} onClick={() => syncWithConfirmation(hubKind, asset.id, asset.conflictStatus)}>
                        <RefreshCw size={16} />
                      </HubIconButton>
                    ) : null}
                    {hubMode === "public" && !ownHubAsset ? (
                      <HubIconButton title="Fork 到 private 资产库" disabled={forkHubAsset.isPending} onClick={() => forkHubAsset.mutate({ hubKind, assetId: asset.id })}>
                        <GitFork size={16} />
                      </HubIconButton>
                    ) : null}
                    {showLikeAction ? (
                      <HubIconButton
                        title={asset.likedByMe ? "取消点赞" : "点赞"}
                        active={Boolean(asset.likedByMe)}
                        disabled={toggleHubAssetLike.isPending}
                        onClick={() => toggleHubAssetLike.mutate({ hubKind, assetId: asset.id, liked: Boolean(asset.likedByMe) })}
                      >
                        <Heart size={16} />
                        <span>{asset.likeCount ?? 0}</span>
                      </HubIconButton>
                    ) : null}
                  </div>
                </article>
              );
            })
          : null}
        {kind !== "agent" && kind !== "tool" && hubAssets.isSuccess && hubAssets.data.assets.length === 0 ? (
          <article className="hub-card empty-hub-card">
            {hubMode === "public" ? null : <div className="hub-card-scope">{emptyAssetScopeTag(kind, hubMode, scope)}</div>}
            <header className="hub-card-head">
              <span className="hub-card-icon hub-card-glyph">
                <PageIcon size={24} />
              </span>
              <h3 className="hub-card-title">暂无{hubModeLabel(kind, hubMode)}资产</h3>
            </header>
            <p className="hub-card-description">{page.title} 会展示真实创建、发布或被授权访问的资产；当前账号还没有可展示记录。</p>
            <div className="tag-row hub-card-tags">
              <span>empty</span>
            </div>
          </article>
        ) : null}
      </div> : null}
    </section>
  );
}

interface HubDetail {
  key: string;
  title: string;
  subtitle: string;
  summary?: string;
  content?: string;
  contentPending?: boolean;
  rows: Array<{ label: string; value: ReactNode }>;
}

function HubDetailPanel({ detail, onClose }: { detail: HubDetail; onClose: () => void }) {
  return (
    <section className="hub-detail-panel" aria-label={`${detail.title} 详情`}>
      <div className="hub-builder-header">
        <div>
          <strong>{detail.title}</strong>
          <span>{detail.subtitle}</span>
        </div>
        <button className="secondary-button compact" type="button" onClick={onClose}>关闭</button>
      </div>
      {detail.summary ? <p className="hub-detail-summary">{detail.summary}</p> : null}
      <div className="hub-detail-grid">
        {detail.rows.map((row) => (
          <div key={row.label} className="hub-detail-row">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      {detail.contentPending || detail.content !== undefined ? (
        <div className="hub-detail-content">
          <span>内容</span>
          <pre>{detail.contentPending ? "正在读取内容..." : detail.content}</pre>
        </div>
      ) : null}
    </section>
  );
}

function buildAgentDetail(agent: AgentDefinition): HubDetail {
  return {
    key: `agent:${agent.id}`,
    title: agent.name,
    subtitle: `Agent · ${agent.type} · ${agent.provider ?? "internal"}`,
    summary: agent.description,
    rows: [
      detailRow("类型", agent.type),
      detailRow("Provider", agent.provider ?? "internal"),
      detailRow("状态", agent.status),
      detailRow("可见性", visibilityLabel(agent.visibility)),
      detailRow("自建", agent.custom ? "是" : "否"),
      detailRow("已订阅", agent.installed ? "是" : "否"),
      detailRow("版本", versionLabel(agent.latestVersion ?? agent.installedVersion)),
      detailRow("更新状态", agent.updateAvailable ? "有更新" : "最新"),
      detailRow("能力标签", tagList(agent.capabilities))
    ]
  };
}

function buildToolDetail(tool: ToolDefinition): HubDetail {
  return {
    key: `tool:${tool.id}`,
    title: tool.name,
    subtitle: `Tool · ${tool.category} · ${tool.risk}`,
    summary: tool.description,
    rows: [
      detailRow("分类", tool.category),
      detailRow("风险", tool.risk),
      detailRow("来源", tool.source ?? "builtin"),
      detailRow("可见性", visibilityLabel(tool.visibility)),
      detailRow("所有者", ownerDisplay(undefined, tool.ownerType, tool.ownerId)),
      detailRow("可执行", tool.executable ? "是" : "否"),
      detailRow("已订阅", tool.subscribed ? "是" : "否"),
      detailRow("版本", versionLabel(tool.sourceVersion ?? tool.installedVersion)),
      detailRow("更新状态", tool.updateAvailable ? "有更新" : "最新"),
      detailRow("权限", tagList(tool.permissionScopes ?? []))
    ]
  };
}

function buildAssetDetail(hubKind: "skill" | "knowledge", asset: WorkspaceAsset): HubDetail {
  return {
    key: `${hubKind}:${asset.id}`,
    title: asset.name,
    subtitle: `${hubKind === "skill" ? "Skill" : "Knowledge"} · ${visibilityLabel(asset.visibility)} · ${asset.kind}`,
    summary: asset.summary,
    rows: [
      detailRow("可见性", visibilityLabel(asset.visibility)),
      detailRow("所有者", ownerDisplay(asset.ownerName, asset.ownerType, asset.ownerId)),
      detailRow("路径", asset.path),
      detailRow("大小", formatBytes(asset.size)),
      detailRow("创建时间", formatDateTime(asset.createdAt)),
      detailRow("更新时间", formatDateTime(asset.updatedAt ?? asset.createdAt)),
      detailRow("版本", assetVersionLabel(asset)),
      detailRow("订阅状态", asset.subscribed ? `已订阅${asset.hubStatus ? ` · ${asset.hubStatus}` : ""}` : "未订阅"),
      detailRow("更新状态", asset.updateAvailable ? "有更新" : "最新")
    ]
  };
}

function hubModeOptions(kind: keyof typeof config): Array<{ id: HubMode; label: string }> {
  const base: Array<{ id: HubMode; label: string }> = [
    { id: "personal", label: "个人" },
    { id: "public", label: "公共" },
    { id: "create", label: "创建" }
  ];
  return kind === "agent" ? [...base, { id: "chat", label: "对话" }] : base;
}

function hubModeLabel(kind: keyof typeof config, mode: HubMode) {
  return hubModeOptions(kind).find((item) => item.id === mode)?.label ?? "";
}

function scopeTag(value?: string) {
  const normalized = value === "public" ? "public" : "private";
  return <span className={`hub-scope-tag ${normalized}`}>{normalized}</span>;
}

function toolScopeTag(tool: ToolDefinition, scope: "personal" | "public") {
  if (scope !== "public") return scopeTag(tool.visibility);
  const type = toolRuntimeTypeView(tool);
  return <span className={`hub-scope-tag tool-type ${type.className}`}>{type.label}</span>;
}

function toolRuntimeTypeView(tool: ToolDefinition) {
  const runtimeType = (tool.runtimeType ?? "").toLowerCase();
  const category = tool.category.toLowerCase();
  if (runtimeType.includes("mcp") || category === "mcp") return { label: "MCP", className: "mcp" };
  if (runtimeType.includes("api") || category === "api") return { label: "API", className: "api" };
  if (runtimeType === "function" || category === "function") return { label: "Function", className: "function" };
  if (runtimeType === "builtin_alias") return { label: "Alias", className: "alias" };
  if (runtimeType === "builtin" || !runtimeType) return { label: "Builtin", className: "builtin" };
  return { label: runtimeType.replaceAll("_", " "), className: "custom" };
}

function assetScopeTag(kind: keyof typeof config, mode: HubMode, asset: WorkspaceAsset, userId?: string) {
  if (kind !== "skill") return scopeTag(asset.visibility);
  if (asset.subscribed && asset.hubStatus === "active" && !isOwnHubAsset(asset, userId)) return <span className="hub-scope-tag subscribed">Subscribed</span>;
  if (asset.forkedFromAssetId || asset.hubStatus === "forked") return <span className="hub-scope-tag fork">Fork</span>;
  if (asset.visibility === "public" && isOwnHubAsset(asset, userId)) return <span className="hub-scope-tag published">Public</span>;
  return <span className="hub-scope-tag private">Personal</span>;
}

function emptyAssetScopeTag(kind: keyof typeof config, mode: HubMode, scope: "personal" | "public") {
  if (kind !== "skill") return scopeTag(scope === "public" ? "public" : "private");
  if (mode === "subscribed") return <span className="hub-scope-tag subscribed">Subscribed</span>;
  if (mode === "fork") return <span className="hub-scope-tag fork">Fork</span>;
  if (mode === "published") return <span className="hub-scope-tag published">Public</span>;
  return <span className="hub-scope-tag private">Personal</span>;
}

function canEditHubAsset(mode: HubMode, asset: WorkspaceAsset, userId?: string) {
  if (mode !== "personal") return false;
  return isOwnHubAsset(asset, userId);
}

function isOwnHubAsset(asset: WorkspaceAsset, userId?: string) {
  return Boolean(userId && asset.ownerType === "user" && asset.ownerId === userId);
}

function detailRow(label: string, value: ReactNode) {
  return { label, value: emptyValue(value) };
}

function emptyValue(value: ReactNode): ReactNode {
  if (value === undefined || value === null || value === "") return "未设置";
  return value;
}

function tagList(values: string[]) {
  if (values.length === 0) return "无";
  return (
    <span className="hub-detail-tags">
      {values.map((value) => <i key={value}>{value}</i>)}
    </span>
  );
}

function visibilityLabel(value?: string) {
  if (value === "private") return "private";
  if (value === "public") return "public";
  if (value === "team") return "team";
  return value ?? "未设置";
}

function ownerLabel(ownerType?: string | null, ownerId?: string | null) {
  if (!ownerType && !ownerId) return "未设置";
  return `${ownerType ?? "unknown"}:${ownerId ?? "-"}`;
}

function ownerDisplay(ownerName?: string | null, ownerType?: string | null, ownerId?: string | null) {
  if (ownerName) return ownerName;
  return ownerLabel(ownerType, ownerId);
}

function versionLabel(value?: string | number | null) {
  return value === undefined || value === null || value === "" ? "未设置" : String(value);
}

function normalizeReleaseVersionInput(value?: string | null) {
  const text = value?.trim();
  if (!text) return undefined;
  const normalized = text.startsWith("v") ? text : `v${text}`;
  return /^v\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

function isValidReleaseVersion(value?: string | null) {
  return !!normalizeReleaseVersionInput(value);
}

function parseReleaseVersion(value?: string | null) {
  const normalized = normalizeReleaseVersionInput(value) ?? "v0.0.1";
  const match = normalized.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] as const : [0, 0, 1] as const;
}

function nextPatchReleaseVersion(value?: string | null) {
  const [major, minor, patch] = parseReleaseVersion(value);
  return `v${major}.${minor}.${patch + 1}`;
}

function skillVersionOptions(value?: string | null) {
  const current = normalizeReleaseVersionInput(value) ?? "v0.0.1";
  const [major, minor, patch] = parseReleaseVersion(value);
  return Array.from(new Set([current, `v${major}.${minor}.${patch + 1}`, `v${major}.${minor + 1}.0`, `v${major + 1}.0.0`]));
}

function assetVersionLabel(asset: WorkspaceAsset) {
  const detailReleaseVersion = typeof asset.details?.releaseVersion === "string" ? asset.details.releaseVersion : undefined;
  return versionLabel(asset.releaseVersion ?? detailReleaseVersion ?? asset.currentVersion ?? asset.latestVersion ?? asset.sourceVersion ?? asset.installedVersion);
}

function formatDateTime(value?: string) {
  if (!value) return "未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatBytes(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未设置";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function HubIconButton({ title, children, active = false, disabled = false, className, onClick }: { title: string; children: ReactNode; active?: boolean; disabled?: boolean; className?: string; onClick?: () => void }) {
  const classes = ["hub-card-action", active ? "active" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button className={classes} type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function AvatarOptionGrid({
  kind,
  label,
  hideLabel = false,
  options,
  value,
  onChange
}: {
  kind: "agent" | "user";
  label: string;
  hideLabel?: boolean;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="avatar-option-field">
      {hideLabel ? null : <span>{label}</span>}
      <div className="avatar-option-grid">
        {options.map((option, index) => (
          <button
            key={option}
            className={value === option ? "active" : ""}
            type="button"
            title={`选择头像 ${index + 1}`}
            onClick={() => onChange(option)}
          >
            <AvatarMark kind={kind} size="sm" value={option} label={`${label} ${index + 1}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

function AssemblySummary({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="hub-assembly-summary">
      <strong>{title}</strong>
      {items.length ? (
        <div>
          {items.slice(0, 5).map((item) => <span key={item}>{item}</span>)}
          {items.length > 5 ? <span>+{items.length - 5}</span> : null}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </div>
  );
}

function AgentSandboxResultPanel({ result }: { result: AgentSandboxTestView }) {
  const sandbox = result.sandbox;
  const model = asObject(sandbox.model);
  const runtime = asObject(sandbox.runtime);
  const contextSummary = asObject(sandbox.contextSummary);
  const executionPlan = asObject(sandbox.executionPlan);
  const memoryCandidate = asObject(sandbox.memoryCandidate);
  const toolCallLog = sandbox.toolCallLog.flatMap((item) => {
    const record = asObject(item);
    return Object.keys(record).length > 0 ? [record] : [];
  });
  const outputBlocks = sandbox.outputBlocks.flatMap((item) => {
    const record = asObject(item);
    return Object.keys(record).length > 0 ? [record] : [];
  });
  return (
    <div className="hub-test-result">
      <strong>沙盒结果</strong>
      <div className="hub-sandbox-summary">
        <span>模型：{stringValue(model.provider) ?? "runtime_default"} / {stringValue(model.model) ?? "runtime_default"}</span>
        <span>流程：{stringValue(runtime.workflowTemplate) ?? "tool_loop"}</span>
        <span>工具：{String(contextSummary.toolCount ?? toolCallLog.length)}</span>
        <span>知识：{String(contextSummary.knowledgeCount ?? sandbox.knowledge.length)}</span>
      </div>
      {sandbox.riskWarnings.length > 0 ? (
        <ul className="hub-risk-list">
          {sandbox.riskWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : <p>未发现高风险权限。</p>}
      <div className="hub-sandbox-section">
        <h4>执行计划</h4>
        <p>{stringValue(executionPlan.note) ?? "沙盒不会执行真实工具，也不会写入真实记忆。"}</p>
        <div className="hub-pill-row">
          <span>执行工具：{executionPlan.willExecuteTools === true ? "是" : "否"}</span>
          <span>写会话记忆：{executionPlan.willWriteConversationMemory === true ? "是" : "否"}</span>
              <span>写 private 记忆：{executionPlan.willWritePersonalMemory === true ? "是" : "否"}</span>
        </div>
      </div>
      <div className="hub-sandbox-section">
        <h4>工具 dry-run 记录</h4>
        {toolCallLog.length > 0 ? (
          <div className="hub-sandbox-list">
            {toolCallLog.map((item) => (
              <div key={`${String(item.step)}-${stringValue(item.toolId) ?? "tool"}`} className="hub-sandbox-row">
                <strong>{String(item.step ?? "-")}. {stringValue(item.name) ?? stringValue(item.toolId) ?? "Tool"}</strong>
                <span>{stringValue(item.category) ?? "custom"} · {stringValue(item.risk) ?? "unknown"} · {stringValue(item.status) ?? "not_executed"}</span>
              </div>
            ))}
          </div>
        ) : <p>当前 Agent 未绑定 Tool。</p>}
      </div>
      <div className="hub-sandbox-section">
        <h4>输出 Message Blocks</h4>
        <div className="hub-sandbox-list">
          {outputBlocks.map((block, index) => (
            <div key={`${String(block.type)}-${index}`} className="hub-sandbox-row">
              <strong>{stringValue(block.type) ?? "block"}</strong>
              <span>{stringValue(block.title) ?? stringValue(block.status) ?? previewText(block.content)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="hub-sandbox-section">
        <h4>记忆候选</h4>
        {Object.keys(memoryCandidate).length > 0 ? (
          <p>{stringValue(memoryCandidate.summary) ?? stringValue(memoryCandidate.note) ?? "本次测试生成了候选记忆，但不会自动写入。"}</p>
        ) : <p>本次测试未请求写入记忆，或当前写回策略为 none。</p>}
      </div>
      <details className="hub-sandbox-raw">
        <summary>查看原始 JSON</summary>
        <pre>{formatJson(sandbox)}</pre>
      </details>
    </div>
  );
}

type AgentBuilderChatRole = "assistant" | "user";

interface AgentBuilderChatMessage {
  id: string;
  role: AgentBuilderChatRole;
  content: string;
}

function AgentBuilderChatPanel({
  messages,
  value,
  checklist,
  generating,
  onChange,
  onSubmit,
  onClose,
  onReset,
  onSync
}: {
  messages: AgentBuilderChatMessage[];
  value: string;
  checklist: AgentBuilderChecklistItem[];
  generating: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onClose: () => void;
  onReset: () => void;
  onSync: () => void;
}) {
  return (
    <section className="agent-builder-chat-panel">
      <header className="agent-builder-chat-head">
        <div>
          <span className="agent-builder-chat-avatar"><Bot size={18} /></span>
          <div>
            <strong>Agent Builder</strong>
            <p>通过对话收集要素，逐步生成可保存的 Agent 草案。</p>
          </div>
        </div>
        <div className="agent-builder-chat-actions">
          <button type="button" title="同步到表单" onClick={onSync}>
            <Sparkles size={14} />
          </button>
          <button type="button" title="重新开始" onClick={onReset}>
            <RefreshCw size={14} />
          </button>
          <button type="button" title="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="agent-builder-chat-body">
        <div className="agent-builder-chat-thread">
          {messages.map((message) => (
            <div key={message.id} className={`agent-builder-chat-message ${message.role}`}>
              <span>{message.content}</span>
            </div>
          ))}
          {generating ? (
            <div className="agent-builder-chat-message assistant pending">
              <span>正在调用专门的 Agent Builder 模型...</span>
            </div>
          ) : null}
        </div>
        <aside className="agent-builder-chat-checklist">
          {checklist.map((item) => (
            <span key={item.id} className={item.status}>
              <CheckCircle2 size={13} />
              {item.label}
            </span>
          ))}
        </aside>
      </div>
      <form
        className="agent-builder-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="直接回答它的问题，也可以一次性说明目标、角色、工具、知识库、权限和命名偏好。"
        />
        <button type="submit" title="发送" disabled={!value.trim() || generating}>
          <Send size={16} />
        </button>
      </form>
    </section>
  );
}

function createInitialAgentBuilderChatMessages(): AgentBuilderChatMessage[] {
  return [
    createAgentBuilderChatMessage(
      "assistant",
      "我是 Agent Builder。先告诉我：你要创建的 Agent 主要解决什么问题？它服务个人、团队项目，还是某类固定任务？"
    )
  ];
}

function createAgentBuilderChatMessage(role: AgentBuilderChatRole, content: string): AgentBuilderChatMessage {
  return {
    id: `builder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content
  };
}

function createInitialAgentBuilderChecklist(): AgentBuilderChecklistItem[] {
  return [
    { id: "goal", label: "目标", status: "active" },
    { id: "role", label: "角色", status: "todo" },
    { id: "components", label: "组件", status: "todo" },
    { id: "permissions", label: "权限", status: "todo" },
    { id: "memory", label: "记忆", status: "todo" },
    { id: "naming", label: "命名", status: "todo" }
  ];
}

interface AgentDraft {
  name: string;
  description: string;
  avatar: string;
  type: "universal" | "product" | "ui" | "review";
  category: string;
  rolePrompt: string;
  goals: string;
  capabilities: string;
  behaviorRules: string;
  outputRules: string;
  refusalRules: string;
  skillAssetIds: string[];
  toolIds: string[];
  knowledgeAssetIds: string[];
  knowledgeModes: Record<string, "query" | "rag">;
  modelProvider: string;
  modelName: string;
  temperature: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  streaming: boolean;
  fallbackModel: string;
  workflowTemplate: "direct_answer" | "tool_loop" | "artifact_generation" | "review" | "human_approval";
  maxToolSteps: string;
  maxRunSeconds: string;
  orchestratorCallable: boolean;
  dispatchTags: string;
  assignmentDescription: string;
  acknowledgeOnAssignment: boolean;
  docRead: boolean;
  docWrite: boolean;
  codeRead: boolean;
  codeWrite: boolean;
  assetCreate: boolean;
  useConversationMemory: boolean;
  usePinnedMessages: boolean;
  usePersonalCrossConversationMemory: boolean;
  writeBackPolicy: "none" | "summary_only" | "confirmed_only";
  permissionScopes: string;
  requireApprovalFor: string;
  defaultFormat: "markdown" | "json" | "artifact";
  allowedBlocks: string[];
  visibility: "private" | "public";
  license: string;
  changelog: string;
}

const defaultAgentAllowedBlocks = ["markdown", "file", "image", "web_preview", "diff", "agent_status"];

const agentAllowedBlockOptions = [
  { value: "markdown", label: "Markdown" },
  { value: "code", label: "代码块" },
  { value: "file", label: "文件" },
  { value: "image", label: "图片" },
  { value: "web_preview", label: "网页预览" },
  { value: "diff", label: "Diff" },
  { value: "deploy_status", label: "部署状态" },
  { value: "agent_status", label: "Agent 状态" }
];

function createEmptyAgentDraft(): AgentDraft {
  return {
    name: "",
    description: "",
    avatar: "",
    type: "product",
    category: "custom",
    rolePrompt: "",
    goals: "",
    capabilities: "",
    behaviorRules: "",
    outputRules: "",
    refusalRules: "",
    skillAssetIds: [],
    toolIds: [],
    knowledgeAssetIds: [],
    knowledgeModes: {},
    modelProvider: "runtime_default",
    modelName: "runtime_default",
    temperature: "",
    reasoningEffort: "high",
    streaming: false,
    fallbackModel: "",
    workflowTemplate: "tool_loop",
    maxToolSteps: "4",
    maxRunSeconds: "180",
    orchestratorCallable: true,
    dispatchTags: "custom",
    assignmentDescription: "",
    acknowledgeOnAssignment: true,
    docRead: true,
    docWrite: true,
    codeRead: true,
    codeWrite: false,
    assetCreate: true,
    useConversationMemory: true,
    usePinnedMessages: true,
    usePersonalCrossConversationMemory: true,
    writeBackPolicy: "summary_only",
    permissionScopes: "message:read\nmessage:write\nworkspace:read",
    requireApprovalFor: "",
    defaultFormat: "markdown",
    allowedBlocks: defaultAgentAllowedBlocks,
    visibility: "private",
    license: "",
    changelog: ""
  };
}

function createEmptyAssetDraft(): HubTextAssetPayload {
  return {
    name: "",
    summary: "",
    content: "",
    visibility: "private",
    releaseVersion: "v0.0.1",
    logo: "sparkles",
    logoColor: "#2563eb"
  };
}

interface ToolDraft {
  name: string;
  description: string;
  runtimeType: NonNullable<CreatePersonalToolPayload["runtimeType"]>;
  runtimeToolId: ExecutableRuntimeToolId;
  category: string;
  risk: NonNullable<CreatePersonalToolPayload["risk"]>;
  permissionScopes: string;
  functionSource: string;
  functionTimeoutMs: number;
  functionMemoryMb: number;
  functionOutputBytes: number;
}

function createEmptyToolDraft(): ToolDraft {
  return {
    name: "",
    description: "",
    runtimeType: "builtin_alias",
    runtimeToolId: "read_file",
    category: "workspace",
    risk: "read",
    permissionScopes: "workspace:read",
    functionSource: "function(input) {\n  const text = String(input.text ?? \"\");\n  return { result: text.trim() };\n}",
    functionTimeoutMs: 800,
    functionMemoryMb: 16,
    functionOutputBytes: 32000
  };
}

function buildPersonalToolPayload(draft: ToolDraft): CreatePersonalToolPayload {
  if (draft.runtimeType === "function") {
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      runtimeType: "function",
      category: draft.category.trim() || "function",
      risk: "read",
      permissionScopes: splitLines(draft.permissionScopes),
      functionLanguage: "javascript",
      functionSource: draft.functionSource.trim(),
      functionTimeoutMs: draft.functionTimeoutMs,
      functionMemoryMb: draft.functionMemoryMb,
      functionOutputBytes: draft.functionOutputBytes,
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: { type: "object", additionalProperties: true }
    };
  }
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    runtimeType: "builtin_alias",
    runtimeToolId: draft.runtimeToolId,
    category: draft.category.trim() || "workspace",
    risk: draft.risk,
    permissionScopes: splitLines(draft.permissionScopes)
  };
}

function agentPayloadToDraft(payload: AgentBuilderPayload): AgentDraft {
  const base = createEmptyAgentDraft();
  return {
    ...base,
    name: payload.name ?? "",
    description: payload.description ?? "",
    avatar: payload.avatar ?? "",
    type: agentTypeValue(payload.type),
    category: payload.category ?? "custom",
    rolePrompt: payload.rolePrompt ?? "",
    goals: (payload.goals ?? []).join("\n"),
    capabilities: (payload.capabilities ?? []).join(", "),
    behaviorRules: (payload.behaviorRules ?? []).join("\n"),
    outputRules: (payload.outputRules ?? []).join("\n"),
    refusalRules: (payload.refusalRules ?? []).join("\n"),
    skillAssetIds: payload.skillAssetIds ?? [],
    toolIds: payload.toolIds ?? [],
    knowledgeAssetIds: payload.knowledgeAssetIds ?? [],
    knowledgeModes: Object.fromEntries((payload.knowledgeBindings ?? []).map((binding) => [binding.assetId, binding.retrievalMode])),
    modelProvider: payload.model?.provider ?? "runtime_default",
    modelName: payload.model?.model ?? "runtime_default",
    temperature: typeof payload.model?.temperature === "number" ? String(payload.model.temperature) : "",
    reasoningEffort: reasoningEffortValue(payload.model?.reasoningEffort),
    streaming: payload.model?.streaming === true,
    fallbackModel: payload.model?.fallbackModel ?? "",
    workflowTemplate: workflowTemplateValue(payload.runtime?.workflowTemplate),
    maxToolSteps: typeof payload.runtime?.maxToolSteps === "number" ? String(payload.runtime.maxToolSteps) : "4",
    maxRunSeconds: typeof payload.runtime?.maxRunSeconds === "number" ? String(payload.runtime.maxRunSeconds) : "180",
    orchestratorCallable: payload.collaboration?.orchestratorCallable ?? true,
    dispatchTags: (payload.collaboration?.dispatchTags ?? ["custom"]).join("\n"),
    assignmentDescription: payload.collaboration?.assignmentDescription ?? "",
    acknowledgeOnAssignment: payload.collaboration?.acknowledgeOnAssignment ?? true,
    docRead: payload.workspace?.docRead ?? true,
    docWrite: payload.workspace?.docWrite ?? true,
    codeRead: payload.workspace?.codeRead ?? true,
    codeWrite: payload.workspace?.codeWrite ?? false,
    assetCreate: payload.workspace?.assetCreate ?? true,
    useConversationMemory: payload.memory?.useConversationMemory ?? true,
    usePinnedMessages: payload.memory?.usePinnedMessages ?? true,
    usePersonalCrossConversationMemory: payload.memory?.usePersonalCrossConversationMemory ?? true,
    writeBackPolicy: writeBackPolicyValue(payload.memory?.writeBackPolicy),
    permissionScopes: (payload.permissions?.scopes ?? ["message:read", "message:write", "workspace:read"]).join("\n"),
    requireApprovalFor: (payload.permissions?.requireApprovalFor ?? []).join("\n"),
    defaultFormat: defaultFormatValue(payload.output?.defaultFormat),
    allowedBlocks: payload.output?.allowedBlocks?.length ? payload.output.allowedBlocks : defaultAgentAllowedBlocks,
    visibility: payload.visibility === "public" ? "public" : "private",
    license: payload.publishing?.license ?? "",
    changelog: payload.publishing?.changelog ?? ""
  };
}

function agentConfigToDraft(view: AgentConfigView): AgentDraft {
  const base = createEmptyAgentDraft();
  const config = asObject(view.config);
  const profile = asObject(config.profile);
  const prompt = asObject(config.prompt);
  const model = asObject(config.model);
  const runtime = asObject(config.runtime);
  const memory = asObject(config.memory);
  const collaboration = asObject(config.collaboration);
  const workspace = asObject(config.workspace);
  const permissions = asObject(config.permissions);
  const output = asObject(config.output);
  const publishing = asObject(config.publishing);
  return {
    ...base,
    name: stringValue(profile.name) ?? view.agent.name,
    description: stringValue(profile.description) ?? view.agent.description,
    avatar: stringValue(profile.avatar) ?? view.agent.avatar ?? "",
    type: agentTypeValue(profile.agentType ?? view.agent.type),
    category: stringValue(profile.category) ?? "custom",
    rolePrompt: stringValue(prompt.role) ?? "",
    goals: stringArrayValue(prompt.goals).join("\n"),
    capabilities: view.agent.capabilities.join(", "),
    behaviorRules: stringArrayValue(prompt.behaviorRules).join("\n"),
    outputRules: stringArrayValue(prompt.outputRules).join("\n"),
    refusalRules: stringArrayValue(prompt.refusalRules).join("\n"),
    skillAssetIds: bindingIds(config, "skills"),
    toolIds: bindingIds(config, "tools"),
    knowledgeAssetIds: bindingIds(config, "knowledge"),
    knowledgeModes: bindingModes(config),
    modelProvider: stringValue(model.provider) ?? "runtime_default",
    modelName: stringValue(model.model) ?? "runtime_default",
    temperature: numberString(model.temperature, ""),
    reasoningEffort: reasoningEffortValue(model.reasoningEffort),
    streaming: booleanValue(model.streaming, false),
    fallbackModel: stringValue(model.fallbackModel) ?? "",
    workflowTemplate: workflowTemplateValue(runtime.workflowTemplate),
    maxToolSteps: numberString(runtime.maxToolSteps, "4"),
    maxRunSeconds: numberString(runtime.maxRunSeconds, "180"),
    orchestratorCallable: booleanValue(collaboration.orchestratorCallable, true),
    dispatchTags: stringArrayValue(collaboration.dispatchTags).join("\n") || "custom",
    assignmentDescription: stringValue(collaboration.assignmentDescription) ?? "",
    acknowledgeOnAssignment: booleanValue(collaboration.acknowledgeOnAssignment, true),
    docRead: booleanValue(workspace.docRead, true),
    docWrite: booleanValue(workspace.docWrite, true),
    codeRead: booleanValue(workspace.codeRead, true),
    codeWrite: booleanValue(workspace.codeWrite, false),
    assetCreate: booleanValue(workspace.assetCreate, true),
    useConversationMemory: booleanValue(memory.useConversationMemory, true),
    usePinnedMessages: booleanValue(memory.usePinnedMessages, true),
    usePersonalCrossConversationMemory: booleanValue(memory.usePersonalCrossConversationMemory, true),
    writeBackPolicy: writeBackPolicyValue(memory.writeBackPolicy),
    permissionScopes: stringArrayValue(permissions.scopes).join("\n") || base.permissionScopes,
    requireApprovalFor: stringArrayValue(permissions.requireApprovalFor).join("\n"),
    defaultFormat: defaultFormatValue(output.defaultFormat),
    allowedBlocks: stringArrayValue(output.allowedBlocks).length > 0 ? stringArrayValue(output.allowedBlocks) : defaultAgentAllowedBlocks,
    visibility: view.agent.visibility === "public" ? "public" : "private",
    license: stringValue(publishing.license) ?? "",
    changelog: stringValue(publishing.changelog) ?? ""
  };
}

function buildAgentPayload(draft: AgentDraft): AgentBuilderPayload {
  const maxToolSteps = parseBoundedInt(draft.maxToolSteps, 4, 1, 12);
  const maxRunSeconds = parseBoundedInt(draft.maxRunSeconds, 180, 30, 1800);
  const temperature = parseOptionalBoundedFloat(draft.temperature, 0, 2);
  const fallbackModel = draft.fallbackModel.trim();
  const license = draft.license.trim();
  const changelog = draft.changelog.trim();
  const payload: AgentBuilderPayload = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    type: draft.type,
    category: draft.category.trim() || "custom",
    capabilities: splitList(draft.capabilities),
    visibility: draft.visibility,
    rolePrompt: draft.rolePrompt.trim() || draft.description.trim(),
    goals: splitLines(draft.goals),
    behaviorRules: splitLines(draft.behaviorRules),
    outputRules: splitLines(draft.outputRules),
    refusalRules: splitLines(draft.refusalRules),
    skillAssetIds: draft.skillAssetIds,
    toolIds: draft.toolIds,
    knowledgeAssetIds: draft.knowledgeAssetIds,
    knowledgeBindings: draft.knowledgeAssetIds.map((assetId) => ({
      assetId,
      retrievalMode: draft.knowledgeModes[assetId] ?? "rag"
    })),
    model: {
      provider: draft.modelProvider.trim() || "runtime_default",
      model: draft.modelName.trim() || "runtime_default",
      ...(temperature !== undefined ? { temperature } : {}),
      reasoningEffort: draft.reasoningEffort,
      streaming: draft.streaming,
      ...(fallbackModel ? { fallbackModel } : {})
    },
    runtime: {
      workflowTemplate: draft.workflowTemplate,
      maxToolSteps,
      maxRunSeconds
    },
    collaboration: {
      orchestratorCallable: draft.orchestratorCallable,
      dispatchTags: splitLines(draft.dispatchTags),
      assignmentDescription: draft.assignmentDescription.trim() || draft.description.trim(),
      acknowledgeOnAssignment: draft.acknowledgeOnAssignment
    },
    workspace: {
      docRead: draft.docRead,
      docWrite: draft.docWrite,
      codeRead: draft.codeRead,
      codeWrite: draft.codeWrite,
      assetCreate: draft.assetCreate
    },
    memory: {
      useConversationMemory: draft.useConversationMemory,
      usePinnedMessages: draft.usePinnedMessages,
      usePersonalCrossConversationMemory: draft.usePersonalCrossConversationMemory,
      writeBackPolicy: draft.writeBackPolicy
    },
    permissions: {
      scopes: splitLines(draft.permissionScopes),
      requireApprovalFor: splitLines(draft.requireApprovalFor)
    },
    output: {
      defaultFormat: draft.defaultFormat,
      allowedBlocks: draft.allowedBlocks.length > 0 ? draft.allowedBlocks : defaultAgentAllowedBlocks
    },
    publishing: {
      ...(license ? { license } : {}),
      ...(changelog ? { changelog } : {})
    }
  };
  const avatar = draft.avatar.trim();
  if (avatar) payload.avatar = avatar;
  return payload;
}

function splitList(value: string) {
  return Array.from(new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)));
}

function splitLines(value: string) {
  return Array.from(new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])));
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberString(value: unknown, fallback: string) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

function bindingIds(config: Record<string, unknown>, key: "skills" | "tools" | "knowledge") {
  const bindings = Array.isArray(config[key]) ? config[key] : [];
  return stringArrayValue(bindings.map((binding) => {
    const item = asObject(binding);
    if (key === "skills") return item.skillAssetId;
    if (key === "knowledge") return item.knowledgeAssetId;
    return item.toolId;
  }));
}

function bindingModes(config: Record<string, unknown>): Record<string, "query" | "rag"> {
  const bindings = Array.isArray(config.knowledge) ? config.knowledge : [];
  return Object.fromEntries(bindings.flatMap((binding) => {
    const item = asObject(binding);
    const assetId = stringValue(item.knowledgeAssetId);
    if (!assetId) return [];
    return [[assetId, item.retrievalMode === "query" ? "query" : "rag"] as const];
  }));
}

function reasoningEffortValue(value: unknown): AgentDraft["reasoningEffort"] {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "high";
}

function workflowTemplateValue(value: unknown): AgentDraft["workflowTemplate"] {
  return value === "direct_answer" || value === "tool_loop" || value === "artifact_generation" || value === "review" || value === "human_approval" ? value : "tool_loop";
}

function agentTypeValue(value: unknown): AgentDraft["type"] {
  return value === "product" || value === "ui" || value === "review" || value === "universal" ? value : "product";
}

function writeBackPolicyValue(value: unknown): AgentDraft["writeBackPolicy"] {
  return value === "none" || value === "summary_only" || value === "confirmed_only" ? value : "summary_only";
}

function defaultFormatValue(value: unknown): AgentDraft["defaultFormat"] {
  return value === "markdown" || value === "json" || value === "artifact" ? value : "markdown";
}

function parseBoundedInt(value: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalBoundedFloat(value: string, min: number, max: number) {
  if (!value.trim()) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(min, Math.min(max, parsed));
}

function formatJson(value: unknown) {
  if (value === undefined || value === null) return "暂无数据";
  return JSON.stringify(value, null, 2);
}

function previewText(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  if (value === undefined || value === null) return "无内容预览";
  return JSON.stringify(value).slice(0, 120);
}

function toggleListValue<K extends "skillAssetIds" | "toolIds" | "knowledgeAssetIds">(draft: AgentDraft, key: K, value: string, checked: boolean): AgentDraft {
  const next = new Set(draft[key]);
  if (checked) next.add(value);
  else next.delete(value);
  return { ...draft, [key]: [...next] };
}

function toggleStringList(values: string[], value: string, checked: boolean) {
  const next = new Set(values);
  if (checked) next.add(value);
  else next.delete(value);
  return [...next];
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
