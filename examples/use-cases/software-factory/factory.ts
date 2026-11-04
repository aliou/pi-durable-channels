import {
  type ChannelAdapter,
  type Channels,
  createChannels,
} from "@aliou/pi-durable-channels";
import {
  defineExtension,
  type Extension,
  type ModelRef,
  section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { GitHubCall } from "@examples/github-channel";
import { buildTools, type Repo, triageTools } from "./tools";
import type { Workspace } from "./workspace";

export type FactoryOptions = {
  slack: ChannelAdapter;
  github: ChannelAdapter;
  call: GitHubCall;
  repo: Repo;
  workspace: Workspace;
  model: ModelRef;
  instructions: { build: string; triage: string };
  labels: readonly string[];
  observers?: readonly Extension[];
};

export type Factory = { channels: Channels; extensions: Extension[] };

const WorkspacePrompt = defineExtension({
  name: "factory-workspace",
  sections: [
    section("workspace", (input) =>
      input.env?.cwd === undefined
        ? undefined
        : `Your working directory is ${input.env.cwd}, a git worktree of the repository. Keep every file you create inside it. Put scratch files, such as one-off scripts, in its scratch/ folder, which git ignores, never in /tmp.`,
    ),
  ],
});

export function softwareFactory(options: FactoryOptions): Factory {
  const { call, repo, model } = options;
  const observers = options.observers ?? [];
  const channels: Channels = createChannels({
    channels: {
      slack: {
        adapter: options.slack,
        conversation: () => ({ agent: personas.build }),
      },
      github: {
        adapter: options.github,
        conversation: (message) =>
          message.event === "issues.opened"
            ? { agent: personas.triage }
            : undefined,
      },
    },
  });
  const build = buildTools({
    call,
    repo,
    workspace: options.workspace,
    bind: channels.bind,
  });
  const triage = triageTools({ call, repo, labels: options.labels });
  const personas = {
    build: {
      model,
      instructions: options.instructions.build,
      extensions: [
        CodingTools,
        WorkspacePrompt,
        channels.tools,
        build,
        ...observers,
      ],
    },
    triage: {
      model,
      instructions: options.instructions.triage,
      extensions: [CodingTools, WorkspacePrompt, triage, ...observers],
    },
  };
  return {
    channels,
    extensions: [CodingTools, WorkspacePrompt, build, triage, ...observers],
  };
}
