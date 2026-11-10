import type {
  OrchestrationV2ThreadMap,
  OrchestrationV2ThreadMapNode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadMapEdgeKind = "fork" | "subagent" | "launched" | "messaged";

export interface ThreadMapLayoutNode {
  readonly node: OrchestrationV2ThreadMapNode;
  readonly x: number;
  readonly y: number;
  /** In another project than the filter, shown because it is connected to one that is. */
  readonly outside: boolean;
}

export interface ThreadMapLayoutEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadMapEdgeKind;
  readonly messageCount: number;
}

export interface ThreadMapLayout {
  readonly nodes: ReadonlyArray<ThreadMapLayoutNode>;
  readonly edges: ReadonlyArray<ThreadMapLayoutEdge>;
  readonly width: number;
  readonly height: number;
}

export interface ThreadMapLayoutOptions {
  readonly projectId: ProjectId | null;
  /** Only the group of threads connected to this one. */
  readonly focusThreadId: ThreadId | null;
  readonly showSubagents: boolean;
  readonly showUnconnected: boolean;
  readonly columnWidth: number;
  readonly rowHeight: number;
  readonly groupGap: number;
}

const pairKey = (a: ThreadId, b: ThreadId) => (a < b ? `${a}\u001f${b}` : `${b}\u001f${a}`);

/**
 * Lays threads out left to right: each thread sits one column right of the thread that started it
 * (its lineage parent, else the thread that launched it). Messages between threads are drawn but
 * do not move anything. Each connected group gets its own band, the most recently active first.
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

  const edges: ThreadMapLayoutEdge[] = [];
  const lineagePairs = new Set<string>();
  for (const node of all.values()) {
    if (node.parentThreadId === null || !all.has(node.parentThreadId)) continue;
    lineagePairs.add(pairKey(node.parentThreadId, node.threadId));
    edges.push({
      sourceThreadId: node.parentThreadId,
      targetThreadId: node.threadId,
      kind: node.relationshipToParent === "subagent" ? "subagent" : "fork",
      messageCount: 0,
    });
  }
  const launcherOf = new Map<ThreadId, ThreadId>();
  for (const edge of map.messageEdges) {
    if (!all.has(edge.senderThreadId) || !all.has(edge.receiverThreadId)) continue;
    // Delegated children carry their parent as sender; the lineage edge already shows it.
    if (lineagePairs.has(pairKey(edge.senderThreadId, edge.receiverThreadId))) continue;
    if (edge.launched) launcherOf.set(edge.receiverThreadId, edge.senderThreadId);
    edges.push({
      sourceThreadId: edge.senderThreadId,
      targetThreadId: edge.receiverThreadId,
      kind: edge.launched ? "launched" : "messaged",
      messageCount: edge.messageCount,
    });
  }

  const neighbors = new Map<ThreadId, Set<ThreadId>>();
  const link = (a: ThreadId, b: ThreadId) => {
    let set = neighbors.get(a);
    if (set === undefined) neighbors.set(a, (set = new Set()));
    set.add(b);
  };
  for (const edge of edges) {
    link(edge.sourceThreadId, edge.targetThreadId);
    link(edge.targetThreadId, edge.sourceThreadId);
  }

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
  const lastActive = (group: ReadonlyArray<ThreadId>) =>
    Math.max(...group.map((id) => DateTime.toEpochMillis(all.get(id)!.updatedAt)));
  visibleGroups.sort((a, b) => lastActive(b) - lastActive(a));

  const starterOf = (threadId: ThreadId): ThreadId | null => {
    const node = all.get(threadId)!;
    if (node.parentThreadId !== null && all.has(node.parentThreadId)) return node.parentThreadId;
    return launcherOf.get(threadId) ?? null;
  };
  const byRecency = (a: ThreadId, b: ThreadId) =>
    DateTime.toEpochMillis(all.get(a)!.updatedAt) - DateTime.toEpochMillis(all.get(b)!.updatedAt);

  const placed: ThreadMapLayoutNode[] = [];
  let top = 0;
  let maxDepth = 0;
  for (const group of visibleGroups) {
    const members = new Set(group);
    const children = new Map<ThreadId, ThreadId[]>();
    const roots: ThreadId[] = [];
    for (const threadId of group) {
      const starter = starterOf(threadId);
      if (starter === null || !members.has(starter)) roots.push(threadId);
      else children.set(starter, [...(children.get(starter) ?? []), threadId]);
    }
    // Starters can form a cycle (two threads launching each other); break it at the oldest.
    const reached = new Set<ThreadId>();
    let row = 0;
    const positions = new Map<ThreadId, { depth: number; row: number }>();
    const place = (threadId: ThreadId, depth: number): number => {
      reached.add(threadId);
      maxDepth = Math.max(maxDepth, depth);
      const kids = (children.get(threadId) ?? [])
        .filter((kid) => !reached.has(kid))
        .sort(byRecency);
      if (kids.length === 0) {
        positions.set(threadId, { depth, row });
        return row++;
      }
      const rows = kids.map((kid) => place(kid, depth + 1));
      const center = (rows[0]! + rows[rows.length - 1]!) / 2;
      positions.set(threadId, { depth, row: center });
      return center;
    };
    for (const root of roots.sort(byRecency)) place(root, 0);
    for (const threadId of [...group].sort(byRecency)) {
      if (!reached.has(threadId)) place(threadId, 0);
    }
    for (const [threadId, position] of positions) {
      const node = all.get(threadId)!;
      placed.push({
        node,
        x: position.depth * options.columnWidth,
        y: top + position.row * options.rowHeight,
        outside: options.projectId !== null && node.projectId !== options.projectId,
      });
    }
    top += row * options.rowHeight + options.groupGap;
  }

  const shown = new Set(placed.map((entry) => entry.node.threadId));
  return {
    nodes: placed,
    edges: edges.filter((edge) => shown.has(edge.sourceThreadId) && shown.has(edge.targetThreadId)),
    width: placed.length === 0 ? 0 : (maxDepth + 1) * options.columnWidth,
    height: Math.max(0, top - options.groupGap),
  };
}
