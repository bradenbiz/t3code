import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  layoutThreadMap,
  type ThreadMapEdgeKind,
  type ThreadMapLayoutEdge,
  type ThreadMapLayoutNode,
} from "@t3tools/client-runtime/state/thread-map";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useProject, useProjects, useThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
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

function liveStatusOf(shell: EnvironmentThreadShell): string | null {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "waiting";
  if (shell.runtime !== null && shell.runtime.status !== "idle") return shell.runtime.status;
  return shell.latestRun?.status ?? null;
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 48;
const COLUMN_WIDTH = NODE_WIDTH + 96;
const ROW_HEIGHT = NODE_HEIGHT + 20;
const PADDING = 48;
const ALL_PROJECTS = "__all__";

const EDGE_STYLE: Record<ThreadMapEdgeKind, { label: string; className: string; dash?: string }> = {
  subagent: { label: "Delegated or subagent", className: "stroke-muted-foreground/50" },
  fork: { label: "Forked", className: "stroke-muted-foreground/50", dash: "6 4" },
  launched: { label: "Launched", className: "stroke-info" },
  messaged: { label: "Messaged", className: "stroke-warning", dash: "2 4" },
};

function statusDotClass(status: string | null): string {
  switch (status) {
    case "running":
    case "in_progress":
    case "starting":
    case "preparing":
    case "queued":
    case "pending":
      return "bg-info";
    case "waiting":
    case "blocked":
      return "bg-warning";
    case "failed":
    case "error":
      return "bg-destructive";
    case "completed":
      return "bg-success";
    default:
      return "bg-muted-foreground/40";
  }
}

function edgePath(source: ThreadMapLayoutNode, target: ThreadMapLayoutNode): string {
  const forward = target.x > source.x;
  const x1 = source.x + (forward ? NODE_WIDTH : NODE_WIDTH / 2) + PADDING;
  const y1 = source.y + NODE_HEIGHT / 2 + PADDING;
  const x2 = target.x + (forward ? 0 : NODE_WIDTH / 2) + PADDING;
  const y2 = target.y + (forward ? NODE_HEIGHT / 2 : 0) + PADDING;
  if (forward) {
    const bend = (x2 - x1) / 2;
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }
  // Messages to a thread that is not further right loop out to the side so they stay visible.
  const loop = Math.max(64, Math.abs(y2 - y1) / 3);
  return `M ${x1 + NODE_WIDTH / 2} ${y1} C ${x1 + NODE_WIDTH / 2 + loop} ${y1}, ${x2 + NODE_WIDTH / 2 + loop} ${y2 + NODE_HEIGHT / 2}, ${x2 + NODE_WIDTH / 2} ${y2 + NODE_HEIGHT / 2}`;
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
          columnWidth: COLUMN_WIDTH,
          rowHeight: ROW_HEIGHT,
          groupGap: ROW_HEIGHT,
        });

  const updateSearch = (patch: ThreadMapSearchPatch) =>
    void navigate({
      search: (previous) => {
        const next: Record<string, unknown> = { ...previous, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next as ThreadMapSearch;
      },
      replace: true,
    });

  const openInNewWindow = () => {
    const url = new URL(window.location.href);
    window.open(url.toString(), THREAD_MAP_WINDOW_NAME, "width=1280,height=860");
  };
  const inMapWindow = typeof window !== "undefined" && window.name === THREAD_MAP_WINDOW_NAME;

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

        {environmentId === null ? (
          <MapMessage>Connect an environment to see its threads.</MapMessage>
        ) : query.error !== null && query.data === null ? (
          <MapMessage>
            This server can’t draw the thread map. Update T3 Code on it and try again.
          </MapMessage>
        ) : layout === null ? (
          <MapMessage>Loading threads…</MapMessage>
        ) : layout.nodes.length === 0 ? (
          <MapMessage>
            No threads have started or messaged other threads
            {projectId === null ? "" : " in this project"} yet. Turn on Unconnected to see every
            thread.
          </MapMessage>
        ) : (
          <MapCanvas
            key={`${environmentId}:${projectId ?? ""}:${focusThreadId ?? ""}`}
            width={layout.width + PADDING * 2}
            height={layout.height + NODE_HEIGHT + PADDING * 2}
          >
            <MapEdges nodes={layout.nodes} edges={layout.edges} />
            {layout.nodes.map((entry) => (
              <MapNode
                key={entry.node.threadId}
                entry={entry}
                environmentId={environmentId}
                status={liveStatus.get(entry.node.threadId) ?? null}
                focused={entry.node.threadId === focusThreadId}
                showProject={projectId === null || entry.outside}
                onOpen={() =>
                  openThreadFromMap(navigate, { environmentId, threadId: entry.node.threadId })
                }
                onFocus={() => updateSearch({ focus: entry.node.threadId })}
              />
            ))}
          </MapCanvas>
        )}
        <MapLegend />
      </div>
    </SidebarInset>
  );
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
      {(Object.keys(EDGE_STYLE) as ThreadMapEdgeKind[]).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <svg width="28" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="28"
              y2="4"
              strokeWidth="2"
              className={EDGE_STYLE[kind].className}
              strokeDasharray={EDGE_STYLE[kind].dash}
            />
          </svg>
          {EDGE_STYLE[kind].label}
        </span>
      ))}
      <span className="ms-auto">
        Drag to move · pinch or Ctrl+scroll to zoom · double-click a thread to focus it
      </span>
    </div>
  );
}

