#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import skillContent from "../skills/stack/SKILL.md" with { type: "text" };
import { BranchError, DirtyWorktreeError, ExecError, MergeBaseError } from "./domain/model.ts";
import { renderStatus } from "./format.ts";
import * as Proc from "./platform/proc.ts";
import { parseBlockLinkConfig, parseTrunksConfig, StackConfig, trunks } from "./services/Config.ts";
import { CodeHost } from "./services/CodeHost.ts";
import { CodeHostGitHub } from "./services/code-host/GitHub.ts";
import { CodeHostGitLab } from "./services/code-host/GitLab.ts";
import { Git } from "./services/Git.ts";
import * as Progress from "./services/Progress.ts";
import { Stack } from "./services/Stack.ts";
import { Store } from "./services/Store.ts";

const apply = Flag.boolean("apply").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Apply the change. Without this flag the command is a dry run."),
);

const auto = Flag.boolean("auto").pipe(
  Flag.withDescription(
    "Enable code-host auto-merge for the root change, wait until it merges, then repair descendants automatically.",
  ),
);

const admin = Flag.boolean("admin").pipe(
  Flag.withDescription(
    "Use administrator privileges to merge immediately, bypassing protection rules. Requires --apply. GitHub only.",
  ),
);

const through = Flag.string("through").pipe(
  Flag.withDescription(
    "With --auto, keep merging stack roots until this branch or change number has landed.",
  ),
  Flag.optional,
);

const except = Flag.string("except").pipe(
  Flag.withDescription(
    "With --auto, land every root in the stack except the named branch or change and its descendants. Mutually exclusive with --through.",
  ),
  Flag.optional,
);

const eager = Flag.boolean("eager").pipe(
  Flag.withDescription(
    "Repair the full remaining chain after every landing instead of only the next root. Restores pre-lazy churn; use it to keep every open change's diff current while the campaign runs.",
  ),
);

const continueCampaign = Flag.boolean("continue").pipe(
  Flag.withDescription(
    "Resume the saved --through or --except campaign from the recorded next root after a manual conflict fix. Cannot be combined with a branch argument, --through, or --except.",
  ),
);

const all = Flag.boolean("all").pipe(
  Flag.withDescription(
    "Sync every tracked stack in the repository. Required for --continue-on-failure.",
  ),
);

const continueOnFailure = Flag.boolean("continue-on-failure").pipe(
  Flag.withAlias("keep-going"),
  Flag.withDescription(
    "With --all, process every independent stack and report failures at the end instead of stopping on the first failure.",
  ),
);

const statusCommand = Command.make(
  "status",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const codeHost = yield* CodeHost.Service;
    const report = yield* stack.status();
    yield* Console.log(
      renderStatus(report, {
        pretty: true,
        reference: codeHost.reference,
        requestLabel: codeHost.requestLabel,
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Show the relevant tracked stack. Use sync to preview target-branch inference and repairs.",
  ),
);

const skillCommand = Command.make(
  "skill",
  {},
  Effect.fn(function* () {
    yield* Console.log(skillContent);
  }),
).pipe(
  Command.withDescription(
    "Print the stack skill (skills/stack/SKILL.md) for AI agent discovery from the installed package.",
  ),
);

const trackCommand = Command.make(
  "track",
  {
    branch: Argument.string("branch"),
    onto: Flag.string("onto").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Parent branch this branch is stacked on"),
    ),
  },
  Effect.fn(function* ({ branch, onto }) {
    const stack = yield* Stack;
    const link = yield* stack.adopt(branch, onto);
    yield* Console.log(`track ${link.branch} onto ${link.parent} @ ${link.anchor}`);
  }),
).pipe(
  Command.withDescription(
    "Manually record stack intent only when change target branches do not already encode the stack.",
  ),
  Command.withExamples([
    {
      command: "stack track stack-c --onto stack-b",
      description: "Record that stack-c is stacked on stack-b",
    },
  ]),
);

const syncCommand = Command.make(
  "sync",
  {
    branch: Argument.string("branch").pipe(Argument.optional),
    apply,
    all,
    continueOnFailure,
  },
  Effect.fn(function* ({ branch, apply, all, continueOnFailure }) {
    const stack = yield* Stack;
    const branchValue = Option.getOrUndefined(branch);
    const items = yield* stack.sync({
      apply,
      all,
      continueOnFailure,
      ...(branchValue === undefined ? {} : { branch: branchValue }),
    });
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Infer stack links from code-host target branches (GitHub PRs / GitLab MRs), clean stale metadata, repair branches, retarget changes, and refresh stack links. Sync scopes to the named branch's subtree (the branch plus its descendants): a lower-branch fix restacks only that subtree, and sibling subtrees never move. Ancestors are read-only rebase targets; name the stack root to freshen the whole stack (including trunk-chase). If branch is omitted, sync uses the current branch's subtree; off-stack, sync the single stack automatically or ask you to pick one. Add --all to sync every stack in the repo. By default this is a dry run. Add --apply to mutate branches, changes, and stack metadata.",
  ),
  Command.withExamples([
    {
      command: "stack sync",
      description: "Preview inferred stack links and repairs without changing branches or changes",
    },
    {
      command: "stack sync effectify-watcher",
      description: "Preview the effectify-watcher subtree (that branch and its descendants)",
    },
    {
      command: "stack sync --apply",
      description: "Run the common stack maintenance workflow for the current branch's subtree",
    },
    {
      command: "stack sync --apply --all",
      description: "Run stack maintenance across every stack in the repository",
    },
    {
      command: "stack sync --apply --all --continue-on-failure",
      description: "Sync independent stacks and summarize any failures at the end",
    },
  ]),
);

const doctorCommand = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const items = yield* stack.doctor();
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Check local Git, code host (GitHub or GitLab), stack metadata, trunk branches, and undo journal health without changing anything.",
  ),
);

