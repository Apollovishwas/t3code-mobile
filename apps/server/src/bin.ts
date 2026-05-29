import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { diagnoseCommand } from "./cli/diagnose.ts";
import { setupMobileCommand } from "./cli/setupMobile.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { WikiWriter } from "./wiki/Services/WikiWriter.ts";
import { WikiScheduler } from "./wiki/Services/WikiScheduler.ts";

// Empty stubs for cli-only commands that don't exercise wiki at all
// (auth/project/diagnose). The full server runtime provides Live
// implementations; these stubs satisfy the CLI's parser-side R channel.
const CliWikiStubs = Layer.mergeAll(
  Layer.mock(WikiWriter)({
    init: () => Effect.never as never,
    captureFromThread: () => Effect.never as never,
    garden: () => Effect.never as never,
    healthRun: () => Effect.never as never,
  }),
  Layer.mock(WikiScheduler)({
    list: () => Effect.succeed([]),
    upsert: () => Effect.never as never,
    remove: () => Effect.void,
    start: () => Effect.void,
  }),
);
const CliRuntimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  CliWikiStubs,
);

export const cli = Command.make("t3", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    projectCommand,
    diagnoseCommand,
    setupMobileCommand,
  ]),
);

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
