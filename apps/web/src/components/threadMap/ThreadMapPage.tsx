import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  layoutThreadMap,
  type ThreadMapArrow,
  type ThreadMapArrowKind,
  type ThreadMapGroup,
  type ThreadMapLane,
} from "@t3tools/client-runtime/state/thread-map";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  OrchestrationV2ThreadMapNode,
  ProjectId,
  ThreadId,
  TimestampFormat,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  BotIcon,
  ExternalLinkIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
  ScanSearchIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useProject, useProjects, useThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useClientSettings } from "../../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { threadRelationshipStatusLabel } from "../chat/ThreadRelationshipIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { openThreadFromMap, THREAD_MAP_WINDOW_NAME } from "./threadMapWindow";

export interface ThreadMapSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly focus?: ThreadId;
  readonly subagents?: boolean;
  readonly unconnected?: boolean;
  readonly archived?: boolean;
}
type ThreadMapSearchPatch = { [Key in keyof ThreadMapSearch]?: ThreadMapSearch[Key] | undefined };

type Selection =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "arrow"; readonly key: string };

interface HoverPoint {
  readonly clientX: number;
  readonly clientY: number;
}

interface Hover {
  readonly selection: Selection;
  readonly clientX: number;
  readonly clientY: number;
}

function liveStatusOf(shell: EnvironmentThreadShell): string | null {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "waiting";
  if (shell.runtime !== null && shell.runtime.status !== "idle") return shell.runtime.status;
  return shell.latestRun?.status ?? null;
}

const PADDING = 24;
const CARD_COLUMN = 280;
const INDENT = 14;
const MAX_INDENT_DEPTH = 6;
const TIMELINE_LEFT = PADDING + CARD_COLUMN + 24;
const SLOT_WIDTH = 34;
const LANE_HEIGHT = 56;
const COMPACT_LANE_HEIGHT = 34;
const AXIS_HEIGHT = 30;
const GROUP_GAP = 28;
const ARROW_HEAD = 7;
const ALL_PROJECTS = "__all__";

const ARROW_STYLE: Record<
  ThreadMapArrowKind,
  { label: string; stroke: string; fill: string; dash?: string }
> = {
  launched: { label: "Launched", stroke: "stroke-info", fill: "fill-info" },
  messaged: { label: "Message", stroke: "stroke-warning", fill: "fill-warning", dash: "4 3" },
  subagent: {
    label: "Started a subagent",
    stroke: "stroke-muted-foreground",
    fill: "fill-muted-foreground",
    dash: "1 3",
  },
  fork: {
    label: "Forked",
    stroke: "stroke-muted-foreground",
    fill: "fill-muted-foreground",
    dash: "6 3",
  },
};

function statusTone(status: string | null): "info" | "warning" | "destructive" | "success" | null {
  switch (status) {
    case "running":
    case "in_progress":
    case "starting":
    case "preparing":
    case "queued":
    case "pending":
      return "info";
    case "waiting":
    case "blocked":
      return "warning";
    case "failed":
    case "error":
      return "destructive";
    case "completed":
      return "success";
    default:
      return null;
  }
}
const DOT_CLASS = {
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  success: "bg-success",
} as const;
const FILL_CLASS = {
  info: "fill-info",
  warning: "fill-warning",
  destructive: "fill-destructive",
  success: "fill-success",
} as const;
const BAR_CLASS = {
  info: "stroke-info",
  warning: "stroke-warning",
  destructive: "stroke-destructive",
  success: "stroke-success/60",
} as const;

const titleOf = (node: OrchestrationV2ThreadMapNode | undefined) =>
  node?.title.trim() || "Untitled thread";
const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
function formatWhen(at: DateTime.Utc, timestampFormat: TimestampFormat): string {
  const date = new Date(DateTime.toEpochMillis(at));
  return `${dayFormatter.format(date)}, ${formatShortTimestamp(iso(at), timestampFormat)}`;
}

function statusLabelFor(node: OrchestrationV2ThreadMapNode, status: string | null): string {
  if (status !== null) return threadRelationshipStatusLabel(status);
  return node.archived ? "Archived" : "Not loaded";
}

