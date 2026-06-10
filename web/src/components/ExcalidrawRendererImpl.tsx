import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef } from "react";
import { emptyExcalidrawContent } from "./ExcalidrawRenderer";

type ExcalidrawInitialData = NonNullable<ComponentProps<typeof Excalidraw>["initialData"]>;

type ExcalidrawParseResult = {
  data: ExcalidrawInitialData;
  error: string | null;
  empty: boolean;
};

const EXCALIDRAW_UI_OPTIONS = {
  canvasActions: {
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false
  },
  welcomeScreen: false
} as const;

export function ExcalidrawPreviewImpl({ content, name }: { content: string; name: string }) {
  const parsed = useMemo(() => parseExcalidrawContent(content), [content]);
  if (parsed.error) {
    return (
      <div className="asset-excalidraw-error">
        <strong>Excalidraw 文件解析失败</strong>
        <span>{parsed.error}</span>
      </div>
    );
  }
  return (
    <div className="asset-excalidraw-preview" aria-label={`${name} 预览`}>
      {parsed.empty ? <div className="asset-excalidraw-empty">空白 Excalidraw 画布</div> : null}
      <Excalidraw
        initialData={parsed.data}
        viewModeEnabled
        zenModeEnabled
        UIOptions={EXCALIDRAW_UI_OPTIONS}
      />
    </div>
  );
}

export function ExcalidrawEditorImpl({
  content,
  name,
  onChangeContent
}: {
  content: string;
  name: string;
  onChangeContent: (content: string) => void;
}) {
  const parsed = useMemo(() => parseExcalidrawContent(content), [content]);
  const latestContentRef = useRef(content);

  useEffect(() => {
    latestContentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (!content.trim() || parsed.error) {
      const next = emptyExcalidrawContent();
      latestContentRef.current = next;
      onChangeContent(next);
    }
  }, [content, onChangeContent, parsed.error]);

  return (
    <div className="workspace-excalidraw-editor" aria-label={`${name} 编辑器`}>
      <Excalidraw
        initialData={parsed.data}
        zenModeEnabled
        UIOptions={EXCALIDRAW_UI_OPTIONS}
        onChange={(elements, appState, files) => {
          const next = serializeAsJSON(elements, appState, files, "local");
          if (next !== latestContentRef.current) {
            latestContentRef.current = next;
            onChangeContent(next);
          }
        }}
      />
    </div>
  );
}

function parseExcalidrawContent(content: string): ExcalidrawParseResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { data: createBlankExcalidrawData() as ExcalidrawInitialData, error: null, empty: true };
  }
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const data = {
      type: typeof raw.type === "string" ? raw.type : "excalidraw",
      version: typeof raw.version === "number" ? raw.version : 2,
      source: typeof raw.source === "string" ? raw.source : "https://excalidraw.com",
      elements: Array.isArray(raw.elements) ? raw.elements : [],
      appState: isPlainRecord(raw.appState) ? raw.appState : {},
      files: isPlainRecord(raw.files) ? raw.files : {},
      scrollToContent: true
    };
    return { data: data as ExcalidrawInitialData, error: null, empty: data.elements.length === 0 };
  } catch (error) {
    return {
      data: createBlankExcalidrawData() as ExcalidrawInitialData,
      error: error instanceof Error ? error.message : "不是合法的 Excalidraw JSON",
      empty: false
    };
  }
}

function createBlankExcalidrawData() {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: {
      viewBackgroundColor: "#ffffff"
    },
    files: {},
    scrollToContent: true
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
