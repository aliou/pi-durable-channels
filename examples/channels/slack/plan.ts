import { compile, obj, str } from "@earendil-works/pi-schema";
import type { SlackCall } from "./api";
import type { Thread } from "./target";

const FLUSH_MS = 2000;
const MAX_TASKS = 50;
const HEAD_TASKS = 10;
const MAX_DETAILS = 300;
const WORKING = "Working…";
const MAX_FINISHED = 1000;
const MAX_TITLE = 60;

const Posted = compile(obj({ ts: str() }, { open: true }));

export type PlanStep = {
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  details?: string;
  narration?: boolean;
};

export type PlanOutcome = "done" | "stopped" | "failed";

const TITLES: Readonly<Record<PlanOutcome, (steps: number) => string>> = {
  done: (steps) => `Done: ${steps} ${steps === 1 ? "step" : "steps"}`,
  stopped: (steps) =>
    `Stopped after ${steps} ${steps === 1 ? "step" : "steps"}`,
  failed: (steps) => `Failed after ${steps} ${steps === 1 ? "step" : "steps"}`,
};

type Plan = {
  thread: Thread;
  title: string;
  steps: Map<string, PlanStep>;
  ts?: string;
  chain: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE)}…` : flat;
}

export function titleOf(name: string, args: unknown): string {
  const values =
    typeof args === "object" && args !== null ? Object.values(args) : [];
  const first = values.find((value) => typeof value === "string");
  return typeof first === "string" ? oneLine(`${name} ${first}`) : name;
}

export function narrationStep(id: string, text: string): PlanStep {
  return {
    id,
    title: oneLine(text),
    status: "complete",
    details: text,
    narration: true,
  };
}

function richText(text: string) {
  const cut =
    text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
  return {
    type: "rich_text",
    elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: cut }] },
    ],
  };
}

function taskOf(step: PlanStep) {
  return {
    task_id: step.id,
    title: step.title,
    status: step.status,
    ...(step.narration === true ? { hide_title: true } : {}),
    ...(step.details === undefined ? {} : { details: richText(step.details) }),
  };
}

function tasksOf(steps: readonly PlanStep[]) {
  if (steps.length <= MAX_TASKS) return steps.map(taskOf);
  const tail = steps.slice(steps.length - (MAX_TASKS - HEAD_TASKS - 1));
  const hidden = steps.length - HEAD_TASKS - tail.length;
  const folded = {
    task_id: "folded",
    title: `… ${hidden} more steps`,
    status: "complete",
  };
  return [
    ...steps.slice(0, HEAD_TASKS).map(taskOf),
    folded,
    ...tail.map(taskOf),
  ];
}

function settle(steps: Map<string, PlanStep>, outcome: PlanOutcome): void {
  const status = outcome === "done" ? "complete" : "error";
  for (const [id, step] of steps)
    if (step.status === "in_progress") steps.set(id, { ...step, status });
}

export function createPlans(
  call: SlackCall,
  onError: (thread: Thread) => (error: unknown) => void,
) {
  const plans = new Map<string, Plan>();
  const finished = new Set<string>();

  async function flush(plan: Plan): Promise<void> {
    const blocks = [
      {
        type: "plan",
        title: plan.title,
        tasks: tasksOf([...plan.steps.values()]),
      },
    ];
    const body = { channel: plan.thread.channel, text: plan.title, blocks };
    if (plan.ts !== undefined) {
      await call("chat.update", { ...body, ts: plan.ts });
      return;
    }
    const posted = await call("chat.postMessage", {
      ...body,
      thread_ts: plan.thread.threadTs,
    });
    plan.ts = Posted.check(posted) ? posted.ts : undefined;
  }

  function queue(plan: Plan): void {
    plan.chain = plan.chain.then(() => flush(plan)).catch(onError(plan.thread));
  }

  function step(key: string, thread: Thread, value: PlanStep): void {
    if (finished.has(key)) return;
    const known = plans.get(key);
    const plan: Plan = known ?? {
      thread,
      title: WORKING,
      steps: new Map(),
      chain: Promise.resolve(),
    };
    plans.set(key, plan);
    plan.steps.set(value.id, value);
    if (known === undefined) {
      queue(plan);
      return;
    }
    plan.timer ??= setTimeout(() => {
      plan.timer = undefined;
      queue(plan);
    }, FLUSH_MS);
  }

  function finishStep(
    key: string,
    id: string,
    status: PlanStep["status"],
  ): void {
    const plan = plans.get(key);
    const known = plan?.steps.get(id);
    if (plan === undefined || known === undefined) return;
    step(key, plan.thread, { ...known, status });
  }

  function markFinished(key: string): void {
    finished.add(key);
    const [oldest] = finished;
    if (finished.size > MAX_FINISHED && oldest !== undefined)
      finished.delete(oldest);
  }

  async function take(key: string): Promise<Plan | undefined> {
    markFinished(key);
    const plan = plans.get(key);
    plans.delete(key);
    clearTimeout(plan?.timer);
    await plan?.chain;
    return plan;
  }

  async function finish(key: string, outcome: PlanOutcome): Promise<void> {
    const plan = await take(key);
    if (plan === undefined) return;
    settle(plan.steps, outcome);
    const tools = [...plan.steps.values()].filter((step) => !step.narration);
    plan.title = TITLES[outcome](tools.length);
    await flush(plan);
  }

  async function discard(key: string): Promise<void> {
    const plan = await take(key);
    if (plan?.ts === undefined) return;
    await call("chat.delete", { channel: plan.thread.channel, ts: plan.ts });
  }

  return { step, finishStep, finish, discard };
}
