import type { ChatMessage, MessageBlock } from "@agenthub/shared";
import { CheckCircle2, ChevronDown, Copy, FileText, Globe2, ImageIcon, Pin, Reply, Rocket, ThumbsUp, XCircle } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { AvatarMark } from "./AvatarMark";
import { CodeHighlighter } from "./CodeHighlighter";
import { MarkdownPreview } from "./MarkdownPreview";
import { useUiStore } from "../store/ui-store";
import { api } from "../api/client";
import { assetRenderEngineLabel } from "./AssetRenderEngine";

export { highlightMentions } from "./MarkdownPreview";

interface MessageRendererProps {
  message: ChatMessage;
  currentUserId?: string | undefined;
  onOpenSender?: (message: ChatMessage) => void;
  onOpenAsset?: (assetId: string) => void;
  onOpenPreview?: (title: string, url: string) => void;
  onReply?: (message: ChatMessage) => void;
  onLike?: (message: ChatMessage, existingAction?: NonNullable<ChatMessage["actions"]>[number]) => void;
  onPin?: (message: ChatMessage, existingAction?: NonNullable<ChatMessage["actions"]>[number]) => void;
  onComment?: (message: ChatMessage, text: string) => void;
  onReviewDecision?: (input: ReviewDecisionInput) => void;
  reviewBusyKey?: string | null;
  canPin?: boolean;
  workspaceId?: string | null | undefined;
}

export type ReviewDecisionInput = {
  message: ChatMessage;
  block: Extract<MessageBlock, { type: "diff" }>;
  proposalId: string;
  decision: "approve" | "reject";
  reason?: string;
};

export function MessageRenderer({
  message,
  currentUserId,
  onOpenSender,
  onOpenAsset,
  onOpenPreview,
  onReply,
  onLike,
  onPin,
  onComment,
  onReviewDecision,
  reviewBusyKey,
  canPin = true,
  workspaceId
}: MessageRendererProps) {
  const isSelfUser = message.sender.type === "user" && message.sender.id === currentUserId;
  const showToast = useUiStore((state) => state.showToast);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const plainText = message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : `[${block.type}]`)).join("\n");
  const renderItems = useMemo(() => groupMessageBlocks(message.blocks), [message.blocks]);
  const hasImageBlocks = renderItems.some((item) => item.kind === "image_group");
  const likeActions = (message.actions ?? []).filter((action) => action.type === "like");
  const pinActions = (message.actions ?? []).filter((action) => action.type === "pin");
  const latestPinAction = pinActions.at(-1);
  const pinNotice = latestPinAction ? pinNoticeText(latestPinAction) : undefined;
  const commentActions = (message.actions ?? []).filter((action) => action.type === "comment");
  const likedByMeAction = currentUserId ? likeActions.find((action) => action.actor.id === currentUserId) : undefined;
  const pinnedByMeAction = currentUserId ? pinActions.find((action) => action.actor.id === currentUserId) : undefined;
  const likedByMe = Boolean(likedByMeAction);
  const pinned = pinActions.length > 0;
  return (
    <article className={isSelfUser ? "message-row user" : "message-row"}>
      <AvatarMark
        className="avatar"
        kind={message.sender.type === "user" ? "user" : "agent"}
        value={message.sender.avatar}
        label={message.sender.name}
        title={`${message.sender.name} 状态`}
        onClick={() => onOpenSender?.(message)}
      />
      <div className="message-main">
        {!isSelfUser ? (
          <div className="message-meta">
            <strong>{message.sender.name}</strong>
            {pinned ? <span className="message-pin-badge"><Pin size={12} /> 已 Pin</span> : null}
          </div>
        ) : null}
        <div className={[isSelfUser ? "message-bubble user-bubble" : "message-bubble", hasImageBlocks ? "with-images" : ""].filter(Boolean).join(" ")}>
          {pinNotice ? (
            <div className="message-pin-notice" role="status" aria-live="polite">
              <Pin size={15} />
              <span>{pinNotice}</span>
            </div>
          ) : null}
          {message.reference ? (
            <div className="message-reference">
              <strong>{message.reference.kind === "review" ? "审阅引用" : "引用回复"}</strong>
              <span>
                {message.reference.senderName}: {message.reference.summary}
              </span>
            </div>
          ) : null}
          {renderItems.map((item) =>
            item.kind === "image_group" ? (
              <ImageGallery
                key={item.key}
                blocks={item.blocks}
                workspaceId={workspaceId}
                onOpenAsset={onOpenAsset}
              />
            ) : (
              <BlockRenderer
                key={item.block.blockId}
                block={item.block}
                workspaceId={workspaceId}
                onOpenAsset={onOpenAsset}
                onOpenPreview={onOpenPreview}
                message={message}
                onReviewDecision={onReviewDecision}
                reviewBusyKey={reviewBusyKey}
              />
            )
          )}
        </div>
        <div className="message-actions">
          <button type="button" onClick={() => copyText(plainText, showToast)}>
            <Copy size={14} /> 复制
          </button>
          <button type="button" onClick={() => onReply?.(message)}>
            <Reply size={14} /> 引用
          </button>
          <button className={likedByMe ? "active" : ""} type="button" onClick={() => onLike?.(message, likedByMeAction)}>
            <ThumbsUp size={14} /> {likedByMe ? "取消赞" : "赞"}{likeActions.length ? ` ${likeActions.length}` : ""}
          </button>
          {canPin ? (
            <button className={pinned ? "active" : ""} type="button" onClick={() => onPin?.(message, pinnedByMeAction)}>
              <Pin size={14} /> {pinnedByMeAction ? "取消 Pin" : "Pin"}{pinActions.length ? ` ${pinActions.length}` : ""}
            </button>
          ) : null}
          <button type="button" onClick={() => setCommentOpen((value) => !value)}>
            <Reply size={14} /> 评论{commentActions.length ? ` ${commentActions.length}` : ""}
          </button>
        </div>
        {commentActions.length ? (
          <div className="message-comments">
            {commentActions.map((action) => (
              <div key={action.id}>
                <strong>{action.actor.name ?? action.actor.id}</strong>
                <span>{typeof action.payload?.text === "string" ? action.payload.text : "评论"}</span>
              </div>
            ))}
          </div>
        ) : null}
        {commentOpen ? (
          <form
            className="message-comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = commentText.trim();
              if (!value) return;
              onComment?.(message, value);
              setCommentText("");
              setCommentOpen(false);
            }}
          >
            <input value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="添加评论" />
            <button className="primary-button compact" type="submit" disabled={!commentText.trim()}>
              发送
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}

