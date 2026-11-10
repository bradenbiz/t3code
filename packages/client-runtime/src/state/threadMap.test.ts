import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, type OrchestrationV2ThreadMapNode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { layoutThreadMap, type ThreadMapLayoutOptions } from "./threadMap.ts";

const projectId = ProjectId.make("project:a");
const options: ThreadMapLayoutOptions = {
  projectId: null,
  focusThreadId: null,
  showSubagents: true,
  showUnconnected: false,
  columnWidth: 100,
  rowHeight: 10,
  groupGap: 5,
};

const node = (
  id: string,
  input: Partial<Omit<OrchestrationV2ThreadMapNode, "threadId" | "updatedAt">> & {
    updatedAt?: number;
  } = {},
): OrchestrationV2ThreadMapNode => ({
  projectId,
  title: id,
  parentThreadId: null,
  relationshipToParent: null,
  sideChat: false,
  archived: false,
  ...input,
  threadId: ThreadId.make(id),
  updatedAt: DateTime.makeUnsafe(input.updatedAt ?? 0),
});
const edge = (sender: string, receiver: string, launched: boolean, messageCount = 1) => ({
  senderThreadId: ThreadId.make(sender),
  receiverThreadId: ThreadId.make(receiver),
  launched,
  messageCount,
  lastMessageAt: DateTime.makeUnsafe(0),
});
const positions = (layout: ReturnType<typeof layoutThreadMap>) =>
  Object.fromEntries(layout.nodes.map((entry) => [entry.node.threadId, [entry.x, entry.y]]));

describe("layoutThreadMap", () => {
  it("places launched and delegated threads one column right of their starter", () => {
    const layout = layoutThreadMap(
      {
        nodes: [
          node("director", { updatedAt: 1 }),
          node("delegate", {
            parentThreadId: ThreadId.make("director"),
            relationshipToParent: "subagent",
            updatedAt: 1,
          }),
          node("launched", { updatedAt: 2 }),
          node("peer", { updatedAt: 3 }),
          node("loose"),
        ],
        messageEdges: [
          edge("director", "delegate", true),
          edge("director", "launched", true),
          edge("launched", "peer", false, 3),
        ],
      },
      options,
    );
    expect(positions(layout)).toEqual({
      director: [0, 5],
      delegate: [100, 0],
      launched: [100, 10],
      peer: [0, 20],
    });
    expect(
      layout.edges.map((e) => [e.sourceThreadId, e.targetThreadId, e.kind, e.messageCount]),
    ).toEqual([
      ["director", "delegate", "subagent", 0],
      ["director", "launched", "launched", 1],
      ["launched", "peer", "messaged", 3],
    ]);
  });

  it("keeps only the focused group, and survives threads that launched each other", () => {
    const layout = layoutThreadMap(
      {
        nodes: [node("a"), node("b"), node("c"), node("d")],
        messageEdges: [edge("a", "b", true), edge("b", "a", true), edge("c", "d", true)],
      },
      { ...options, focusThreadId: ThreadId.make("b") },
    );
    expect(layout.nodes.map((entry) => entry.node.threadId).sort()).toEqual(["a", "b"]);
    expect(layout.width).toBe(200);
  });

  it("hides side chats and, on request, subagents and unconnected threads", () => {
    const map = {
      nodes: [
        node("parent"),
        node("side", { parentThreadId: ThreadId.make("parent"), sideChat: true }),
        node("sub", { parentThreadId: ThreadId.make("parent"), relationshipToParent: "subagent" }),
      ],
      messageEdges: [],
    };
    expect(
      layoutThreadMap(map, options)
        .nodes.map((entry) => entry.node.threadId)
        .sort(),
    ).toEqual(["parent", "sub"]);
    expect(layoutThreadMap(map, { ...options, showSubagents: false }).nodes).toEqual([]);
    expect(
      layoutThreadMap(map, { ...options, showSubagents: false, showUnconnected: true }).nodes,
    ).toHaveLength(1);
  });
});