const mergeCommand = Command.make(
  "merge",
  {
    branch: Argument.string("branch").pipe(Argument.optional),
    apply,
    auto,
    admin,
    through,
    except,
    eager,
    continue: continueCampaign,
  },
  Effect.fn(function* ({ branch, apply, auto, admin, through, except, eager, continue: resume }) {
    const stack = yield* Stack;
    const throughValue = Option.getOrUndefined(through);
    const exceptValue = Option.getOrUndefined(except);
    const items = yield* stack.land(Option.getOrUndefined(branch), {
      apply,
      auto,
      admin,
      eager,
      continue: resume,
      ...(throughValue === undefined ? {} : { through: throughValue }),
      ...(exceptValue === undefined ? {} : { except: exceptValue }),
    });
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Merge the oldest branch in a stack, preserve a local backup branch, repair descendants, and print the next root branch. If branch is omitted, infer the root from the current branch. By default this is a dry run. Add --apply to merge immediately, --apply --admin to force with admin privileges (GitHub only), or --auto to enable code-host auto-merge and wait until it lands before repairing descendants. Add --auto --through <branch-or-change> to land only the roots on the chain to that target; each landing repairs only the next root (grandchildren wait their turn) with one final full repair pass over anything still open. Sibling subtrees that branch off the chain are never merged by --through — under lazy repair they are not rebased until that final pass. Add --auto --except <branch-or-change> instead to land every root in the stack except that branch and its descendants (they keep their history and wait for their own campaign); --through and --except are mutually exclusive. Add --eager to repair the whole remaining chain after every landing, or --continue to resume a campaign that stopped on a conflict.",
  ),
  Command.withExamples([
    {
      command: "stack merge",
      description: "Preview merge + repair for the inferred root of the current stack",
    },
    {
      command: "stack merge effectify-watcher",
      description: "Preview merge + repair for the root branch of a stack",
    },
    {
      command: "stack merge effectify-watcher --apply",
      description: "Merge the root change, repair descendants, and print the next root branch",
    },
    {
      command: "stack merge effectify-watcher --auto",
      description: "Wait for code-host merge requirements, then merge and repair descendants",
    },
    {
      command: "stack merge --auto --through effectify-format",
      description:
        "Auto-merge roots until the target lands, repairing only the next root each turn",
    },
    {
      command: "stack merge --auto --through effectify-format --eager",
      description: "Same campaign, but repair every remaining open change after each landing",
    },
    {
      command: "stack merge --auto --except effectify-docs",
      description:
        "Land the whole stack except effectify-docs and its descendants, which stay open for later",
    },
    {
      command: "stack merge --continue",
      description: "Resume a stopped campaign from its next root after fixing the conflict",
    },
    {
      command: "stack merge effectify-watcher --apply --admin",
      description: "Force-merge the root GitHub PR with admin privileges, then repair descendants",
    },
  ]),
);

const historyCommand = Command.make(
  "history",
  {},
  Effect.fn(function* () {
    const stack = yield* Stack;
    const items = yield* stack.last();
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Show the most recent applied stack mutation so you can see what changed and what `undo --apply` would restore.",
  ),
);

const undoCommand = Command.make(
  "undo",
  { apply },
  Effect.fn(function* ({ apply }) {
    const stack = yield* Stack;
    const items = yield* stack.undo(apply);
    yield* Console.log(items.join("\n"));
  }),
).pipe(
  Command.withDescription(
    "Restore the last applied mutation using backup branches and the saved metadata snapshot. By default this is a dry run. Add --apply to actually restore branches, push them, close created changes, and restore stored metadata.",
  ),
  Command.withExamples([
    {
      command: "stack undo",
      description: "Preview the rollback plan for the last applied mutation",
    },
    {
      command: "stack undo --apply",
      description:
        "Restore branch tips, target branches, and metadata from the last mutation journal",
    },
  ]),
);

const cli = Command.make("stack").pipe(
  Command.withDescription(
    "A squash-safe stacked change CLI. Use plain git for normal editing and commits, then use stack to track branch relationships, inspect the graph, sync after parent changes, merge stack roots, and undo the last mutation if needed.",
  ),
  Command.withExamples([
    {
      command: "stack skill",
      description: "Print the stack skill for AI agent discovery",
    },
    {
      command: "stack sync",
      description: "Preview inferred stack links from code-host target branches",
    },
    {
      command: "stack sync --apply",
      description: "Run the previewed stack maintenance",
    },
  ]),
  Command.withSubcommands([
    statusCommand,
    skillCommand,
    trackCommand,
    syncCommand,
    doctorCommand,
    mergeCommand,
    historyCommand,
    undoCommand,
  ]),
);

export const runCli = (argv: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: pkg.version })(argv);

const live = (() => {
  const proc = Proc.live;
  const cfg = Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const proc = yield* Proc.Service;
      const root = yield* proc
        .exec(process.cwd(), "git", ["rev-parse", "--show-toplevel"])
        .pipe(
          Effect.catch((err) =>
            Console.error(err.stderr).pipe(
              Effect.flatMap(() => Effect.fail(new Error("not in a git repository"))),
            ),
          ),
        );

      const dir = yield* proc.exec(root, "git", ["rev-parse", "--git-common-dir"]);
      const git = path.isAbsolute(dir) ? dir : path.join(root, dir);
      const configuredTrunksOut = yield* proc.exec(
        root,
        "git",
        ["config", "--get", "stack.trunks"],
        [0, 1],
      );
      const configuredTrunks = parseTrunksConfig(configuredTrunksOut);
      const blockLinkOut = yield* proc.exec(
        root,
        "git",
        ["config", "--get", "stack.blockLink"],
        [0, 1],
      );
      const blockLink = parseBlockLinkConfig(blockLinkOut);

      return StackConfig.layer({
        root,
        store: path.join(git, "stack", "state.json"),
        journal: path.join(git, "stack", "undo.json"),
        campaign: path.join(git, "stack", "campaign.json"),
        trunks: configuredTrunks.length > 0 ? configuredTrunks : trunks,
        blockLink,
      });
    }),
  ).pipe(Layer.provideMerge(proc));

  const git = Git.live.pipe(Layer.provide(cfg));
  const codeHost = Layer.unwrap(
    Effect.gen(function* () {
      const proc = yield* Proc.Service;
      const cfgValue = yield* StackConfig;
      const remoteOut = yield* proc
        .exec(cfgValue.root, "git", ["config", "--get", "remote.origin.url"], [0, 1])
        .pipe(Effect.catch(() => Effect.succeed("")));
      const configuredOut = yield* proc.exec(
        cfgValue.root,
        "git",
        ["config", "--get", "stack.codeHost"],
        [0, 1],
      );
      const envValue = process.env.STACK_CODE_HOST;
      const explicitValue = envValue ?? (configuredOut || undefined);
      const explicit = CodeHost.providerFrom(explicitValue);
      if (explicitValue && !explicit) {
        return yield* Effect.fail(
          new Error(`invalid code host '${explicitValue}'; expected github or gitlab`),
        );
      }
      const detected = remoteOut ? CodeHost.detectProvider(remoteOut) : null;
      const provider = explicit ?? detected;
      if (!provider) {
        return yield* Effect.fail(
          new Error(
            "unable to determine the code host; configure it with: git config stack.codeHost github|gitlab",
          ),
        );
      }
      return provider === "gitlab" ? CodeHostGitLab.layer : CodeHostGitHub.layer;
    }),
  ).pipe(Layer.provide(cfg));
  const store = Store.live.pipe(Layer.provideMerge(cfg));
  return Stack.layer.pipe(
    Layer.provideMerge(cfg),
    Layer.provideMerge(git),
    Layer.provideMerge(codeHost),
    Layer.provideMerge(Progress.live),
    Layer.provideMerge(store),
  );
})();

