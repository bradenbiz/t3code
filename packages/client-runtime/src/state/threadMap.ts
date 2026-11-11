import type {
  OrchestrationV2ThreadMap,
  OrchestrationV2ThreadMapMessage,
  OrchestrationV2ThreadMapNode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadMapArrowKind = "fork" | "subagent" | "launched" | "messaged";

/** One thread's row: its card on the left, then a bar from when it started to its last activity. */
export interface ThreadMapLane {
  readonly node: OrchestrationV2ThreadMapNode;
  /** How many starters sit above it, for indenting its card. */
  readonly depth: number;
  readonly top: number;
  readonly height: number;
  readonly compact: boolean;
  readonly startX: number;
  readonly endX: number;
  /** In another project than the filter, shown because it is connected to one that is. */
  readonly outside: boolean;
}

/** One event between two rows: a thread starting another, or one message. */
export interface ThreadMapArrow {
  readonly key: string;
  readonly kind: ThreadMapArrowKind;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly at: DateTime.Utc;
  readonly x: number;
  /** The message behind it; null for a fork or subagent with no recorded first message. */
  readonly message: OrchestrationV2ThreadMapMessage | null;
}

/** A point on the time axis. Each event has its own, so arrows never share a column. */
export interface ThreadMapTick {
  readonly x: number;
  readonly at: DateTime.Utc;
}

export interface ThreadMapGroup {
  readonly top: number;
  readonly height: number;
  readonly lanes: ReadonlyArray<ThreadMapLane>;
  readonly arrows: ReadonlyArray<ThreadMapArrow>;
}

export interface ThreadMapLayout {
  readonly groups: ReadonlyArray<ThreadMapGroup>;
  /** One axis shared by every group. */
  readonly ticks: ReadonlyArray<ThreadMapTick>;
  readonly width: number;
  readonly height: number;
}

export interface ThreadMapLayoutOptions {
  readonly projectId: ProjectId | null;
  /** Only the group of threads connected to this one. */
  readonly focusThreadId: ThreadId | null;
  readonly showSubagents: boolean;
  readonly showUnconnected: boolean;
  /** Where the time axis starts; the cards sit left of it. */
  readonly timelineLeft: number;
  readonly slotWidth: number;
  readonly laneHeight: number;
  readonly compactLaneHeight: number;
  /** Room above the first group for the time axis. */
  readonly axisHeight: number;
  readonly groupGap: number;
}

const pairKey = (a: ThreadId, b: ThreadId) => (a < b ? `${a}\u001f${b}` : `${b}\u001f${a}`);
const millis = DateTime.toEpochMillis;

const lastActivity = (node: OrchestrationV2ThreadMapNode) =>
  Math.max(millis(node.updatedAt), node.lastMessageAt === null ? 0 : millis(node.lastMessageAt));

/**
 * Lays threads out on one timeline: a band per connected group, a row per thread right under the
 * thread that started it, and a column per start or message in time order across every group.
 * Columns are evenly spaced, not to scale, so arrows never share one and quiet hours take no room.
 */
export function layoutThreadMap(
  map: OrchestrationV2ThreadMap,
  options: ThreadMapLayoutOptions,
): ThreadMapLayout {
  const all = new Map(
    map.nodes
      .filter(
        (node) =>
          !node.sideChat && (options.showSubagents || node.relationshipToParent !== "subagent"),
      )
      .map((node) => [node.threadId, node]),
  );

  const lineagePairs = new Set<string>();
  for (const node of all.values()) {
    if (node.parentThreadId !== null && all.has(node.parentThreadId)) {
      lineagePairs.add(pairKey(node.parentThreadId, node.threadId));
    }
  }
  const firstMessageOf = new Map<ThreadId, OrchestrationV2ThreadMapMessage>();
  const launcherOf = new Map<ThreadId, ThreadId>();
  const messages: OrchestrationV2ThreadMapMessage[] = [];
  for (const message of map.messages) {
    if (!all.has(message.senderThreadId) || !all.has(message.receiverThreadId)) continue;
    if (message.launched) {
      firstMessageOf.set(message.receiverThreadId, message);
      // A lineage child's first message from its parent is its start, drawn as such.
      if (lineagePairs.has(pairKey(message.senderThreadId, message.receiverThreadId))) continue;
      launcherOf.set(message.receiverThreadId, message.senderThreadId);
    }
    messages.push(message);
  }

  const neighbors = new Map<ThreadId, Set<ThreadId>>();
  const link = (a: ThreadId, b: ThreadId) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      let set = neighbors.get(from);
      if (set === undefined) neighbors.set(from, (set = new Set()));
      set.add(to);
    }
  };
  for (const node of all.values()) {
    if (node.parentThreadId !== null && all.has(node.parentThreadId)) {
      link(node.parentThreadId, node.threadId);
    }
  }
  for (const message of messages) link(message.senderThreadId, message.receiverThreadId);

  const groups: ThreadId[][] = [];
  const grouped = new Set<ThreadId>();
  for (const threadId of all.keys()) {
    if (grouped.has(threadId)) continue;
    const group: ThreadId[] = [];
    const stack = [threadId];
    grouped.add(threadId);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (grouped.has(next)) continue;
        grouped.add(next);
        stack.push(next);
      }
    }
    groups.push(group);
  }

  const visibleGroups = groups.filter((group) => {
    if (options.focusThreadId !== null) return group.includes(options.focusThreadId);
    if (!options.showUnconnected && group.length === 1) return false;
    return (
      options.projectId === null || group.some((id) => all.get(id)!.projectId === options.projectId)
    );
  });
  const starterOf = (threadId: ThreadId): ThreadId | null => {
    const node = all.get(threadId)!;
    if (node.parentThreadId !== null && all.has(node.parentThreadId)) return node.parentThreadId;
    return launcherOf.get(threadId) ?? null;
  };
  /** A thread launched by message starts at that message, so the two share a column. */
  const launchMessageOf = (threadId: ThreadId) => {
    const first = firstMessageOf.get(threadId);
    return first !== undefined && launcherOf.get(threadId) === first.senderThreadId
      ? first
      : undefined;
  };
  const startOf = (threadId: ThreadId) =>
    launchMessageOf(threadId)?.createdAt ?? all.get(threadId)!.createdAt;
  const byStart = (a: ThreadId, b: ThreadId) => millis(startOf(a)) - millis(startOf(b));
  const groupStart = (group: ReadonlyArray<ThreadId>) =>
    Math.min(...group.map((id) => millis(startOf(id))));
  // Newest first, so the top right corner is now and older groups step down and to the left.
  visibleGroups.sort((a, b) => groupStart(b) - groupStart(a));

  // One axis for every group: a column per start or message, in time order.
  type Event =
    | { kind: "start"; threadId: ThreadId; at: DateTime.Utc }
    | { kind: "message"; message: OrchestrationV2ThreadMapMessage; at: DateTime.Utc };
  const visible = new Set(visibleGroups.flat());
  const events: Event[] = [];
  for (const threadId of visible) {
    if (launchMessageOf(threadId) === undefined) {
      events.push({ kind: "start", threadId, at: startOf(threadId) });
    }
  }
  for (const message of messages) {
    if (visible.has(message.receiverThreadId)) {
      events.push({ kind: "message", message, at: message.createdAt });
    }
  }
  events.sort((a, b) => millis(a.at) - millis(b.at));

  const slotX = (index: number) => options.timelineLeft + (index + 0.5) * options.slotWidth;
  const ticks: ThreadMapTick[] = [];
  const arrowsOf = new Map<ThreadId, ThreadMapArrow[]>();
  const startX = new Map<ThreadId, number>();
  const addArrow = (arrow: ThreadMapArrow) =>
    arrowsOf.set(arrow.targetThreadId, [...(arrowsOf.get(arrow.targetThreadId) ?? []), arrow]);
  events.forEach((event, index) => {
    const x = slotX(index);
    ticks.push({ x, at: event.at });
    if (event.kind === "message") {
      const { message } = event;
      const launch = launchMessageOf(message.receiverThreadId) === message;
      if (launch) startX.set(message.receiverThreadId, x);
      addArrow({
        key: message.messageId,
        kind: launch ? "launched" : "messaged",
        sourceThreadId: message.senderThreadId,
        targetThreadId: message.receiverThreadId,
        at: message.createdAt,
        x,
        message,
      });
      return;
    }
    startX.set(event.threadId, x);
    const node = all.get(event.threadId)!;
    if (node.parentThreadId === null || !visible.has(node.parentThreadId)) return;
    addArrow({
      key: `start:${event.threadId}`,
      kind: node.relationshipToParent === "subagent" ? "subagent" : "fork",
      sourceThreadId: node.parentThreadId,
      targetThreadId: event.threadId,
      at: event.at,
      x,
      message: firstMessageOf.get(event.threadId) ?? null,
    });
  });

  /** The x of the last column at or before a time, so a row ends where its activity did. */
  const xAtOrBefore = (at: number) => {
    let found = 0;
    for (let index = 0; index < events.length && millis(events[index]!.at) <= at; index++) {
      found = index;
    }
    return slotX(found);
  };

  const laid: ThreadMapGroup[] = [];
  let top = options.axisHeight;
  for (const group of visibleGroups) {
    const members = new Set(group);
    const children = new Map<ThreadId, ThreadId[]>();
    const roots: ThreadId[] = [];
    for (const threadId of group) {
      const starter = starterOf(threadId);
      if (starter === null || !members.has(starter)) roots.push(threadId);
      else children.set(starter, [...(children.get(starter) ?? []), threadId]);
    }
    const order: { threadId: ThreadId; depth: number }[] = [];
    const reached = new Set<ThreadId>();
    const visit = (threadId: ThreadId, depth: number) => {
      if (reached.has(threadId)) return;
      reached.add(threadId);
      order.push({ threadId, depth });
      for (const kid of [...(children.get(threadId) ?? [])].sort(byStart)) visit(kid, depth + 1);
    };
    for (const root of [...roots].sort(byStart)) visit(root, 0);
    // Starters can form a cycle (two threads launching each other); the oldest unreached leads.
    for (const threadId of [...group].sort(byStart)) visit(threadId, 0);

    const lanes: ThreadMapLane[] = [];
    const arrows: ThreadMapArrow[] = [];
    let laneTop = top;
    for (const { threadId, depth } of order) {
      const node = all.get(threadId)!;
      const compact = node.relationshipToParent === "subagent";
      const height = compact ? options.compactLaneHeight : options.laneHeight;
      const start = startX.get(threadId) ?? slotX(0);
      lanes.push({
        node,
        depth,
        top: laneTop,
        height,
        compact,
        startX: start,
        endX: Math.max(start, xAtOrBefore(lastActivity(node))) + options.slotWidth / 2,
        outside: options.projectId !== null && node.projectId !== options.projectId,
      });
      arrows.push(...(arrowsOf.get(threadId) ?? []));
      laneTop += height;
    }
    arrows.sort((a, b) => a.x - b.x);
    laid.push({ top, height: laneTop - top, lanes, arrows });
    top = laneTop + options.groupGap;
  }

  return {
    groups: laid,
    ticks,
    width: slotX(events.length),
    height: laid.length === 0 ? 0 : top - options.groupGap,
  };
}
