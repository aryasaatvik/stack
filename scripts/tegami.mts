import { tegami, type TegamiPlugin } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

import rootPackage from "../package.json" with { type: "json" };

const REPOSITORY = "aryasaatvik/stack";
const PACKAGE_ID = "npm:@aryasaatvik/stack";

const stackTag = (): TegamiPlugin => ({
  name: "stack-tag",
  enforce: "post",
  initPublishPlan({ plan }) {
    const pkg = this.graph.get(PACKAGE_ID);
    const packagePlan = plan.packages.get(PACKAGE_ID);
    if (!pkg?.version || !packagePlan) return;

    packagePlan.git ??= {};
    packagePlan.git.tag = `v${pkg.version}`;
  },
});

if (rootPackage.name !== "@aryasaatvik/stack") throw new Error("unexpected release package");

const paper = tegami({
  npm: { client: "bun" },
  packages: {
    "@aryasaatvik/stack": {},
  },
  plugins: [
    github({
      repo: REPOSITORY,
      pushTags: true,
      versionPr: {
        branch: "tegami/version-packages",
        base: "dev",
        forceCreate: true,
        commit() {
          return { title: "chore(release): version packages" };
        },
        create() {
          const version = this.graph.get(PACKAGE_ID)?.version;
          return {
            title: version
              ? `chore(release): prepare Stack ${version}`
              : "chore(release): prepare Stack",
          };
        },
      },
      release: {
        create({ tag }) {
          return { title: tag };
        },
      },
    }),
    stackTag(),
  ],
});

await runCli(paper);
