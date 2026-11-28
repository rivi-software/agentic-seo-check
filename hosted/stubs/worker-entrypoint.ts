/**
 * What the OAuth provider (src/premium/) takes from `cloudflare:workers` besides DurableObject:
 * the class it extends for an entry point it offers, which the Node tests never use.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
