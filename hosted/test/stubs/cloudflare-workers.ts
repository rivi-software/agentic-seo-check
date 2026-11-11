/**
 * What src/state.ts takes from `cloudflare:workers`, a module only workerd has, for the tests that
 * import the Worker's modules in Node (vitest.config.ts). They import state.ts for `globalState`,
 * and never run the Durable Object; the workerd tests run it.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
