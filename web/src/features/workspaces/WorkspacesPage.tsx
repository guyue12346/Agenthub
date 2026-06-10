import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceAsset } from "@agenthub/shared";
import type { ReactNode } from "react";
import type { ComponentType } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  Boxes,
  Brain,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Layers3,
  MessageSquare,
  GitBranch,
  GitCommit,
  GitPullRequest,
  History,
  Rocket,
  Pencil,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Save,
  Upload,
  Sparkles,
  type LucideProps,
  Users,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { AssetRenderPreview } from "../../components/AssetRenderEngine";
import { ExcalidrawEditor, isExcalidrawFile } from "../../components/ExcalidrawRenderer";
import {
  api,
  type WorkspaceAssetVersionContent,
  type WorkspaceCodeContributor,
  type WorkspaceCodeProposalView,
  type WorkspaceFileLockView,
  type WorkspaceFileView,
  type WorkspaceGitView,
  type WorkspaceTreeNode
} from "../../api/client";
import { queryKeys } from "../../api/query-keys";
import { useAuthStore } from "../../store/auth-store";
import { useRealtimeStore } from "../../store/realtime-store";
import { useUiStore } from "../../store/ui-store";
import { formatBytes, uploadFileInChunks, validateUploadFile, type UploadProgress } from "../../utils/upload";

type WorkspaceUploadState = UploadProgress & {
  id: string;
  name: string;
  phase: "reading" | "uploading";
};

type WorkspaceGitPanelKey = "changes" | "proposals" | "commits";
type WorkspaceGitDialog =
  | { kind: "commit" }
  | { kind: "review" }
  | { kind: "reject"; proposalId: string };