type ImageBlock = Extract<MessageBlock, { type: "image" }>;
type MessageRenderItem =
  | { kind: "block"; block: MessageBlock }
  | { kind: "image_group"; key: string; blocks: ImageBlock[] };

function pinNoticeText(action: NonNullable<ChatMessage["actions"]>[number]) {
  const actorName = action.actor.name ?? action.actor.id;
  const reason = typeof action.payload?.reason === "string" ? action.payload.reason.trim() : "";
  if (action.actor.id === "agent-orchestrator" || actorName.toLowerCase() === "orchestrator") {
    if (reason.includes("UI v2") || reason.includes("基准")) return "Orchestrator Pin 了当前基准方案";
    return "Orchestrator Pin 了这条消息";
  }
  return `${actorName} Pin 了这条消息`;
}

function groupMessageBlocks(blocks: MessageBlock[]): MessageRenderItem[] {
  const items: MessageRenderItem[] = [];
  let imageGroup: ImageBlock[] = [];

  const flushImages = () => {
    if (imageGroup.length === 0) return;
    const visibleImages = filterRenderableImageBlocks(imageGroup);
    if (visibleImages.length === 0) {
      imageGroup = [];
      return;
    }
    items.push({
      kind: "image_group",
      key: visibleImages.map((block) => block.blockId).join(":"),
      blocks: visibleImages
    });
    imageGroup = [];
  };

  for (const block of blocks) {
    if (block.type === "image") {
      imageGroup.push(block);
      continue;
    }
    flushImages();
    items.push({ kind: "block", block });
  }
  flushImages();
  return items;
}

