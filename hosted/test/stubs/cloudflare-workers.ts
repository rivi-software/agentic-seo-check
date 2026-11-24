/**
 * What src/state.ts and src/crawls.ts take from `cloudflare:workers`, a module only workerd has,
 * for the tests that import the Worker's modules in Node (vitest.config.ts). They import state.ts
 * for `globalState` and crawls.ts for its store, and never run the Durable Object or the Workflow;
 * the workerd tests run both.
 */
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
