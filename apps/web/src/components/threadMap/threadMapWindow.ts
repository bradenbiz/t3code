import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { buildThreadRouteParams } from "~/threadRoutes";

/** `window.name` of the separate map window, so it hands thread clicks back to its opener. */
export const THREAD_MAP_WINDOW_NAME = "t3-thread-map";
const OPEN_THREAD_MESSAGE = "t3:thread-map:open-thread";

interface ThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

function sameOriginOpener(): Window | null {
  if (window.name !== THREAD_MAP_WINDOW_NAME || window.opener === null) return null;
  try {
    return (window.opener as Window).location.origin === window.location.origin
      ? (window.opener as Window)
      : null;
  } catch {
    return null;
  }
}

/** In the map window the thread opens in the main window, so the map stays in view. */
export function openThreadFromMap(navigate: ReturnType<typeof useNavigate>, ref: ThreadRef) {
  const opener = sameOriginOpener();
  if (opener !== null) {
    opener.postMessage({ type: OPEN_THREAD_MESSAGE, ...ref }, window.location.origin);
    opener.focus();
    return;
  }
  void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}

export function useThreadMapOpenerBridge() {
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for thread clicks posted by the map window
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<ThreadRef & { type: string }> | null;
      if (data?.type !== OPEN_THREAD_MESSAGE || !data.environmentId || !data.threadId) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: data.environmentId,
          threadId: data.threadId,
        }),
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);
}
