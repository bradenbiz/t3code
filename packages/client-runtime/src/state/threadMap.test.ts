import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadMap,
  type OrchestrationV2ThreadMapNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { layoutThreadMap, type ThreadMapLayoutOptions } from "./threadMap.ts";

const projectId = ProjectId.make("project:a");
const options: ThreadMapLayoutOptions = {
  projectId: null,
  focusThreadId: null,
  showSubagents: true,
  showUnconnected: false,
  timelineLeft: 100,
  slotWidth: 10,
  laneHeight: 20,
  compactLaneHeight: 10,
  axisHeight: 5,
  groupGap: 7,
};

const node = (
  id: string,
  input: Partial<Omit<OrchestrationV2ThreadMapNode, "threadId" | "createdAt" | "updatedAt">> & {
    createdAt?: number;
    updatedAt?: number;
  } = {},
): OrchestrationV2ThreadMapNode => ({
  projectId,
  title: id,
  parentThreadId: null,
  relationshipToParent: null,
  sideChat: false,
  archived: false,
  messageCount: 0,
  lastMessageAt: null,
  ...input,
  threadId: ThreadId.make(id),
  createdAt: DateTime.makeUnsafe(input.createdAt ?? 0),
  updatedAt: DateTime.makeUnsafe(input.updatedAt ?? input.createdAt ?? 0),
});
const message = (id: string, sender: string, receiver: string, at: number, launched = false) => ({
  messageId: MessageId.make(id),
  senderThreadId: ThreadId.make(sender),
  receiverThreadId: ThreadId.make(receiver),
  launched,
  createdAt: DateTime.makeUnsafe(at),
  preview: id,
});
const rows = (layout: ReturnType<typeof layoutThreadMap>) =>
  layout.groups.flatMap((group) =>
    group.lanes.map((lane) => [lane.node.threadId, lane.depth, lane.top, lane.compact]),
  );
const arrows = (layout: ReturnType<typeof layoutThreadMap>) =>
  layout.groups.flatMap((group) =>
    group.arrows.map((arrow) => [
      arrow.kind,
      arrow.sourceThreadId,
      arrow.targetThreadId,
      arrow.x,
      arrow.message?.messageId ?? null,
    ]),
  );

describe("layoutThreadMap", () => {
  const map: OrchestrationV2ThreadMap = {
    nodes: [
      node("director", { createdAt: 0, updatedAt: 60 }),
      node("delegate", {
        parentThreadId: ThreadId.make("director"),
        relationshipToParent: "subagent",
        createdAt: 10,
      }),
      node("launched", { createdAt: 20 }),
      node("peer", { createdAt: 5 }),
      node("loose"),
    ],
    messages: [
      message("delegate-task", "director", "delegate", 10, true),
      message("launch", "director", "launched", 20, true),
      message("first-ping", "launched", "peer", 30),
      message("second-ping", "launched", "peer", 40),
    ],
  };

  it("puts each thread under its starter and gives every start and message its own column", () => {
    const layout = layoutThreadMap(map, options);
    expect(rows(layout)).toEqual([
      ["director", 0, 5, false],
      ["delegate", 1, 25, true],
      ["launched", 1, 35, false],
      ["peer", 0, 55, false],
    ]);
    expect(arrows(layout)).toEqual([
      ["subagent", "director", "delegate", 125, "delegate-task"],
      ["launched", "director", "launched", 135, "launch"],
      ["messaged", "launched", "peer", 145, "first-ping"],
      ["messaged", "launched", "peer", 155, "second-ping"],
    ]);
    const lanes = new Map(layout.groups[0]!.lanes.map((lane) => [lane.node.threadId, lane]));
    expect([
      lanes.get(ThreadId.make("director"))!.startX,
      lanes.get(ThreadId.make("director"))!.endX,
    ]).toEqual([105, 160]);
    expect(lanes.get(ThreadId.make("launched"))!.startX).toBe(135);
  });

  it("puts every group on one time axis, the group that started last on top", () => {
    const layout = layoutThreadMap(
      {
        nodes: [
          node("old", { createdAt: 0 }),
          node("old-child", { createdAt: 30 }),
          node("new", { createdAt: 10 }),
          node("new-child", { createdAt: 20 }),
        ],
        messages: [
          message("old-launch", "old", "old-child", 30, true),
          message("new-launch", "new", "new-child", 20, true),
        ],
      },
      options,
    );
    expect(rows(layout).map(([threadId]) => threadId)).toEqual([
      "new",
      "new-child",
      "old",
      "old-child",
    ]);
    expect(arrows(layout).map(([, , target, x]) => [target, x])).toEqual([
      ["new-child", 125],
      ["old-child", 135],
    ]);
    expect(layout.ticks.map((tick) => tick.x)).toEqual([105, 115, 125, 135]);
  });

  it("keeps only the focused group, and survives threads that launched each other", () => {
    const layout = layoutThreadMap(
      {
        nodes: [node("a"), node("b", { createdAt: 1 }), node("c"), node("d")],
        messages: [
          message("ab", "a", "b", 1, true),
          message("ba", "b", "a", 2, true),
          message("cd", "c", "d", 1, true),
        ],
      },
      { ...options, focusThreadId: ThreadId.make("b") },
    );
    expect(rows(layout).map(([threadId]) => threadId)).toEqual(["b", "a"]);
  });

  it("hides side chats and, on request, subagents and unconnected threads", () => {
    const small: OrchestrationV2ThreadMap = {
      nodes: [
        node("parent"),
        node("side", { parentThreadId: ThreadId.make("parent"), sideChat: true }),
        node("sub", { parentThreadId: ThreadId.make("parent"), relationshipToParent: "subagent" }),
      ],
      messages: [],
    };
    expect(rows(layoutThreadMap(small, options)).map(([threadId]) => threadId)).toEqual([
      "parent",
      "sub",
    ]);
    expect(layoutThreadMap(small, { ...options, showSubagents: false }).groups).toEqual([]);
    expect(
      layoutThreadMap(small, { ...options, showSubagents: false, showUnconnected: true }).groups,
    ).toHaveLength(1);
  });
});