const docs = Layer.mergeAll(
  Layer.succeed(Stack, {
    status: () => Effect.die("help-only"),
    adopt: () => Effect.die("help-only"),
    land: () => Effect.die("help-only"),
    links: () => Effect.die("help-only"),
    sync: () => Effect.die("help-only"),
    doctor: () => Effect.die("help-only"),
    last: () => Effect.die("help-only"),
    undo: () => Effect.die("help-only"),
  }),
  CodeHostGitHub.memory(),
);

const isShowHelp = (err: unknown): err is CliError.ShowHelp =>
  CliError.isCliError(err) && err._tag === "ShowHelp";

if (import.meta.main) {
  const help = process.argv
    .slice(2)
    .some((arg) => arg === "--help" || arg === "-h" || arg === "--version");

  const app = help
    ? runCli(process.argv.slice(2)).pipe(Effect.provide(docs))
    : runCli(process.argv.slice(2)).pipe(Effect.provide(live));

  const main = pipe(
    app,
    Effect.provide(NodeServices.layer),
    Effect.catchIf(isShowHelp, (err) =>
      Effect.sync(() => {
        process.exitCode = err.errors.length ? 1 : 0;
      }),
    ),
    Effect.tapError((err) =>
      Console.error(
        err instanceof ExecError && err.stderr
          ? `${err.message}\n${err.stderr}`
          : err instanceof DirtyWorktreeError ||
              err instanceof BranchError ||
              err instanceof MergeBaseError ||
              err instanceof Error
            ? err.message
            : String(err),
      ),
    ),
    Effect.catch(() => Effect.sync(() => process.exit(1))),
  );

  NodeRuntime.runMain(main);
}
