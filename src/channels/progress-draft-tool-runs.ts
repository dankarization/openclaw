import { resolveToolDisplay } from "../agents/tool-display.js";
import type {
  ChannelProgressDraftCompositorLine as Line,
  ChannelProgressDraftCompositorParams,
} from "./progress-draft-compositor.types.js";
import { getProgressDraftLineText, type ChannelProgressDraftLine } from "./progress-draft-lines.js";
import { resolveChannelStreamingPreviewCommandText } from "./streaming.js";

type Member = { line: ChannelProgressDraftLine; hidden?: boolean };
type Run = { members: Member[] };

function isCompactTool(line: ChannelProgressDraftLine): boolean {
  return (
    (line.kind === "tool" || line.kind === "item") &&
    Boolean(line.toolName) &&
    !line.detail &&
    (!line.status || line.status === "running" || line.status === "completed") &&
    // Authored/truncated titles are not tool identities or interchangeable details.
    line.label === resolveToolDisplay({ name: line.toolName }).label
  );
}

/** Display-only runs; invocation ids, not lifecycle callbacks or rendered text, own counts. */
export function createProgressDraftToolRuns(
  params: ChannelProgressDraftCompositorParams,
  quietProgress: boolean,
  merge: (lines: Line[], line: Line) => Line[],
) {
  if (
    !params.compactToolRuns ||
    !params.preparedItems ||
    params.mode !== "progress" ||
    quietProgress ||
    resolveChannelStreamingPreviewCommandText(params.entry) === "raw"
  ) {
    return undefined;
  }
  const invocations = new Map<string, { run: Run; member: Member }>();
  let rowRuns = new WeakMap<ChannelProgressDraftLine, { run: Run; members: readonly Member[] }>();
  let current: Run | undefined;

  const project = (run: Run, members = run.members): ChannelProgressDraftLine[] => {
    const rows: ChannelProgressDraftLine[] = [];
    let batch: Member[] = [];
    const flush = () => {
      const first = batch[0]?.line;
      if (!first) {
        return;
      }
      const row =
        batch.length === 1
          ? first
          : {
              ...first,
              label: `${first.label} ×${batch.length}`,
              status: batch.some((member) => member.line.status === "running")
                ? "running"
                : "completed",
            };
      if (batch.length > 1) {
        row.text = getProgressDraftLineText(row);
      }
      rowRuns.set(row, { run, members: batch });
      rows.push(row);
      batch = [];
    };
    for (const member of members) {
      const { line, hidden } = member;
      if (hidden) {
        continue;
      }
      if (isCompactTool(line)) {
        if (
          batch[0] &&
          (batch[0].line.toolName !== line.toolName || batch[0].line.icon !== line.icon)
        ) {
          flush();
        }
        batch.push(member);
      } else {
        flush();
        rowRuns.set(line, { run, members: [member] });
        rows.push(line);
      }
    }
    flush();
    return rows;
  };

  const replace = (lines: Line[], run: Run, append: boolean): Line[] => {
    const index = lines.findIndex(
      (line) => typeof line === "object" && rowRuns.get(line)?.run === run,
    );
    if (index < 0) {
      return append ? project(run).reduce(merge, lines) : lines;
    }
    const before = lines.slice(0, index);
    const after = lines
      .slice(index)
      .filter((line) => typeof line !== "object" || rowRuns.get(line)?.run !== run);
    const visibleMembers = new Set(
      lines.flatMap((line) => {
        const row = typeof line === "object" ? rowRuns.get(line) : undefined;
        return row?.run === run ? row.members : [];
      }),
    );
    // A split run may have lost only its oldest fragment to the row budget.
    // Lifecycle updates must not resurrect that fragment or displace its newer siblings.
    const members = append
      ? run.members
      : run.members.filter((member) => visibleMembers.has(member));
    return [...project(run, members), ...after].reduce(merge, before);
  };

  return {
    merge(lines: Line[], line: Line): Line[] {
      if (
        typeof line !== "object" ||
        !line.id ||
        !line.toolName ||
        !["tool", "item"].includes(line.kind)
      ) {
        current = undefined;
        return merge(lines, line);
      }
      const known = invocations.get(line.id);
      if (known) {
        const changed =
          JSON.stringify(known.member.line) !== JSON.stringify(line) || known.member.hidden;
        known.member.line = line;
        known.member.hidden = false;
        // Lifecycle replay neither increments a run nor re-inserts an evicted row.
        // A newly observed failure still gets a visible row after eviction.
        if (changed && !isCompactTool(line)) {
          current = undefined;
          const previousRun = known.run;
          previousRun.members = previousRun.members.filter((member) => member !== known.member);
          const retained = replace(lines, previousRun, false);
          // Meaningful updates get their own newest row, even with a one-row budget.
          known.run = { members: [known.member] };
          return project(known.run).reduce(merge, retained);
        }
        return replace(lines, known.run, false);
      }
      const previous = current?.members.at(-1)?.line;
      const continues =
        isCompactTool(line) &&
        previous &&
        isCompactTool(previous) &&
        previous.toolName === line.toolName &&
        previous.icon === line.icon;
      const run = continues && current ? current : { members: [] };
      const member = { line };
      run.members.push(member);
      invocations.set(line.id, { run, member });
      current = isCompactTool(line) ? run : undefined;
      return replace(lines, run, true);
    },
    remove(lines: Line[], id: string): Line[] | undefined {
      const known = invocations.get(id);
      if (!known) {
        return undefined;
      }
      known.member.hidden = true;
      return replace(lines, known.run, false);
    },
    breakRun() {
      current = undefined;
    },
    reset() {
      invocations.clear();
      rowRuns = new WeakMap();
      current = undefined;
    },
  };
}
