import { AtSign, Paperclip, Send, X } from "lucide-react";
import type { ClipboardEvent } from "react";
import { useMemo, useRef, useState } from "react";
import type { AgentDefinition, ChatMessage } from "@agenthub/shared";
import { AvatarMark } from "../../components/AvatarMark";
import { formatBytes, validateUploadFile } from "../../utils/upload";

export function Composer({
  agents,
  conversationTitle,
  enableMentions = false,
  onSend,
  disabled,
  replyTarget,
  onCancelReply
}: {
  agents: AgentDefinition[];
  conversationTitle: string;
  enableMentions?: boolean;
  onSend: (text: string, replyToMessageId?: string, attachments?: File[]) => void;
  disabled?: boolean;
  replyTarget?: ChatMessage | null;
  onCancelReply?: () => void;
}) {
  const [text, setText] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const showMentions = enableMentions && /(^|\s)@[\w-]*$/.test(text);
  const visibleAgents = useMemo(() => agents, [agents]);
  const hasText = text.trim().length > 0;
  const hasAttachment = attachments.length > 0;

  const send = () => {
    if (disabled) return;
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    onSend(value, replyTarget?.id, attachments);
    setText("");
    setAttachments([]);
    onCancelReply?.();
  };

  const insertMention = (agent: AgentDefinition) => {
    const alias = agentAlias(agent);
    setText((current) => current.replace(/(^|\s)@[\w-]*$/, (_match, prefix: string) => `${prefix}@${alias} `));
  };

  const addAttachments = (files: FileList | null) => {
    if (!files || disabled) return;
    const next = [...attachments];
    Array.from(files).forEach((file) => {
      try {
        validateUploadFile(file, file.name, 50_000_000);
      } catch {
        return;
      }
      const exists = next.some((existing) => existing.name === file.name && existing.size === file.size);
      if (!exists) next.push(file);
    });
    setAttachments(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const pasteTextAtCursor = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText) return;
    event.preventDefault();
    const target = event.currentTarget;
    const selectionStart = target.selectionStart ?? text.length;
    const selectionEnd = target.selectionEnd ?? selectionStart;
    const nextText = `${text.slice(0, selectionStart)}${pastedText}${text.slice(selectionEnd)}`;
    setText(nextText);
    window.requestAnimationFrame(() => {
      const nextCursor = selectionStart + pastedText.length;
      target.focus();
      target.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <div className="composer-wrap">
      {showMentions ? (
        <div className="mention-menu">
          {visibleAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => insertMention(agent)}
            >
              <AvatarMark className="mini-avatar" kind="agent" size="sm" value={agent.avatar} label={agent.name} />
              <strong>{agent.name}</strong>
              <small>{agent.description}</small>
            </button>
          ))}
        </div>
      ) : null}
      {replyTarget ? (
        <div className="composer-reply-preview">
          <span>
            引用 {replyTarget.sender.name}: {summarizeMessage(replyTarget)}
          </span>
          <button type="button" title="取消引用" onClick={onCancelReply}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-attachment-list">
          {attachments.map((file, index) => (
            <div
              className="composer-attachment-preview"
              key={`${file.name}-${file.size}-${index}`}
              title={`${file.name} (${formatBytes(file.size)})`}
            >
              <span>{file.name}</span>
              <span className="muted-text">{formatBytes(file.size)}</span>
              <button type="button" title="移除" onClick={() => removeAttachment(index)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <textarea
          value={text}
          placeholder={`发送给 ${conversationTitle}`}
          onChange={(event) => setText(event.target.value)}
          onPaste={pasteTextAtCursor}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-toolbar">
          <button
            type="button"
            title="添加附件"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <Paperclip size={19} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => addAttachments(event.target.files)}
          />
          {enableMentions ? (
            <button type="button" title="@ Agent" onClick={() => setText((current) => `${current}@`)}>
              <AtSign size={21} />
            </button>
          ) : null}
          <button className="send-button" type="button" disabled={disabled || (!hasText && !hasAttachment)} onClick={send} title="发送">
            <Send size={22} />
          </button>
        </div>
      </div>
    </div>
  );
}

function agentAlias(agent: AgentDefinition) {
  if (agent.provider === "codex") return "codex";
  if (agent.provider === "opencode") return "opencode";
  if (agent.type === "orchestrator") return "orchestrator";
  return agent.id.replace(/^agent-/, "").toLowerCase();
}

function summarizeMessage(message: ChatMessage) {
  const text = message.blocks.map((block) => (block.type === "markdown" ? block.payload.text : `[${block.type}]`)).join(" ");
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean || "非文本消息";
}
