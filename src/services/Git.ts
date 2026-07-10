import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BranchRef, branchRef, ExecError, ReplayConflictError } from "../domain/model.ts";
import * as Proc from "../platform/proc.ts";
import { StackConfig } from "./Config.ts";

export interface Worktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly dirty: ReadonlyArray<string>;
}

export interface Interface {
  readonly dirty: () => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly worktrees: () => Effect.Effect<ReadonlyArray<Worktree>, ExecError>;
  readonly fetch: () => Effect.Effect<void, ExecError>;
  readonly remotes: () => Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly url: string }>,
    ExecError
  >;
  readonly refs: () => Effect.Effect<ReadonlyArray<BranchRef>, ExecError>;
  readonly current: () => Effect.Effect<string, ExecError>;
  readonly remote: () => Effect.Effect<Option.Option<string>, ExecError>;
  readonly switch: (branch: string) => Effect.Effect<void, ExecError>;
  readonly head: (name: string) => Effect.Effect<Option.Option<string>, ExecError>;
  readonly ancestor: (a: string, b: string) => Effect.Effect<boolean, ExecError>;
  readonly fastForward: (branch: string) => Effect.Effect<void, ExecError>;
  readonly base: (
    branch: string,
    parent: string,
  ) => Effect.Effect<Option.Option<string>, ExecError>;
  readonly commits: (
    from: string,
    branch: string,
  ) => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly novel: (
    parent: string,
    branch: string,
    commits: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly replay: (
    branch: string,
    parent: string,
    commits: ReadonlyArray<string>,
  ) => Effect.Effect<void, ExecError | ReplayConflictError>;
  readonly unmergedPaths: () => Effect.Effect<ReadonlyArray<string>, ExecError>;
  readonly release: (branch: string) => Effect.Effect<void, ExecError>;
  readonly backup: (branch: string, name: string) => Effect.Effect<void, ExecError>;
  readonly drop: (branch: string) => Effect.Effect<void, ExecError>;
  readonly restore: (branch: string, name: string) => Effect.Effect<void, ExecError>;
  readonly push: (branch: string, remote?: string) => Effect.Effect<void, ExecError>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Git") {}

export const live = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* StackConfig;
    const proc = yield* Proc.Service;
    const fs = yield* FileSystem.FileSystem;

    const runAt = Effect.fn("Git.runAt")(function* (
      cwd: string,
      tool: string,
      args: ReadonlyArray<string>,
      ok: ReadonlyArray<number> = [0],
    ) {
      return yield* proc.exec(cwd, tool, args, ok);
    });
    const run = Effect.fn("Git.run")(
      (tool: string, args: ReadonlyArray<string>, ok: ReadonlyArray<number> = [0]) =>
        runAt(cfg.root, tool, args, ok),
    );

    const dirtyAt = Effect.fn("Git.dirtyAt")((path: string) =>
      runAt(path, "git", ["status", "--short"]).pipe(
        Effect.map((out) => out.split("\n").filter(Boolean)),
      ),
    );

    // Snapshot cache: worktrees() is called on every replay/release/drop. A deep-stack
    // repair loop calls replay() once per branch, and replay's checkout dance is net-neutral
    // on the worktree->branch/dirty mapping (it always restores the original checkout via its
    // ensuring chain), so one snapshot per CLI run stays valid across N replays. Invalidated
    // only by mutations that actually change the mapping: switch, release, drop.
    let worktreeSnapshot: ReadonlyArray<Worktree> | null = null;
    const invalidateWorktrees = () => {
      worktreeSnapshot = null;
    };

    const worktrees = Effect.fn("Git.worktrees")(function* () {
      if (worktreeSnapshot) return worktreeSnapshot;
      const out = yield* run("git", ["worktree", "list", "--porcelain", "-z"]);
      const records: Array<{
        path: string;
        head: string | null;
        branch: string | null;
        prunable: boolean;
      }> = [];
      let current: {
        path: string;
        head: string | null;
        branch: string | null;
        prunable: boolean;
      } | null = null;
      for (const field of out.split("\0").filter(Boolean)) {
        if (field.startsWith("worktree ")) {
          if (current) records.push(current);
          current = {
            path: field.slice("worktree ".length),
            head: null,
            branch: null,
            prunable: false,
          };
          continue;
        }
        if (!current) continue;
        if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
        else if (field.startsWith("branch refs/heads/"))
          current.branch = field.slice("branch refs/heads/".length);
        else if (field === "detached") current.branch = null;
        else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
      }
      if (current) records.push(current);

      const snapshot = yield* Effect.forEach(
        records.filter((record) => !record.prunable),
        (record) =>
          dirtyAt(record.path).pipe(
            Effect.map(
              (dirty): Worktree => ({
                path: record.path,
                head: record.head,
                branch: record.branch,
                dirty,
              }),
            ),
          ),
        { concurrency: 4 },
      );
      worktreeSnapshot = snapshot;
      return snapshot;
    });

    const checkedOutDirtyError = (branch: string, worktree: Worktree) =>
      new ExecError(
        "git",
        ["replay", branch],
        1,
        [
          `${branch} is checked out at ${worktree.path} with local changes:`,
          ...worktree.dirty.map((line) => `  ${line}`),
          "",
          `Commit, stash, or clean that worktree before repairing ${branch}.`,
        ].join("\n"),
      );

    const releaseDirtyError = (branch: string, worktree: Worktree) =>
      new ExecError(
        "git",
        ["release", branch],
        1,
        [
          `${branch} is checked out at ${worktree.path} with local changes:`,
          ...worktree.dirty.map((line) => `  ${line}`),
          "",
          `Commit, stash, or clean that worktree before releasing ${branch}.`,
        ].join("\n"),
      );

    const refs = Effect.fn("Git.refs")(function* () {
      const out = yield* run("git", [
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)",
        "refs/heads",
      ]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split("\0"))
        .filter(
          (row): row is [string, string] => row.length === 2 && Boolean(row[0]) && Boolean(row[1]),
        )
        .map(([name, head]) => branchRef({ name, head }));
    });

    const dirty = Effect.fn("Git.dirty")(() => dirtyAt(cfg.root));

    const current = Effect.fn("Git.current")(() => run("git", ["branch", "--show-current"]));
    const remote = Effect.fn("Git.remote")(() =>
      run("git", ["config", "--get", "remote.origin.url"], [0, 1]).pipe(
        Effect.map((out) => (out ? Option.some(out) : Option.none<string>())),
      ),
    );
    const switch_ = Effect.fn("Git.switch")(function* (branch: string) {
      yield* run("git", ["checkout", branch]);
      invalidateWorktrees();
    });
    const fetch = Effect.fn("Git.fetch")(() =>
      run("git", ["fetch", "origin", "--prune"]).pipe(Effect.asVoid),
    );
    const remotes = Effect.fn("Git.remotes")(() =>
      run("git", ["config", "--get-regexp", "^remote\\..*\\.(push)?url$"], [0, 1]).pipe(
        Effect.map((out) => {
          const map = new Map<string, string>();
          for (const line of out.split("\n").filter(Boolean)) {
            const match = line.match(/^remote\.(.+)\.(push)?url\s+(.+)$/);
            if (!match) continue;
            if (match[2] === "push" || !map.has(match[1]!)) map.set(match[1]!, match[3]!);
          }
          return [...map].map(([name, url]) => ({ name, url }));
        }),
      ),
    );
    const head = Effect.fn("Git.head")((name: string) =>
      run("git", ["rev-parse", "--verify", name], [0, 1]).pipe(
        Effect.map((out) => (out ? Option.some(out) : Option.none<string>())),
      ),
    );
    // `git merge-base --is-ancestor a b` exits 0 when a is an ancestor of b, 1
    // when it is not, and 128 when a ref is unknown (e.g. a persisted anchor
    // whose commit was garbage-collected after a force-push). For this
    // predicate an unknown ref simply is not an ancestor — callers fall back
    // to the merge-base path — so 128 maps to false rather than failing.
    const ancestor = Effect.fn("Git.ancestor")((a: string, b: string) =>
      run("git", ["merge-base", "--is-ancestor", a, b]).pipe(
        Effect.as(true),
        Effect.catchTag("ExecError", (err) =>
          err.code === 1 || err.code === 128 ? Effect.succeed(false) : Effect.fail(err),
        ),
      ),
    );
    // Fast-forward a local branch ref to its origin counterpart. `git branch -f`
    // refuses a checked-out branch, so when a worktree owns it we fast-forward
    // there instead; a dirty owner worktree is fatal (naming it) since we cannot
    // move the ref out from under uncommitted work.
    const fastForward = Effect.fn("Git.fastForward")(function* (branch: string) {
      const owner = (yield* worktrees()).find((worktree) => worktree.branch === branch) ?? null;
      if (owner) {
        if (owner.dirty.length > 0) {
          return yield* Effect.fail(
            new ExecError(
              "git",
              ["merge", "--ff-only", `origin/${branch}`],
              1,
              [
                `${branch} is checked out at ${owner.path} with local changes:`,
                ...owner.dirty.map((line) => `  ${line}`),
                "",
                `Commit, stash, or clean that worktree before fast-forwarding ${branch} to origin/${branch}.`,
              ].join("\n"),
            ),
          );
        }
        return yield* runAt(owner.path, "git", ["merge", "--ff-only", `origin/${branch}`]).pipe(
          Effect.asVoid,
        );
      }
      return yield* run("git", ["branch", "-f", branch, `origin/${branch}`]).pipe(Effect.asVoid);
    });
    const base = Effect.fn("Git.base")(function* (branch: string, parent: string) {
      const out = yield* run("git", ["merge-base", branch, parent], [0, 1]);
      return out ? Option.some(out) : Option.none<string>();
    });
    const commits = Effect.fn("Git.commits")((from: string, branch: string) =>
      run("git", [
        "rev-list",
        "--reverse",
        "--first-parent",
        "--no-merges",
        `${from}..${branch}`,
      ]).pipe(Effect.map((out) => out.split("\n").filter(Boolean))),
    );
    const novel = Effect.fn("Git.novel")((
      parent: string,
      branch: string,
      commits: ReadonlyArray<string>,
    ) => {
      if (commits.length === 0) return Effect.succeed(Array.from(commits));
      return run("git", ["cherry", parent, branch]).pipe(
        Effect.map((out) => {
          const keep = new Set(
            out
              .split("\n")
              .filter((line) => line.startsWith("+ "))
              .map((line) => line.slice(2)),
          );
          return commits.filter((commit) => keep.has(commit));
        }),
      );
    });
    const unmergedPathsAt = Effect.fn("Git.unmergedPathsAt")((path: string) =>
      runAt(path, "git", ["diff", "--name-only", "--diff-filter=U"], [0, 1]).pipe(
        Effect.map((out) => out.split("\n").filter(Boolean)),
      ),
    );
    const unmergedPaths = Effect.fn("Git.unmergedPaths")(() => unmergedPathsAt(cfg.root));
    // Replay onto an owning worktree in place: build the new tip on a temp branch, then
    // fast-forward the branch's own worktree via checkout + reset. The worktree's original
    // checkout is restored and the temp branch deleted in the ensuring chain.
    const replayInOwner = Effect.fn("Git.replayInOwner")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
      owner: Worktree,
    ) {
      const root = owner.path;
      const current = yield* runAt(root, "git", ["branch", "--show-current"]);
      const now = yield* Clock.currentTimeMillis;
      const temp = `stack/replay-${now}-${branch.replaceAll("/", "-")}`;
      const abortCherryPick = runAt(root, "git", ["cherry-pick", "--abort"], [0, 1, 128]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const deleteTemp = runAt(root, "git", ["branch", "-D", temp], [0, 1]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const restoreCurrent = current
        ? runAt(root, "git", ["checkout", current]).pipe(Effect.asVoid, Effect.orDie)
        : Effect.void;

      yield* Effect.gen(function* () {
        yield* runAt(root, "git", ["checkout", "-B", temp, parent]).pipe(Effect.asVoid);
        if (commits.length > 0) {
          yield* runAt(root, "git", ["cherry-pick", "--empty=drop", ...commits]).pipe(
            Effect.asVoid,
            Effect.catchTag("ExecError", (err) =>
              Effect.gen(function* () {
                const paths = yield* unmergedPathsAt(root).pipe(
                  Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
                );
                return yield* Effect.fail(
                  new ReplayConflictError(branch, parent, paths, err.stderr),
                );
              }),
            ),
          );
        }
        yield* runAt(root, "git", ["checkout", branch]).pipe(Effect.asVoid);
        yield* runAt(root, "git", ["reset", "--hard", temp]).pipe(Effect.asVoid);
      }).pipe(
        Effect.ensuring(
          abortCherryPick.pipe(Effect.ensuring(restoreCurrent.pipe(Effect.ensuring(deleteTemp)))),
        ),
      );
    });

    // Replay an unowned branch in an ephemeral detached workbench worktree so the primary
    // checkout's HEAD and working tree are never touched. Cherry-pick on the detached HEAD,
    // then move the branch ref to the new tip. The workbench is always removed in the ensuring
    // chain, on success, conflict, or defect.
    const replayInWorkbench = Effect.fn("Git.replayInWorkbench")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
    ) {
      const tmp = yield* fs
        .makeTempDirectory({ prefix: "stack-replay-" })
        .pipe(
          Effect.mapError(
            (err) =>
              new ExecError(
                "mktemp",
                ["stack-replay-"],
                1,
                `temp directory failed: ${String(err)}`,
              ),
          ),
        );
      const abortCherryPick = runAt(tmp, "git", ["cherry-pick", "--abort"], [0, 1, 128]).pipe(
        Effect.asVoid,
        Effect.orDie,
      );
      const removeWorkbench = Effect.gen(function* () {
        yield* runAt(cfg.root, "git", ["worktree", "remove", "--force", tmp], [0, 1, 128]).pipe(
          Effect.asVoid,
          Effect.orDie,
        );
        invalidateWorktrees();
        yield* fs.remove(tmp, { recursive: true, force: true }).pipe(Effect.orDie);
      });

      yield* Effect.gen(function* () {
        yield* runAt(cfg.root, "git", ["worktree", "add", "--detach", tmp, parent]).pipe(
          Effect.asVoid,
        );
        invalidateWorktrees();
        if (commits.length > 0) {
          yield* runAt(tmp, "git", ["cherry-pick", "--empty=drop", ...commits]).pipe(
            Effect.asVoid,
            Effect.catchTag("ExecError", (err) =>
              Effect.gen(function* () {
                const paths = yield* unmergedPathsAt(tmp).pipe(
                  Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
                );
                return yield* Effect.fail(
                  new ReplayConflictError(branch, parent, paths, err.stderr),
                );
              }),
            ),
          );
        }
        yield* runAt(tmp, "git", ["branch", "-f", branch, "HEAD"]).pipe(Effect.asVoid);
      }).pipe(Effect.ensuring(abortCherryPick.pipe(Effect.ensuring(removeWorkbench))));
    });

    const replayOnce = Effect.fn("Git.replayOnce")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
    ) {
      const owner = (yield* worktrees()).find((worktree) => worktree.branch === branch) ?? null;
      if (owner && owner.dirty.length > 0) {
        return yield* Effect.fail(checkedOutDirtyError(branch, owner));
      }
      return owner
        ? yield* replayInOwner(branch, parent, commits, owner)
        : yield* replayInWorkbench(branch, parent, commits);
    });

    // Stale-ownership resilience: a snapshot taken earlier in the run can misroute a replay if a
    // worktree grabbed or released the branch mid-run. Git reports that as "already used by
    // worktree" from checkout/worktree-add, or "checked out at" from `branch -f` on a branch a
    // worktree acquired concurrently. Either way: drop the snapshot, recompute ownership, retry
    // exactly once.
    const staleOwnership = (stderr: string) =>
      stderr.includes("already used by worktree") || stderr.includes("checked out at");
    const replay = Effect.fn("Git.replay")(function* (
      branch: string,
      parent: string,
      commits: ReadonlyArray<string>,
    ) {
      return yield* replayOnce(branch, parent, commits).pipe(
        Effect.catchTag("ExecError", (err) =>
          staleOwnership(err.stderr)
            ? Effect.sync(invalidateWorktrees).pipe(
                Effect.flatMap(() => replayOnce(branch, parent, commits)),
              )
            : Effect.fail(err),
        ),
      );
    });
    const backup = Effect.fn("Git.backup")((branch: string, name: string) =>
      run("git", ["branch", "-f", name, branch]).pipe(Effect.asVoid),
    );
    const release = Effect.fn("Git.release")(function* (branch: string) {
      const owner =
        (yield* worktrees()).find(
          (worktree) => worktree.branch === branch && worktree.path !== cfg.root,
        ) ?? null;
      if (!owner) return;
      if (owner.dirty.length > 0) {
        return yield* Effect.fail(releaseDirtyError(branch, owner));
      }
      yield* runAt(owner.path, "git", ["checkout", "--detach", "HEAD"]);
      invalidateWorktrees();
    });
    const drop = Effect.fn("Git.drop")(function* (branch: string) {
      const owner =
        (yield* worktrees()).find(
          (worktree) => worktree.branch === branch && worktree.path !== cfg.root,
        ) ?? null;
      if (owner) {
        return yield* Effect.fail(
          new ExecError(
            "git",
            ["branch", "-D", branch],
            1,
            `${branch} is checked out at ${owner.path}; detach or remove that worktree before deleting the local branch.`,
          ),
        );
      }
      yield* run("git", ["branch", "-D", branch], [0, 1]);
      invalidateWorktrees();
    });
    const restore = Effect.fn("Git.restore")((branch: string, name: string) =>
      run("git", ["branch", "-f", branch, name]).pipe(Effect.asVoid),
    );
    const push = Effect.fn("Git.push")((branch: string, remote = "origin") =>
      remote === "origin"
        ? run("git", ["push", "--force-with-lease", "-u", remote, branch]).pipe(Effect.asVoid)
        : run("git", ["fetch", remote, "--prune"]).pipe(
            Effect.flatMap(() => run("git", ["push", "--force-with-lease", remote, branch])),
            Effect.asVoid,
          ),
    );
    return Service.of({
      fetch,
      remotes,
      dirty,
      worktrees,
      refs,
      current,
      remote,
      switch: switch_,
      head,
      ancestor,
      fastForward,
      base,
      commits,
      novel,
      replay,
      unmergedPaths,
      release,
      backup,
      drop,
      restore,
      push,
    });
  }),
);

