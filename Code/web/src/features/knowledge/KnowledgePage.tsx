import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Database,
  FileText,
  GitFork,
  Heart,
  Info,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  api,
  type CreateKnowledgePayload,
  type IndexDocumentPayload,
  type KnowledgeAsset,
  type KnowledgeDocument,
  type KnowledgeSearchResult
} from "../../api/client";
import { HubAssetLogo, HubAssetLogoPicker, normalizeHubLogo, normalizeHubLogoColor } from "../../components/HubAssetLogo";
import { useAuthStore } from "../../store/auth-store";
import { useUiStore } from "../../store/ui-store";
import { formatBytes, readFileAsBase64, validateUploadFile } from "../../utils/upload";

const MAX_KNOWLEDGE_UPLOAD_BYTES = 5_000_000;
const PRESETS = [
  { key: "standard" as const, label: "标准（推荐）", description: "适合大多数文档，句子分割 + 512 token 块" },
  { key: "precise" as const, label: "精确", description: "较小块，更精准匹配，适合技术文档" },
  { key: "broad" as const, label: "宽泛", description: "较大块，保留更多上下文，适合长文章" }
];

interface KnowledgeDraft {
  name: string;
  description: string;
  preset: "standard" | "precise" | "broad";
  visibility: "private" | "public";
  logo: string;
  logoColor: string;
}

function createEmptyDraft(): KnowledgeDraft {
  return {
    name: "",
    description: "",
    preset: "standard",
    visibility: "private",
    logo: "book",
    logoColor: "#2563eb"
  };
}

