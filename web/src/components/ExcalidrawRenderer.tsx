import { lazy, Suspense } from "react";

const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";
const LazyExcalidrawPreview = lazy(() => import("./ExcalidrawRendererImpl").then((module) => ({ default: module.ExcalidrawPreviewImpl })));
const LazyExcalidrawEditor = lazy(() => import("./ExcalidrawRendererImpl").then((module) => ({ default: module.ExcalidrawEditorImpl })));

export function isExcalidrawFile(file: { name?: string | null | undefined; mimeType?: string | null | undefined }) {
  const name = (file.name ?? "").toLowerCase();
  const mimeType = (file.mimeType ?? "").toLowerCase();
  return name.endsWith(".excalidraw") || mimeType === EXCALIDRAW_MIME;
}

export function emptyExcalidrawContent() {
  return JSON.stringify(createBlankExcalidrawData(), null, 2);
}

export function ExcalidrawPreview({ content, name }: { content: string; name: string }) {
  return (
    <Suspense fallback={<div className="asset-excalidraw-empty">正在加载 Excalidraw...</div>}>
      <LazyExcalidrawPreview content={content} name={name} />
    </Suspense>
  );
}

export function ExcalidrawEditor({
  content,
  name,
  onChangeContent
}: {
  content: string;
  name: string;
    onChangeContent: (content: string) => void;
  }) {
  return (
    <Suspense fallback={<div className="asset-excalidraw-empty">正在加载 Excalidraw 编辑器...</div>}>
      <LazyExcalidrawEditor content={content} name={name} onChangeContent={onChangeContent} />
    </Suspense>
  );
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