function MapCanvas(props: { width: number; height: number; children: React.ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

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
      x: (rect.width - props.width * scale) / 2,
      y: Math.max(0, (rect.height - props.height * scale) / 2),
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-map-node]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    setView((current) => ({
      ...current,
      x: start.originX + event.clientX - start.x,
      y: start.originY + event.clientY - start.y,
    }));
  };

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
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

function MapEdges(props: {
  nodes: ReadonlyArray<ThreadMapLayoutNode>;
  edges: ReadonlyArray<ThreadMapLayoutEdge>;
}) {
  const byId = new Map(props.nodes.map((entry) => [entry.node.threadId, entry]));
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
      <defs>
        {(Object.keys(EDGE_STYLE) as ThreadMapEdgeKind[]).map((kind) => (
          <marker
            key={kind}
            id={`thread-map-arrow-${kind}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" stroke="none" className={fillFor(kind)} />
          </marker>
        ))}
      </defs>
      {props.edges.map((edge) => {
        const source = byId.get(edge.sourceThreadId);
        const target = byId.get(edge.targetThreadId);
        if (!source || !target) return null;
        const style = EDGE_STYLE[edge.kind];
        const path = edgePath(source, target);
        return (
          <g key={`${edge.sourceThreadId}:${edge.targetThreadId}:${edge.kind}`}>
            <path
              d={path}
              fill="none"
              strokeWidth={edge.kind === "messaged" ? 1.5 : 2}
              className={style.className}
              strokeDasharray={style.dash}
              markerEnd={`url(#thread-map-arrow-${edge.kind})`}
            />
            {edge.kind === "messaged" && edge.messageCount > 1 ? (
              <text
                x={(source.x + target.x) / 2 + NODE_WIDTH / 2 + PADDING}
                y={(source.y + target.y) / 2 + NODE_HEIGHT / 2 + PADDING - 6}
                className="fill-warning text-3xs"
                textAnchor="middle"
              >
                {edge.messageCount}×
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function fillFor(kind: ThreadMapEdgeKind): string {
  return kind === "launched"
    ? "fill-info"
    : kind === "messaged"
      ? "fill-warning"
      : "fill-muted-foreground/50";
}

function MapNode(props: {
  entry: ThreadMapLayoutNode;
  environmentId: EnvironmentId;
  status: string | null;
  focused: boolean;
  showProject: boolean;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const { node } = props.entry;
  const project = useProject(
    props.showProject ? scopeProjectRef(props.environmentId, node.projectId) : null,
  );
  const statusLabel =
    props.status === null
      ? node.archived
        ? "Archived"
        : "Not loaded"
      : threadRelationshipStatusLabel(props.status);
  return (
    <button
      type="button"
      data-map-node
      aria-label={`${node.title.trim() || "Untitled thread"}, ${statusLabel}`}
      onClick={props.onOpen}
      onDoubleClick={props.onFocus}
      className={cn(
        "absolute flex items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm shadow-xs transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
        props.focused && "border-info ring-2 ring-info/40",
        (props.entry.outside || node.archived) && "opacity-60",
      )}
      style={{
        left: props.entry.x + PADDING,
        top: props.entry.y + PADDING,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
    >
      <span
        aria-label={statusLabel}
        className={cn("size-2 shrink-0 rounded-full", statusDotClass(props.status))}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{node.title.trim() || "Untitled thread"}</span>
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
