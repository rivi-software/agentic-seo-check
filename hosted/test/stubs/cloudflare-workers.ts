/**
 * What src/state.ts, src/crawls.ts and the OAuth provider (src/premium/) take from
 * `cloudflare:workers`, a module only workerd has, for the tests that import the Worker's modules
 * in Node (vitest.config.ts). They import state.ts for `globalState` and crawls.ts for its store,
 * and never run the Durable Object or the Workflow; the workerd tests run both.
 */
export { WorkerEntrypoint } from "./worker-entrypoint.ts";

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// One class a file: the Workflow's is in a file of its own.
export { WorkflowEntrypoint } from "./workflow-entrypoint.ts";
