import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ForgeError, PullMeta, PullRef } from "../domain/model.ts";

export interface Interface {
  readonly auto: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly merge: (
    pr: number,
    opts?: { readonly admin?: boolean },
  ) => Effect.Effect<void, ForgeError>;
  readonly wait: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly pulls: () => Effect.Effect<ReadonlyArray<PullRef>, ForgeError>;
  readonly pull: (pr: number) => Effect.Effect<PullMeta, ForgeError>;
  readonly edit: (pr: number, base: string) => Effect.Effect<void, ForgeError>;
  readonly body: (pr: number, body: string) => Effect.Effect<void, ForgeError>;
  readonly close: (pr: number) => Effect.Effect<void, ForgeError>;
  readonly create: (
    branch: string,
    base: string,
    title: string,
    body: string,
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<PullRef, ForgeError>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Forge") {}

export type ForgeKind = "github" | "gitlab";

export interface RemoteInfo {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

const trimGit = (value: string) => (value.endsWith(".git") ? value.slice(0, -4) : value);

const matchGitHub = (remote: string): RemoteInfo | null => {
  const https = remote.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https && https[1] === "github.com") {
    return { kind: "github", host: https[1]!, owner: https[2]!, repo: trimGit(https[3]!) };
  }
  const ssh = remote.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ssh && ssh[1] === "github.com") {
    return { kind: "github", host: ssh[1]!, owner: ssh[2]!, repo: trimGit(ssh[3]!) };
  }
  return null;
};

export const detect = (remote: string): RemoteInfo | null => matchGitHub(remote);

export const pullUrlBase = (info: RemoteInfo): string => {
  switch (info.kind) {
    case "github":
      return `https://${info.host}/${info.owner}/${info.repo}/pull`;
    case "gitlab":
      return `https://${info.host}/${info.owner}/${info.repo}/-/merge_requests`;
  }
};

export const pullUrlBaseFor = (remote: string): string | null => {
  const info = detect(remote);
  return info ? pullUrlBase(info) : null;
};
