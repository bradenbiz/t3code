import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ThreadMapPage, type ThreadMapSearch } from "../components/threadMap/ThreadMapPage";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 500) : undefined;

export const Route = createFileRoute("/_chat/map")({
  validateSearch: (raw: Record<string, unknown>): ThreadMapSearch => {
    const search: { -readonly [K in keyof ThreadMapSearch]: ThreadMapSearch[K] } = {};
    const environmentId = text(raw.environmentId);
    const projectId = text(raw.projectId);
    const focus = text(raw.focus);
    if (environmentId) search.environmentId = EnvironmentId.make(environmentId);
    if (projectId) search.projectId = ProjectId.make(projectId);
    if (focus) search.focus = ThreadId.make(focus);
    if (raw.subagents === false || raw.subagents === "false") search.subagents = false;
    if (raw.unconnected === true || raw.unconnected === "true") search.unconnected = true;
    if (raw.archived === true || raw.archived === "true") search.archived = true;
    return search;
  },
  component: ThreadMapPage,
});