export function ThreadMapPage() {
  const search = useSearch({ from: "/_chat/map" });
  const navigate = useNavigate({ from: "/map" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = search.environmentId ?? primaryEnvironmentId;
  const projectId = search.projectId ?? null;
  const focusThreadId = search.focus ?? null;
  const showSubagents = search.subagents !== false;
  const showUnconnected = search.unconnected === true;
  const includeArchived = search.archived === true;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [selection, setSelection] = useState<Selection | null>(
    focusThreadId === null ? null : { kind: "thread", threadId: focusThreadId },
  );
  const [hover, setHover] = useState<Hover | null>(null);

  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.threadMap({ environmentId, input: { includeArchived } }),
  );
  const shells = useThreadShells();
  const liveStatus = new Map<ThreadId, string | null>();
  for (const shell of shells) {
    if (shell.environmentId !== environmentId) continue;
    liveStatus.set(shell.id, liveStatusOf(shell));
  }
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]));

  const layout =
    query.data === null
      ? null
      : layoutThreadMap(query.data, {
          projectId,
          focusThreadId,
          showSubagents,
          showUnconnected,
          timelineLeft: TIMELINE_LEFT,
          slotWidth: SLOT_WIDTH,
          laneHeight: LANE_HEIGHT,
          compactLaneHeight: COMPACT_LANE_HEIGHT,
          axisHeight: AXIS_HEIGHT,
          groupGap: GROUP_GAP,
        });
  const lanes = new Map<ThreadId, ThreadMapLane>();
  const arrows = new Map<string, ThreadMapArrow>();
  for (const group of layout?.groups ?? []) {
    for (const lane of group.lanes) lanes.set(lane.node.threadId, lane);
    for (const arrow of group.arrows) arrows.set(arrow.key, arrow);
  }
  const resolve = (target: Selection | null) =>
    target === null
      ? null
      : target.kind === "thread"
        ? lanes.has(target.threadId)
          ? target
          : null
        : arrows.has(target.key)
          ? target
          : null;
  const selected = resolve(selection);
  const hovered = hover === null ? null : resolve(hover.selection);
  const highlightThreadId =
    hovered?.kind === "thread"
      ? hovered.threadId
      : selected?.kind === "thread"
        ? selected.threadId
        : null;

  const updateSearch = (patch: ThreadMapSearchPatch) =>
    void navigate({
      search: (previous) => {
        const next: Record<string, unknown> = { ...previous, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next as ThreadMapSearch;
      },
      replace: true,
    });
  const openThread = (threadId: ThreadId) => {
    if (environmentId !== null) openThreadFromMap(navigate, { environmentId, threadId });
  };

  const openInNewWindow = () => {
    const url = new URL(window.location.href);
    window.open(url.toString(), THREAD_MAP_WINDOW_NAME, "width=1280,height=860");
  };
  const inMapWindow = typeof window !== "undefined" && window.name === THREAD_MAP_WINDOW_NAME;

  const context: MapContext = {
    lanes,
    arrows,
    liveStatus,
    timestampFormat,
    messages: query.data?.messages ?? [],
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div
        {...workspaceAreaProps("thread-map", 1, "Thread map")}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <WorkspacePageHeader electron={isElectron} className="relative gap-2 bg-background">
          <h1 className="shrink-0 text-sm font-medium">Thread map</h1>
          {focusThreadId !== null ? (
            <Button size="xs" variant="outline" onClick={() => updateSearch({ focus: undefined })}>
              Show all threads
            </Button>
          ) : (
            <Select
              value={projectId ?? ALL_PROJECTS}
              onValueChange={(value) => {
                if (value === null) return;
                updateSearch({
                  projectId: value === ALL_PROJECTS ? undefined : (value as ProjectId),
                });
              }}
            >
              <SelectTrigger aria-label="Project" className="w-44" size="xs">
                <SelectValue>
                  {projectId === null
                    ? "All projects"
                    : (projectTitles.get(projectId) ?? "Project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <div className="ms-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground [-webkit-app-region:no-drag]">
            <MapToggle
              label="Subagents"
              checked={showSubagents}
              onChange={(checked) => updateSearch({ subagents: checked ? undefined : false })}
            />
            <MapToggle
              label="Unconnected"
              checked={showUnconnected}
              onChange={(checked) => updateSearch({ unconnected: checked ? true : undefined })}
            />
            <MapToggle
              label="Archived"
              checked={includeArchived}
              onChange={(checked) => updateSearch({ archived: checked ? true : undefined })}
            />
            <Button size="icon-xs" variant="ghost" aria-label="Refresh" onClick={query.refresh}>
              <RefreshIcon size="sm" refreshing={query.isPending} />
            </Button>
            {inMapWindow ? null : (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Open in a new window"
                onClick={openInNewWindow}
              >
                <ExternalLinkIcon />
              </Button>
            )}
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 flex-1">
          {environmentId === null ? (
            <MapMessage>Connect an environment to see its threads.</MapMessage>
          ) : query.error !== null && query.data === null ? (
            <MapMessage>
              This server can’t draw the thread map. Update T3 Code on it and try again.
            </MapMessage>
          ) : layout === null ? (
            <MapMessage>Loading threads…</MapMessage>
          ) : layout.groups.length === 0 ? (
            <MapMessage>
              No threads have started or messaged other threads
              {projectId === null ? "" : " in this project"} yet. Turn on Unconnected to see every
              thread.
            </MapMessage>
          ) : (
            <MapCanvas
              key={`${environmentId}:${projectId ?? ""}:${focusThreadId ?? ""}`}
              width={layout.width + PADDING}
              height={layout.height + PADDING * 2}
              onBackgroundClick={() => setSelection(null)}
            >
              {layout.groups.map((group) => (
                <MapGroup
                  key={group.lanes[0]!.node.threadId}
                  group={group}
                  width={layout.width}
                  context={context}
                  environmentId={environmentId}
                  projectId={projectId}
                  selected={selected}
                  highlightThreadId={highlightThreadId}
                  onHover={(target, point) =>
                    setHover(
                      target === null || point === null
                        ? null
                        : { selection: target, clientX: point.clientX, clientY: point.clientY },
                    )
                  }
                  onSelect={setSelection}
                  onOpen={openThread}
                />
              ))}
            </MapCanvas>
          )}
          {selected === null || environmentId === null ? null : (
            <DetailsPanel
              selection={selected}
              context={context}
              environmentId={environmentId}
              onSelect={setSelection}
              onOpen={openThread}
              onFocus={(threadId) => updateSearch({ focus: threadId })}
              onClose={() => setSelection(null)}
            />
          )}
        </div>
        {hover === null || hovered === null ? null : (
          <HoverCard hover={{ ...hover, selection: hovered }} context={context} />
        )}
        <MapLegend />
      </div>
    </SidebarInset>
  );
}

interface MapContext {
  readonly lanes: ReadonlyMap<ThreadId, ThreadMapLane>;
  readonly arrows: ReadonlyMap<string, ThreadMapArrow>;
  readonly liveStatus: ReadonlyMap<ThreadId, string | null>;
  readonly timestampFormat: TimestampFormat;
  readonly messages: ReadonlyArray<{
    readonly senderThreadId: ThreadId;
    readonly receiverThreadId: ThreadId;
  }>;
}

function MapToggle(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <Switch checked={props.checked} onCheckedChange={props.onChange} />
      {props.label}
    </label>
  );
}

function MapMessage(props: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
      <p className="max-w-md">{props.children}</p>
    </div>
  );
}

function MapLegend() {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
      {(Object.keys(ARROW_STYLE) as ThreadMapArrowKind[]).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <svg width="30" height="10" aria-hidden>
            <line
              x1="0"
              y1="5"
              x2="22"
              y2="5"
              strokeWidth="2"
              className={ARROW_STYLE[kind].stroke}
              strokeDasharray={ARROW_STYLE[kind].dash}
            />
            <path d="M22,1 L30,5 L22,9 z" className={ARROW_STYLE[kind].fill} />
          </svg>
          {ARROW_STYLE[kind].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="flex items-center gap-1 rounded-full border border-dashed px-1.5 py-px text-3xs">
          <BotIcon className="size-3" />
          Subagent
        </span>
      </span>
      <span className="ms-auto">
        Oldest on the left, one column per event · hover for details · click to inspect ·
        double-click to open
      </span>
    </div>
  );
}

function MapCanvas(props: {
  width: number;
  height: number;
  onBackgroundClick: () => void;
  children: React.ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const zoomAround = (factor: number, clientX?: number, clientY?: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setView((current) => {
      const scale = Math.min(2, Math.max(0.2, current.scale * factor));
      const applied = scale / current.scale;
      return { scale, x: px - (px - current.x) * applied, y: py - (py - current.y) * applied };
    });
  };
  const fit = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = Math.min(1, rect.width / props.width, rect.height / props.height);
    setView({
      scale,
      x: Math.max(0, (rect.width - props.width * scale) / 2),
      y: Math.max(0, (rect.height - props.height * scale) / 2),
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-map-item]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3) {
      start.moved = true;
    }
    setView((current) => ({
      ...current,
      x: start.originX + event.clientX - start.x,
      y: start.originY + event.clientY - start.y,
    }));
  };
  const onPointerUp = () => {
    if (drag.current !== null && !drag.current.moved) props.onBackgroundClick();
    drag.current = null;
  };

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 min-w-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onWheel={(event) => {
        if (event.ctrlKey || event.metaKey) {
          zoomAround(Math.exp(-event.deltaY / 300), event.clientX, event.clientY);
        } else {
          setView((current) => ({
            ...current,
            x: current.x - event.deltaX,
            y: current.y - event.deltaY,
          }));
        }
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: props.width,
          height: props.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {props.children}
      </div>
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 rounded-lg border bg-popover p-1 shadow-sm">
        <Button size="icon-xs" variant="ghost" aria-label="Zoom in" onClick={() => zoomAround(1.2)}>
          <PlusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => zoomAround(1 / 1.2)}
        >
          <MinusIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Fit to view" onClick={fit}>
          <ScanIcon />
        </Button>
      </div>
    </div>
  );
}

/** Rough width of a 10px tabular label, so labels can skip columns instead of overlapping. */
const LABEL_CHAR_WIDTH = 6;
const LABEL_GAP = 12;

/** Labels skip columns that would overlap the previous one; the first label of a day names it. */
function labeledTicks(group: ThreadMapGroup, timestampFormat: TimestampFormat) {
  const labels: { x: number; text: string }[] = [];
  let lastRight = -Infinity;
  let lastDay = "";
  for (const tick of group.ticks) {
    const day = dayFormatter.format(new Date(DateTime.toEpochMillis(tick.at)));
    const time = formatShortTimestamp(iso(tick.at), timestampFormat);
    const text = day === lastDay ? time : `${day}, ${time}`;
    const half = (text.length * LABEL_CHAR_WIDTH) / 2;
    if (tick.x - half < lastRight + LABEL_GAP) continue;
    labels.push({ x: tick.x, text });
    lastRight = tick.x + half;
    lastDay = day;
  }
  return labels;
}

function MapGroup(props: {
  group: ThreadMapGroup;
  width: number;
  context: MapContext;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  selected: Selection | null;
  highlightThreadId: ThreadId | null;
  onHover: (target: Selection | null, point: HoverPoint | null) => void;
  onSelect: (target: Selection) => void;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { group, context } = props;
  const top = group.top + PADDING;
  const laneCenter = (threadId: ThreadId) => {
    const lane = context.lanes.get(threadId)!;
    return lane.top + PADDING + lane.height / 2;
  };
  const touches = (arrow: ThreadMapArrow) =>
    props.highlightThreadId === null ||
    arrow.sourceThreadId === props.highlightThreadId ||
    arrow.targetThreadId === props.highlightThreadId;
  const ticks = labeledTicks(group, context.timestampFormat);

  return (
    <>
      <div
        className="absolute rounded-xl border border-border/60 bg-muted/10"
        style={{ left: 8, top: top - 6, width: props.width - 8, height: group.height + 12 }}
      />
      {group.lanes.map((lane, index) =>
        index % 2 === 1 ? (
          <div
            key={`stripe:${lane.node.threadId}`}
            className="absolute bg-muted/25"
            style={{
              left: TIMELINE_LEFT,
              top: lane.top + PADDING,
              width: props.width - TIMELINE_LEFT,
              height: lane.height,
            }}
          />
        ) : null,
      )}
      {ticks.map((tick) => (
        <span
          key={`tick:${tick.x}`}
          className="absolute -translate-x-1/2 text-3xs whitespace-nowrap text-muted-foreground tabular-nums"
          style={{ left: tick.x, top: top + 6 }}
        >
          {tick.text}
        </span>
      ))}
      <svg
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        width={props.width}
        height={1}
        aria-hidden
      >
        {ticks.map((tick) => (
          <line
            key={`grid:${tick.x}`}
            x1={tick.x}
            x2={tick.x}
            y1={top + 22}
            y2={top + group.height}
            strokeWidth={1}
            className="stroke-border/50"
          />
        ))}
        {group.lanes.map((lane) => {
          const y = lane.top + PADDING + lane.height / 2;
          const tone = statusTone(context.liveStatus.get(lane.node.threadId) ?? null);
          const dim =
            props.highlightThreadId !== null && props.highlightThreadId !== lane.node.threadId;
          return (
            <g key={`bar:${lane.node.threadId}`} opacity={dim ? 0.5 : 1}>
              <line
                x1={lane.startX}
                x2={lane.endX}
                y1={y}
                y2={y}
                strokeLinecap="round"
                strokeWidth={lane.compact ? 2 : 4}
                strokeDasharray={lane.compact ? "2 4" : undefined}
                className={tone === null ? "stroke-muted-foreground/40" : BAR_CLASS[tone]}
              />
              <circle
                cx={lane.startX}
                cy={y}
                r={lane.compact ? 3 : 4.5}
                className={cn(
                  "stroke-background",
                  tone === null ? "fill-muted-foreground" : FILL_CLASS[tone],
                )}
                strokeWidth={1.5}
              />
              <line
                data-map-item
                x1={lane.startX}
                x2={lane.endX}
                y1={y}
                y2={y}
                stroke="transparent"
                strokeWidth={12}
                className="pointer-events-auto cursor-pointer"
                onPointerMove={(event) =>
                  props.onHover({ kind: "thread", threadId: lane.node.threadId }, event)
                }
                onPointerLeave={() => props.onHover(null, null)}
                onClick={() => props.onSelect({ kind: "thread", threadId: lane.node.threadId })}
                onDoubleClick={() => props.onOpen(lane.node.threadId)}
              />
            </g>
          );
        })}
        {group.arrows.map((arrow) => {
          const y1 = laneCenter(arrow.sourceThreadId);
          const y2 = laneCenter(arrow.targetThreadId);
          const down = y2 > y1;
          const tip = y2 + (down ? -4 : 4);
          const base = tip + (down ? -ARROW_HEAD : ARROW_HEAD);
          const style = ARROW_STYLE[arrow.kind];
          const isSelected = props.selected?.kind === "arrow" && props.selected.key === arrow.key;
          return (
            <g key={arrow.key} opacity={touches(arrow) || isSelected ? 1 : 0.2}>
              {isSelected ? (
                <line
                  x1={arrow.x}
                  x2={arrow.x}
                  y1={y1}
                  y2={tip}
                  strokeWidth={8}
                  strokeLinecap="round"
                  className="stroke-ring/40"
                />
              ) : null}
              <circle cx={arrow.x} cy={y1} r={3} className={style.fill} />
              <line
                x1={arrow.x}
                x2={arrow.x}
                y1={y1}
                y2={base}
                strokeWidth={2}
                strokeDasharray={style.dash}
                className={style.stroke}
              />
              <path
                d={`M ${arrow.x - 5} ${base} L ${arrow.x} ${tip} L ${arrow.x + 5} ${base} z`}
                className={style.fill}
              />
              <line
                data-map-item
                x1={arrow.x}
                x2={arrow.x}
                y1={y1}
                y2={tip}
                stroke="transparent"
                strokeWidth={14}
                className="pointer-events-auto cursor-pointer"
                onPointerMove={(event) => props.onHover({ kind: "arrow", key: arrow.key }, event)}
                onPointerLeave={() => props.onHover(null, null)}
                onClick={() => props.onSelect({ kind: "arrow", key: arrow.key })}
                onDoubleClick={() => props.onOpen(arrow.targetThreadId)}
              />
            </g>
          );
        })}
      </svg>
      {group.lanes.map((lane) => (
        <LaneCard
          key={lane.node.threadId}
          lane={lane}
          environmentId={props.environmentId}
          status={context.liveStatus.get(lane.node.threadId) ?? null}
          selected={
            props.selected?.kind === "thread" && props.selected.threadId === lane.node.threadId
          }
          showProject={props.projectId === null || lane.outside}
          onHover={(point) =>
            props.onHover(
              point === null ? null : { kind: "thread", threadId: lane.node.threadId },
              point,
            )
          }
          onSelect={() => props.onSelect({ kind: "thread", threadId: lane.node.threadId })}
          onOpen={() => props.onOpen(lane.node.threadId)}
        />
      ))}
    </>
  );
}

function LaneCard(props: {
  lane: ThreadMapLane;
  environmentId: EnvironmentId;
  status: string | null;
  selected: boolean;
  showProject: boolean;
  onHover: (point: HoverPoint | null) => void;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { lane } = props;
  const { node } = lane;
  const project = useProject(
    props.showProject ? scopeProjectRef(props.environmentId, node.projectId) : null,
  );
  const statusLabel = statusLabelFor(node, props.status);
  const tone = statusTone(props.status);
  const indent = Math.min(lane.depth, MAX_INDENT_DEPTH) * INDENT;
  const common = {
    type: "button" as const,
    "data-map-item": true,
    "aria-label": `${titleOf(node)}, ${lane.compact ? "subagent, " : ""}${statusLabel}`,
    onClick: props.onSelect,
    onDoubleClick: props.onOpen,
    onPointerMove: (event: React.PointerEvent) => props.onHover(event),
    onPointerLeave: () => props.onHover(null),
  };

  if (lane.compact) {
    return (
      <button
        {...common}
        className={cn(
          "absolute flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-background px-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          props.selected && "border-solid border-info text-foreground ring-2 ring-info/30",
          (lane.outside || node.archived) && "opacity-60",
        )}
        style={{
          left: PADDING + indent,
          top: lane.top + PADDING + 4,
          width: CARD_COLUMN - indent,
          height: lane.height - 8,
        }}
      >
        <BotIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{titleOf(node)}</span>
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === null ? "bg-muted-foreground/40" : DOT_CLASS[tone],
          )}
        />
      </button>
    );
  }

  return (
    <button
      {...common}
      className={cn(
        "absolute flex items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm shadow-xs transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
        props.selected && "border-info ring-2 ring-info/40",
        (lane.outside || node.archived) && "opacity-60",
      )}
      style={{
        left: PADDING + indent,
        top: lane.top + PADDING + 4,
        width: CARD_COLUMN - indent,
        height: lane.height - 8,
      }}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === null ? "bg-muted-foreground/40" : DOT_CLASS[tone],
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{titleOf(node)}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {props.showProject && project ? (
            <>
              <ProjectFavicon project={project} className="size-3" />
              <span className="truncate">{project.title}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="shrink-0">{statusLabel}</span>
        </span>
      </span>
    </button>
  );
}

function threadStats(threadId: ThreadId, context: MapContext) {
  let sent = 0;
  let received = 0;
  for (const message of context.messages) {
    if (message.senderThreadId === threadId) sent++;
    if (message.receiverThreadId === threadId) received++;
  }
  return { sent, received };
}

function arrowSummary(arrow: ThreadMapArrow, context: MapContext): string {
  const source = titleOf(context.lanes.get(arrow.sourceThreadId)?.node);
  const target = titleOf(context.lanes.get(arrow.targetThreadId)?.node);
  switch (arrow.kind) {
    case "launched":
      return `${source} launched ${target}`;
    case "messaged":
      return `${source} messaged ${target}`;
    case "subagent":
      return `${source} started subagent ${target}`;
    case "fork":
      return `${target} was forked from ${source}`;
  }
}

function HoverCard(props: { hover: Hover; context: MapContext }) {
  const { selection, clientX, clientY } = props.hover;
  const { context } = props;
  const left = Math.min(clientX + 14, window.innerWidth - 336);
  const top = Math.min(clientY + 14, window.innerHeight - 200);
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-80 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
      style={{ left, top }}
    >
      {selection.kind === "thread" ? (
        <ThreadSummary threadId={selection.threadId} context={context} compact />
      ) : (
        <ArrowSummary arrow={context.arrows.get(selection.key)!} context={context} compact />
      )}
    </div>
  );
}

function Fact(props: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 tabular-nums">{props.children}</dd>
    </>
  );
}

function When(props: { at: DateTime.Utc; timestampFormat: TimestampFormat }) {
  return (
    <>
      {formatWhen(props.at, props.timestampFormat)}
      <span className="text-muted-foreground"> · {formatRelativeTimeLabel(iso(props.at))}</span>
    </>
  );
}

function ThreadSummary(props: { threadId: ThreadId; context: MapContext; compact?: boolean }) {
  const { context } = props;
  const lane = context.lanes.get(props.threadId)!;
  const { node } = lane;
  const status = context.liveStatus.get(node.threadId) ?? null;
  const { sent, received } = threadStats(node.threadId, context);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 font-medium">
        {lane.compact ? <BotIcon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        <span className={props.compact ? "truncate" : "text-sm"}>{titleOf(node)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Fact label="Kind">
          {lane.compact ? "Subagent" : node.relationshipToParent === "fork" ? "Fork" : "Thread"}
        </Fact>
        <Fact label="Status">{statusLabelFor(node, status)}</Fact>
        <Fact label="Created">
          <When at={node.createdAt} timestampFormat={context.timestampFormat} />
        </Fact>
        <Fact label="Last message">
          {node.lastMessageAt === null ? (
            "None"
          ) : (
            <When at={node.lastMessageAt} timestampFormat={context.timestampFormat} />
          )}
        </Fact>
        <Fact label="Messages">{node.messageCount.toLocaleString()}</Fact>
        <Fact label="To other threads">{sent.toLocaleString()}</Fact>
        <Fact label="From other threads">{received.toLocaleString()}</Fact>
      </dl>
    </div>
  );
}

function ArrowSummary(props: { arrow: ThreadMapArrow; context: MapContext; compact?: boolean }) {
  const { arrow, context } = props;
  const preview = arrow.message?.preview.trim() ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 font-medium">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4" className={ARROW_STYLE[arrow.kind].fill} />
        </svg>
        {ARROW_STYLE[arrow.kind].label}
      </div>
      <p>{arrowSummary(arrow, context)}</p>
      <p className="text-muted-foreground">
        <When at={arrow.at} timestampFormat={context.timestampFormat} />
      </p>
      {preview.length === 0 ? null : (
        <p
          className={cn(
            "rounded-md border bg-muted/30 p-2 wrap-break-word whitespace-pre-wrap",
            props.compact && "line-clamp-4",
          )}
        >
          {preview}
          {arrow.message !== null && arrow.message.preview.length >= 400 ? "…" : ""}
        </p>
      )}
    </div>
  );
}

function DetailsPanel(props: {
  selection: Selection;
  context: MapContext;
  environmentId: EnvironmentId;
  onSelect: (target: Selection) => void;
  onOpen: (threadId: ThreadId) => void;
  onFocus: (threadId: ThreadId) => void;
  onClose: () => void;
}) {
  const { selection, context } = props;
  return (
    <aside className="flex w-88 shrink-0 flex-col overflow-y-auto border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        {selection.kind === "thread" ? "Thread details" : "Event details"}
        <Button size="icon-xs" variant="ghost" aria-label="Close details" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-col gap-4 p-3 text-xs">
        {selection.kind === "thread" ? (
          <ThreadDetails threadId={selection.threadId} {...props} />
        ) : (
          <ArrowDetails arrow={context.arrows.get(selection.key)!} {...props} />
        )}
      </div>
    </aside>
  );
}

function ThreadLink(props: {
  threadId: ThreadId;
  context: MapContext;
  onSelect: (target: Selection) => void;
}) {
  return (
    <button
      type="button"
      className="min-w-0 truncate text-left font-medium text-foreground underline-offset-2 hover:underline"
      onClick={() => props.onSelect({ kind: "thread", threadId: props.threadId })}
    >
      {titleOf(props.context.lanes.get(props.threadId)?.node)}
    </button>
  );
}

function ThreadDetails(props: {
  threadId: ThreadId;
  context: MapContext;
  onSelect: (target: Selection) => void;
  onOpen: (threadId: ThreadId) => void;
  onFocus: (threadId: ThreadId) => void;
}) {
  const { context, threadId } = props;
  const events = [...context.arrows.values()]
    .filter((arrow) => arrow.sourceThreadId === threadId || arrow.targetThreadId === threadId)
    .toSorted((a, b) => DateTime.toEpochMillis(b.at) - DateTime.toEpochMillis(a.at));
  return (
    <>
      <ThreadSummary threadId={threadId} context={context} />
      <div className="flex gap-2">
        <Button size="xs" onClick={() => props.onOpen(threadId)}>
          <ExternalLinkIcon />
          Open thread
        </Button>
        <Button size="xs" variant="outline" onClick={() => props.onFocus(threadId)}>
          <ScanSearchIcon />
          Show only its group
        </Button>
      </div>
      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-muted-foreground">
          Starts and messages ({events.length.toLocaleString()})
        </h3>
        {events.length === 0 ? (
          <p className="text-muted-foreground">No other thread started or messaged this one.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {events.map((arrow) => {
              const outgoing = arrow.sourceThreadId === threadId;
              const other = outgoing ? arrow.targetThreadId : arrow.sourceThreadId;
              return (
                <li key={arrow.key}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => props.onSelect({ kind: "arrow", key: arrow.key })}
                  >
                    <span className="flex items-center gap-1.5">
                      <svg width="8" height="8" aria-hidden>
                        <circle cx="4" cy="4" r="3.5" className={ARROW_STYLE[arrow.kind].fill} />
                      </svg>
                      <span className="text-muted-foreground">
                        {ARROW_STYLE[arrow.kind].label} {outgoing ? "to" : "from"}
                      </span>
                      <span className="min-w-0 truncate font-medium">
                        {titleOf(context.lanes.get(other)?.node)}
                      </span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatWhen(arrow.at, context.timestampFormat)}
                    </span>
                    {arrow.message !== null && arrow.message.preview.trim().length > 0 ? (
                      <span className="line-clamp-2 text-muted-foreground">
                        {arrow.message.preview.trim()}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}

function ArrowDetails(props: {
  arrow: ThreadMapArrow;
  context: MapContext;
  onSelect: (target: Selection) => void;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { arrow, context } = props;
  return (
    <>
      <ArrowSummary arrow={arrow} context={context} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Fact label="From">
          <ThreadLink threadId={arrow.sourceThreadId} context={context} onSelect={props.onSelect} />
        </Fact>
        <Fact label="To">
          <ThreadLink threadId={arrow.targetThreadId} context={context} onSelect={props.onSelect} />
        </Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" onClick={() => props.onOpen(arrow.targetThreadId)}>
          <ExternalLinkIcon />
          Open receiving thread
        </Button>
        <Button size="xs" variant="outline" onClick={() => props.onOpen(arrow.sourceThreadId)}>
          Open sending thread
        </Button>
      </div>
    </>
  );
}
