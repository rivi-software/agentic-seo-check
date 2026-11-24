/** What src/crawls.ts takes for its Workflow, which only the workerd tests run. */
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