export const test = (opts: {
  current?: string;
  remote?: string;
  refs?: ReadonlyArray<BranchRef>;
  bases?: Readonly<Record<string, string>>;
}) =>
  Layer.succeed(
    Service,
    Service.of({
      fetch: () => Effect.void,
      dirty: () => Effect.succeed([]),
      worktrees: () => Effect.succeed([]),
      refs: () => Effect.succeed(opts.refs ?? []),
      remotes: () => Effect.succeed([]),
      current: () => Effect.succeed(opts.current ?? ""),
      remote: () => Effect.succeed(Option.fromNullishOr(opts.remote)),
      switch: () => Effect.void,
      head: (name: string) =>
        Effect.succeed(
          Option.fromNullishOr(
            opts.refs?.find((ref) => ref.name === name)?.head ??
              (name.startsWith("origin/")
                ? opts.refs?.find((ref) => ref.name === name.slice(7))?.head
                : undefined),
          ),
        ),
      ancestor: () => Effect.succeed(false),
      fastForward: () => Effect.void,
      base: (branch: string, parent: string) =>
        Effect.succeed(Option.fromNullishOr(opts.bases?.[`${branch}:${parent}`])),
      commits: () => Effect.succeed([]),
      novel: (_parent, _branch, commits) => Effect.succeed(commits),
      replay: () => Effect.void,
      unmergedPaths: () => Effect.succeed([] as ReadonlyArray<string>),
      release: () => Effect.void,
      backup: () => Effect.void,
      drop: () => Effect.void,
      restore: () => Effect.void,
      push: () => Effect.void,
    }),
  );

export * as Git from "./Git.ts";
