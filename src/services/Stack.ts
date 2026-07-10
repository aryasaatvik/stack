import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  BranchError,
  BranchRef,
  branchName,
  branchRef,
  CampaignLanding,
  campaignLanding,
  campaignState,
  DirtyWorktreeError,
  MergeBaseError,
  PullMeta,
  pullRef,
  PullRef,
  stackLink,
  StackLink,
  StackOperationError,
  type StackError,
  stackState,
  StackState,
  StatusReport,
  UndoEntry,
  undoEntry,
  undoState,
} from "../domain/model.ts";
import { renderDiagram } from "../format.ts";
import { RepairExecution } from "../repairExecution.ts";
import * as RepairPlan from "../repairPlan.ts";
import * as StackGraph from "../stackGraph.ts";
import * as StackBlock from "../stackBlock.ts";
import * as StackResult from "../stackResult.ts";
import { StackConfig } from "./Config.ts";
import { Git } from "./Git.ts";
import { CodeHost } from "./CodeHost.ts";
import * as Progress from "./Progress.ts";
import { Store } from "./Store.ts";

export interface StackService {
  readonly status: () => Effect.Effect<StatusReport, StackError>;
  readonly adopt: (branch: string, parent: string) => Effect.Effect<StackLink, StackError>;
  readonly links: (apply?: boolean) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly land: (
    branch?: string,
    opts?: {
      readonly apply?: boolean;
      readonly auto?: boolean;
      readonly admin?: boolean;
      readonly through?: string;
      readonly eager?: boolean;
      readonly continue?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly sync: (opts?: {
    readonly apply?: boolean;
    readonly branch?: string;
    readonly all?: boolean;
    readonly continueOnFailure?: boolean;
  }) => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly doctor: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly last: () => Effect.Effect<ReadonlyArray<string>, StackError>;
  readonly undo: (apply?: boolean) => Effect.Effect<ReadonlyArray<string>, StackError>;
}

export class Stack extends Context.Service<Stack, StackService>()("@stack/Stack") {
  static readonly layer = Layer.effect(
    Stack,
    Effect.gen(function* () {
      const cfg = yield* StackConfig;
      const git = yield* Git.Service;
      const codeHost = yield* CodeHost.Service;
      const progress = yield* Progress.Service;
      const store = yield* Store;

      const reference = (number: number) => codeHost.reference(number);
      const requestLabel = codeHost.requestLabel;

      const draft = (link: StackLink, parent: string, old: PullMeta | null) => {
        if (!old) {
          return {
            title: `stack: ${link.branch}`,
            body: `Restacked ${link.branch} onto ${parent}.`,
            labels: Array<string>(),
          };
        }

        const note = `Restacked from ${reference(Number(old.number))} onto \`${parent}\` after parent merge.`;
        const body = old.body.match(/^Stacked on [#!]\d+\.$/m)
          ? old.body.replace(/^Stacked on [#!]\d+\.$/m, note)
          : `${old.body}

${note}`;

        return {
          title: old.title,
          body,
          labels: old.labels.map((item) => item.name),
        };
      };

      const clean = Effect.fn("Stack.clean")(() =>
        Effect.gen(function* () {
          const lines = yield* git.dirty();
          if (lines.length > 0) return yield* Effect.fail(new DirtyWorktreeError(lines));
        }),
      );

      const ensureRepairableWorktrees = Effect.fn("Stack.ensureRepairableWorktrees")(function* (
        branches: ReadonlyArray<string>,
      ) {
        const wanted = new Set(branches);
        if (wanted.size === 0) return;
        const dirty = (yield* git.worktrees()).filter(
          (item) => item.branch && wanted.has(item.branch) && item.dirty.length > 0,
        );
        if (dirty.length === 0) return;
        return yield* Effect.fail(
          new StackOperationError(
            [
              "Cannot repair checked-out dirty worktree branches:",
              "",
              ...dirty.flatMap((item) => [
                `  ${item.branch} -> ${item.path}`,
                ...item.dirty.map((line) => `    ${line}`),
              ]),
              "",
              "Commit, stash, or clean those worktrees, then rerun the command.",
            ].join("\n"),
          ),
        );
      });

      const trunk = (name: string) => cfg.trunks.some((item) => item === name);
      const step = (message: string) => progress.emit({ _tag: "Step", message });
      const wait = (message: string) => progress.emit({ _tag: "Wait", message });
      const mergeFailure = (err: unknown) =>
        new StackOperationError(
          `${err instanceof Error ? err.message : String(err)}\n\n` +
            `The change did not merge immediately. If checks are still running or the change is waiting on required reviews, use: stack merge --auto\n` +
            `If you intentionally want to bypass merge requirements with admin privileges (GitHub only), use: stack merge --apply --admin`,
        );
      const replayFailure = (
        rebase: RepairPlan.RebaseBranchPlan,
        err: StackError,
        state: ReturnType<typeof stackState>,
        pulls: ReadonlyArray<PullRef>,
        actions: ReadonlyArray<StackResult.StackResultItem>,
      ) =>
        new StackOperationError(
          [
            ...renderSyncTree({
              title: "Sync stopped",
              state,
              pulls,
              actions,
              mode: "apply",
              failed: { branch: rebase.branch, parent: rebase.parent },
            }),
            "",
            "Failed:",
            `  ${rebase.branch} could not be replayed onto ${rebase.parent}`,
            ...(err._tag === "ReplayConflictError" && err.paths.length > 0
              ? ["", "Conflicting paths:", ...err.paths.map((p) => `  ${p}`)]
              : []),
            "",
            "Cleaned up:",
            `  backup created: ${rebase.backup}`,
            "  the failed cherry-pick was aborted",
            "  the original branch was restored",
            "  the temporary replay branch was deleted",
            "  the undo journal was saved",
            "",
            "Next:",
            `  repair ${rebase.branch} from ${rebase.backup}, push it, then run: stack sync --apply`,
            "  or restore the pre-sync state with: stack undo --apply",
            "",
            "Git error:",
            err instanceof Error ? `  ${err.message}` : `  ${String(err)}`,
            err._tag === "ExecError" && err.stderr
              ? `  ${err.stderr}`
              : err._tag === "ReplayConflictError" && err.stderr
                ? `  ${err.stderr}`
                : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        );
      const timestamp = Effect.fn("Stack.timestamp")(function* () {
        const now = yield* DateTime.nowAsDate;
        return now.toISOString().replaceAll(":", "").replaceAll(".", "");
      });
      const sameState = Schema.toEquivalence(StackState);

      const renderSyncTree = (opts: {
        readonly title: string;
        readonly state: ReturnType<typeof stackState>;
        readonly pulls: ReadonlyArray<PullRef>;
        readonly actions: ReadonlyArray<StackResult.StackResultItem>;
        readonly mode: StackResult.Mode;
        readonly failed?: { readonly branch: string; readonly parent: string };
      }) => {
        const trunkNames = cfg.trunks.map(String);
        const pulls = new Map(opts.pulls.map((pull) => [String(pull.head), pull]));
        const children = new Map<string, Array<string>>();
        const links = new Map(opts.state.links.map((link) => [String(link.branch), link]));
        for (const link of opts.state.links) {
          const parent = String(link.parent);
          const list = children.get(parent) ?? [];
          list.push(String(link.branch));
          children.set(parent, list);
        }
        for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));

        const rebased = new Map<string, string>();
        const pushed = new Map<string, ReadonlyArray<string>>();
        const created = new Map<
          string,
          StackResult.StackResultItem & { readonly _tag: "CreatePull" }
        >();
        const updatedPrs = new Set<number>();
        const fastForwarded = new Set<string>();
        let backups = 0;
        for (const action of opts.actions) {
          if (action._tag === "Rebase") rebased.set(action.branch, action.parent);
          if (action._tag === "Push") pushed.set(action.branch, action.remotes);
          if (action._tag === "CreatePull") created.set(action.branch, action);
          if (action._tag === "FastForward") fastForwarded.add(action.branch);
          if (action._tag === "Backup") backups += 1;
          if (action._tag === "UpdateStackLinks") updatedPrs.add(action.pr);
        }

        const failedBranch = opts.failed?.branch ?? null;
        const blocked = new Set<string>();
        const collectBlocked = (branch: string) => {
          for (const child of children.get(branch) ?? []) {
            blocked.add(child);
            collectBlocked(child);
          }
        };
        if (failedBranch) collectBlocked(failedBranch);

        const label = (branch: string) => {
          const link = links.get(branch);
          const pull = pulls.get(branch);
          const creating = created.get(branch) ?? null;
          const pr = pull?.number ?? creating?.pr ?? (creating ? null : (link?.pr ?? null));
          return `${branch}${pr ? ` ${reference(Number(pr))}` : ""}`;
        };
        const status = (branch: string) => {
          if (failedBranch === branch) {
            return {
              icon: "✕",
              note: `failed to rebase onto ${opts.failed?.parent}`,
            };
          }
          if (blocked.has(branch)) return { icon: "◌", note: "not changed" };
          const parent = rebased.get(branch);
          if (parent) {
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would rebase onto ${parent}` }
              : {
                  icon: pushed.has(branch) ? "✓" : "◌",
                  note: `rebased onto ${parent}`,
                };
          }
          const remotes = pushed.get(branch);
          if (remotes) {
            const remoteText =
              remotes.length === 1 && remotes[0] === "origin" ? "" : ` to ${remotes.join(", ")}`;
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would push${remoteText}` }
              : { icon: "✓", note: `pushed${remoteText}` };
          }
          if (created.has(branch)) {
            return opts.mode === "dry-run"
              ? { icon: "◌", note: `would create ${requestLabel}` }
              : { icon: "✓", note: `created ${requestLabel}` };
          }
          return { icon: "●", note: "" };
        };

        // Anchor the tree at each in-scope branch whose parent is out of scope: a
        // trunk, or (under subtree scoping) an ancestor left read-only. The parent
        // is shown only as context; the walk descends into the scoped subtree.
        const inScope = new Set(opts.state.links.map((link) => String(link.branch)));
        const parentOf = (branch: string) => String(links.get(branch)?.parent ?? "");
        const tops = [...inScope]
          .filter((branch) => !inScope.has(parentOf(branch)))
          .sort((a, b) => a.localeCompare(b));
        const anchors = new Map<string, Array<string>>();
        for (const top of tops) {
          const list = anchors.get(parentOf(top)) ?? [];
          list.push(top);
          anchors.set(parentOf(top), list);
        }
        // Render anchor groups in trunk config order first, then remaining
        // parents alphabetically, so multi-trunk output follows stack.trunks.
        const anchorRank = (parent: string) => {
          const index = trunkNames.indexOf(parent);
          return index >= 0 ? index : trunkNames.length;
        };
        const orderedAnchors = [...anchors.entries()].sort(
          ([a], [b]) => anchorRank(a) - anchorRank(b) || a.localeCompare(b),
        );
        const trunkName =
          trunkNames.find((name) => (children.get(name) ?? []).length > 0) ??
          trunkNames[0] ??
          "main";
        const lines =
          tops.length === 0
            ? [opts.title, "", `● ${trunkName}`, "└─ ◌ stack is current"]
            : [opts.title, ""];
        const walk = (branch: string, prefix: string, last: boolean) => {
          const item = status(branch);
          lines.push(
            `${prefix}${last ? "└─" : "├─"} ${item.icon} ${label(branch)}${item.note ? ` ${item.note}` : ""}`,
          );
          const kids = children.get(branch) ?? [];
          kids.forEach((child, index) =>
            walk(child, `${prefix}${last ? "   " : "│  "}`, index === kids.length - 1),
          );
        };
        for (const [parent, groupTops] of orderedAnchors) {
          lines.push(`● ${parent}`);
          groupTops.forEach((top, index) => walk(top, "", index === groupTops.length - 1));
        }

        const summary = new Array<string>();
        if (fastForwarded.size > 0) {
          const prefix = opts.mode === "dry-run" ? "would " : "";
          for (const branch of [...fastForwarded].sort((a, b) => a.localeCompare(b))) {
            summary.push(`${prefix}fast-forward ${branch} to origin/${branch}`);
          }
        }
        if (created.size > 0) {
          const verb =
            opts.mode === "dry-run" ? `Would create ${requestLabel}s` : `Created ${requestLabel}s`;
          summary.push(
            `${verb}: ${[...created.values()]
              .sort((a, b) => a.branch.localeCompare(b.branch))
              .map((item) => (item.pr ? reference(item.pr) : `${item.branch} -> ${item.base}`))
              .join(", ")}`,
          );
        }
        if (updatedPrs.size > 0) {
          const verb =
            opts.mode === "dry-run" ? `Would update ${requestLabel}s` : `Updated ${requestLabel}s`;
          summary.push(
            `${verb}: ${[...updatedPrs]
              .sort((a, b) => a - b)
              .map((pr) => reference(pr))
              .join(", ")}`,
          );
        }
        if (backups > 0 && opts.mode === "apply") summary.push(`Backups created: ${backups}`);
        if (summary.length > 0) lines.push("", ...summary);
        if (opts.mode === "dry-run") lines.push("", "Apply:", "  stack sync --apply");
        else if (!opts.failed && (backups > 0 || updatedPrs.size > 0)) {
          lines.push("", "Undo:", "  stack undo --apply");
        }
        return lines;
      };

      const scopedBranches = (state: ReturnType<typeof stackState>, root: string) => {
        const children = new Map<string, Array<string>>();
        for (const link of state.links) {
          const parent = String(link.parent);
          const list = children.get(parent) ?? [];
          list.push(String(link.branch));
          children.set(parent, list);
        }

        const branches = new Set<string>();
        const visit = (branch: string) => {
          if (branches.has(branch)) return;
          branches.add(branch);
          for (const child of children.get(branch) ?? []) visit(child);
        };
        visit(root);
        return branches;
      };

      const filterState = (state: ReturnType<typeof stackState>, branches: ReadonlySet<string>) =>
        stackState(state.links.filter((link) => branches.has(String(link.branch))));

      const mergeState = (
        state: ReturnType<typeof stackState>,
        branches: ReadonlySet<string>,
        scoped: ReturnType<typeof stackState>,
      ) =>
        stateWithPlan(
          stackState(state.links.filter((link) => !branches.has(String(link.branch)))),
          scoped.links,
        );

      const writeScopedState = (branches: ReadonlySet<string>) =>
        Effect.fn("Stack.writeScopedState")((next: ReturnType<typeof stackState>) =>
          store
            .read()
            .pipe(Effect.flatMap((latest) => store.write(mergeState(latest, branches, next)))),
        );

      // Cheap stack-membership graph over stored links and open PR bases. It
      // performs no per-branch merge-base calls, so sync can resolve scope before
      // paying the reconcile/infer cost, and never pays it for out-of-scope stacks.
      const syncMembership = (
        state: ReturnType<typeof stackState>,
        pulls: ReadonlyArray<PullRef>,
      ) => {
        const trunks = new Set(cfg.trunks.map(String));
        const storedBranches = new Set(state.links.map((link) => String(link.branch)));
        const storedParent = new Map(
          state.links.map((link) => [String(link.branch), String(link.parent)]),
        );
        const prsByHead = new Map<string, Array<PullRef>>();
        for (const pull of pulls) {
          const head = String(pull.head);
          const list = prsByHead.get(head) ?? [];
          list.push(pull);
          prsByHead.set(head, list);
        }
        // A branch follows its sole open PR base when it has exactly one, so a PR
        // retargeted into another stack moves with it; otherwise it falls back to
        // its stored link parent.
        const edge = (branch: string) => {
          const heads = prsByHead.get(branch);
          if (heads && heads.length === 1) return String(heads[0]!.base);
          return storedParent.get(branch) ?? null;
        };
        const grounded = (branch: string, seen = new Set<string>()): boolean => {
          if (seen.has(branch)) return false;
          seen.add(branch);
          const parent = edge(branch);
          if (parent === null) return false;
          return trunks.has(parent) || grounded(parent, seen);
        };
        const members = new Set<string>(storedBranches);
        for (const head of prsByHead.keys()) if (grounded(head)) members.add(head);

        const children = new Map<string, Array<string>>();
        for (const branch of members) {
          const parent = edge(branch);
          if (parent === null) continue;
          const list = children.get(parent) ?? [];
          list.push(branch);
          children.set(parent, list);
        }
        for (const list of children.values()) list.sort((a, b) => a.localeCompare(b));

        // A trunk-parented branch is a stack root only if it is a stored link or
        // another branch is based on it; a standalone trunk-root PR is never a root.
        const roots = [...members]
          .filter((branch) => {
            const parent = edge(branch);
            if (parent === null || !trunks.has(parent)) return false;
            return storedBranches.has(branch) || (children.get(branch)?.length ?? 0) > 0;
          })
          .sort((a, b) => a.localeCompare(b));

        const scopeBranches = (root: string) => {
          const branches = new Set<string>();
          const visit = (branch: string) => {
            if (branches.has(branch)) return;
            branches.add(branch);
            for (const child of children.get(branch) ?? []) visit(child);
          };
          visit(root);
          return branches;
        };

        const rootByMember = new Map<string, string>();
        for (const root of roots) {
          for (const branch of scopeBranches(root)) {
            if (!rootByMember.has(branch)) rootByMember.set(branch, root);
          }
        }

        return {
          roots,
          scopeBranches,
          rootOf: (branch: string) => rootByMember.get(branch) ?? null,
        };
      };

      const actionBranch = (action: StackResult.StackResultItem) => {
        switch (action._tag) {
          case "Text":
          case "UpdateStackLinks":
            return null;
          case "Track":
            return String(action.link.branch);
          case "RemoveLink":
          case "UpdateLink":
          case "Reparent":
          case "FastForward":
          case "Backup":
          case "Rebase":
          case "Push":
          case "CreatePull":
            return action.branch;
          case "RetargetPull":
            return null;
        }
      };

      const filterActions = (
        actions: ReadonlyArray<StackResult.StackResultItem>,
        branches: ReadonlySet<string>,
      ) =>
        actions.filter((action) => {
          const branch = actionBranch(action);
          return branch === null || branches.has(branch);
        });

      const changeForLink = Effect.fn("Stack.changeForLink")(function* (
        link: StackLink,
        pulls: ReadonlyArray<PullRef>,
      ) {
        const candidates = pulls.filter((pull) => pull.head === link.branch);
        const recorded = link.pr
          ? (candidates.find((pull) => Number(pull.number) === Number(link.pr)) ?? null)
          : null;
        if (recorded) return recorded;
        if (candidates.length <= 1) return candidates[0] ?? null;
        return yield* Effect.fail(
          new StackOperationError(
            `multiple open ${requestLabel}s have head branch ${link.branch}; cannot safely select ${reference(Number(link.pr ?? candidates[0]!.number))}`,
          ),
        );
      });

      const changesForLinks = Effect.fn("Stack.changesForLinks")(
        (links: ReadonlyArray<StackLink>, pulls: ReadonlyArray<PullRef>) =>
          Effect.forEach(links, (link) => changeForLink(link, pulls)).pipe(
            Effect.map((items) => items.filter((item): item is PullRef => item !== null)),
          ),
      );

      const status: StackService["status"] = Effect.fn("Stack.status")(() =>
        Effect.gen(function* () {
          const [state, refs, current, remote] = yield* Effect.all([
            store.read(),
            git.refs(),
            git.current(),
            git.remote(),
          ]);
          const pulls = yield* codeHost.changes().pipe(
            Effect.catchTags({
              ExecError: () => Effect.succeed([]),
              CodeHostDecodeError: () => Effect.succeed([]),
            }),
          );
          const base = Option.isSome(remote) ? codeHost.changeUrlBase(remote.value) : null;
          const prUrls = new Map(
            state.links.flatMap((link) =>
              base && link.pr ? [[Number(link.pr), `${base}/${link.pr}`]] : [],
            ),
          );
          return StackGraph.make({
            state,
            refs,
            pulls,
            prUrls,
            trunks: cfg.trunks,
            current,
          }).report;
        }),
      );

      const diagram = Effect.fn("Stack.diagram")(function* (branches?: ReadonlySet<string>) {
        const report = yield* status();
        const scopedReport = branches
          ? new StatusReport({
              current: report.current,
              trunks: report.trunks,
              nodes: report.nodes.filter((node) => branches.has(String(node.branch))),
            })
          : report;
        return ["", "Stack", renderDiagram(scopedReport, reference)];
      });

      const adopt = Effect.fn("Stack.adopt")((branch: string, parent: string) =>
        Effect.gen(function* () {
          const refs = yield* git.refs();
          if (trunk(branch)) {
            return yield* Effect.fail(
              new StackOperationError(`cannot track trunk branch: ${branch}`),
            );
          }
          if (branch === parent) {
            return yield* Effect.fail(
              new StackOperationError(`${branch} cannot be its own parent`),
            );
          }
          if (!refs.some((ref) => ref.name === branch))
            return yield* Effect.fail(new BranchError(branch));
          if (!refs.some((ref) => ref.name === parent) && !trunk(parent)) {
            return yield* Effect.fail(new BranchError(parent));
          }

          const base = yield* git.base(branch, parent);
          if (Option.isNone(base)) return yield* Effect.fail(new MergeBaseError(branch, parent));

          const [state, pulls] = yield* Effect.all([store.read(), codeHost.changes()]);
          const nextLinks = new Map(
            state.links
              .filter((link) => link.branch !== branch)
              .map((link) => [String(link.branch), String(link.parent)]),
          );
          if (
            StackGraph.wouldCreateCycle(nextLinks, new Set(cfg.trunks.map(String)), branch, parent)
          ) {
            return yield* Effect.fail(
              new StackOperationError(`tracking ${branch} onto ${parent} would create a cycle`),
            );
          }
          const candidates = pulls.filter((pull) => pull.head === branch);
          if (candidates.length > 1) {
            return yield* Effect.fail(
              new StackOperationError(
                `multiple open ${requestLabel}s have head branch ${branch}; cannot safely track one`,
              ),
            );
          }
          const pull = candidates[0] ?? null;
          const pr = pull?.number ?? null;
          const next = stackLink({
            branch,
            parent,
            anchor: base.value,
            pr,
            headRepository: pull?.headRepository ?? null,
          });
          const prev = state.links.find((link) => link.branch === branch) ?? null;
          if (
            prev &&
            prev.parent === next.parent &&
            prev.anchor === next.anchor &&
            prev.pr === next.pr &&
            prev.headRepository === next.headRepository
          ) {
            return next;
          }
          const links = state.links.filter((link) => link.branch !== branch);

          yield* store.write(
            stackState([...links, next].sort((a, b) => a.branch.localeCompare(b.branch))),
          );

          return next;
        }),
      );

      const inferApplyPlan = Effect.fn("Stack.inferApplyPlan")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
        ) =>
          Effect.gen(function* () {
            const refNames = new Set(refs.map((ref) => String(ref.name)));
            const explicit = new Map(
              state.links.map((link) => [String(link.branch), String(link.parent)]),
            );
            const trunks = new Set(cfg.trunks.map(String));
            const childBases = new Set(
              pulls.map((pull) => String(pull.base)).filter((base) => !trunks.has(base)),
            );
            const planned = new Map(explicit);
            const actions: Array<StackLink> = [];

            for (const pull of pulls) {
              const branch = String(pull.head);
              const parent = String(pull.base);
              if (explicit.has(branch)) continue;
              if (!refNames.has(branch)) continue;
              if (!refNames.has(parent) && !trunks.has(parent)) continue;
              if (branch === parent) continue;
              if (trunks.has(parent) && !childBases.has(branch)) continue;
              if (pulls.filter((item) => item.head === pull.head).length > 1) {
                return yield* Effect.fail(
                  new StackOperationError(
                    `multiple open ${requestLabel}s have head branch ${branch}; cannot safely infer a stack link`,
                  ),
                );
              }
              if (StackGraph.wouldCreateCycle(planned, trunks, branch, parent)) {
                continue;
              }

              const anchor = yield* git.base(branch, parent);
              if (Option.isNone(anchor)) continue;

              const action = stackLink({
                branch,
                parent,
                anchor: anchor.value,
                pr: Number(pull.number),
                headRepository: pull.headRepository,
              });
              actions.push(action);
              planned.set(branch, parent);
            }

            return actions;
          }),
      );

      const reconcileApplyState = Effect.fn("Stack.reconcileApplyState")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
          mode: StackResult.Mode,
        ) =>
          Effect.gen(function* () {
            const trunks = new Set(cfg.trunks.map(String));
            const refNames = new Set(refs.map((ref) => String(ref.name)));
            const selectedPulls = yield* changesForLinks(state.links, pulls);
            const pullsByBranch = new Map(selectedPulls.map((pull) => [String(pull.head), pull]));
            const openBases = new Set(pulls.map((pull) => String(pull.base)));
            const actions: Array<StackResult.StackResultItem> = [];
            const kept = new Array<StackLink>();
            const replayAnchors = new Map<string, string>();

            for (const link of state.links) {
              const branch = String(link.branch);
              const pull = pullsByBranch.get(branch) ?? null;
              if (!pull && !openBases.has(branch)) {
                actions.push({
                  _tag: "RemoveLink",
                  mode,
                  branch,
                  reason: `no open ${requestLabel} and no open child ${requestLabel} depends on it`,
                });
                continue;
              }
              kept.push(link);
            }

            const plannedParents = new Map(
              kept.map((link) => [String(link.branch), String(link.parent)]),
            );
            const reconciled = new Array<StackLink>();
            for (const link of kept) {
              const branch = String(link.branch);
              const pull = pullsByBranch.get(branch) ?? null;
              const parent = pull ? String(pull.base) : String(link.parent);
              const parentValid = refNames.has(parent) || trunks.has(parent);
              if (
                pull &&
                parent !== link.parent &&
                parentValid &&
                branch !== parent &&
                !StackGraph.wouldCreateCycle(
                  new Map([...plannedParents].filter(([name]) => name !== branch)),
                  trunks,
                  branch,
                  parent,
                )
              ) {
                const anchor = yield* git.base(branch, parent);
                if (Option.isSome(anchor)) {
                  const oldParent = String(link.parent);
                  const oldParentTracked = plannedParents.has(oldParent) || trunks.has(oldParent);
                  if (!oldParentTracked) replayAnchors.set(branch, String(link.anchor));
                  const next = stackLink({
                    branch,
                    parent,
                    anchor: oldParentTracked ? anchor.value : link.anchor,
                    pr: Number(pull.number),
                    headRepository: pull.headRepository,
                  });
                  actions.push({
                    _tag: "UpdateLink",
                    mode,
                    branch,
                    from: String(link.parent),
                    to: parent,
                    anchor: anchor.value,
                  });
                  plannedParents.set(branch, parent);
                  reconciled.push(next);
                  continue;
                }
              }
              reconciled.push(link);
            }

            return {
              state: stackState(reconciled.sort((a, b) => a.branch.localeCompare(b.branch))),
              actions,
              replayAnchors,
            };
          }),
      );

      const stateWithPlan = (
        state: ReturnType<typeof stackState>,
        plan: ReadonlyArray<StackLink>,
      ) => {
        const planned = new Map(state.links.map((link) => [String(link.branch), link]));
        for (const action of plan) {
          planned.set(String(action.branch), action);
        }

        return stackState([...planned.values()].sort((a, b) => a.branch.localeCompare(b.branch)));
      };

      const repairStack = Effect.fn("Stack.repairStack")(
        (
          state: ReturnType<typeof stackState>,
          refs: ReadonlyArray<BranchRef>,
          pulls: ReadonlyArray<PullRef>,
          opts: {
            readonly apply: boolean;
            readonly saved?: Map<string, string>;
            readonly journalState?: ReturnType<typeof stackState>;
            readonly initialEntries?: ReadonlyArray<UndoEntry>;
            readonly journalActions?: ReadonlyArray<StackResult.StackResultItem>;
            readonly initialActions?: ReadonlyArray<StackResult.StackResultItem>;
            readonly replayAnchors?: ReadonlyMap<string, string>;
            readonly writeState?: (
              state: ReturnType<typeof stackState>,
            ) => Effect.Effect<void, StackError>;
            readonly preserveUndo?: boolean;
          },
        ) =>
          Effect.gen(function* () {
            const apply = opts.apply;
            const saved = opts.saved ?? new Map<string, string>();
            const replayAnchors = opts.replayAnchors ?? new Map<string, string>();
            const journalState = opts.journalState ?? state;
            const journalActions = opts.journalActions ?? [];
            const initialActions = opts.initialActions ?? [];
            const mode: StackResult.Mode = apply ? "apply" : "dry-run";
            const stamp = yield* timestamp();
            const actions: Array<StackResult.StackResultItem> = Array.from(initialActions);
            const links = new Map(state.links.map((link) => [String(link.branch), link]));
            const graph = StackGraph.make({
              state,
              refs,
              pulls,
              trunks: cfg.trunks,
              current: "",
            });

            const live = new Map(refs.map((ref) => [String(ref.name), ref]));
            const heads = new Map(refs.map((ref) => [String(ref.name), ref.head]));
            const duplicateHeads = new Set<string>();
            const prs = new Map<string, PullRef>();
            for (const pull of pulls) {
              const branch = String(pull.head);
              if (prs.has(branch)) duplicateHeads.add(branch);
              prs.set(branch, pull);
            }
            const ambiguous = state.links.find((link) => duplicateHeads.has(String(link.branch)));
            if (ambiguous) {
              return yield* Effect.fail(
                new StackOperationError(
                  `multiple open ${requestLabel}s have head branch ${ambiguous.branch}; cannot safely select a remote to repair`,
                ),
              );
            }
            const childBases = new Set(pulls.map((pull) => String(pull.base)));
            let remoteByRepository: Map<string, string> | null = null;
            const tips = new Map<string, string | null>();
            const prior = new Map<string, string>();
            const moved = new Set<string>();
            const entries: Array<UndoEntry> = Array.from(opts.initialEntries ?? []);
            const next: Array<StackLink> = [];
            let journal = apply && (initialActions.length > 0 || entries.length > 0);

            const headRemote = Effect.fn("Stack.repairStack.headRemote")(function* (
              headRepository: string | null,
              change: number | null,
            ) {
              if (!headRepository) return "origin";
              if (!remoteByRepository) {
                const originRemote = yield* git.remote();
                remoteByRepository = new Map(
                  (yield* git.remotes()).flatMap((remote): Array<[string, string]> => {
                    const repository = codeHost.repository(
                      remote.url,
                      Option.getOrUndefined(originRemote),
                    );
                    return repository ? [[repository, remote.name]] : [];
                  }),
                );
              }
              const remote = remoteByRepository.get(headRepository);
              if (remote) return remote;
              return yield* new StackOperationError(
                `${requestLabel}${change === null ? "" : ` ${reference(change)}`} head is ${headRepository}, but no local git remote points to that repository`,
              );
            });

            const pushRemotes = Effect.fn("Stack.repairStack.pushRemotes")(function* (
              branch: string,
              headRepository: string | null,
              change: number | null,
            ) {
              const remotes = new Set<string>([yield* headRemote(headRepository, change)]);
              if (childBases.has(branch)) remotes.add("origin");
              return [...remotes];
            });

            const backups = refs
              .map((ref) => ref.name)
              .filter(
                (name) =>
                  name.startsWith("backup/landed-") || name.startsWith("backup/stack-sync-"),
              )
              .sort();
            for (const name of backups) {
              for (const link of state.links) {
                if (name.endsWith(`-${link.branch}`)) prior.set(String(link.branch), name);
              }
            }

            const checkpoint = Effect.fn("Stack.repairStack.checkpoint")(() =>
              apply
                ? store.writeUndo(
                    undoState(
                      stamp,
                      journalState,
                      entries,
                      StackResult.renderAll(
                        [...journalActions, ...actions],
                        reference,
                        requestLabel,
                      ),
                    ),
                  )
                : Effect.void,
            );

            if (journal) yield* checkpoint();

            const resolve = (name: string, seen = new Set<string>()): string | null => {
              let parent = name;
              for (;;) {
                if (live.has(parent) || trunk(parent)) return parent;
                if (seen.has(parent)) return null;
                seen.add(parent);
                const link = links.get(parent);
                if (!link) return null;
                parent = String(link.parent);
              }
            };

            // Effective tip per reconciled branch: origin's tip when the local ref
            // was fast-forwarded to it. Drift detection and `onto` resolution below
            // consult this so a stale local ref never measures drift or replays
            // against the wrong parent — in apply mode we also move the local ref,
            // but in dry-run the ref stays put and this map carries origin's tip.
            const reconciledTips = new Map<string, string>();

            // Reconcile local branch refs against origin before any drift detection.
            // `git fetch` moves only remote-tracking refs; when a parent (or an
            // in-scope branch) was force-pushed from another worktree/agent, the
            // local ref is stale and drift would be measured against the wrong tip —
            // producing a silent no-op "success" or a rebase onto the stale parent.
            //
            // We touch only branches this run already reads: in-scope members and
            // their non-trunk parent rebase targets (trunks resolve to origin/<trunk>
            // and need no reconciliation). Per branch, comparing local L and origin R:
            //   L == R                -> nothing.
            //   L is an ancestor of R -> fast-forward the local ref to R.
            //   R is an ancestor of L -> local is strictly ahead; it will be pushed.
            //   diverged              -> asymmetric: a read-only parent target is
            //                            fatal (we will not guess which tip wins),
            //                            but an in-scope member is left to repair,
            //                            whose replay + force-with-lease push is
            //                            exactly the retry-after-failed-push recovery.
            const reconcile = Effect.fn("Stack.repairStack.reconcile")(function* () {
              const members = new Set(state.links.map((link) => String(link.branch)));
              // Value = isMember. Every branch in state.links is inserted with `true`
              // before any child link can add it as a parent-only target, so the
              // `!targets.has(parent)` guard never downgrades a member to a
              // parent-only `false` entry — parents already seen keep their flag.
              const targets = new Map<string, boolean>();
              for (const link of state.links) {
                const branch = String(link.branch);
                if (live.has(branch)) targets.set(branch, true);
                const parent = resolve(String(link.parent));
                if (parent && !trunk(parent) && live.has(parent) && !targets.has(parent)) {
                  targets.set(parent, members.has(parent));
                }
              }

              for (const [branch, isMember] of targets) {
                const localRef = live.get(branch);
                if (!localRef) continue;
                const local = String(localRef.head);
                const remoteRef = yield* git.head(`origin/${branch}`);
                if (Option.isNone(remoteRef)) continue;
                const remote = remoteRef.value;
                if (local === remote) continue;

                // One merge-base call classifies behind/ahead/diverged: mb == local
                // means local is strictly behind origin, mb == remote means local is
                // strictly ahead, anything else is a divergence.
                const mergeBase = yield* git.base(local, remote);
                const mb = Option.isSome(mergeBase) ? mergeBase.value : null;
                if (mb === local) {
                  reconciledTips.set(branch, remote);
                  actions.push({ _tag: "FastForward", mode, branch });
                  if (apply) yield* git.fastForward(branch);
                  heads.set(branch, remote);
                  tips.set(branch, remote);
                  live.set(branch, branchRef({ name: branch, head: remote }));
                  continue;
                }
                if (mb === remote) continue;

                // Diverged. Repair owns in-scope members; a read-only parent is fatal.
                if (isMember) continue;
                return yield* Effect.fail(
                  new StackOperationError(
                    [
                      `${branch} has diverged from origin/${branch}:`,
                      `  local:  ${local}`,
                      `  origin: ${remote}`,
                      "",
                      `${branch} is a read-only rebase target for this sync, so stack will not guess which tip is correct.`,
                      "Reconcile it, then rerun:",
                      `  git branch -f ${branch} origin/${branch}            # if origin is correct`,
                      `  git push --force-with-lease origin ${branch}        # if your local ${branch} is correct`,
                    ].join("\n"),
                  ),
                );
              }
            });

            yield* reconcile();

            const plannedRepairBranches = Effect.fn("Stack.repairStack.plannedRepairBranches")(
              function* () {
                const branches = new Set<string>();
                const plannedMoved = new Set<string>();
                const plannedTips = new Map<string, string | null>(reconciledTips);

                for (const link of [...state.links].sort(
                  (a, b) => graph.rank(String(a.branch)) - graph.rank(String(b.branch)),
                )) {
                  if (!live.has(String(link.branch))) continue;

                  const parent = resolve(String(link.parent));
                  if (!parent) continue;

                  const onto = trunk(parent) ? `origin/${parent}` : parent;
                  if (!plannedTips.has(onto)) {
                    const tip = yield* git.head(onto);
                    plannedTips.set(onto, Option.isSome(tip) ? tip.value : null);
                  }
                  const want = plannedTips.get(onto) ?? heads.get(parent) ?? null;
                  const have = yield* git.base(link.branch, onto);
                  const drift =
                    replayAnchors.has(String(link.branch)) ||
                    parent !== link.parent ||
                    plannedMoved.has(parent) ||
                    (want && (Option.isNone(have) || have.value !== want));

                  if (drift) {
                    branches.add(String(link.branch));
                    plannedMoved.add(String(link.branch));
                  }
                }

                return branches;
              },
            );

            if (apply) yield* ensureRepairableWorktrees([...(yield* plannedRepairBranches())]);

            for (const link of [...state.links].sort(
              (a, b) => graph.rank(String(a.branch)) - graph.rank(String(b.branch)),
            )) {
              if (!live.has(String(link.branch))) {
                if (!prs.has(String(link.branch))) continue;
                next.push(link);
                continue;
              }

              const parent = resolve(String(link.parent));
              if (!parent) {
                next.push(link);
                actions.push(
                  StackResult.text(`skip ${link.branch}: cannot resolve parent ${link.parent}`),
                );
                continue;
              }

              if (parent !== link.parent)
                actions.push({
                  _tag: "Reparent",
                  mode,
                  branch: String(link.branch),
                  from: String(link.parent),
                  to: parent,
                });

              const pr = prs.get(String(link.branch)) ?? null;
              const onto = trunk(parent) ? `origin/${parent}` : parent;
              const from =
                saved.get(String(link.parent)) ??
                (live.has(String(link.parent))
                  ? String(link.parent)
                  : (prior.get(String(link.parent)) ?? String(link.parent)));
              if (!tips.has(onto)) {
                const tip = yield* git.head(onto);
                tips.set(onto, Option.isSome(tip) ? tip.value : null);
              }
              const want = tips.get(onto) ?? heads.get(parent) ?? null;
              const have = yield* git.base(link.branch, onto);
              const drift =
                replayAnchors.has(String(link.branch)) ||
                parent !== link.parent ||
                (!apply && moved.has(parent)) ||
                (want && (Option.isNone(have) || have.value !== want));
              const base = pr?.base ?? null;
              let backup: string | null = null;
              let created: number | null = null;
              let num = pr?.number ?? link.pr;
              const previous =
                apply && !pr && link.pr
                  ? yield* codeHost
                      .change(link.pr)
                      .pipe(
                        Effect.catchTag("CodeHostChangeNotFoundError", () =>
                          Effect.succeed<PullMeta | null>(null),
                        ),
                      )
                  : null;
              const headRepository =
                pr?.headRepository ?? previous?.headRepository ?? link.headRepository ?? null;

              if (drift) {
                const targetRemotes = yield* pushRemotes(
                  String(link.branch),
                  headRepository,
                  pr ? Number(pr.number) : link.pr ? Number(link.pr) : null,
                );
                // Replay-range base preference, most precise first:
                //   1. same-run rewrites — `replayAnchors` (this run retargeted the
                //      child off an untracked parent) and `saved` backups (this run
                //      rebased the parent, folded into `from` below): exact old-parent
                //      tips recorded this run.
                //   2. persisted `link.anchor` when it is still an ancestor of the
                //      child — the parent tip the child was last made consistent with.
                //      Preferring it over merge-base means a manual parent rewrite
                //      between runs replays exactly the child's own commits instead of
                //      the rewritten-parent commits a wide merge-base range would drag
                //      in (whose patches no longer apply).
                //   3. merge-base(child, from) fallback.
                const replayAnchor = replayAnchors.get(String(link.branch));
                const persistedAnchor =
                  replayAnchor === undefined &&
                  !saved.has(String(link.parent)) &&
                  link.anchor !== "" &&
                  (yield* git.ancestor(String(link.anchor), String(link.branch)))
                    ? String(link.anchor)
                    : null;
                const anchor = replayAnchor ?? persistedAnchor;
                const baseRef = anchor ? Option.some(anchor) : yield* git.base(link.branch, from);
                const commitsToReplay = Option.isSome(baseRef)
                  ? yield* Effect.gen(function* () {
                      const commits = yield* git.commits(baseRef.value, link.branch);
                      return yield* git.novel(onto, link.branch, commits);
                    })
                  : Array<string>();
                backup = `backup/stack-sync-${stamp}-${link.branch}`;
                const rebase = {
                  branch: String(link.branch),
                  parent,
                  onto,
                  backup,
                  commits: commitsToReplay,
                  pushRemotes: targetRemotes,
                } satisfies RepairPlan.RebaseBranchPlan;
                actions.push(...RepairPlan.rebaseBranch(rebase, mode));

                if (apply) {
                  const priorEntry = entries.find((item) => item.branch === link.branch) ?? null;
                  const entry = undoEntry({
                    branch: link.branch,
                    backup,
                    pr: priorEntry?.pr ?? pr?.number ?? link.pr ?? null,
                    base: priorEntry?.base ?? base,
                    created: priorEntry?.created ?? null,
                    pushRemotes: targetRemotes,
                  });
                  const entryIndex = entries.findIndex((item) => item.branch === link.branch);
                  if (entryIndex >= 0) entries[entryIndex] = entry;
                  else entries.push(entry);
                  journal = true;
                  yield* RepairExecution.applyRebaseBranch(rebase, {
                    git,
                    checkpoint,
                    step,
                    onReplayFailure: (err) => replayFailure(rebase, err, state, pulls, actions),
                  });
                  saved.set(rebase.branch, rebase.backup);
                  const tip = yield* git.head(link.branch);
                  const head = Option.isSome(tip)
                    ? tip.value
                    : (want ?? heads.get(link.branch) ?? link.anchor);
                  heads.set(link.branch, head);
                  tips.set(link.branch, head);
                  live.set(link.branch, branchRef({ name: link.branch, head }));
                } else {
                  heads.set(link.branch, `planned/${link.branch}`);
                }

                moved.add(link.branch);
              }

              const now = prs.get(link.branch) ?? null;
              if (now && now.base !== parent) {
                const retarget = {
                  pr: Number(now.number),
                  base: parent,
                } satisfies RepairPlan.RetargetPullPlan;
                actions.push(RepairPlan.retargetPull(retarget, mode));
                if (apply) {
                  if (!entries.some((item) => item.branch === link.branch)) {
                    entries.push(
                      undoEntry({
                        branch: link.branch,
                        backup: null,
                        pr: now.number,
                        base,
                        created,
                      }),
                    );
                    journal = true;
                  }
                  yield* RepairExecution.applyRetargetPull(retarget, {
                    checkpoint,
                    step,
                    edit: codeHost.edit,
                    reference,
                  });
                }
                prs.set(
                  link.branch,
                  pullRef({
                    number: now.number,
                    head: now.head,
                    headRepository: now.headRepository,
                    base: parent,
                    url: now.url,
                    draft: now.draft,
                    checks: now.checks,
                  }),
                );
              }

              const open = prs.get(link.branch) ?? null;
              if (!open) {
                if (apply) {
                  const prev = previous;
                  const nextPr = draft(link, parent, prev);
                  if (!entries.some((item) => item.branch === link.branch)) {
                    entries.push(
                      undoEntry({
                        branch: link.branch,
                        backup: null,
                        pr: now?.number ?? link.pr ?? null,
                        base,
                        created: null,
                      }),
                    );
                    journal = true;
                  }
                  yield* step(`create ${requestLabel} for ${link.branch} -> ${parent}`);
                  yield* checkpoint();
                  const made = yield* codeHost.create(
                    link.branch,
                    parent,
                    nextPr.title,
                    nextPr.body,
                    nextPr.labels,
                    headRepository,
                  );
                  created = made.number;
                  num = made.number;
                  prs.set(link.branch, made);
                  const createdPull = {
                    branch: String(link.branch),
                    base: parent,
                    pr: Number(made.number),
                  } satisfies RepairPlan.CreatePullPlan;
                  actions.push(RepairPlan.createPull(createdPull, mode));
                  const i = entries.findIndex((item) => item.branch === link.branch);
                  if (i >= 0) {
                    entries[i] = undoEntry({
                      branch: entries[i]!.branch,
                      backup: entries[i]!.backup,
                      pr: entries[i]!.pr,
                      base: entries[i]!.base,
                      created: made.number,
                      ...(entries[i]!.pushRemotes ? { pushRemotes: entries[i]!.pushRemotes } : {}),
                    });
                  } else {
                    entries.push(
                      undoEntry({
                        branch: link.branch,
                        backup: null,
                        pr: now?.number ?? link.pr ?? null,
                        base,
                        created: made.number,
                      }),
                    );
                  }
                  journal = true;
                  yield* checkpoint();
                } else {
                  actions.push(
                    RepairPlan.createPull(
                      {
                        branch: String(link.branch),
                        base: parent,
                        pr: null,
                      },
                      mode,
                    ),
                  );
                }
              } else {
                num = open.number;
              }

              next.push(
                stackLink({
                  branch: String(link.branch),
                  parent,
                  anchor: heads.get(parent) ?? want ?? link.anchor,
                  pr: num ?? null,
                  headRepository: open?.headRepository ?? headRepository,
                }),
              );
            }

            const resultState = stackState(next.sort((a, b) => a.branch.localeCompare(b.branch)));

            if (apply && (actions.length > 0 || !sameState(state, resultState))) {
              yield* (opts.writeState ?? store.write)(resultState);
            }

            if (apply && !journal && !opts.preserveUndo) {
              yield* store.clearUndo();
            }

            return {
              actions,
              state: resultState,
              undo: journal
                ? undoState(
                    stamp,
                    journalState,
                    entries,
                    StackResult.renderAll([...journalActions, ...actions], reference, requestLabel),
                  )
                : null,
              lines:
                actions.length > 0
                  ? StackResult.renderAll(actions, reference, requestLabel)
                  : [apply ? "stack is current" : "would make no changes"],
            };
          }),
      );

      const sync: StackService["sync"] = Effect.fn("Stack.sync")((opts) =>
        Effect.gen(function* () {
          const apply = opts?.apply ?? false;
          const dryRun = !apply;
          const requestedBranch = opts?.branch;
          const all = opts?.all ?? false;
          const continueOnFailure = opts?.continueOnFailure ?? false;
          if (all && requestedBranch) {
            return yield* Effect.fail(
              new StackOperationError("use either a branch or --all, not both"),
            );
          }
          if (continueOnFailure && !all) {
            return yield* Effect.fail(
              new StackOperationError("--continue-on-failure requires --all"),
            );
          }
          const current = (requestedBranch || all) && dryRun ? "" : yield* git.current();
          return yield* Effect.gen(function* () {
            if (!dryRun) yield* clean();
            // Fetch in dry-run too: refreshing remote-tracking refs is a read
            // refresh, not a mutation, and reconciliation/drift detection below
            // must see origin's real tips so previews match what apply would do.
            yield* git.fetch();
            const [state, refs, pulls] = yield* Effect.all([
              store.read(),
              git.refs(),
              codeHost.changes(),
            ]);
            const mode: StackResult.Mode = dryRun ? "dry-run" : "apply";

            // Reconcile stale links and infer PR-base links over a subset of the
            // repo (or the whole repo), then plan its track/reconcile actions.
            const reconcilePlan = (
              scopedState: ReturnType<typeof stackState>,
              scopedPulls: ReadonlyArray<PullRef>,
            ) =>
              Effect.gen(function* () {
                const reconciled = yield* reconcileApplyState(scopedState, refs, scopedPulls, mode);
                const plan = yield* inferApplyPlan(reconciled.state, refs, scopedPulls);
                const planned = stateWithPlan(reconciled.state, plan);
                const initialActions = [...reconciled.actions, ...plan.map(StackResult.track)];
                return { planned, initialActions, replayAnchors: reconciled.replayAnchors };
              });

            // Repair one scope (or the whole repo when target is null) and render
            // the tree summary from an already-scoped plan.
            const repairAndRender = (opts: {
              readonly planned: ReturnType<typeof stackState>;
              readonly initialActions: ReadonlyArray<StackResult.StackResultItem>;
              readonly replayAnchors: ReadonlyMap<string, string>;
              readonly target: {
                readonly root: string;
                readonly branches: ReadonlySet<string>;
              } | null;
              // Whole-stack member set for the read-only stack-block body refresh.
              // Branch mutations stay within `target.branches`; PR bodies may span
              // the stack so sibling/ancestor widgets keep correct topology.
              readonly bodyScope?: ReadonlySet<string>;
              readonly preserveUndo?: boolean;
            }) =>
              Effect.gen(function* () {
                const { target } = opts;
                const scoped = target ? filterState(opts.planned, target.branches) : opts.planned;
                const scopedInitial = target
                  ? filterActions(opts.initialActions, target.branches)
                  : opts.initialActions;
                const replayAnchors = target
                  ? new Map(
                      [...opts.replayAnchors].filter(([branch]) => target.branches.has(branch)),
                    )
                  : opts.replayAnchors;
                const writeState = target ? writeScopedState(target.branches) : undefined;
                const scopedPulls = yield* changesForLinks(scoped.links, pulls);
                const repair = yield* repairStack(scoped, refs, scopedPulls, {
                  apply: !dryRun,
                  journalState: state,
                  replayAnchors,
                  initialActions: scopedInitial,
                  ...(writeState ? { writeState } : {}),
                  preserveUndo: opts.preserveUndo ?? false,
                });
                const changedOpenPulls = repair.actions.some(
                  (action) => action._tag === "RetargetPull" || action._tag === "CreatePull",
                );
                const freshPulls = !dryRun && changedOpenPulls ? yield* codeHost.changes() : pulls;
                // Body refresh spans the whole stack when a subtree was scoped, so
                // ancestor and sibling widgets re-render with the current topology.
                const bodyState =
                  opts.bodyScope && target
                    ? filterState(mergeState(state, target.branches, repair.state), opts.bodyScope)
                    : repair.state;
                const notesPulls = yield* changesForLinks(bodyState.links, freshPulls);
                const notes = yield* linksFor(bodyState, !dryRun, new Set(), notesPulls);
                const changed = repair.actions.length > 0 || notes.actions.length > 0;
                const lines = !changed
                  ? renderSyncTree({
                      title: "Stack is current",
                      state: scoped,
                      pulls: scopedPulls,
                      actions: [],
                      mode,
                    })
                  : renderSyncTree({
                      title: dryRun ? "Sync preview" : "Synced stack",
                      state: repair.state,
                      pulls: scopedPulls,
                      actions: [...repair.actions, ...notes.actions],
                      mode,
                    });
                return { lines, undo: repair.undo };
              });

            if (!all) {
              // Resolve scope from the cheap membership graph before any
              // merge-base work, then reconcile/infer/repair only that subset.
              const membership = syncMembership(state, pulls);
              // Scope is the named branch's subtree (branch + descendants), not the
              // whole stack: ancestors stay read-only rebase targets so a lower-branch
              // fix never moves the root or sibling subtrees. `stackBranches` carries
              // the full stack for the read-only whole-stack stack-block body refresh.
              const scope = yield* Effect.gen(function* () {
                if (requestedBranch) {
                  const stackRoot = membership.rootOf(requestedBranch);
                  if (!stackRoot) {
                    return yield* Effect.fail(
                      new StackOperationError(`${requestedBranch} is not part of a tracked stack`),
                    );
                  }
                  return {
                    root: requestedBranch,
                    branches: membership.scopeBranches(requestedBranch),
                    stackBranches: membership.scopeBranches(stackRoot),
                  };
                }
                const currentRoot = membership.rootOf(current);
                if (currentRoot) {
                  return {
                    root: current,
                    branches: membership.scopeBranches(current),
                    stackBranches: membership.scopeBranches(currentRoot),
                  };
                }
                const roots = membership.roots;
                if (roots.length === 1) {
                  const branches = membership.scopeBranches(roots[0]!);
                  return { root: roots[0]!, branches, stackBranches: branches };
                }
                if (roots.length === 0) return null;
                return yield* Effect.fail(
                  new StackOperationError(
                    [
                      `off-stack: ${roots.length} stacks found`,
                      ...roots.map((root) => `  ${root}`),
                      "run: stack sync <branch> to sync that branch and its descendants",
                      "or: stack sync --all to sync every stack",
                    ].join("\n"),
                  ),
                );
              });

              const scopedState = scope ? filterState(state, scope.branches) : state;
              const scopedPulls = scope
                ? pulls.filter((pull) => scope.branches.has(String(pull.head)))
                : pulls;
              const { planned, initialActions, replayAnchors } = yield* reconcilePlan(
                scopedState,
                scopedPulls,
              );
              const result = yield* repairAndRender({
                planned,
                initialActions,
                replayAnchors,
                target: scope ? { root: scope.root, branches: scope.branches } : null,
                ...(scope ? { bodyScope: scope.stackBranches } : {}),
              });
              return result.lines;
            }

            // --all: reconcile and infer across the whole repo, then repair every
            // stack (optionally continuing past per-stack failures).
            const { planned, initialActions, replayAnchors } = yield* reconcilePlan(state, pulls);

            if (!continueOnFailure) {
              const result = yield* repairAndRender({
                planned,
                initialActions,
                replayAnchors,
                target: null,
              });
              return result.lines;
            }

            const roots = cfg.trunks
              .flatMap((trunk) => planned.links.filter((link) => String(link.parent) === trunk))
              .map((link) => String(link.branch))
              .sort((a, b) => a.localeCompare(b));
            const succeeded = new Array<string>();
            const failed = new Array<{ root: string; error: string }>();
            const sections = new Array<string>();
            const aggregateEntries = new Array<UndoEntry>();
            const aggregateActions = new Array<string>();
            let aggregateAt: string | null = null;

            const rememberUndo = (run: ReturnType<typeof undoState> | null) => {
              if (!run) return;
              aggregateAt ??= String(run.at);
              aggregateEntries.push(...run.entries);
              aggregateActions.push(...run.actions);
            };

            for (const root of roots) {
              const result = yield* Effect.result(
                repairAndRender({
                  planned,
                  initialActions,
                  replayAnchors,
                  target: { root, branches: scopedBranches(planned, root) },
                  preserveUndo: true,
                }),
              );
              if (Result.isSuccess(result)) {
                succeeded.push(root);
                if (sections.length > 0) sections.push("");
                rememberUndo(result.success.undo);
                sections.push(...result.success.lines);
              } else {
                rememberUndo(yield* store.readUndo());
                failed.push({ root, error: String(result.failure) });
              }

              if (!dryRun && aggregateAt && aggregateEntries.length > 0) {
                yield* store.writeUndo(
                  undoState(aggregateAt, state, aggregateEntries, aggregateActions),
                );
              }
            }

            const summary = [
              "Sync complete",
              `${succeeded.length} ${succeeded.length === 1 ? "stack" : "stacks"} synced, ${failed.length} ${failed.length === 1 ? "stack" : "stacks"} failed`,
            ];
            if (succeeded.length > 0) {
              summary.push("", "Succeeded:", ...succeeded.map((root) => `  ${root}`));
            }
            if (failed.length > 0) {
              summary.push("", "Failed:");
              for (const item of failed) {
                summary.push(`  ${item.root}`, item.error);
              }
            }

            const output = [...summary, ...(sections.length > 0 ? ["", ...sections] : [])];
            if (failed.length > 0) {
              return yield* Effect.fail(new StackOperationError(output.join("\n")));
            }
            return output;
          }).pipe(
            Effect.ensuring(
              dryRun
                ? Effect.void
                : git.switch(current).pipe(Effect.catchTag("ExecError", () => Effect.void)),
            ),
          );
        }),
      );

      const linksFor = Effect.fn("Stack.linksFor")(
        (
          stateOverride: ReturnType<typeof stackState> | null,
          apply = false,
          completed = new Set<string>(),
          pullsOverride?: ReadonlyArray<PullRef>,
        ) =>
          Effect.gen(function* () {
            const [state, pulls] = yield* Effect.all([
              stateOverride ? Effect.succeed(stateOverride) : store.read(),
              pullsOverride ? Effect.succeed(pullsOverride) : codeHost.changes(),
            ]);
            const selectedPulls = yield* changesForLinks(state.links, pulls);
            const prs = new Map(selectedPulls.map((pull) => [String(pull.head), pull]));
            const info = yield* Effect.all(
              state.links
                .map((link) => link.pr)
                .filter((pr): pr is NonNullable<typeof pr> => pr !== null)
                .map((pr) =>
                  codeHost
                    .change(pr)
                    .pipe(
                      Effect.catchTag("CodeHostChangeNotFoundError", () => Effect.succeed(null)),
                    ),
                ),
              { concurrency: cfg.codeHostConcurrency },
            );
            const metas = new Map(
              info
                .filter((item): item is PullMeta => item !== null)
                .map((item) => [String(item.head), item]),
            );
            const metasByNumber = new Map(
              info
                .filter((item): item is PullMeta => item !== null)
                .map((item) => [Number(item.number), item]),
            );
            const completedTitles = yield* Effect.gen(function* () {
              if (codeHost.provider !== "gitlab") return new Map<number, string>();
              const numbers = [
                ...new Set(
                  info
                    .filter((item): item is PullMeta => item !== null)
                    .flatMap((item) => StackBlock.references(item.body)),
                ),
              ];
              const completed = yield* Effect.all(
                numbers.map((number) =>
                  codeHost
                    .change(number)
                    .pipe(
                      Effect.catchTag("CodeHostChangeNotFoundError", () => Effect.succeed(null)),
                    ),
                ),
                { concurrency: cfg.codeHostConcurrency },
              );
              return new Map(
                completed
                  .filter((item): item is PullMeta => item !== null)
                  .map((item) => [Number(item.number), item.title]),
              );
            });
            const graph = StackGraph.make({
              state,
              refs: [],
              pulls: selectedPulls,
              trunks: cfg.trunks,
              current: "",
            });
            const jobs = state.links
              .map((link) => prs.get(String(link.branch)))
              .filter((pull): pull is PullRef => Boolean(pull))
              .map((pull) =>
                Effect.gen(function* () {
                  const meta =
                    metasByNumber.get(Number(pull.number)) ?? (yield* codeHost.change(pull.number));
                  const next = StackBlock.splice(
                    meta.body,
                    StackBlock.render({
                      pulls: selectedPulls,
                      metas,
                      tree: graph.displayTreeFor(String(pull.head)),
                      completed,
                      branch: String(pull.head),
                      previous: meta.body,
                      reference,
                      showTitles: codeHost.provider === "gitlab",
                      completedTitles,
                      blockLink: cfg.blockLink,
                    }),
                  );
                  if (next === meta.body) return null;
                  if (apply) {
                    yield* step(`update ${reference(Number(pull.number))} stack block`);
                    yield* codeHost.body(pull.number, next);
                  }
                  return {
                    _tag: "UpdateStackLinks",
                    mode: apply ? "apply" : "dry-run",
                    pr: Number(pull.number),
                  } satisfies StackResult.StackResultItem;
                }),
              );

            const items = yield* Effect.all(jobs, {
              concurrency: cfg.codeHostConcurrency,
            });
            const actions = items.filter((item): item is NonNullable<typeof item> => item !== null);
            return {
              actions,
              lines:
                actions.length > 0
                  ? StackResult.renderAll(actions, reference, requestLabel)
                  : [apply ? "stack links are current" : "would make no description changes"],
            };
          }),
      );

      const links: StackService["links"] = Effect.fn("Stack.links")((apply = false) =>
        linksFor(null, apply).pipe(Effect.map((result) => result.lines)),
      );

      const last = Effect.fn("Stack.last")(() =>
        Effect.gen(function* () {
          const run = yield* store.readUndo();
          if (!run) return ["no applied mutation recorded"];
          const items = run.actions.length > 0 ? run.actions : ["no actions recorded"];
          return [`last mutation: ${run.at}`, ...items, "undo with: stack undo --apply"];
        }),
      );

      const doctor: StackService["doctor"] = Effect.fn("Stack.doctor")(() =>
        Effect.gen(function* () {
          const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
          const current = yield* git.current().pipe(
            Effect.match({
              onFailure: (err) => `fail current branch: ${describe(err)}`,
              onSuccess: (branch) =>
                branch ? `ok current branch: ${branch}` : "warn detached HEAD",
            }),
          );
          const clean = yield* git.dirty().pipe(
            Effect.match({
              onFailure: (err) => `fail worktree status: ${describe(err)}`,
              onSuccess: (lines) =>
                lines.length === 0
                  ? "ok worktree clean"
                  : `warn worktree dirty: ${lines.length} changed file(s)`,
            }),
          );
          const refs = yield* git.refs().pipe(
            Effect.match({
              onFailure: (err) => ({ ok: false as const, err }),
              onSuccess: (refs) => ({ ok: true as const, refs }),
            }),
          );
          const trunks = refs.ok
            ? cfg.trunks.map((trunk) =>
                refs.refs.some((ref) => ref.name === trunk)
                  ? `ok trunk branch: ${trunk}`
                  : `warn missing local trunk branch: ${trunk}`,
              )
            : [`fail branch refs: ${describe(refs.err)}`];
          const pulls = yield* codeHost.changes().pipe(
            Effect.match({
              onFailure: (err) => `fail open ${requestLabel}s: ${describe(err)}`,
              onSuccess: (pulls) => `ok open ${requestLabel}s visible: ${pulls.length}`,
            }),
          );
          const state = yield* store.read().pipe(
            Effect.match({
              onFailure: (err) => `fail stack metadata: ${describe(err)}`,
              onSuccess: (state) => `ok stack metadata: ${state.links.length} link(s)`,
            }),
          );
          const undo = yield* store.readUndo().pipe(
            Effect.match({
              onFailure: (err) => `fail undo journal: ${describe(err)}`,
              onSuccess: (undo) =>
                undo ? `info undo journal: ${undo.at}` : "ok undo journal: none",
            }),
          );

          return [current, clean, ...trunks, pulls, state, undo];
        }),
      );

      const landTarget = Effect.fn("Stack.landTarget")((branch?: string) =>
        Effect.gen(function* () {
          const [state, refs, pulls, current] = yield* Effect.all([
            store.read(),
            git.refs(),
            codeHost.changes(),
            git.current(),
          ]);
          const graph = StackGraph.make({
            state,
            refs,
            pulls,
            trunks: cfg.trunks,
            current,
          });
          const inferred = graph.rootOf(current);
          const roots = state.links
            .filter((item) => trunk(String(item.parent)))
            .map((item) => String(item.branch))
            .sort((a, b) => a.localeCompare(b));
          const target =
            branch ??
            (state.links.some((item) => item.branch === inferred)
              ? inferred
              : roots.length === 1
                ? roots[0]!
                : inferred);
          if (!branch && !state.links.some((item) => item.branch === target)) {
            if (roots.length > 1) {
              return yield* Effect.fail(
                new StackOperationError(
                  `multiple stack roots found: ${roots.join(", ")}. run: stack merge <branch>`,
                ),
              );
            }
          }
          return { state, refs, pulls, current, graph, target };
        }),
      );

      const throughTarget = Effect.fn("Stack.land.throughTarget")(
        (branch: string | undefined, through: string) =>
          Effect.gen(function* () {
            const { state, pulls, graph, target } = yield* landTarget(branch);
            const input = through.trim();
            const prText = input.startsWith("#") || input.startsWith("!") ? input.slice(1) : input;
            const prNumber = /^\d+$/.test(prText) ? Number(prText) : null;
            const byPr = prNumber
              ? (pulls.find((item) => Number(item.number) === prNumber)?.head ??
                state.links.find((item) => Number(item.pr) === prNumber)?.branch ??
                null)
              : null;
            const throughBranch = byPr ? String(byPr) : input;
            const chain = graph.pathTo(throughBranch);
            const targetIndex = chain.indexOf(target);
            if (targetIndex === -1) {
              return yield* Effect.fail(
                new StackOperationError(`${through} is not in the current stack from ${target}`),
              );
            }
            return { stop: throughBranch, chain: chain.slice(targetIndex) };
          }),
      );

      const landOne = Effect.fn("Stack.landOne")(
        (
          branch?: string,
          opts?: {
            readonly apply?: boolean;
            readonly auto?: boolean;
            readonly admin?: boolean;
            // Post-merge descendant repair scope for this landing:
            //   undefined -> full eager repair of the whole subtree (single/final
            //                merge, or --eager campaign landing),
            //   a branch  -> lazy: repair only that next root, deferring the rest,
            //   null      -> repair nothing (last chain root; the campaign's final
            //                pass freshens whatever remains).
            readonly repairOnly?: string | null;
            // Called once the root has merged (after the post-merge baseline is
            // written), before descendant repair. Campaigns use it to promote the
            // landing into persisted campaign state so a repair conflict leaves the
            // journal pointing at the next root for `merge --continue`.
            readonly onLanded?: (info: {
              readonly branch: string;
              readonly pr: number;
              readonly backup: string | null;
            }) => Effect.Effect<void, StackError>;
          },
        ) =>
          Effect.gen(function* () {
            const apply = opts?.apply ?? false;
            const auto = opts?.auto ?? false;
            const admin = opts?.admin ?? false;
            const repairOnly = opts?.repairOnly;
            const onLanded = opts?.onLanded;
            if (apply && auto) {
              return yield* Effect.fail(
                new StackOperationError("use either --apply or --auto, not both"),
              );
            }
            if (admin && !apply) {
              return yield* Effect.fail(new StackOperationError("use --admin only with --apply"));
            }
            if (admin && !codeHost.capabilities.adminMerge) {
              return yield* Effect.fail(
                new StackOperationError(`--admin is not supported by ${codeHost.provider}`),
              );
            }
            const active = apply || auto;

            if (active) yield* clean();
            const { state, refs, pulls, current, target } = yield* landTarget(branch);
            const link = state.links.find((item) => item.branch === target) ?? null;
            if (!link) {
              const pr = pulls.find((item) => item.head === target) ?? null;
              if (!refs.some((item) => item.name === target) && !pr)
                return yield* Effect.fail(new BranchError(target));
              const parent = pr?.base ?? String(cfg.trunks[0] ?? "dev");
              return yield* Effect.fail(
                new StackOperationError(
                  `${target} is not tracked in stack state. status can infer it, but merge needs an explicit link. run: stack track ${target} --onto ${parent}`,
                ),
              );
            }
            if (!trunk(link.parent)) {
              return yield* Effect.fail(
                new StackOperationError(`${target} is not the oldest branch in its stack`),
              );
            }

            const branches = scopedBranches(state, target);
            const scopedState = filterState(state, branches);

            const pr = yield* changeForLink(link, pulls);
            if (!pr) {
              return yield* Effect.fail(
                new StackOperationError(`no open ${requestLabel} found for ${target}`),
              );
            }

            const root = link.parent;
            const stamp = yield* timestamp();
            const name = `backup/landed-${stamp}-${target}`;
            const hasLocalTarget = refs.some((item) => item.name === target);
            const targetOwner = hasLocalTarget
              ? ((yield* git.worktrees()).find(
                  (worktree) => worktree.branch === target && worktree.path !== cfg.root,
                ) ?? null)
              : null;
            const next = scopedState.links.find((item) => item.parent === target)?.branch ?? null;
            const landed = new Set([reference(Number(pr.number)), String(target)]);
            const preRetargets = (yield* Effect.forEach(
              scopedState.links.filter((item) => item.parent === target),
              (child) =>
                changeForLink(child, pulls).pipe(
                  Effect.map((childPr) =>
                    childPr && childPr.base !== link.parent
                      ? {
                          pr: Number(childPr.number),
                          branch: String(child.branch),
                          base: String(link.parent),
                        }
                      : null,
                  ),
                ),
            )).filter((item): item is NonNullable<typeof item> => item !== null);
            const retargetChildren = Effect.forEach(
              preRetargets,
              (item) =>
                RepairExecution.applyRetargetPull(
                  { pr: item.pr, base: item.base },
                  {
                    checkpoint: checkpointRetargets,
                    step,
                    edit: codeHost.edit,
                    message: `retarget ${reference(item.pr)} (${item.branch}) to ${item.base} before merge`,
                    reference,
                  },
                ),
              { discard: true },
            );
            const landedState = stackState(
              scopedState.links.flatMap((item) => {
                if (item.branch === target) return [];
                return [
                  item.parent === target
                    ? stackLink({
                        branch: String(item.branch),
                        parent: String(root),
                        anchor: String(item.anchor),
                        pr: item.pr === null ? null : Number(item.pr),
                        headRepository: item.headRepository ?? null,
                      })
                    : item,
                ];
              }),
            );
            const beginPostMergeRepair = Effect.fn("Stack.land.beginPostMergeRepair")(function* () {
              yield* writeScopedState(branches)(landedState);
              yield* store.clearUndo();
            });
            const retargetEntries = preRetargets.map((item) =>
              undoEntry({
                branch: item.branch,
                backup: null,
                pr: item.pr,
                base: target,
                created: null,
              }),
            );
            const retargetActions = preRetargets.map(
              (item): StackResult.StackResultItem => ({
                _tag: "RetargetPull",
                mode: "apply",
                pr: item.pr,
                base: item.base,
              }),
            );
            const checkpointRetargets = () =>
              retargetEntries.length > 0
                ? store.writeUndo(
                    undoState(
                      stamp,
                      state,
                      retargetEntries,
                      StackResult.renderAll(retargetActions, reference, requestLabel),
                    ),
                  )
                : Effect.void;
            const plannedPulls = pulls.map((item) => {
              const retarget = preRetargets.find((next) => next.pr === item.number);
              return retarget
                ? pullRef({
                    number: item.number,
                    head: item.head,
                    headRepository: item.headRepository,
                    base: retarget.base,
                    url: item.url,
                    draft: item.draft,
                    checks: item.checks,
                  })
                : item;
            });
            const repairPulls = yield* changesForLinks(
              scopedState.links.filter((item) => item.branch !== target),
              plannedPulls,
            );
            const plannedRepair = yield* repairStack(
              scopedState,
              refs.filter((item) => item.name !== target),
              repairPulls,
              { apply: false },
            );
            // Under lazy repair only the next root (or nothing) is touched this
            // landing, so the cleanliness gate covers just those branches; a dirty
            // sibling worktree deferred to a later turn must not block this landing.
            const repairCheckBranches =
              repairOnly === undefined
                ? plannedRepair.actions.flatMap((item) =>
                    item._tag === "Rebase" ? [String(item.branch)] : [],
                  )
                : repairOnly === null
                  ? []
                  : [repairOnly];
            if (active) {
              yield* ensureRepairableWorktrees([
                ...(targetOwner ? [target] : []),
                ...repairCheckBranches,
              ]);
            }
            const actions = [
              ...(current === target ? [`${active ? "" : "would "}switch to ${root}`] : []),
              ...(hasLocalTarget ? [`${active ? "" : "would "}backup ${target} -> ${name}`] : []),
              ...preRetargets.map(
                (item) =>
                  `${active ? "" : "would "}retarget ${reference(item.pr)} (${item.branch}) to ${item.base} before merge`,
              ),
              auto
                ? `enable auto-merge ${reference(Number(pr.number))} (${target})`
                : `${apply ? "" : "would "}${admin ? "admin " : ""}merge ${reference(Number(pr.number))} (${target})`,
              ...(auto ? [`wait for ${reference(Number(pr.number))} to merge`] : []),
            ];

            // The links repairStack sees always keep the landed target (so
            // descendants resolve their parent through it to trunk); under lazy
            // repair only the next root's link joins it, deferring the rest.
            const repairScopeState =
              repairOnly === undefined
                ? scopedState
                : filterState(
                    scopedState,
                    new Set(repairOnly === null ? [target] : [target, repairOnly]),
                  );
            // Persist only what this landing actually repaired: the whole subtree
            // when eager, just the next root when lazy, nothing for the last root.
            const writeScope =
              repairOnly === undefined
                ? branches
                : new Set<string>(repairOnly === null ? [] : [repairOnly]);
            const repairAfterMerge = Effect.fn("Stack.land.repairAfterMerge")(() =>
              Effect.gen(function* () {
                yield* git.fetch();
                const [nextState, nextRefs, nextPulls] = yield* Effect.all([
                  store.read(),
                  git.refs(),
                  codeHost.changes(),
                ]);
                const repairPulls = yield* changesForLinks(
                  repairScopeState.links.filter((item) => item.branch !== target),
                  nextPulls,
                );
                const repair = yield* repairStack(
                  repairScopeState,
                  nextRefs.filter((item) => item.name !== target),
                  repairPulls,
                  {
                    apply: true,
                    saved: new Map([[target, name]]),
                    journalState: nextState,
                    journalActions: retargetActions,
                    writeState: writeScopedState(writeScope),
                  },
                );
                const repairedPulls = yield* changesForLinks(
                  repair.state.links,
                  yield* codeHost.changes(),
                );
                const notes = yield* linksFor(repair.state, true, landed, repairedPulls);
                if (current !== target) yield* git.switch(current);
                const tail = next ? `next root: ${next}` : "next root: none";
                const view = yield* diagram(branches);
                return [...actions, ...repair.lines, ...notes.lines, tail, ...view];
              }),
            );

            if (auto || apply) {
              yield* checkpointRetargets();
              if (current === target) {
                yield* step(`switch to ${root}`);
                yield* git.switch(root);
              }
              if (hasLocalTarget) {
                yield* step(`backup ${target} -> ${name}`);
                yield* git.backup(target, name);
              }
              yield* retargetChildren;
              if (auto) {
                yield* step(`enable auto-merge ${reference(Number(pr.number))} (${target})`);
                yield* codeHost.auto(pr.number);
                yield* wait(`waiting for ${reference(Number(pr.number))} to merge`);
                yield* codeHost.wait(pr.number);
              } else {
                yield* step(
                  `${admin ? "admin " : ""}merge ${reference(Number(pr.number))} (${target})`,
                );
                yield* codeHost.merge(pr.number, { admin }).pipe(Effect.mapError(mergeFailure));
              }
              yield* beginPostMergeRepair();
              // Record the landing before descendant repair: a repair conflict now
              // leaves the campaign journal pointing at the next root, not this one.
              if (onLanded)
                yield* onLanded({
                  branch: target,
                  pr: Number(pr.number),
                  backup: hasLocalTarget ? name : null,
                });
              if (hasLocalTarget) {
                if (targetOwner) {
                  yield* step(`release ${target} worktree`);
                  yield* git.release(target);
                }
                yield* step(`drop local ${target}`);
                yield* git.drop(target);
              }
              return yield* repairAfterMerge();
            }

            const tail = next ? `next root: ${next}` : "next root: none";
            return [...actions, ...plannedRepair.lines, tail];
          }),
      );

      // One eager repair pass over whatever stays open after a campaign's landings.
      // Lazy landings only repair the next root each turn, so unlanded siblings and
      // grandchildren are freshened here exactly once. Landed roots were dropped
      // from state, so filtering to the campaign's stack leaves just the remainder;
      // an empty remainder is a no-op that preserves the last landing's undo journal.
      const finalRepairPass = Effect.fn("Stack.land.finalRepairPass")(
        (stackBranches: ReadonlySet<string>, landed: ReadonlySet<string>) =>
          Effect.gen(function* () {
            yield* git.fetch();
            const [state, refs, pulls] = yield* Effect.all([
              store.read(),
              git.refs(),
              codeHost.changes(),
            ]);
            const scoped = filterState(state, stackBranches);
            if (scoped.links.length === 0) return Array<string>();
            const scopedPulls = yield* changesForLinks(scoped.links, pulls);
            const repair = yield* repairStack(scoped, refs, scopedPulls, {
              apply: true,
              journalState: state,
              writeState: writeScopedState(stackBranches),
              preserveUndo: true,
            });
            const repairedPulls = yield* changesForLinks(
              repair.state.links,
              yield* codeHost.changes(),
            );
            const notes = yield* linksFor(repair.state, true, landed, repairedPulls);
            return [...repair.lines, ...notes.lines];
          }),
      );

      // Drive a `--through` campaign: land each chain root in order, repairing lazily
      // (only the next root per landing) unless --eager restores full-chain repair.
      // Campaign state is journaled at every landing boundary so `merge --continue`
      // can resume from the recorded next root after a manual conflict fix, then
      // cleared on success. A conflict propagates as today (abort/restore/tree) with
      // the journal left pointing at the failed root.
      //
      // The campaign journal (Store.*Campaign) is independent of the undo journal
      // (Store.*Undo): each landing rewrites undo.json with that landing's mutations,
      // so `undo` restores the last landing while the campaign survives for
      // `--continue`. The two never conflict — undo rolls back git/host state, the
      // campaign only records which roots have merged — but undoing a landing does
      // not un-record it, so re-landing an undone root means restarting the campaign.
      const runCampaign = Effect.fn("Stack.land.runCampaign")(
        (input: {
          readonly through: string;
          readonly eager: boolean;
          readonly chain: ReadonlyArray<string>;
          readonly stack: ReadonlyArray<string>;
          readonly landed: ReadonlyArray<CampaignLanding>;
        }) =>
          Effect.gen(function* () {
            const stamp = yield* timestamp();
            let landed = [...input.landed];
            const persist = () =>
              store.writeCampaign(
                campaignState({
                  at: stamp,
                  through: input.through,
                  eager: input.eager,
                  chain: input.chain,
                  stack: input.stack,
                  landed,
                }),
              );
            const items = new Array<string>();
            for (let i = landed.length; i < input.chain.length; i++) {
              const target = input.chain[i]!;
              const last = i === input.chain.length - 1;
              const repairOnly = input.eager ? undefined : last ? null : input.chain[i + 1]!;
              // Point the journal at this root before merging so a merge or pre-merge
              // failure resumes here; onLanded advances it once the root has merged.
              yield* persist();
              if (items.length > 0) items.push("");
              items.push(
                ...(yield* landOne(target, {
                  auto: true,
                  ...(repairOnly === undefined ? {} : { repairOnly }),
                  onLanded: (info) =>
                    Effect.gen(function* () {
                      landed = [...landed, campaignLanding(info)];
                      yield* persist();
                    }),
                })),
              );
            }
            if (!input.eager) {
              const landedBranches = new Set(landed.map((item) => String(item.branch)));
              const tail = yield* finalRepairPass(new Set(input.stack), landedBranches);
              if (tail.length > 0) items.push("", ...tail);
            }
            yield* store.clearCampaign();
            items.push(`merged through: ${input.through}`);
            return items;
          }),
      );

      const land: StackService["land"] = Effect.fn("Stack.land")((branch, opts) =>
        Effect.gen(function* () {
          if (opts?.continue) {
            if (branch !== undefined) {
              return yield* Effect.fail(
                new StackOperationError(
                  "merge --continue resumes the saved campaign; drop the branch argument",
                ),
              );
            }
            if (opts.through !== undefined) {
              return yield* Effect.fail(
                new StackOperationError(
                  "merge --continue resumes the saved campaign; drop --through (the campaign owns it)",
                ),
              );
            }
            if (opts.apply || opts.admin) {
              return yield* Effect.fail(
                new StackOperationError(
                  "merge --continue resumes the saved campaign with auto-merge; drop --apply/--admin",
                ),
              );
            }
            const campaign = yield* store.readCampaign();
            if (!campaign) {
              return yield* Effect.fail(
                new StackOperationError(
                  "no saved merge campaign to continue; start one with: stack merge --auto --through <branch-or-change>",
                ),
              );
            }
            // Trust the journal only once the recorded landings really merged.
            // Checking merge state (not absence from the open set) also catches a
            // recorded landing whose change was closed without merging.
            const openHeads = new Set((yield* codeHost.changes()).map((pull) => String(pull.head)));
            for (const item of campaign.landed) {
              const landedOk =
                item.pr !== null
                  ? yield* codeHost.merged(Number(item.pr))
                  : !openHeads.has(String(item.branch));
              if (!landedOk) {
                return yield* Effect.fail(
                  new StackOperationError(
                    `campaign recorded ${item.branch} as landed, but ${item.pr !== null ? `${requestLabel} ${reference(Number(item.pr))} is not merged (still open, or closed without merging)` : `its ${requestLabel} is still open`}; merge or resolve it before continuing`,
                  ),
                );
              }
            }
            return yield* runCampaign({
              through: String(campaign.through),
              eager: campaign.eager,
              chain: campaign.chain.map(String),
              stack: campaign.stack.map(String),
              landed: campaign.landed,
            });
          }

          const through = opts?.through;
          if (!through) {
            return yield* landOne(branch, {
              apply: opts?.apply ?? false,
              auto: opts?.auto ?? false,
              admin: opts?.admin ?? false,
            });
          }

          if (!opts?.auto) {
            return yield* Effect.fail(new StackOperationError("use --through only with --auto"));
          }
          const { stop, chain } = yield* throughTarget(branch, through);
          const state = yield* store.read();
          const stack = [...scopedBranches(state, chain[0]!)];
          return yield* runCampaign({
            through: stop,
            eager: opts?.eager ?? false,
            chain,
            stack,
            landed: [],
          });
        }),
      );

      const undo = Effect.fn("Stack.undo")((apply = false) =>
        Effect.gen(function* () {
          const current = yield* git.current();
          if (apply) yield* clean();
          const run = yield* store.readUndo();
          if (!run) return [apply ? "nothing to undo" : "would do nothing"];

          const mode = apply ? "" : "would ";
          const actions: Array<string> = [];
          const trunks = new Set(cfg.trunks.map(String));
          const stateTrunk = run.state.links.find((link) =>
            trunks.has(String(link.parent)),
          )?.parent;
          const trunk = stateTrunk ?? cfg.trunks[0] ?? branchName("dev");
          const restore = new Set(
            run.entries.flatMap((item) => (item.backup ? [String(item.branch)] : [])),
          );

          if (restore.has(current)) {
            actions.push(`${mode}switch to ${trunk}`);
            if (apply) yield* git.switch(trunk);
          }

          for (const item of run.entries) {
            if (!item.backup) continue;
            actions.push(`${mode}restore ${item.branch} from ${item.backup}`);
            const remotes = item.pushRemotes ?? ["origin"];
            actions.push(
              StackResult.render({
                _tag: "Push",
                mode: apply ? "apply" : "dry-run",
                branch: String(item.branch),
                remotes,
              }),
            );
            if (apply) {
              yield* git.restore(item.branch, item.backup);
              for (const remote of remotes) yield* git.push(item.branch, remote);
            }
          }

          for (const item of run.entries) {
            if (item.created) {
              actions.push(`${mode}close ${reference(Number(item.created))}`);
              if (apply) yield* codeHost.close(item.created);
            }
            if (item.pr && item.base) {
              actions.push(`${mode}retarget ${reference(Number(item.pr))} to ${item.base}`);
              if (apply) yield* codeHost.edit(item.pr, item.base);
            }
          }

          actions.push(`${mode}restore stack metadata`);

          if (apply) {
            yield* store.write(run.state);
            yield* store.clearUndo();
            yield* git.switch(current);
          }

          return actions;
        }),
      );

      return Stack.of({ status, adopt, links, land, sync, doctor, last, undo });
    }),
  );
}