export function KnowledgePage() {
  const [mode, setMode] = useState<"personal" | "public" | "create">("personal");
  const [filterText, setFilterText] = useState("");
  const [draft, setDraft] = useState<KnowledgeDraft>(createEmptyDraft);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [uploadingTo, setUploadingTo] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const user = useAuthStore((state) => state.user);
  const showToast = useUiStore((state) => state.showToast);
  const queryClient = useQueryClient();
  const filter = mode === "public" ? "public" : "mine";

  const list = useQuery({
    queryKey: ["knowledge-list", user?.id, filter],
    queryFn: () => api.knowledgeList(filter),
    enabled: Boolean(user)
  });
  const selectedDetail = useQuery({
    queryKey: ["knowledge", user?.id, selectedKnowledgeId],
    queryFn: () => api.knowledgeGet(selectedKnowledgeId!),
    enabled: Boolean(selectedKnowledgeId)
  });
  const documents = useQuery({
    queryKey: ["knowledge", user?.id, selectedKnowledgeId, "documents"],
    queryFn: () => api.knowledgeDocuments(selectedKnowledgeId!),
    enabled: Boolean(selectedKnowledgeId)
  });

  const invalidateKnowledge = async (id?: string | null) => {
    await queryClient.invalidateQueries({ queryKey: ["knowledge-list"] });
    if (id) {
      await queryClient.invalidateQueries({ queryKey: ["knowledge", user?.id, id] });
      await queryClient.invalidateQueries({ queryKey: ["knowledge", user?.id, id, "documents"] });
    }
    await queryClient.invalidateQueries({ queryKey: ["agent-builder-knowledge"] });
  };

  const createKnowledge = useMutation({
    mutationFn: (payload: CreateKnowledgePayload) => api.knowledgeCreate(payload),
    onSuccess: async () => {
      await invalidateKnowledge();
      showToast("知识库已创建", "success");
      closeEditor();
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const updateKnowledge = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<CreateKnowledgePayload> }) => api.knowledgeUpdate(id, payload),
    onSuccess: async (_result, variables) => {
      await invalidateKnowledge(variables.id);
      showToast("知识库已更新", "success");
      closeEditor();
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const deleteKnowledge = useMutation({
    mutationFn: (id: string) => api.knowledgeDelete(id),
    onSuccess: async (_result, id) => {
      if (selectedKnowledgeId === id) setSelectedKnowledgeId(null);
      await invalidateKnowledge();
      showToast("知识库已删除", "success");
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const subscription = useMutation({
    mutationFn: async ({ id, subscribed }: { id: string; subscribed: boolean }) => {
      if (subscribed) await api.knowledgeUnsubscribe(id);
      else await api.knowledgeSubscribe(id);
      return { id, subscribed };
    },
    onSuccess: async (_result, variables) => {
      await invalidateKnowledge(variables.id);
      showToast(variables.subscribed ? "已取消订阅" : "已订阅", "success");
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const forkKnowledge = useMutation({
    mutationFn: (id: string) => api.knowledgeFork(id),
    onSuccess: async () => {
      await invalidateKnowledge();
      showToast("已 Fork 到个人知识库", "success");
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const toggleLike = useMutation({
    mutationFn: ({ id, liked }: { id: string; liked: boolean }) =>
      liked ? api.unlikeHubAsset("knowledge", id) : api.likeHubAsset("knowledge", id),
    onSuccess: async (_result, variables) => invalidateKnowledge(variables.id),
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const uploadDocuments = useMutation({
    mutationFn: async ({ knowledgeId, files }: { knowledgeId: string; files: File[] }) => {
      for (const file of files) {
        validateUploadFile(file, file.name, MAX_KNOWLEDGE_UPLOAD_BYTES);
        const payload: IndexDocumentPayload = {
          name: file.name,
          contentBase64: await readFileAsBase64(file),
          mimeType: file.type || inferBrowserMimeType(file.name)
        };
        await api.knowledgeIndexDocument(knowledgeId, payload);
      }
      return { knowledgeId, count: files.length };
    },
    onSuccess: async ({ knowledgeId, count }) => {
      await invalidateKnowledge(knowledgeId);
      setUploadingTo(null);
      setSelectedFiles([]);
      showToast(`已保存并索引 ${count} 份文档`, "success");
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const deleteDocument = useMutation({
    mutationFn: ({ knowledgeId, documentId }: { knowledgeId: string; documentId: string }) =>
      api.knowledgeDeleteDocument(knowledgeId, documentId),
    onSuccess: async (_result, variables) => {
      await invalidateKnowledge(variables.knowledgeId);
      showToast("文档已删除", "success");
    },
    onError: (error: Error) => showToast(error.message, "warning")
  });
  const searchKnowledge = useMutation({
    mutationFn: ({ id, query }: { id: string; query: string }) => api.knowledgeSearch(id, query),
    onSuccess: ({ results }) => setSearchResults(results),
    onError: (error: Error) => showToast(error.message, "warning")
  });

  const items = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const all = list.data?.items ?? [];
    if (!needle) return all;
    return all.filter((item) => `${item.name} ${item.description} ${item.ownerName ?? ""}`.toLowerCase().includes(needle));
  }, [filterText, list.data?.items]);

  const closeEditor = () => {
    setMode("personal");
    setEditingKnowledgeId(null);
    setDraft(createEmptyDraft());
  };
  const openEditor = (knowledge?: KnowledgeAsset) => {
    setMode("create");
    setEditingKnowledgeId(knowledge?.id ?? null);
    setDraft(knowledge
      ? {
          name: knowledge.name,
          description: knowledge.description,
          preset: normalizePreset(knowledge.preset ?? knowledge.metadata?.preset),
          visibility: knowledge.visibility,
          logo: normalizeHubLogo(knowledge.logo),
          logoColor: normalizeHubLogoColor(knowledge.logoColor)
        }
      : createEmptyDraft());
  };
  const saveKnowledge = () => {
    const name = draft.name.trim();
    if (!name) {
      showToast("请输入知识库名称", "warning");
      return;
    }
    const payload: CreateKnowledgePayload = {
      name,
      description: draft.description.trim(),
      preset: draft.preset,
      visibility: draft.visibility,
      logo: draft.logo,
      logoColor: draft.logoColor
    };
    if (editingKnowledgeId) updateKnowledge.mutate({ id: editingKnowledgeId, payload });
    else createKnowledge.mutate(payload);
  };
  const selectKnowledge = (id: string) => {
    setSelectedKnowledgeId((current) => current === id ? null : id);
    setSearchText("");
    setSearchResults([]);
  };
  const setFiles = (files: File[]) => {
    const accepted = files.filter(isSupportedKnowledgeFile);
    if (accepted.length !== files.length) showToast("已忽略不支持的文件类型", "warning");
    setSelectedFiles(accepted);
  };
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDraggingFiles(false);
    setFiles(Array.from(event.dataTransfer.files));
  };

  if (mode === "create") {
    return (
      <section className="hub-layout">
        <section className="hub-builder-panel">
          <div className="hub-builder-header">
            <div>
              <strong>{editingKnowledgeId ? "编辑知识库" : "创建知识库"}</strong>
              <span>设置知识库用途和检索预设，创建后上传文件建立 RAG 索引。</span>
            </div>
            <button className="secondary-button compact" type="button" onClick={closeEditor}>返回</button>
          </div>
          <div className="hub-builder-grid">
            <label>
              名称
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：AgentHub 产品设计资料" maxLength={100} />
            </label>
            <label>
              可见性
              <select value={draft.visibility} onChange={(event) => setDraft((current) => ({ ...current, visibility: event.target.value as KnowledgeDraft["visibility"] }))}>
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label className="span-2">
              描述
              <textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="说明知识库包含什么，以及 Agent 应在什么任务中使用它" rows={3} />
            </label>
            <label>
              检索预设
              <select value={draft.preset} onChange={(event) => setDraft((current) => ({ ...current, preset: event.target.value as KnowledgeDraft["preset"] }))}>
                {PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
              </select>
            </label>
            <div className="span-2">
              <HubAssetLogoPicker
                logo={draft.logo}
                color={draft.logoColor}
                onLogoChange={(logo) => setDraft((current) => ({ ...current, logo }))}
                onColorChange={(logoColor) => setDraft((current) => ({ ...current, logoColor }))}
              />
            </div>
          </div>
          <div className="knowledge-preset-note">
            <Database size={17} />
            <span>{PRESETS.find((preset) => preset.key === draft.preset)?.description}</span>
          </div>
          <div className="hub-builder-footer">
            <span className="muted">知识库可绑定到自建 Agent，并通过 search_knowledge 工具检索。</span>
            <button className="primary-button compact" type="button" disabled={!draft.name.trim() || createKnowledge.isPending || updateKnowledge.isPending} onClick={saveKnowledge}>
              <Database size={15} />
              {editingKnowledgeId ? "保存修改" : "创建知识库"}
            </button>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="hub-layout">
      <div className="page-header inline">
        <div>
          <h1>KnowledgeHub</h1>
          <p>上传项目资料，建立可被 Agent 调用的 RAG 知识库。</p>
        </div>
        <div className="hub-header-actions">
          <label className="knowledge-filter">
            <Search size={15} />
            <input value={filterText} onChange={(event) => setFilterText(event.target.value)} placeholder="搜索知识库" />
          </label>
          <div className="segmented">
            <button className={mode === "personal" ? "active" : ""} type="button" onClick={() => setMode("personal")}>个人</button>
            <button className={mode === "public" ? "active" : ""} type="button" onClick={() => setMode("public")}>公共</button>
            <button type="button" onClick={() => openEditor()}>创建</button>
          </div>
        </div>
      </div>

      <div className="hub-card-grid">
        {items.map((knowledge) => {
          const preset = PRESETS.find((item) => item.key === normalizePreset(knowledge.preset ?? knowledge.metadata?.preset));
          const showLike = knowledge.visibility === "public";
          return (
            <article key={knowledge.id} className="hub-card">
              {mode === "personal" ? <div className="hub-card-scope">{personalScopeTag(knowledge)}</div> : null}
              <header className="hub-card-head">
                <HubAssetLogo logo={knowledge.logo ?? knowledge.metadata?.logo as string | undefined} color={knowledge.logoColor ?? knowledge.metadata?.logoColor as string | undefined} />
                <h3 className="hub-card-title">{knowledge.name}</h3>
              </header>
              <p className="hub-card-description">{knowledge.description || "尚未添加知识库说明"}</p>
              <div className="tag-row hub-card-tags">
                <span>{statusLabel(knowledge.indexStatus)}</span>
                <span>{knowledge.fileCount ?? 0} 文档</span>
                <span>{preset?.label ?? "标准"}</span>
                <span>{knowledge.ownerName ?? "未知所有者"}</span>
              </div>
              <div className="hub-card-actions">
                <HubIconButton title="详情与检索" active={selectedKnowledgeId === knowledge.id} onClick={() => selectKnowledge(knowledge.id)}>
                  <Info size={16} />
                </HubIconButton>
                {knowledge.isOwner ? (
                  <>
                    <HubIconButton title="编辑" onClick={() => openEditor(knowledge)}><Pencil size={16} /></HubIconButton>
                    <HubIconButton title="上传文档" onClick={() => { setUploadingTo(knowledge.id); setSelectedFiles([]); }}>
                      <Upload size={16} />
                    </HubIconButton>
                    <HubIconButton
                      title="删除"
                      disabled={deleteKnowledge.isPending}
                      onClick={() => {
                        if (window.confirm(`删除知识库「${knowledge.name}」及其全部索引？`)) deleteKnowledge.mutate(knowledge.id);
                      }}
                    >
                      <Trash2 size={16} />
                    </HubIconButton>
                  </>
                ) : (
                  <>
                    <HubIconButton
                      title={knowledge.isSubscribed ? "取消订阅" : "订阅"}
                      active={Boolean(knowledge.isSubscribed)}
                      disabled={subscription.isPending}
                      onClick={() => subscription.mutate({ id: knowledge.id, subscribed: Boolean(knowledge.isSubscribed) })}
                    >
                      {knowledge.isSubscribed ? <CheckCircle2 size={16} /> : <PackagePlus size={16} />}
                    </HubIconButton>
                    <HubIconButton title="Fork" disabled={forkKnowledge.isPending} onClick={() => forkKnowledge.mutate(knowledge.id)}>
                      <GitFork size={16} />
                    </HubIconButton>
                  </>
                )}
                {showLike ? (
                  <button
                    type="button"
                    className={`hub-card-action hub-card-like ${knowledge.likedByMe ? "active" : ""}`}
                    title={knowledge.likedByMe ? "取消点赞" : "点赞"}
                    disabled={toggleLike.isPending}
                    onClick={() => toggleLike.mutate({ id: knowledge.id, liked: knowledge.likedByMe })}
                  >
                    <Heart size={16} fill={knowledge.likedByMe ? "currentColor" : "none"} />
                    <span>{knowledge.likeCount}</span>
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {list.isSuccess && items.length === 0 ? (
          <article className="hub-card empty-hub-card">
            {mode === "personal" ? <div className="hub-card-scope"><span className="hub-scope-tag private">Personal</span></div> : null}
            <header className="hub-card-head">
              <span className="hub-card-icon hub-card-glyph"><Database size={24} /></span>
              <h3 className="hub-card-title">暂无知识库</h3>
            </header>
            <p className="hub-card-description">{filterText ? "没有匹配的知识库。" : "创建知识库并上传文件后，Agent 即可使用 RAG 检索。"}</p>
          </article>
        ) : null}
      </div>

      {selectedKnowledgeId && selectedDetail.data ? (
        <KnowledgeDetail
          knowledge={selectedDetail.data}
          documents={documents.data?.documents ?? []}
          searchText={searchText}
          searchResults={searchResults}
          searching={searchKnowledge.isPending}
          deletingDocument={deleteDocument.isPending}
          onClose={() => setSelectedKnowledgeId(null)}
          onSearchText={setSearchText}
          onSearch={() => {
            const query = searchText.trim();
            if (!query) return;
            searchKnowledge.mutate({ id: selectedKnowledgeId, query });
          }}
          onDeleteDocument={(documentId) => {
            if (window.confirm("删除该文档及其全部索引？")) {
              deleteDocument.mutate({ knowledgeId: selectedKnowledgeId, documentId });
            }
          }}
          onUpload={() => setUploadingTo(selectedKnowledgeId)}
        />
      ) : null}

      {uploadingTo ? (
        <section className="hub-detail-panel knowledge-upload-panel">
          <div className="hub-builder-header">
            <div>
              <strong>上传知识文件</strong>
              <span>原文件保存到个人 Hub 工作空间，正文提取后建立向量索引。</span>
            </div>
            <button className="icon-button" type="button" title="关闭" onClick={() => { setUploadingTo(null); setSelectedFiles([]); }}>
              <X size={16} />
            </button>
          </div>
          <div className="hub-builder-section">
            <label
              className={`file-upload-area ${draggingFiles ? "dragging" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDraggingFiles(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDraggingFiles(false)}
              onDrop={handleDrop}
            >
              <input
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.csv,.log,.html,.htm,.pdf,.docx"
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              />
              <Upload size={30} />
              <strong>选择或拖入文件</strong>
              <span>支持 TXT、Markdown、JSON、CSV、HTML、PDF、DOCX；单文件最大 5 MB</span>
            </label>
            {selectedFiles.length > 0 ? (
              <div className="selected-files-list">
                {selectedFiles.map((file) => (
                  <div key={`${file.name}:${file.size}`} className="knowledge-selected-file">
                    <FileText size={15} />
                    <span>{file.name}</span>
                    <small>{formatBytes(file.size)}</small>
                    <button type="button" title="移除" onClick={() => setSelectedFiles((current) => current.filter((item) => item !== file))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="hub-builder-footer">
            <span className="muted">上传完成后即可在详情中直接测试检索效果。</span>
            <button
              className="primary-button compact"
              type="button"
              disabled={selectedFiles.length === 0 || uploadDocuments.isPending}
              onClick={() => uploadDocuments.mutate({ knowledgeId: uploadingTo, files: selectedFiles })}
            >
              <Upload size={15} />
              {uploadDocuments.isPending ? "提取并索引中..." : `上传 ${selectedFiles.length} 个文件`}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function KnowledgeDetail(props: {
  knowledge: KnowledgeAsset;
  documents: KnowledgeDocument[];
  searchText: string;
  searchResults: KnowledgeSearchResult[];
  searching: boolean;
  deletingDocument: boolean;
  onClose: () => void;
  onSearchText: (value: string) => void;
  onSearch: () => void;
  onDeleteDocument: (documentId: string) => void;
  onUpload: () => void;
}) {
  return (
    <section className="hub-detail-panel knowledge-detail-panel">
      <div className="hub-builder-header">
        <div>
          <strong>{props.knowledge.name}</strong>
          <span>{props.knowledge.description || "知识库详情与检索测试"}</span>
        </div>
        <button className="icon-button" type="button" title="关闭" onClick={props.onClose}><X size={16} /></button>
      </div>
      <div className="knowledge-detail-grid">
        <div className="knowledge-document-section">
          <div className="knowledge-section-heading">
            <div>
              <strong>知识文件</strong>
              <span>{props.documents.length} 份已索引文档</span>
            </div>
            {props.knowledge.isOwner ? (
              <button className="secondary-button compact" type="button" onClick={props.onUpload}><Upload size={14} />上传</button>
            ) : null}
          </div>
          <div className="knowledge-doc-list">
            {props.documents.map((document) => (
              <div key={document.id} className="knowledge-doc-item">
                <FileText size={17} />
                <div className="knowledge-doc-info">
                  <div className="knowledge-doc-title">{document.title}</div>
                  <div className="knowledge-doc-path">{document.path}</div>
                </div>
                {props.knowledge.isOwner ? (
                  <button className="icon-btn" type="button" title="删除文档" disabled={props.deletingDocument} onClick={() => props.onDeleteDocument(document.id)}>
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>
            ))}
            {props.documents.length === 0 ? <div className="knowledge-empty-state">尚未上传知识文件</div> : null}
          </div>
        </div>
        <div className="knowledge-search-section">
          <div className="knowledge-section-heading">
            <div>
              <strong>RAG 检索测试</strong>
              <span>使用与 Agent 相同的 search_knowledge 检索链路</span>
            </div>
          </div>
          <div className="knowledge-search-box">
            <Search size={16} />
            <input
              value={props.searchText}
              onChange={(event) => props.onSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") props.onSearch();
              }}
              placeholder="输入要从知识库中查找的问题"
            />
            <button className="primary-button compact" type="button" disabled={!props.searchText.trim() || props.searching} onClick={props.onSearch}>
              {props.searching ? "检索中" : "检索"}
            </button>
          </div>
          <div className="knowledge-search-results">
            {props.searchResults.map((result) => (
              <article key={result.chunkId} className="knowledge-search-result">
                <header>
                  <strong>{result.metadata.title}</strong>
                  <span>{Math.round(result.score * 100)}%</span>
                </header>
                <p>{result.content}</p>
                <small>{result.metadata.path} · Chunk {result.metadata.chunkIndex + 1}</small>
              </article>
            ))}
            {!props.searching && props.searchResults.length === 0 ? <div className="knowledge-empty-state">输入问题后查看向量检索片段</div> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function HubIconButton(props: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`hub-card-action ${props.active ? "active" : ""}`}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function personalScopeTag(knowledge: KnowledgeAsset) {
  const kind = knowledge.personalKind ?? (knowledge.isSubscribed ? "Subscribed" : knowledge.forkedFromId ? "Fork" : knowledge.visibility === "public" ? "Public" : "Personal");
  const className = kind === "Subscribed" ? "subscribed" : kind === "Fork" ? "fork" : kind === "Public" ? "published" : "private";
  return <span className={`hub-scope-tag ${className}`}>{kind}</span>;
}

function statusLabel(status: string) {
  if (status === "indexed") return "已索引";
  if (status === "indexing") return "索引中";
  if (status === "error") return "索引失败";
  return "待索引";
}

function normalizePreset(value: unknown): KnowledgeDraft["preset"] {
  return value === "precise" || value === "broad" ? value : "standard";
}

function isSupportedKnowledgeFile(file: File) {
  return /\.(txt|md|markdown|json|csv|log|html|htm|pdf|docx)$/i.test(file.name);
}

function inferBrowserMimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "text/plain";
}
