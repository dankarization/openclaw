// Telegram plugin module owns detached-subagent typing lifecycle state.
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS } from "./chat-action-timing.js";
import type { TelegramSubagentTypingPresentation } from "./subagent-typing-policy.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramSubagentTypingRoute = {
  accountId?: string;
  to: string;
  threadId?: string | number;
};

type TelegramSubagentProgressEvent = {
  phase: "started" | "ended";
  runId: string;
  /** Core-owned. Missing or false must not allocate public typing. */
  publicPresentation?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type ActiveRoute = {
  key: string;
  typing: ReturnType<typeof createTypingCallbacks>;
  runIds: Set<string>;
};

type ActiveRun = {
  route: ActiveRoute;
  expiryTimer: ReturnType<typeof setTimeout>;
};

function resolveTelegramTypingRoute(
  event: TelegramSubagentProgressEvent,
): TelegramSubagentTypingRoute | undefined {
  const requester = event.requester;
  const to = requester?.to?.trim();
  if (
    requester?.channel !== "telegram" ||
    !to ||
    parseTelegramTarget(to).directMessagesTopicId != null
  ) {
    return undefined;
  }
  return {
    ...(requester.accountId ? { accountId: requester.accountId } : {}),
    to,
    ...(requester.threadId !== undefined ? { threadId: requester.threadId } : {}),
  };
}

function buildTelegramTypingRouteKey(route: TelegramSubagentTypingRoute): string {
  return JSON.stringify([route.accountId ?? "", route.to, route.threadId ?? ""]);
}

export function createTelegramSubagentTyping(params: {
  sendTyping: (route: TelegramSubagentTypingRoute) => Promise<void>;
  onTypingError: (err: unknown, route: TelegramSubagentTypingRoute) => void;
}) {
  const routes = new Map<string, ActiveRoute>();
  const runs = new Map<string, ActiveRun>();
  let disposed = false;

  const removeRun = (runId: string) => {
    const run = runs.get(runId);
    if (!run) {
      return;
    }
    clearTimeout(run.expiryTimer);
    runs.delete(runId);

    const activeRoute = run.route;
    activeRoute.runIds.delete(runId);
    if (activeRoute.runIds.size > 0) {
      return;
    }
    activeRoute.typing.onCleanup?.();
    routes.delete(activeRoute.key);
  };

  const handle = (
    event: TelegramSubagentProgressEvent,
    presentation?: TelegramSubagentTypingPresentation,
  ): void => {
    if (disposed) {
      return;
    }
    if (event.phase === "ended") {
      removeRun(event.runId);
      return;
    }
    if (runs.has(event.runId)) {
      return;
    }
    // Quiet/internal runs and typingMode "never" must not allocate a route.
    // Authority lifetime remains a maintainer decision; do not reconstruct it here.
    if (event.publicPresentation !== true || presentation?.enabled !== true) {
      return;
    }

    const route = resolveTelegramTypingRoute(event);
    if (!route) {
      return;
    }
    const routeKey = buildTelegramTypingRouteKey(route);
    let activeRoute = routes.get(routeKey);
    if (!activeRoute) {
      activeRoute = {
        key: routeKey,
        typing: createTypingCallbacks({
          start: () => params.sendTyping(route),
          onStartError: (err) => params.onTypingError(err, route),
          keepaliveIntervalMs: presentation.intervalMs,
          maxDurationMs: 0,
        }),
        runIds: new Set(),
      };
      routes.set(routeKey, activeRoute);
      void activeRoute.typing.onReplyStart();
    }

    const expiryTimer = setTimeout(
      () => removeRun(event.runId),
      TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS,
    );
    expiryTimer.unref?.();
    activeRoute.runIds.add(event.runId);
    runs.set(event.runId, { route: activeRoute, expiryTimer });
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const run of runs.values()) {
      clearTimeout(run.expiryTimer);
    }
    for (const activeRoute of routes.values()) {
      activeRoute.typing.onCleanup?.();
    }
    runs.clear();
    routes.clear();
  };

  return { handle, dispose };
}
