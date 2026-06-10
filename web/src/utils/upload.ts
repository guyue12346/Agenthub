export const MAX_BROWSER_UPLOAD_BYTES = 50_000_000;
export const DEFAULT_UPLOAD_CHUNK_BYTES = 1_000_000;

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function validateUploadFile(file: File, label = "文件", maxBytes = MAX_BROWSER_UPLOAD_BYTES) {
  if (file.size <= 0) throw new Error(`${label}不能为空`);
  if (file.size > maxBytes) throw new Error(`${label}不能超过 ${formatBytes(maxBytes)}`);
}

export function readFileAsBase64(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
    errorMessage?: string;
  } = {}
) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    const reader = new FileReader();
    const total = file.size;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      if (reader.readyState === FileReader.LOADING) reader.abort();
      reject(abortError());
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error(options.errorMessage ?? "读取文件失败"));
    };
    reader.onabort = () => {
      cleanup();
      reject(abortError());
    };
    reader.onprogress = (event) => {
      const loaded = event.lengthComputable ? event.loaded : Math.min(total, event.loaded || 0);
      options.onProgress?.(toProgress(loaded, total));
    };
    reader.onload = () => {
      cleanup();
      options.onProgress?.(toProgress(total, total));
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadFileInChunks<TComplete>(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
    begin: (file: { name: string; mimeType: string; size: number }) => Promise<{ uploadId: string; workspaceId: string; chunkSize: number }>;
    uploadChunk: (session: { uploadId: string; workspaceId: string }, chunk: { offset: number; contentBase64: string }) => Promise<unknown>;
    complete: (session: { uploadId: string; workspaceId: string }) => Promise<TComplete>;
    cancel?: (session: { uploadId: string; workspaceId: string }) => Promise<unknown>;
  }
) {
  validateUploadFile(file);
  let session: { uploadId: string; workspaceId: string; chunkSize: number } | undefined;
  try {
    session = await options.begin({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size });
    const chunkSize = Math.max(1, Math.min(session.chunkSize || DEFAULT_UPLOAD_CHUNK_BYTES, DEFAULT_UPLOAD_CHUNK_BYTES));
    let offset = 0;
    options.onProgress?.(toProgress(0, file.size));
    while (offset < file.size) {
      if (options.signal?.aborted) throw abortError();
      const end = Math.min(offset + chunkSize, file.size);
      const contentBase64 = await readBlobAsBase64(file.slice(offset, end), options.signal ? { signal: options.signal } : {});
      await options.uploadChunk(session, { offset, contentBase64 });
      offset = end;
      options.onProgress?.(toProgress(offset, file.size));
    }
    return await options.complete(session);
  } catch (error) {
    if (session && options.signal?.aborted) await options.cancel?.(session).catch(() => undefined);
    throw error;
  }
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function toProgress(loaded: number, total: number): UploadProgress {
  const safeTotal = Math.max(total, 1);
  const safeLoaded = Math.min(Math.max(loaded, 0), safeTotal);
  return {
    loaded: safeLoaded,
    total: safeTotal,
    percent: Math.round((safeLoaded / safeTotal) * 100)
  };
}

function readBlobAsBase64(blob: Blob, options: { signal?: AbortSignal } = {}) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const reader = new FileReader();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      if (reader.readyState === FileReader.LOADING) reader.abort();
      reject(abortError());
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error("读取文件分片失败"));
    };
    reader.onabort = () => {
      cleanup();
      reject(abortError());
    };
    reader.onload = () => {
      cleanup();
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function abortError() {
  const error = new Error("上传已取消");
  error.name = "AbortError";
  return error;
}
