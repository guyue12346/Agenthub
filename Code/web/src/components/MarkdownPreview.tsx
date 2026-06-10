import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

type MarkdownPreviewProps = {
  source: string;
  className?: string;
};

export function MarkdownPreview({ source, className = "markdown-block" }: MarkdownPreviewProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          strong({ children }) {
            const text = String(children);
            if (text.startsWith("@")) return <span className="mention-token">{children}</span>;
            return <strong>{children}</strong>;
          }
        }}
      >
        {highlightMentions(source)}
      </ReactMarkdown>
    </div>
  );
}

export function highlightMentions(text: string) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part) => {
      if (part.startsWith("`")) return part;
      return part.replace(/@([a-zA-Z][\w-]*)/g, "**@$1**");
    })
    .join("");
}