export function WorkspacesPage() {
  const { workspaceId } = useParams();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileLockRef = useRef<WorkspaceFileLockView | null>(null);
  const remoteEditNoticeRef = useRef<string>("");
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [fileMode, setFileMode] = useState<"preview" | "edit" | "history">("preview");
  const [fileLock, setFileLock] = useState<WorkspaceFileLockView | null>(null);
  const [fileSearch, setFileSearch] = useState("");
  const [leftView, setLeftView] = useState<"files" | "assets" | "git">("files");
  const [gitPanel, setGitPanel] = useState<WorkspaceGitPanelKey>("changes");
  const [selectedGitCommitHash, setSelectedGitCommitHash] = useState<string | null>(null);
  const [selectedGitFilePath, setSelectedGitFilePath] = useState<string | null>(null);
  const [gitDialog, setGitDialog] = useState<WorkspaceGitDialog | null>(null);
  const [gitDialogValue, setGitDialogValue] = useState("");
  const [gitDialogSummary, setGitDialogSummary] = useState("");
  const [uploadStatus, setUploadStatus] = useState<WorkspaceUploadState | null>(null);
  const currentUser = useAuthStore((state) => state.user);
  const showToast = useUiStore((state) => state.showToast);
  const setActiveWorkspaceId = useRealtimeStore((state) => state.setActiveWorkspaceId);
  const userId = currentUser?.id ?? "";

  const workspaces = useQuery({
    queryKey: userId ? queryKeys.workspaces(userId) : ["workspaces"],
    queryFn: api.workspaces,
    enabled: Boolean(currentUser)
  });
  const workspaceCards = workspaces.data?.workspaces ?? [];
  const active = useMemo(
    () => workspaceCards.find((workspace) => workspace.id === workspaceId),
    [workspaceCards, workspaceId]
  );
  const tree = useQuery({
    queryKey: userId && active ? queryKeys.workspaceTree(userId, active.id) : ["workspace-tree", active?.id],
    queryFn: () => api.workspaceTree(active!.id),
    enabled: Boolean(active && currentUser)
  });
  const assets = useQuery({
    queryKey: userId && active ? queryKeys.assets(userId, active.id) : ["assets", active?.id],
    queryFn: () => api.assets(active!.id),
    enabled: Boolean(active && currentUser)
  });
  const gitView = useQuery({
    queryKey: userId && active ? queryKeys.workspaceGit(userId, active.id) : ["workspace-git", active?.id],
    queryFn: () => api.workspaceGit(active!.id),
    enabled: Boolean(active && currentUser)
  });
  const gitFiles = gitView.data?.view.git.files ?? [];
  const effectiveSelectedGitFilePath = selectedGitFilePath && gitFiles.some((fileItem) => fileItem.path === selectedGitFilePath)
    ? selectedGitFilePath
    : gitFiles[0]?.path ?? null;
  const file = useQuery({
    queryKey: userId && active && selectedPath ? queryKeys.workspaceFile(userId, active.id, selectedPath) : ["workspace-file", active?.id, selectedPath],
    queryFn: () => api.workspaceFile(active!.id, selectedPath),
    enabled: Boolean(active && selectedPath)
  });
  const gitFileDiff = useQuery({
    queryKey: userId && active && effectiveSelectedGitFilePath ? queryKeys.workspaceGitDiff(userId, active.id, effectiveSelectedGitFilePath) : ["workspace-git-diff", active?.id, effectiveSelectedGitFilePath],
    queryFn: () => api.workspaceGitDiff(active!.id, effectiveSelectedGitFilePath!),
    enabled: Boolean(active && effectiveSelectedGitFilePath && leftView === "git" && gitPanel === "changes")
  });
  const filteredTree = useMemo(() => filterTree(tree.data?.tree ?? [], fileSearch), [tree.data?.tree, fileSearch]);
  const filteredAssets = useMemo(() => filterAssets(assets.data?.assets ?? [], fileSearch), [assets.data?.assets, fileSearch]);
  const assetGroups = useMemo(() => groupWorkspaceAssets(filteredAssets), [filteredAssets]);
  const filteredOtherProposals = useMemo(
    () => filterProposals(gitView.data?.view.otherMemberProposals ?? [], fileSearch),
    [gitView.data?.view.otherMemberProposals, fileSearch]
  );
  const assetByPath = useMemo(() => {
    const map = new Map<string, WorkspaceAsset>();
    for (const asset of assets.data?.assets ?? []) map.set(asset.path, asset);
    return map;
  }, [assets.data?.assets]);
  const selectedAsset = selectedPath ? assetByPath.get(selectedPath) : undefined;
  const draftFileName = lastPathSegment(newFilePath.trim()) ?? "";
  const draftDirectory = parentDirectory(newFilePath.trim());
  const selectedFileName = file.data?.file?.name ?? lastPathSegment(selectedPath || newFilePath.trim()) ?? "选择文件";
  const draftIsExcalidraw = isExcalidrawFile({
    name: draftFileName || selectedFileName,
    mimeType: file.data?.file?.mimeType
  });
  const pathError = validateWorkspaceFileName(draftFileName) || validateWorkspacePath(newFilePath);
  const selectedFileChanged = Boolean(newFilePath.trim()) && (!file.data?.file || newFilePath.trim() !== file.data.file.path || newFileContent !== file.data.file.content);
  const selectedFileIsBinary = Boolean(file.data?.file?.binary);
  const canPreviewFile = Boolean(selectedPath);
  const selectedLock = file.data?.file?.lock ?? null;
  const fileLockedByOther = Boolean(selectedLock && !selectedLock.ownedByMe);
  const canEditFile = !selectedFileIsBinary && !fileLockedByOther;
  const canShowHistory = Boolean(selectedAsset?.id ?? file.data?.file?.assetId);

  const refreshActive = async () => {
    if (!userId) return;
    if (!active) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(userId) });
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(userId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(userId, active.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.assets(userId, active.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceGit(userId, active.id) })
    ]);
  };

  const releaseCurrentFileLock = async (pathOverride?: string) => {
    const lock = fileLockRef.current;
    if (!active || !lock?.token) {
      setFileLock(null);
      fileLockRef.current = null;
      return;
    }
    const releasePath = pathOverride ?? lock.path;
    fileLockRef.current = null;
    setFileLock(null);
    await api.releaseWorkspaceFileLock(active.id, releasePath, lock.token).catch(() => undefined);
  };

  const acquireEditLock = async (path: string) => {
    if (!active) throw new Error("工作空间不存在");
    const result = await api.acquireWorkspaceFileLock(active.id, path);
    setFileLock(result.lock);
    fileLockRef.current = result.lock;
    return result.lock;
  };

  const enterEditMode = async () => {
    if (!canEditFile) return;
    const pathToLock = selectedPath || newFilePath.trim();
    if (!pathToLock) {
      setFileMode("edit");
      return;
    }
    try {
      await acquireEditLock(pathToLock);
      setFileMode("edit");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "获取文件编辑锁失败", "warning");
    }
  };

  const leaveEditMode = () => {
    void releaseCurrentFileLock();
    setFileMode("preview");
  };

  const enterHistoryMode = () => {
    void releaseCurrentFileLock();
    setFileMode("history");
  };

  const uploadAsset = useMutation({
    mutationFn: async (input: { uploadId: string; file: File; controller: AbortController }) => {
      validateUploadFile(input.file, "文件");
      setUploadStatus({
        id: input.uploadId,
        name: input.file.name,
        phase: "uploading",
        loaded: 0,
        total: input.file.size,
        percent: 0
      });
      return uploadFileInChunks(input.file, {
        signal: input.controller.signal,
        onProgress: (progress) => {
          setUploadStatus((current) => (current?.id === input.uploadId ? { ...current, ...progress } : current));
        },
        begin: (file) => api.beginWorkspaceUpload(active!.id, file).then((result) => result.upload),
        uploadChunk: (session, chunk) => api.uploadWorkspaceChunk(session.workspaceId, session.uploadId, chunk, { signal: input.controller.signal }),
        complete: (session) => api.completeWorkspaceUpload(session.workspaceId, session.uploadId),
        cancel: (session) => api.cancelWorkspaceUpload(session.workspaceId, session.uploadId)
      });
    },
    onSuccess: async () => {
      await refreshActive();
      showToast("文件已上传到工作空间", "success");
    },
    onError: (error) => {
      const aborted = error instanceof Error && error.name === "AbortError";
      showToast(aborted ? "文件上传已取消" : error instanceof Error ? error.message : "上传失败", aborted ? "info" : "warning");
    },
    onSettled: (_data, _error, input) => {
      if (uploadAbortRef.current === input.controller) uploadAbortRef.current = null;
      setUploadStatus((current) => (current?.id === input.uploadId ? null : current));
    }
  });

  const writeFile = useMutation({
    mutationFn: async () => {
      const fileName = lastPathSegment(newFilePath.trim()) ?? "";
      const error = validateWorkspaceFileName(fileName) || validateWorkspacePath(newFilePath);
      if (error) throw new Error(error);
      const lockPath = selectedPath || newFilePath.trim();
      const lock = fileLockRef.current?.token && fileLockRef.current.path === lockPath
        ? fileLockRef.current
        : await acquireEditLock(lockPath);
      return api.writeWorkspaceFile(active!.id, newFilePath.trim(), newFileContent, {
        ...(selectedPath ? { originalPath: selectedPath } : {}),
        ...(lock.token ? { lockToken: lock.token } : {}),
        expectedVersion: file.data?.file?.latestVersion ?? 0
      });
    },
    onSuccess: async ({ file: saved }) => {
      await releaseCurrentFileLock(saved.path);
      setSelectedPath(saved.path);
      setNewFilePath(saved.path);
      setFileMode("preview");
      await refreshActive();
      if (userId && active) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile(userId, active.id, saved.path) });
      }
      showToast("文件已保存，变更已写入长期记忆", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "写入失败", "warning")
  });

  const commitGit = useMutation({
    mutationFn: (message: string) => api.commitWorkspaceGit(active!.id, message),
    onSuccess: async () => {
      closeGitDialog();
      await refreshActive();
      showToast("已提交到 main", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "提交失败", "warning")
  });

  const createGitProposal = useMutation({
    mutationFn: (payload: { title?: string; summary?: string }) => api.createWorkspaceGitProposal(active!.id, payload),
    onSuccess: async () => {
      closeGitDialog();
      await refreshActive();
      if (userId && active) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.conversationRoot(userId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.messages(userId, active.conversationId) })
        ]);
      }
      showToast("已提交审阅，等待群聊成员处理", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "生成审阅提议失败", "warning")
  });

  const approveGitProposal = useMutation({
    mutationFn: (proposalId: string) => api.approveWorkspaceGitProposal(active!.id, proposalId),
    onSuccess: async () => {
      await refreshActive();
      showToast("审阅已通过，并已提交 main", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "通过审阅失败", "warning")
  });

  const rejectGitProposal = useMutation({
    mutationFn: (input: { proposalId: string; reason: string }) => api.rejectWorkspaceGitProposal(active!.id, input.proposalId, input.reason),
    onSuccess: async () => {
      closeGitDialog();
      await refreshActive();
      showToast("已退回修改提议", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "退回失败", "warning")
  });

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  useEffect(() => {
    fileLockRef.current = fileLock;
  }, [fileLock]);

  useEffect(() => {
    if (fileMode !== "edit" || !active || !fileLock?.token) return undefined;
    const interval = window.setInterval(() => {
      void api.acquireWorkspaceFileLock(active.id, fileLock.path)
        .then((result) => {
          setFileLock(result.lock);
          fileLockRef.current = result.lock;
        })
        .catch((error) => {
          setFileMode("preview");
          setFileLock(null);
          fileLockRef.current = null;
          showToast(error instanceof Error ? error.message : "文件编辑锁已失效", "warning");
        });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [active, fileLock?.path, fileLock?.token, fileMode, showToast]);

  useEffect(() => () => {
    const lock = fileLockRef.current;
    if (active?.id && lock?.token) void api.releaseWorkspaceFileLock(active.id, lock.path, lock.token).catch(() => undefined);
  }, [active?.id]);

  useEffect(() => {
    setActiveWorkspaceId(active?.id ?? null);
    return () => setActiveWorkspaceId(null);
  }, [active?.id, setActiveWorkspaceId]);

  useEffect(() => {
    const commits = gitView.data?.view.git.recentCommits ?? [];
    if (!selectedGitCommitHash || commits.some((commit) => commit.hash === selectedGitCommitHash)) return;
    setSelectedGitCommitHash(commits[0]?.hash ?? null);
  }, [gitView.data?.view.git.recentCommits, selectedGitCommitHash]);

  useEffect(() => {
    const files = gitView.data?.view.git.files ?? [];
    if (!selectedGitFilePath || files.some((file) => file.path === selectedGitFilePath)) {
      if (!selectedGitFilePath && files[0]) setSelectedGitFilePath(files[0].path);
      return;
    }
    setSelectedGitFilePath(files[0]?.path ?? null);
  }, [gitView.data?.view.git.files, selectedGitFilePath]);

  useEffect(() => {
    const currentFile = file.data?.file;
    if (!currentFile) return;
    if (fileMode === "edit") {
      if (currentFile.path === selectedPath && currentFile.content !== newFileContent) {
        const noticeKey = `${currentFile.path}:${currentFile.latestVersion}:${currentFile.content.length}`;
        if (remoteEditNoticeRef.current !== noticeKey) {
          remoteEditNoticeRef.current = noticeKey;
          showToast("当前文件已有远端更新。你的编辑未被覆盖，请保存前先查看最新版本或差异。", "warning");
        }
      }
      return;
    }
    remoteEditNoticeRef.current = "";
    setNewFilePath(currentFile.path);
    setNewFileContent(currentFile.content);
  }, [file.data?.file?.path, file.data?.file?.content, file.data?.file?.latestVersion, fileMode, newFileContent, selectedPath, showToast]);

  const startUpload = (pickedFile: File) => {
    try {
      validateUploadFile(pickedFile, "文件");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "文件不符合上传限制", "warning");
      return;
    }
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    uploadAsset.mutate({ uploadId: `workspace-upload-${Date.now()}`, file: pickedFile, controller });
  };

  const openGitDialog = (dialog: WorkspaceGitDialog) => {
    setGitDialog(dialog);
    setGitDialogSummary("");
    if (dialog.kind === "commit") {
      setGitDialogValue(gitView.data?.view.git.headMessage ? "更新代码" : "初始化代码");
      return;
    }
    if (dialog.kind === "review") {
      setGitDialogValue("审阅当前 Code/ 变更");
      return;
    }
    setGitDialogValue("");
  };

  function closeGitDialog() {
    setGitDialog(null);
    setGitDialogValue("");
    setGitDialogSummary("");
  }

  const submitGitDialog = () => {
    if (!gitDialog) return;
    const value = gitDialogValue.trim();
    const summary = gitDialogSummary.trim();
    if (gitDialog.kind === "commit") {
      if (!value) {
        showToast("请填写提交信息", "warning");
        return;
      }
      commitGit.mutate(value);
      return;
    }
    if (gitDialog.kind === "review") {
      createGitProposal.mutate({
        ...(value ? { title: value } : {}),
        ...(summary ? { summary } : {})
      });
      return;
    }
    if (!value) {
      showToast("请填写退回原因", "warning");
      return;
    }
    rejectGitProposal.mutate({ proposalId: gitDialog.proposalId, reason: value });
  };

  const gitDialogBusy = commitGit.isPending || createGitProposal.isPending || rejectGitProposal.isPending;
  const gitDialogTitle = gitDialog?.kind === "commit"
    ? "直接提交 main"
    : gitDialog?.kind === "review"
      ? "提交代码审阅"
      : "退回修改提议";
  const gitDialogPrimaryText = gitDialog?.kind === "commit"
    ? "提交"
    : gitDialog?.kind === "review"
      ? "提交审阅"
      : "退回";
  const gitDialogFieldLabel = gitDialog?.kind === "commit"
    ? "提交信息"
    : gitDialog?.kind === "review"
      ? "审阅标题"
      : "退回原因";
  const gitDialogPlaceholder = gitDialog?.kind === "commit"
    ? "例如：更新首页样式"
    : gitDialog?.kind === "review"
      ? "例如：审阅当前 Code/ 变更"
      : "说明需要继续修改的原因";
  const gitDialogSubmitDisabled = gitDialogBusy || (gitDialog?.kind !== "review" && !gitDialogValue.trim());

  return (
    <section className="workspace-layout">
      <header className="workspace-header">
        <div>
          <h1>{active ? active.name : "工作空间"}</h1>
        </div>
        <div className="workspace-actions">
          {active ? (
            <NavLink className="secondary-button compact" to="/workspaces">
              <ArrowLeft size={15} /> 全部工作空间
            </NavLink>
          ) : null}
          <button className="secondary-button compact" type="button" onClick={() => void refreshActive()} disabled={!currentUser}>
            <RefreshCw size={15} /> 刷新
          </button>
          {active ? (
            <button className="primary-button compact" type="button" onClick={() => inputRef.current?.click()} disabled={uploadAsset.isPending}>
              <Upload size={15} /> 上传
            </button>
          ) : null}
          <input
            ref={inputRef}
            hidden
            type="file"
            onChange={(event) => {
              const picked = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (picked) startUpload(picked);
            }}
          />
          {uploadStatus ? (
            <div className="upload-status compact">
              <div>
                <strong>{uploadStatus.phase === "uploading" ? "正在上传" : "正在读取"} {uploadStatus.name}</strong>
                <span>{formatBytes(uploadStatus.loaded)} / {formatBytes(uploadStatus.total)}</span>
              </div>
              <div className="upload-progress-bar" aria-label={`上传进度 ${uploadStatus.percent}%`}>
                <span style={{ width: `${uploadStatus.percent}%` }} />
              </div>
              <button type="button" className="icon-button" title="取消上传" onClick={() => uploadAbortRef.current?.abort()}>
                <XCircle size={15} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {!active ? (
        <main className="workspace-card-page">
          {workspaceCards.length ? (
            <div className="workspace-grid">
              {workspaceCards.map((workspace) => <WorkspaceCard key={workspace.id} workspace={workspace} />)}
            </div>
          ) : (
            <div className="workspace-empty large">
              <FolderOpen size={36} />
              <h2>{workspaces.isLoading ? "正在加载工作空间" : "没有可访问的项目工作空间"}</h2>
              <p>创建项目群聊后会自动生成对应工作空间。</p>
            </div>
          )}
        </main>
      ) : (
        <div className="workspace-detail-body">
          <main className="workspace-main">
            <section className="workspace-panel file-tree-panel">
              <PanelTitle title={leftView === "files" ? "文件夹" : leftView === "assets" ? "资产索引" : "Git 与提议"} />
              <div className="workspace-left-tabs" aria-label="工作空间左侧视图">
                <button className={leftView === "files" ? "active" : ""} type="button" onClick={() => setLeftView("files")}>
                  文件
                </button>
                <button className={leftView === "assets" ? "active" : ""} type="button" onClick={() => setLeftView("assets")}>
                  资产
                </button>
                <button className={leftView === "git" ? "active" : ""} type="button" onClick={() => setLeftView("git")}>
                  Git
                </button>
              </div>
              <div className="workspace-tree-toolbar">
                <input
                  className="workspace-search-input"
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  placeholder={leftView === "files" ? "搜索文件路径" : leftView === "assets" ? "搜索资产名称或路径" : "搜索修改提议"}
                />
                <button
                  className="icon-button"
                  type="button"
                  title="新建文本文件"
                  disabled={leftView !== "files"}
                  onClick={() => {
                    void releaseCurrentFileLock();
                    setSelectedPath("");
                    setNewFilePath("Doc/notes.md");
                    setNewFileContent("");
                    setFileMode("edit");
                  }}
                >
                  <Pencil size={16} />
                </button>
              </div>
              {leftView === "files" ? (
                <div className="workspace-tree">
                  {filteredTree.length ? (
                    filteredTree.map((node) => (
                      <TreeNode
                        key={node.path}
                        node={node}
                        selectedPath={selectedPath}
                        onSelect={(path) => {
                          void releaseCurrentFileLock();
                          setSelectedPath(path);
                          setFileMode("preview");
                        }}
                      />
                    ))
                  ) : (
                    <p className="muted">{fileSearch.trim() ? "没有匹配的文件。" : "当前工作空间还没有文件。"}</p>
                  )}
                </div>
              ) : leftView === "assets" ? (
                <div className="workspace-asset-index">
                  {assetGroups.length ? (
                    assetGroups.map((group) => (
                      <details key={group.kind} className="workspace-asset-group" open>
                        <summary>
                          <Folder size={15} />
                          <span>{group.label}</span>
                          <b>{group.assets.length}</b>
                        </summary>
                        <div className="workspace-asset-group-body">
                          {group.assets.map((asset) => {
                            const provenance = assetProvenance(asset);
                            return (
                              <button
                                key={asset.id}
                                className={selectedAsset?.id === asset.id ? "workspace-asset-index-item active" : "workspace-asset-index-item"}
                                type="button"
                                onClick={() => {
                                  void releaseCurrentFileLock();
                                  setSelectedPath(asset.path);
                                  setFileMode("preview");
                                }}
                              >
                                {assetKindIcon(asset.kind)}
                                <span>
                                  <strong>{asset.name}</strong>
                                  <small>{provenance.producerName} · {formatDateTime(provenance.producedAt)} · {provenance.taskTitle}</small>
                                  <em>{asset.path}</em>
                                </span>
                                <b>{asset.kind}{asset.latestVersion ? ` · v${asset.latestVersion}` : ""}</b>
                              </button>
                            );
                          })}
                        </div>
                      </details>
                    ))
                  ) : (
                    <p className="muted">{fileSearch.trim() ? "没有匹配的资产。" : "当前工作空间还没有资产。"}</p>
                  )}
                </div>
              ) : (
                <SourceControlNavigator
                  isLoading={gitView.isLoading}
                  view={gitView.data?.view}
                  proposals={filteredOtherProposals}
                  activePanel={gitPanel}
                  onPanelChange={setGitPanel}
                  selectedCommitHash={selectedGitCommitHash}
                  selectedFilePath={effectiveSelectedGitFilePath}
                  onSelectChanges={() => {
                    setGitPanel("changes");
                    const firstFile = gitView.data?.view.git.files[0];
                    if (firstFile && !selectedGitFilePath) setSelectedGitFilePath(firstFile.path);
                  }}
                  onSelectFile={(filePath) => {
                    setSelectedGitFilePath(filePath);
                    setGitPanel("changes");
                  }}
                  onSelectCommit={(commitHash) => {
                    setSelectedGitCommitHash(commitHash);
                    setGitPanel("commits");
                  }}
                />
              )}
            </section>

            <section className="workspace-right-pane">
              {leftView === "git" ? (
                <WorkspaceGitPanel
                  view={gitView.data?.view}
                  isLoading={gitView.isLoading}
                  error={gitView.error}
                  activePanel={gitPanel}
                  selectedCommitHash={selectedGitCommitHash}
                  selectedFilePath={effectiveSelectedGitFilePath}
                  fileDiff={gitFileDiff.data?.diff}
                  fileDiffLoading={gitFileDiff.isLoading}
                  fileDiffError={gitFileDiff.error}
                  workspaceId={active.id}
                  onRefresh={() => void gitView.refetch()}
                  onCommitMain={() => openGitDialog({ kind: "commit" })}
                  onCreateProposal={() => openGitDialog({ kind: "review" })}
                  onApproveProposal={(proposalId) => approveGitProposal.mutate(proposalId)}
                  onSelectCommit={(commitHash) => {
                    setSelectedGitCommitHash(commitHash);
                    setGitPanel("commits");
                  }}
                  onRejectProposal={(proposalId) => openGitDialog({ kind: "reject", proposalId })}
                  busy={commitGit.isPending || createGitProposal.isPending || approveGitProposal.isPending || rejectGitProposal.isPending}
                />
              ) : (
              <section className="workspace-panel file-preview-panel workspace-file-panel">
                <div className="workspace-file-panel-header">
                  <h2>{selectedFileName}</h2>
                  <div className="workspace-mode-toggle" aria-label="文件模式切换">
                    <button
                      className={fileMode === "preview" ? "active" : ""}
                      type="button"
                      disabled={!canPreviewFile}
                      onClick={leaveEditMode}
                    >
                      <Eye size={14} /> 预览
                    </button>
                    <button
                      className={fileMode === "edit" ? "active" : ""}
                      type="button"
                      disabled={!canEditFile}
                      onClick={() => void enterEditMode()}
                    >
                      <Pencil size={14} /> 编辑
                    </button>
                    <button
                      className={fileMode === "history" ? "active" : ""}
                      type="button"
                      disabled={!canShowHistory}
                      onClick={enterHistoryMode}
                    >
                      <History size={14} /> 历史
                    </button>
                  </div>
                </div>
                {fileLockedByOther && selectedLock ? (
                  <div className="workspace-lock-warning">
                    <AlertTriangle size={15} />
                    {selectedLock.lockedByName} 正在编辑该文件，锁将在 {formatDateTime(selectedLock.expiresAt)} 失效。
                  </div>
                ) : fileMode === "edit" && fileLock?.ownedByMe ? (
                  <div className="workspace-lock-owned">
                    <CheckCircle2 size={15} />
                    已锁定当前文件，其他成员暂时不能覆盖保存。
                  </div>
                ) : null}

                {fileMode === "edit" ? (
                  <div className="workspace-file-editor">
                    <div className="workspace-file-name-row">
                      <span>{draftDirectory ? `${draftDirectory}/` : ""}</span>
                      <input
                        value={draftFileName}
                        onChange={(event) => {
                          const nextName = event.target.value.replace(/[\\/]/g, "");
                          setNewFilePath(replaceFileName(newFilePath || selectedPath || "Doc/notes.md", nextName));
                        }}
                        placeholder="文件名"
                      />
                    </div>
                    {pathError ? <span className="workspace-path-error">{pathError}</span> : null}
                    {draftIsExcalidraw ? (
                      <ExcalidrawEditor
                        key={selectedPath || newFilePath.trim() || "new-excalidraw"}
                        content={newFileContent}
                        name={draftFileName || selectedFileName}
                        onChangeContent={setNewFileContent}
                      />
                    ) : (
                      <textarea value={newFileContent} onChange={(event) => setNewFileContent(event.target.value)} placeholder="输入文件内容" disabled={selectedFileIsBinary} />
                    )}
                    {selectedFileIsBinary ? <span className="workspace-path-error">当前文件不是可文本编辑类型，请通过上传替换。</span> : null}
                    {file.data?.file && !selectedFileIsBinary && !draftIsExcalidraw ? (
                      <WorkspaceDiff original={file.data.file.content} draft={newFileContent} />
                    ) : draftIsExcalidraw ? (
                      <div className="workspace-excalidraw-note">
                        Excalidraw 会保存为 JSON 文件；保存后可在历史页面预览旧版本，必要时回滚。
                      </div>
                    ) : null}
                    <div className="workspace-editor-actions">
                      <button className="secondary-button compact" type="button" disabled={!selectedFileChanged || selectedFileIsBinary} onClick={() => setNewFileContent(file.data?.file?.content ?? "")}>
                        <RotateCcw size={14} /> 回滚当前改动
                      </button>
                      <button className="primary-button compact" type="button" disabled={Boolean(pathError) || !newFilePath.trim() || writeFile.isPending || selectedFileIsBinary} onClick={() => writeFile.mutate()}>
                        <Save size={14} /> {selectedPath ? "保存文件" : "写入文件"}
                      </button>
                    </div>
                  </div>
                ) : fileMode === "history" && file.data?.file ? (
                  <FileHistory file={file.data.file} workspaceId={active.id} asset={selectedAsset} />
                ) : file.isLoading ? (
                  <p className="muted">正在读取文件...</p>
                ) : file.data?.file ? (
                  <FilePreview file={file.data.file} workspaceId={active.id} asset={selectedAsset} />
                ) : file.error ? (
                  <p className="workspace-path-error">{file.error instanceof Error ? file.error.message : "文件预览失败"}</p>
                ) : (
                  <div className="workspace-empty inline">
                    <Eye size={28} />
                    <strong>选择文件后预览</strong>
                    <p>支持 Markdown、代码、JSON、CSV、图片、PDF、HTML 和常见二进制附件。</p>
                  </div>
                )}
              </section>
              )}

            </section>
          </main>
          {gitDialog ? (
            <div className="workspace-dialog-backdrop" role="presentation">
              <form
                className="workspace-git-dialog"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitGitDialog();
                }}
              >
                <div className="workspace-git-dialog-header">
                  <div>
                    <h2>{gitDialogTitle}</h2>
                    <p>{gitDialog.kind === "review" ? "审阅提交后会同步到项目群聊，群聊成员可以在消息中看到这次修改提议。" : "该操作会写入项目工作空间的 Git 记录。"}</p>
                  </div>
                  <button className="icon-button" type="button" title="关闭" onClick={closeGitDialog} disabled={gitDialogBusy}>
                    <XCircle size={16} />
                  </button>
                </div>
                <label className="workspace-git-dialog-field">
                  <span>{gitDialogFieldLabel}</span>
                  {gitDialog.kind === "reject" ? (
                    <textarea
                      autoFocus
                      value={gitDialogValue}
                      onChange={(event) => setGitDialogValue(event.target.value)}
                      placeholder={gitDialogPlaceholder}
                      rows={4}
                    />
                  ) : (
                    <input
                      autoFocus
                      value={gitDialogValue}
                      onChange={(event) => setGitDialogValue(event.target.value)}
                      placeholder={gitDialogPlaceholder}
                    />
                  )}
                </label>
                {gitDialog.kind === "review" ? (
                  <label className="workspace-git-dialog-field">
                    <span>补充说明</span>
                    <textarea
                      value={gitDialogSummary}
                      onChange={(event) => setGitDialogSummary(event.target.value)}
                      placeholder="说明这次修改完成了什么、希望成员重点审阅什么。可留空。"
                      rows={4}
                    />
                  </label>
                ) : null}
                {gitDialog.kind === "review" ? (
                  <div className="workspace-git-dialog-meta">
                    当前待审阅文件：{gitView.data?.view.git.files.length ?? 0} 个
                  </div>
                ) : null}
                <div className="workspace-git-dialog-actions">
                  <button className="secondary-button compact" type="button" onClick={closeGitDialog} disabled={gitDialogBusy}>
                    取消
                  </button>
                  <button className="primary-button compact" type="submit" disabled={gitDialogSubmitDisabled}>
                    {gitDialogPrimaryText}
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SourceControlNavigator({
  isLoading,
  view,
  proposals,
  activePanel,
  onPanelChange,
  selectedCommitHash,
  selectedFilePath,
  onSelectChanges,
  onSelectFile,
  onSelectCommit
}: {
  isLoading: boolean;
  view: WorkspaceGitView | undefined;
  proposals: WorkspaceCodeProposalView[];
  activePanel: WorkspaceGitPanelKey;
  onPanelChange: (panel: WorkspaceGitPanelKey) => void;
  selectedCommitHash: string | null;
  selectedFilePath: string | null;
  onSelectChanges: () => void;
  onSelectFile: (filePath: string) => void;
  onSelectCommit: (commitHash: string) => void;
}) {
  const changedFiles = view?.git.files ?? [];
  const commits = view?.git.recentCommits ?? [];
  return (
    <div className="workspace-git-side">
      <GitGraphTree
        isLoading={isLoading}
        view={view}
        activePanel={activePanel}
        selectedCommitHash={selectedCommitHash}
        onSelectChanges={onSelectChanges}
        onSelectCommit={onSelectCommit}
      />
      <SourceControlNavItem
        active={activePanel === "changes"}
        icon={<FileText size={16} />}
        title="变更"
        count={changedFiles.length}
        meta={changedFiles.length ? "保存后的 Code/ 改动" : "没有未提交变更"}
        onClick={() => onPanelChange("changes")}
      />
      {activePanel === "changes" && changedFiles.length ? (
        <div className="workspace-source-sublist">
          {changedFiles.map((file) => (
            <button
              key={`${file.status}-${file.path}`}
              className={`workspace-source-row file ${selectedFilePath === file.path ? "active" : ""}`}
              type="button"
              onClick={() => onSelectFile(file.path)}
            >
              <span>{file.path}</span>
            </button>
          ))}
        </div>
      ) : null}
      <SourceControlNavItem
        active={activePanel === "proposals"}
        icon={<GitPullRequest size={16} />}
        title="其他人的提议"
        count={proposals.length}
        meta={proposals.length ? "等待查看或处理" : "暂无待看提议"}
        onClick={() => onPanelChange("proposals")}
      />
      {activePanel === "proposals" && proposals.length ? (
        <div className="workspace-source-sublist">
          {proposals.map((proposal) => (
            <button key={proposal.id} className="workspace-source-row proposal" type="button" onClick={() => onPanelChange("proposals")}>
              <b>{statusLabel(proposal.status)}</b>
              <span>{proposal.title}</span>
              <small>{proposal.authorName}</small>
            </button>
          ))}
        </div>
      ) : null}
      <SourceControlNavItem
        active={activePanel === "commits"}
        icon={<GitCommit size={16} />}
        title="最近提交"
        count={commits.length}
        meta={view?.git.headCommit ? `HEAD ${view.git.headCommit}` : "暂无提交"}
        onClick={() => {
          if (commits[0]) {
            onSelectCommit(selectedCommitHash && commits.some((commit) => commit.hash === selectedCommitHash) ? selectedCommitHash : commits[0].hash);
          } else {
            onPanelChange("commits");
          }
        }}
      />
      {activePanel === "commits" && commits.length ? (
        <div className="workspace-source-sublist">
          {commits.slice(0, 5).map((commit) => (
            <button
              key={commit.hash}
              className={`workspace-source-row commit ${selectedCommitHash === commit.hash ? "active" : ""}`}
              type="button"
              onClick={() => onSelectCommit(commit.hash)}
            >
              <b>{commit.shortHash}</b>
              <span>{commit.subject}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SourceControlNavItem({
  active,
  icon,
  title,
  count,
  meta,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  count: number;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button className={`workspace-source-nav-item ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <span>{icon}</span>
      <strong>{title}</strong>
      <small>{meta}</small>
      <b>{count}</b>
    </button>
  );
}

const gitGraphTones = ["purple", "red", "blue", "green"] as const;

function GitGraphTree({
  isLoading,
  view,
  activePanel,
  selectedCommitHash,
  onSelectChanges,
  onSelectCommit
}: {
  isLoading: boolean;
  view: WorkspaceGitView | undefined;
  activePanel: WorkspaceGitPanelKey;
  selectedCommitHash: string | null;
  onSelectChanges: () => void;
  onSelectCommit: (commitHash: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const changedFiles = view?.git.files ?? [];
  const commits = view?.git.recentCommits ?? [];
  const graphCount = commits.length + (changedFiles.length ? 1 : 0);
  const branch = view?.git.branch ?? "main";
  const head = view?.git.headCommit ?? "无提交";

  return (
    <section className={`workspace-git-graph ${expanded ? "expanded" : "collapsed"}`}>
      <button
        className="workspace-git-graph-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <div>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <GitBranch size={18} />
          <strong>图表</strong>
          <span>{graphCount}</span>
        </div>
        <small>HEAD {head}</small>
      </button>

      {!expanded ? null : isLoading ? (
        <p className="muted workspace-git-loading">正在读取 Git 图谱...</p>
      ) : graphCount ? (
        <div className="workspace-git-graph-list">
          {changedFiles.length ? (
            <GitGraphRow
              tone="dirty"
              title="工作区变更"
              meta={`${changedFiles.length} 个未提交文件`}
              refs={[branch]}
              selected={activePanel === "changes"}
              onClick={onSelectChanges}
            />
          ) : null}
          {commits.map((commit, index) => (
            <GitGraphRow
              key={commit.hash}
              tone={gitGraphTones[index % gitGraphTones.length] ?? "purple"}
              title={commit.subject}
              meta={`${commit.shortHash} · ${commit.author} · ${formatDateTime(commit.date)}`}
              refs={index === 0 ? [branch, "HEAD"] : []}
              selected={activePanel === "commits" && (selectedCommitHash ? selectedCommitHash === commit.hash : index === 0)}
              onClick={() => onSelectCommit(commit.hash)}
            />
          ))}
        </div>
      ) : (
        <p className="muted workspace-git-loading">暂无 Git 记录。保存 Code/ 文件或完成提交后会显示图谱。</p>
      )}

    </section>
  );
}

function GitGraphRow({
  title,
  meta,
  refs,
  tone,
  selected,
  onClick
}: {
  title: string;
  meta: string;
  refs: string[];
  tone: "dirty" | (typeof gitGraphTones)[number];
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`workspace-git-graph-row ${selected ? "active" : ""}`} type="button" onClick={onClick} aria-pressed={selected}>
      <div className={`workspace-git-lane ${tone}`} aria-hidden="true">
        <span />
      </div>
      <div className="workspace-git-graph-content">
        <strong>{title}</strong>
        <small>{meta}</small>
        {refs.length ? (
          <div className="workspace-git-ref-tags">
            {refs.map((ref) => (
              <span key={ref}>{ref}</span>
            ))}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function WorkspaceGitPanel({
  view,
  isLoading,
  error,
  activePanel,
  selectedCommitHash,
  selectedFilePath,
  fileDiff,
  fileDiffLoading,
  fileDiffError,
  workspaceId,
  onRefresh,
  onCommitMain,
  onCreateProposal,
  onApproveProposal,
  onRejectProposal,
  onSelectCommit,
  busy
}: {
  view: WorkspaceGitView | undefined;
  isLoading: boolean;
  error: unknown;
  activePanel: WorkspaceGitPanelKey;
  selectedCommitHash: string | null;
  selectedFilePath: string | null;
  fileDiff: Awaited<ReturnType<typeof api.workspaceGitDiff>>["diff"] | undefined;
  fileDiffLoading: boolean;
  fileDiffError: unknown;
  workspaceId: string;
  onRefresh: () => void;
  onCommitMain: () => void;
  onCreateProposal: () => void;
  onApproveProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  onSelectCommit: (commitHash: string) => void;
  busy: boolean;
}) {
  const hasChanges = Boolean(view?.git.files.length);
  const title = activePanel === "changes"
    ? "变更"
    : activePanel === "proposals"
      ? "修改提议"
      : "最近提交";
  return (
    <section className="workspace-panel workspace-file-panel workspace-git-panel">
      <div className="workspace-file-panel-header">
        <h2>{title}</h2>
        <div className="workspace-git-header-actions">
          <button className="secondary-button compact" type="button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={14} /> 刷新
          </button>
          {activePanel === "changes" ? (
            <>
              <button className="secondary-button compact" type="button" onClick={onCreateProposal} disabled={!hasChanges || busy}>
                <GitPullRequest size={14} /> 提交审阅
              </button>
              <button className="primary-button compact" type="button" onClick={onCommitMain} disabled={!hasChanges || busy}>
                <GitCommit size={14} /> 直接提交 main
              </button>
            </>
          ) : null}
        </div>
      </div>
      {isLoading ? (
        <p className="muted">正在读取工作空间 Git 状态...</p>
      ) : error ? (
        <p className="workspace-path-error">{error instanceof Error ? error.message : "Git 状态读取失败"}</p>
      ) : view ? (
        <WorkspaceGitPanelBody
          activePanel={activePanel}
          view={view}
          workspaceId={workspaceId}
          selectedCommitHash={selectedCommitHash}
          selectedFilePath={selectedFilePath}
          fileDiff={fileDiff}
          fileDiffLoading={fileDiffLoading}
          fileDiffError={fileDiffError}
          onApproveProposal={onApproveProposal}
          onRejectProposal={onRejectProposal}
          onSelectCommit={onSelectCommit}
          busy={busy}
        />
      ) : null}
    </section>
  );
}

function WorkspaceGitPanelBody({
  activePanel,
  view,
  workspaceId,
  selectedCommitHash,
  selectedFilePath,
  fileDiff,
  fileDiffLoading,
  fileDiffError,
  onApproveProposal,
  onRejectProposal,
  onSelectCommit,
  busy
}: {
  activePanel: WorkspaceGitPanelKey;
  view: WorkspaceGitView;
  workspaceId: string;
  selectedCommitHash: string | null;
  selectedFilePath: string | null;
  fileDiff: Awaited<ReturnType<typeof api.workspaceGitDiff>>["diff"] | undefined;
  fileDiffLoading: boolean;
  fileDiffError: unknown;
  onApproveProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  onSelectCommit: (commitHash: string) => void;
  busy: boolean;
}) {
  if (activePanel === "proposals") {
    return (
      <section className="workspace-git-section">
        <div className="workspace-section-heading">
          <h3>同群聊修改提议</h3>
          <span>{view.proposals.length}</span>
        </div>
        {view.proposals.length ? (
          <div className="workspace-proposal-grid">
            {view.proposals.map((proposal) => (
              <ProposalCard
                key={`${proposal.kind}-${proposal.id}`}
                proposal={proposal}
                workspaceId={workspaceId}
                onApprove={onApproveProposal}
                onReject={onRejectProposal}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <p className="muted">暂无代码修改提议。成员提交审阅后会出现在这里。</p>
        )}
      </section>
    );
  }
  if (activePanel === "commits") {
    const selectedCommit = view.git.recentCommits.find((commit) => commit.hash === selectedCommitHash) ?? view.git.recentCommits[0];
    return (
      <section className="workspace-git-section">
        <div className="workspace-section-heading">
          <h3>提交详情</h3>
          <span>{view.git.recentCommits.length}</span>
        </div>
        {selectedCommit ? (
          <article className="workspace-commit-detail-card">
            <div>
              <b>{selectedCommit.shortHash}</b>
              <strong>{selectedCommit.subject}</strong>
            </div>
            <dl>
              <div>
                <dt>完整哈希</dt>
                <dd>{selectedCommit.hash}</dd>
              </div>
              <div>
                <dt>作者</dt>
                <dd>{selectedCommit.author}</dd>
              </div>
              <div>
                <dt>贡献者</dt>
                <dd>{formatContributors(selectedCommit.contributors)}</dd>
              </div>
              <div>
                <dt>提交时间</dt>
                <dd>{formatDateTime(selectedCommit.date)}</dd>
              </div>
              <div>
                <dt>所在分支</dt>
                <dd>{view.git.branch ?? "main"}{selectedCommit.hash === view.git.headCommit ? " · HEAD" : ""}</dd>
              </div>
            </dl>
          </article>
        ) : null}
        {view.git.recentCommits.length ? (
          <div className="workspace-commit-list">
            {view.git.recentCommits.map((commit) => (
              <button
                key={commit.hash}
                className={`workspace-commit-row ${selectedCommit?.hash === commit.hash ? "active" : ""}`}
                type="button"
                onClick={() => onSelectCommit(commit.hash)}
              >
                <b>{commit.shortHash}</b>
                <span>{commit.subject}</span>
                <small>{commit.author} · {formatDateTime(commit.date)}</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">当前 `Code/` 仓库还没有提交。</p>
        )}
      </section>
    );
  }
  const selectedFile = view.git.files.find((file) => file.path === selectedFilePath) ?? view.git.files[0];
  return (
    <section className="workspace-git-section">
      <div className="workspace-section-heading">
        <h3>{selectedFile ? selectedFile.path : "未提交文件"}</h3>
        <span>{view.git.files.length}</span>
      </div>
      {view.git.error ? <p className="workspace-path-error">{view.git.error}</p> : null}
      {view.git.files.length ? (
        <>
          <p className="muted workspace-git-page-note">这些是你保存到 `Code/` 后尚未提交的改动。确认一组修改完成后，再点击右上角“提交审阅”。</p>
          <ContributorStrip contributors={view.git.pendingContributors} label="本批改动贡献者" />
          {selectedFile ? (
            <div className="workspace-git-selected-file">
              <div>
                <b>{selectedFile.label}</b>
                <span>{formatContributors(selectedFile.contributors)}</span>
                <small>{selectedFile.staged ? "已暂存" : ""}{selectedFile.staged && selectedFile.unstaged ? " / " : ""}{selectedFile.unstaged ? "未暂存" : ""}</small>
              </div>
              {fileDiffLoading ? (
                <p className="muted">正在加载文件 Diff...</p>
              ) : fileDiffError ? (
                <p className="workspace-path-error">{fileDiffError instanceof Error ? fileDiffError.message : "文件 Diff 加载失败"}</p>
              ) : fileDiff?.diff ? (
                <DiffCodePreview diff={fileDiff.diff} />
              ) : (
                <p className="muted">当前文件没有可展示的 Diff。</p>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">当前 `Code/` 没有未提交变更。</p>
      )}
    </section>
  );
}

function ContributorStrip({ contributors, label, compact = false }: { contributors: WorkspaceCodeContributor[]; label: string; compact?: boolean }) {
  if (!contributors.length) return null;
  return (
    <div className={`workspace-contributor-strip ${compact ? "compact" : ""}`}>
      <span>{label}</span>
      <div>
        {contributors.map((contributor) => (
          <b key={contributor.id ?? contributor.name}>
            {contributor.name}{contributor.contributions > 1 ? ` ×${contributor.contributions}` : ""}
          </b>
        ))}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  workspaceId,
  onApprove,
  onReject,
  busy
}: {
  proposal: WorkspaceCodeProposalView;
  workspaceId: string;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  busy: boolean;
}) {
  const diffUrl = proposal.diffAssetId ? api.assetContentUrl(workspaceId, proposal.diffAssetId) : "";
  const canReview = proposal.status === "waiting_review";
  const canApprove = canReview && (!proposal.isFromCurrentUser || proposal.autoApproved);
  return (
    <article className={`workspace-proposal-card ${proposal.isFromCurrentUser ? "mine" : ""}`}>
      <div className="workspace-proposal-card-top">
        <span>{formatProposalKind(proposal.kind)}</span>
        <b>{statusLabel(proposal.status)}</b>
      </div>
      <h4>{proposal.title}</h4>
      <p>{proposal.authorName} · {proposal.branchName ?? "main"}{proposal.changedFileCount !== null ? ` · ${proposal.changedFileCount} 文件` : ""}</p>
      <ContributorStrip contributors={proposal.contributors} label="改动贡献者" compact />
      <div className="workspace-proposal-policy">
        {proposal.autoApproved ? "单真人项目，可直接通过" : proposal.requiresPeerReview ? "等待群聊成员审阅" : "无需他人审批"}
      </div>
      {diffUrl ? (
        <a className="secondary-button compact" href={diffUrl} target="_blank" rel="noreferrer">
          <Eye size={14} /> 查看 Diff
        </a>
      ) : null}
      {canReview ? (
        <div className="workspace-proposal-actions">
          <button className="secondary-button compact" type="button" disabled={!canApprove || busy} onClick={() => onApprove(proposal.id)}>
            <CheckCircle2 size={14} /> 通过提交
          </button>
          <button className="secondary-button compact" type="button" disabled={busy} onClick={() => onReject(proposal.id)}>
            <XCircle size={14} /> 退回
          </button>
        </div>
      ) : null}
    </article>
  );
}

function formatContributors(contributors: WorkspaceCodeContributor[]) {
  return contributors.length
    ? contributors.map((contributor) => contributor.name).join("、")
    : "未记录";
}

function WorkspaceCard({ workspace }: { workspace: NonNullable<Awaited<ReturnType<typeof api.workspaces>>["workspaces"]>[number] }) {
  const iconTone = workspaceCardIconTone(workspace.id);
  const icon = workspaceCardIcon(workspace.id);
  const Icon = icon.component;
  return (
    <NavLink className="workspace-card" to={`/workspaces/${workspace.id}`}>
      <div className={`workspace-card-icon ${iconTone}`}>
        {Icon ? <Icon size={23} strokeWidth={2.2} /> : null}
      </div>
      <div className="workspace-card-content">
        <div className="workspace-card-title-row">
          <h2>{workspace.name}</h2>
          <span>{workspace.scope === "team" ? "Team" : "Project"}</span>
        </div>
        <div className="workspace-card-metrics">
          <small><Users size={14} /> {workspace.memberCount} 成员</small>
          <small><FileText size={14} /> {workspace.assetCount} 资产</small>
          {workspace.codeAgentId ? <small><Code2 size={14} /> {workspace.codeAgentId.replace(/^agent-/, "")}</small> : null}
        </div>
      </div>
      <time>{formatDateTime(workspace.updatedAt)}</time>
    </NavLink>
  );
}

const workspaceIconToneOptions = ["blue", "cyan", "violet", "emerald", "amber", "rose"] as const;
const workspaceIconOptions = [FolderOpen, Boxes, Brain, Layers3, MessageSquare, Rocket, Sparkles] as const;

type WorkspaceCardIcon = {
  component: ComponentType<LucideProps>;
};

function workspaceCardIcon(value: string): WorkspaceCardIcon {
  const Icon = workspaceIconOptions[stableHash(`${value}:icon`) % workspaceIconOptions.length] ?? FolderOpen;
  return { component: Icon };
}

function workspaceCardIconTone(value: string) {
  return workspaceIconToneOptions[stableHash(`${value}:tone`) % workspaceIconToneOptions.length] ?? "blue";
}

function stableHash(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function PanelTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="workspace-panel-title">
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}

function filterTree(nodes: WorkspaceTreeNode[], query: string): WorkspaceTreeNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return nodes;
  return nodes.flatMap((node) => {
    const children = node.children ? filterTree(node.children, query) : [];
    const matched = node.path.toLowerCase().includes(normalized) || node.name.toLowerCase().includes(normalized);
    if (!matched && children.length === 0) return [];
    return [{ ...node, ...(children.length ? { children } : {}) }];
  });
}

function filterAssets(assets: WorkspaceAsset[], query: string) {
  const normalized = query.trim().toLowerCase();
  const indexedAssets = assets.filter(shouldShowInAssetIndex);
  if (!normalized) return indexedAssets;
  return indexedAssets.filter((asset) =>
    [asset.name, asset.path, asset.summary ?? "", asset.kind].some((value) => value.toLowerCase().includes(normalized))
  );
}

function shouldShowInAssetIndex(asset: WorkspaceAsset) {
  const provenance = assetProvenance(asset);
  if (provenance.source === "text_write") return false;
  if (asset.kind === "file" && provenance.source === "workspace_asset") return false;
  return true;
}

function groupWorkspaceAssets(assets: WorkspaceAsset[]) {
  const order: WorkspaceAsset["kind"][] = ["image", "doc", "diff", "log", "web", "file"];
  const groups = new Map<WorkspaceAsset["kind"], WorkspaceAsset[]>();
  for (const asset of assets) {
    const current = groups.get(asset.kind) ?? [];
    current.push(asset);
    groups.set(asset.kind, current);
  }
  return order.flatMap((kind) => {
    const items = groups.get(kind) ?? [];
    if (!items.length) return [];
    return [{
      kind,
      label: assetKindLabel(kind),
      assets: items.sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt))
    }];
  });
}

function assetProvenance(asset: WorkspaceAsset) {
  const provenance = recordValue(asset.details?.provenance);
  return {
    producerName: stringValue(provenance.producerName) || "系统",
    producedAt: stringValue(provenance.producedAt) || asset.createdAt,
    taskTitle: stringValue(provenance.taskTitle) || stringValue(provenance.sourceLabel) || "工作空间资产",
    source: stringValue(provenance.source) || "workspace_asset"
  };
}

function assetKindLabel(kind: WorkspaceAsset["kind"]) {
  const labels: Record<WorkspaceAsset["kind"], string> = {
    image: "图片",
    doc: "文档",
    diff: "Diff",
    log: "日志",
    web: "网页",
    file: "文件产物"
  };
  return labels[kind] ?? kind;
}

function assetKindIcon(kind: WorkspaceAsset["kind"]) {
  if (kind === "image") return <FileText size={16} />;
  if (kind === "diff") return <GitPullRequest size={16} />;
  if (kind === "log") return <FileText size={16} />;
  if (kind === "web") return <Eye size={16} />;
  return <FileText size={16} />;
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function versionActionLabel(action: string | undefined, sourceLabel: string | undefined) {
  const labels: Record<string, string> = {
    created: "创建文件",
    updated: "修改文件",
    renamed: "重命名文件",
    rollback: "回滚文件",
    uploaded: "上传文件"
  };
  return action ? labels[action] ?? action : sourceLabel ?? "修改文件";
}

function filterProposals(proposals: WorkspaceCodeProposalView[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return proposals;
  return proposals.filter((proposal) =>
    [proposal.title, proposal.authorName, proposal.status, proposal.branchName ?? ""].some((value) => value.toLowerCase().includes(normalized))
  );
}

function formatProposalKind(kind: WorkspaceCodeProposalView["kind"]) {
  return kind === "manual" ? "成员提议" : "Code Agent";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "执行中",
    cancelling: "取消中",
    waiting_review: "待审阅",
    revision_requested: "需修改",
    merged: "已合并",
    completed: "已完成",
    committed: "已提交",
    failed: "失败",
    timed_out: "超时",
    cancelled: "已取消",
    stale: "已失效",
    changes_requested: "需修改",
    approved: "已通过"
  };
  return labels[status] ?? status;
}

function validateWorkspacePath(path: string) {
  const value = path.trim();
  if (!value) return "请输入文件路径";
  if (value.startsWith("/") || value.includes("..") || value.includes("\\") || value.includes("//")) return "路径不能包含绝对路径、..、反斜杠或连续斜杠";
  if (/[<>:"|?*\u0000-\u001F]/.test(value)) return "路径包含非法字符";
  return "";
}

function validateWorkspaceFileName(name: string) {
  const value = name.trim();
  if (!value) return "请输入文件名";
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") return "只能修改文件名，不能修改目录路径";
  if (/[<>:"|?*\u0000-\u001F]/.test(value)) return "文件名包含非法字符";
  return "";
}

function parentDirectory(path: string) {
  const trimmed = path.trim().replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(0, index) : "";
}

function replaceFileName(path: string, fileName: string) {
  const directory = parentDirectory(path);
  return directory ? `${directory}/${fileName}` : fileName;
}

function lastPathSegment(path: string) {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.split("/").pop() || trimmed;
}

function WorkspaceDiff({ original, draft }: { original: string; draft: string }) {
  if (original === draft) return <p className="muted">当前内容与已加载版本一致。</p>;
  const originalLines = original.split("\n");
  const draftLines = draft.split("\n");
  const changedLines = Math.max(originalLines.length, draftLines.length);
  return (
    <div className="workspace-diff-preview">
      <strong>保存前对比</strong>
      <span>{changedLines} 行内容参与比较</span>
      <pre>
        <code>{buildSimpleDiff(originalLines, draftLines)}</code>
      </pre>
    </div>
  );
}

function buildSimpleDiff(originalLines: string[], draftLines: string[]) {
  const rows: string[] = [];
  const limit = Math.min(Math.max(originalLines.length, draftLines.length), 80);
  for (let index = 0; index < limit; index += 1) {
    const before = originalLines[index] ?? "";
    const after = draftLines[index] ?? "";
    if (before === after) {
      rows.push(`  ${after}`);
      continue;
    }
    if (before) rows.push(`- ${before}`);
    if (after) rows.push(`+ ${after}`);
  }
  if (Math.max(originalLines.length, draftLines.length) > limit) rows.push("... diff 已截断");
  return rows.join("\n");
}

function TreeNode({ node, selectedPath, onSelect }: { node: WorkspaceTreeNode; selectedPath: string; onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const isFile = node.type === "file";
  const hasChildren = Boolean(node.children?.length);
  return (
    <div className="workspace-tree-node">
      <button
        className={`${selectedPath === node.path ? "active" : ""} ${!isFile ? "directory" : ""}`}
        type="button"
        onClick={() => {
          if (isFile) onSelect(node.path);
          else setExpanded((current) => !current);
        }}
        aria-expanded={!isFile ? expanded : undefined}
      >
        {isFile ? <FileText size={16} /> : expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span>{node.name}</span>
        {!isFile && hasChildren ? (
          <small className="workspace-tree-toggle">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</small>
        ) : null}
        {node.size ? <small>{formatBytes(node.size)}</small> : null}
      </button>
      {hasChildren && expanded ? (
        <div className="workspace-tree-children">
          {node.children!.map((child) => <TreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} />)}
        </div>
      ) : null}
    </div>
  );
}

type RenderableWorkspaceFile = {
  name: string;
  mimeType: string;
  size: number;
  content: string;
  binary?: boolean;
  previewableText?: boolean;
};

function FilePreview({ file, workspaceId, asset }: { file: WorkspaceFileView; workspaceId: string; asset?: WorkspaceAsset | undefined }) {
  const assetId = asset?.id ?? file.assetId ?? undefined;
  const assetUrl = assetId ? api.assetContentUrl(workspaceId, assetId) : "";
  return (
    <div className="workspace-file-preview">
      <WorkspaceFileRenderer file={file} assetUrl={assetUrl} />
    </div>
  );
}

function FileHistory({ file, workspaceId, asset }: { file: WorkspaceFileView; workspaceId: string; asset?: WorkspaceAsset | undefined }) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((state) => state.user);
  const showToast = useUiStore((state) => state.showToast);
  const assetId = asset?.id ?? file.assetId ?? undefined;
  const userId = currentUser?.id ?? "";
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [historyMode, setHistoryMode] = useState<"preview" | "compare">("preview");
  const versions = useQuery({
    queryKey: userId && assetId ? queryKeys.assetVersions(userId, workspaceId, assetId) : ["asset-versions", workspaceId, assetId ?? "none"],
    queryFn: () => api.assetVersions(workspaceId, assetId!),
    enabled: Boolean(userId && assetId)
  });
  const selectedVersionNumber = selectedVersion ?? versions.data?.versions[0]?.version ?? null;
  const versionContent = useQuery({
    queryKey: userId && assetId && selectedVersionNumber ? queryKeys.assetVersion(userId, workspaceId, assetId, selectedVersionNumber) : ["asset-version", workspaceId, assetId ?? "none", selectedVersionNumber ?? "none"],
    queryFn: () => api.assetVersion(workspaceId, assetId!, selectedVersionNumber!),
    enabled: Boolean(userId && assetId && selectedVersionNumber)
  });
  const rollback = useMutation({
    mutationFn: (version: number) => api.rollbackAsset(workspaceId, assetId!, version),
    onSuccess: async () => {
      if (userId && assetId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.assetVersions(userId, workspaceId, assetId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile(userId, workspaceId, file.path) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(userId, workspaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.assets(userId, workspaceId) })
        ]);
      }
      showToast("已回滚到所选历史版本", "success");
    },
    onError: (error) => showToast(error instanceof Error ? error.message : "回滚失败", "warning")
  });
  useEffect(() => {
    const latest = versions.data?.versions[0]?.version;
    if (latest && !selectedVersion) setSelectedVersion(latest);
  }, [selectedVersion, versions.data?.versions]);

  if (!assetId) {
    return (
      <div className="workspace-history-page empty">
        <History size={28} />
        <strong>暂无修改历史</strong>
        <p>文件保存为工作空间资产后才会生成历史版本。</p>
      </div>
    );
  }

  const selected = versions.data?.versions.find((version) => version.version === selectedVersionNumber);
  const selectedFile = versionContent.data?.version;
  const selectedAssetUrl = selectedVersionNumber ? api.assetVersionContentUrl(workspaceId, assetId, selectedVersionNumber) : "";
  const latestVersion = versions.data?.versions[0]?.version ?? file.latestVersion;
  const isLatest = selectedVersionNumber === latestVersion;
  return (
    <div className="workspace-history-page">
      <aside className="workspace-history-sidebar">
        <div className="workspace-section-heading">
          <h3>修改历史</h3>
          <span>{versions.data?.versions.length ?? 0}</span>
        </div>
        {versions.isLoading ? (
          <p className="muted">正在读取历史记录...</p>
        ) : versions.data?.versions.length ? (
          <div className="workspace-version-list">
            {versions.data.versions.map((version) => (
              <button
                key={version.id}
                className={`workspace-version-row selectable ${selectedVersionNumber === version.version ? "active" : ""}`}
                type="button"
                onClick={() => {
                  setSelectedVersion(version.version);
                  setHistoryMode("preview");
                }}
              >
                <b>v{version.version}</b>
                <span>
                  <strong>{versionActionLabel(version.action, version.sourceLabel)}</strong>
                  <small>{version.createdByName ?? version.createdByUserId ?? "系统"} · {formatDateTime(version.createdAt)} · {formatBytes(version.size)}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">暂无修改历史。</p>
        )}
      </aside>
      <section className="workspace-history-detail">
        <div className="workspace-history-detail-header">
          <div>
            <strong>{selected ? `v${selected.version}` : "选择历史版本"}</strong>
            <small>{selected ? `${versionActionLabel(selected.action, selected.sourceLabel)} · ${formatDateTime(selected.createdAt)}` : "选择左侧版本后查看内容"}</small>
          </div>
          <div className="workspace-history-actions">
            <button className={historyMode === "preview" ? "active" : ""} type="button" disabled={!selectedVersionNumber} onClick={() => setHistoryMode("preview")}>
              <Eye size={14} /> 预览
            </button>
            <button className={historyMode === "compare" ? "active" : ""} type="button" disabled={!selectedVersionNumber || !selectedFile || selectedFile.binary} onClick={() => setHistoryMode("compare")}>
              <GitCommit size={14} /> 对比最新版
            </button>
            <button
              className="secondary-button compact"
              type="button"
              disabled={!selectedVersionNumber || isLatest || rollback.isPending}
              onClick={() => {
                if (selectedVersionNumber) rollback.mutate(selectedVersionNumber);
              }}
            >
              <RotateCcw size={14} /> 回滚
            </button>
          </div>
        </div>
        {versionContent.isLoading ? (
          <p className="muted">正在读取版本内容...</p>
        ) : versionContent.error ? (
          <p className="workspace-path-error">{versionContent.error instanceof Error ? versionContent.error.message : "读取版本失败"}</p>
        ) : selectedFile && historyMode === "compare" ? (
          <VersionDiffPreview historical={selectedFile} latest={file} />
        ) : selectedFile ? (
          <WorkspaceFileRenderer file={selectedFile} assetUrl={selectedAssetUrl} />
        ) : (
          <p className="muted">选择一个历史版本查看内容。</p>
        )}
      </section>
    </div>
  );
}

function WorkspaceFileRenderer({ file, assetUrl }: { file: RenderableWorkspaceFile; assetUrl?: string }) {
  return <AssetRenderPreview file={file} assetUrl={assetUrl} className="workspace-markdown-preview" />;
}

function VersionDiffPreview({ historical, latest }: { historical: WorkspaceAssetVersionContent; latest: WorkspaceFileView }) {
  if (historical.binary || latest.binary) {
    return <p className="muted">二进制文件暂不支持文本差异对比。</p>;
  }
  return (
    <div className="workspace-diff-preview history">
      <strong>v{historical.version} 与最新版对比</strong>
      <span>{historical.name} · 历史版本在上，最新版在下</span>
      <pre>
        <code>{buildSimpleDiff(historical.content.split("\n"), latest.content.split("\n"))}</code>
      </pre>
    </div>
  );
}

function CodePreview({ content, className = "workspace-code-preview" }: { content: string; className?: string }) {
  return (
    <pre className={className}>
      <code>{content || "当前文件没有可显示的文本内容。"}</code>
    </pre>
  );
}

function DiffCodePreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className="workspace-git-diff-preview">
      <code>
        {lines.map((line, index) => {
          const kind = line.startsWith("+") && !line.startsWith("+++") ? "add"
            : line.startsWith("-") && !line.startsWith("---") ? "remove"
              : line.startsWith("@@") ? "hunk"
                : line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "meta"
                  : "context";
          return (
            <span key={`${index}-${line}`} className={`workspace-git-diff-line ${kind}`}>
              <b>{index + 1}</b>
              <span>{line || " "}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function BinaryPreview({ file, assetUrl }: { file: RenderableWorkspaceFile; assetUrl: string }) {
  return (
    <div className="workspace-binary-preview">
      <FileText size={34} />
      <strong>该文件不能按文本内联预览</strong>
      <p>{file.mimeType} · {formatBytes(file.size)}</p>
      {assetUrl ? (
        <a className="secondary-button compact" href={assetUrl} download={file.name}>
          <Download size={14} /> 下载文件
        </a>
      ) : null}
    </div>
  );
}

function CsvPreview({ content }: { content: string }) {
  const rows = parseCsv(content).slice(0, 80);
  if (!rows.length) return <p className="muted">CSV 文件没有可显示的数据。</p>;
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <div className="workspace-csv-preview">
      <table>
        <thead>
          <tr>{headers.map((cell, index) => <th key={`${cell}-${index}`}>{cell || `列 ${index + 1}`}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {headers.map((_header, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{row[cellIndex] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {content.split(/\r?\n/).length > rows.length ? <small>仅显示前 {rows.length} 行。</small> : null}
    </div>
  );
}

function parseCsv(content: string) {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(splitCsvLine);
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function formatJson(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
