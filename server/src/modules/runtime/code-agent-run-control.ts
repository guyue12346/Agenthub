export function createCodeAgentRunAbortSignal(_timeoutMs: number, parent?: AbortSignal | undefined) {
  const controller = new AbortController();
  let reason: "timeout" | "cancelled" | undefined;
  const abort = (nextReason: "timeout" | "cancelled") => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort();
  };
  const onParentAbort = () => abort("cancelled");
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) abort("cancelled");
  return {
    signal: controller.signal,
    timedOut: () => reason === "timeout",
    cancelled: () => reason === "cancelled",
    dispose: () => {
      parent?.removeEventListener("abort", onParentAbort);
    }
  };
}