function filterRenderableImageBlocks(blocks: ImageBlock[]) {
  const rasterBlocks = blocks.filter((block) => !isVectorImageBlock(block));
  const candidates = rasterBlocks.length > 0 ? rasterBlocks : blocks;
  const seen = new Set<string>();
  return candidates.filter((block) => {
    const key = normalizeImageDedupKey(block);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isVectorImageBlock(block: ImageBlock) {
  const text = [
    block.payload.alt,
    block.payload.thumbnailUrl,
    block.payload.previewUrl
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("svg") || text.includes("矢量");
}

function normalizeImageDedupKey(block: ImageBlock) {
  const text = block.payload.alt?.toLowerCase().replace(/png|jpeg|jpg|webp|gif|svg|预览图|矢量|preview|image/g, "").replace(/\s+/g, "") || "";
  return text || block.payload.assetId;
}

function BlockRenderer({
  block,
  workspaceId,
  onOpenAsset,
  onOpenPreview,
  message,
  onReviewDecision,
  reviewBusyKey
}: {
  block: MessageBlock;
  workspaceId?: string | null | undefined;
  onOpenAsset: ((assetId: string) => void) | undefined;
  onOpenPreview: ((title: string, url: string) => void) | undefined;
  message: ChatMessage;
  onReviewDecision: ((input: ReviewDecisionInput) => void) | undefined;
  reviewBusyKey: string | null | undefined;
}) {
  if (block.type === "markdown") {
    return <MarkdownPreview source={block.payload.text} />;
  }
  if (block.type === "code") {
    const showToast = useUiStore.getState().showToast;
    return (
      <div className="code-card">
        <div className="code-card-header">
          <span>{block.payload.filename ?? block.payload.language}</span>
          <button type="button" onClick={() => copyText(block.payload.code, showToast)}>复制</button>
        </div>
        <CodeHighlighter code={block.payload.code} fileName={block.payload.filename} language={block.payload.language} />
      </div>
    );
  }
  if (block.type === "file") {
    const engineLabel = assetRenderEngineLabel({
      name: block.payload.name,
      mimeType: block.payload.mimeType,
      size: block.payload.size
    });
    return (
      <button className="file-card" type="button" onClick={() => onOpenAsset?.(block.payload.assetId)}>
        <FileText size={24} />
        <span>
          <strong>{block.payload.name}</strong>
          <small>{engineLabel} 渲染</small>
        </span>
        <b>预览</b>
      </button>
    );
  }
  if (block.type === "image") {
    return <ImageGallery blocks={[block]} workspaceId={workspaceId} onOpenAsset={onOpenAsset} />;
  }
  if (block.type === "web_preview") {
    return (
      <button className="web-preview-card" type="button" onClick={() => onOpenPreview?.(block.payload.title, block.payload.url)}>
        <Globe2 size={28} />
        <span>
          <strong>{block.payload.title}</strong>
          <small>{block.payload.url}</small>
        </span>
      </button>
    );
  }
  if (block.type === "agent_status") {
    return null;
  }
  if (block.type === "diff") {
    return <DiffBlock block={block} message={message} onReviewDecision={onReviewDecision} reviewBusyKey={reviewBusyKey} />;
  }
  if (block.type === "deploy_status") {
    const statusLabel = deployStatusLabel(block.payload.status);
    return (
      <div className={`deploy-card ${block.payload.status}`}>
        <Rocket size={22} />
        <span>
          <strong>{block.payload.title}</strong>
          <small>{block.payload.detail ?? statusLabel}</small>
          {block.payload.error ? <em>{block.payload.error}</em> : null}
        </span>
        <div className="deploy-card-actions">
          {block.payload.previewUrl && block.payload.status === "ready" ? (
            <button type="button" onClick={() => onOpenPreview?.(block.payload.title, block.payload.previewUrl!)}>
              预览
            </button>
          ) : null}
          {block.payload.logAssetId ? (
            <button type="button" onClick={() => onOpenAsset?.(block.payload.logAssetId!)}>
              日志
            </button>
          ) : null}
          <b>{statusLabel}</b>
        </div>
      </div>
    );
  }
  return null;
}

function deployStatusLabel(status: Extract<MessageBlock, { type: "deploy_status" }>["payload"]["status"]) {
  if (status === "queued") return "排队中";
  if (status === "building") return "构建中";
  if (status === "ready") return "已就绪";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status;
}

function ImageGallery({
  blocks,
  workspaceId,
  onOpenAsset
}: {
  blocks: ImageBlock[];
  workspaceId?: string | null | undefined;
  onOpenAsset: ((assetId: string) => void) | undefined;
}) {
  const isSingle = blocks.length === 1;
  return (
    <div className={isSingle ? "image-gallery single" : "image-gallery multiple"}>
      {blocks.map((block) => {
        const imageUrl = resolveImageUrl(block, workspaceId);
        return (
          <button key={block.blockId} className="image-card" type="button" onClick={() => onOpenAsset?.(block.payload.assetId)}>
            {imageUrl ? (
              <img src={imageUrl} alt={block.payload.alt ?? "图片"} loading="lazy" />
            ) : (
              <span className="image-card-fallback"><ImageIcon size={24} /> 图片</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function resolveImageUrl(block: Extract<MessageBlock, { type: "image" }>, workspaceId?: string | null) {
  const explicitUrl = block.payload.thumbnailUrl ?? block.payload.previewUrl;
  if (explicitUrl && isRenderableImageUrl(explicitUrl)) return explicitUrl;
  if (workspaceId) return api.assetContentUrl(workspaceId, block.payload.assetId);
  return undefined;
}

function isRenderableImageUrl(value: string) {
  return value.startsWith("/") || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:image/");
}

function DiffBlock({
  block,
  message,
  onReviewDecision,
  reviewBusyKey
}: {
  block: Extract<MessageBlock, { type: "diff" }>;
  message: ChatMessage;
  onReviewDecision: ((input: ReviewDecisionInput) => void) | undefined;
  reviewBusyKey: string | null | undefined;
}) {
  const [openFiles, setOpenFiles] = useState(() => new Set(block.payload.files.filter((file) => file.expanded).map((file) => file.path)));
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const additions = block.payload.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = block.payload.files.reduce((sum, file) => sum + file.deletions, 0);
  const reviewPayload = block.payload as typeof block.payload & { reviewProposalId?: string };
  const fallbackCodeTaskId = message.blocks.find(isCodeTaskStatusBlock)?.payload.targetId;
  const proposalId = reviewPayload.reviewProposalId ?? fallbackCodeTaskId;
  const canReview = Boolean(proposalId && onReviewDecision && block.payload.reviewState === "pending");
  const isBusy = Boolean(proposalId && reviewBusyKey === proposalId);
  return (
    <section className="diff-card">
      <header>
        <div>
          <strong>{block.payload.title}</strong>
          <small>
            +{additions} -{deletions}
          </small>
        </div>
        <span className={`diff-review-state ${block.payload.reviewState}`}>
          {reviewStateLabel(block.payload.reviewState)}
        </span>
      </header>
      {canReview ? (
        <div className="diff-review-toolbar">
          <button
            type="button"
            className="diff-review-button approve"
            disabled={isBusy}
            onClick={() => {
              if (!proposalId) return;
              onReviewDecision?.({ message, block, proposalId, decision: "approve" });
            }}
          >
            <CheckCircle2 size={15} /> 通过
          </button>
          <button
            type="button"
            className="diff-review-button reject"
            disabled={isBusy}
            onClick={() => setRejectOpen((value) => !value)}
          >
            <XCircle size={15} /> 不通过
          </button>
        </div>
      ) : null}
      {rejectOpen && canReview ? (
        <form
          className="diff-review-reject-form"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = rejectReason.trim();
            if (!proposalId || !reason) return;
            onReviewDecision?.({ message, block, proposalId, decision: "reject", reason });
            setRejectOpen(false);
            setRejectReason("");
          }}
        >
          <textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="说明需要修改的原因" rows={2} />
          <button type="submit" disabled={isBusy || !rejectReason.trim()}>
            发送打回意见
          </button>
        </form>
      ) : null}
      {block.payload.files.map((file) => {
        const expanded = openFiles.has(file.path);
        return (
          <div key={file.path} className="diff-file">
            <button
              type="button"
              className="diff-file-header"
              onClick={() => {
                const next = new Set(openFiles);
                if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                setOpenFiles(next);
              }}
            >
              <span>{file.path}</span>
              <b>
                +{file.additions} -{file.deletions}
              </b>
              <ChevronDown className={expanded ? "expanded" : ""} size={16} />
            </button>
            {expanded ? (
              <VirtualDiffLines file={file} />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function isCodeTaskStatusBlock(block: MessageBlock): block is Extract<MessageBlock, { type: "agent_status" }> {
  return block.type === "agent_status" && block.payload.subtype === "code_task";
}

function reviewStateLabel(state: Extract<MessageBlock, { type: "diff" }>["payload"]["reviewState"]) {
  if (state === "approved") return "已通过";
  if (state === "changes_requested") return "需修改";
  return "待审阅";
}

type DiffFile = Extract<MessageBlock, { type: "diff" }>["payload"]["files"][number];
type DiffRow =
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line";
      key: string;
      lineKind: "context" | "add" | "delete";
      oldLine?: number | undefined;
      newLine?: number | undefined;
      content: string;
    };

const DIFF_LINE_HEIGHT = 30;
const DIFF_VIEWPORT_HEIGHT = 360;
const DIFF_OVERSCAN = 16;
const DIFF_VIRTUAL_THRESHOLD = 240;

function VirtualDiffLines({ file }: { file: DiffFile }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rows = useMemo(() => flattenDiffRows(file), [file]);
  const isVirtual = rows.length > DIFF_VIRTUAL_THRESHOLD;
  const viewportHeight = isVirtual ? DIFF_VIEWPORT_HEIGHT : undefined;
  const startIndex = isVirtual ? Math.max(0, Math.floor(scrollTop / DIFF_LINE_HEIGHT) - DIFF_OVERSCAN) : 0;
  const visibleCount = isVirtual ? Math.ceil(DIFF_VIEWPORT_HEIGHT / DIFF_LINE_HEIGHT) + DIFF_OVERSCAN * 2 : rows.length;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className={isVirtual ? "diff-lines virtual" : "diff-lines"}
      style={viewportHeight ? { maxHeight: viewportHeight } : undefined}
      data-total-lines={rows.length}
      onScroll={(event) => {
        if (isVirtual) setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      {isVirtual ? (
        <div className="diff-lines-spacer" style={{ height: rows.length * DIFF_LINE_HEIGHT }}>
          <div className="diff-lines-window" style={{ transform: `translateY(${startIndex * DIFF_LINE_HEIGHT}px)` }}>
            {visibleRows.map(renderDiffRow)}
          </div>
        </div>
      ) : (
        visibleRows.map(renderDiffRow)
      )}
    </div>
  );
}

function flattenDiffRows(file: DiffFile): DiffRow[] {
  return file.hunks.flatMap((hunk, hunkIndex) => [
    { kind: "hunk" as const, key: `${file.path}-hunk-${hunkIndex}`, header: hunk.header },
    ...hunk.lines.map((line, lineIndex): DiffRow => {
      const row: DiffRow = {
        kind: "line",
        key: `${file.path}-line-${hunkIndex}-${lineIndex}`,
        lineKind: line.kind,
        content: line.content
      };
      if (line.oldLine !== undefined) row.oldLine = line.oldLine;
      if (line.newLine !== undefined) row.newLine = line.newLine;
      return row;
    })
  ]);
}

function renderDiffRow(row: DiffRow) {
  if (row.kind === "hunk") {
    return (
      <div key={row.key} className="diff-hunk">
        {row.header}
      </div>
    );
  }
  return (
    <div key={row.key} className={`diff-line ${row.lineKind}`}>
      <span>{row.oldLine ?? ""}</span>
      <span>{row.newLine ?? ""}</span>
      <code>
        {row.lineKind === "add" ? "+" : row.lineKind === "delete" ? "-" : " "}
        {row.content}
      </code>
    </div>
  );
}

async function copyText(text: string, showToast: (message: string, tone?: "info" | "success" | "warning") => void) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制", "success");
      return;
    } catch {
      // Fall back to the legacy copy path below. Electron over plain http can
      // reject the async Clipboard API even when the action is user-triggered.
    }
  }
  if (copyTextWithTemporaryTextarea(text)) {
    showToast("已复制", "success");
    return;
  }
  showToast("当前浏览器不允许直接写入剪贴板", "warning");
}

function copyTextWithTemporaryTextarea(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
