import { createHmac, randomBytes } from "node:crypto";

import { DurableObject } from "cloudflare:workers";

/** The count of one day's outgoing requests, all callers together. */
interface DayCount {
  /** The UTC date, YYYY-MM-DD. */
  day: string;
  count: number;
}

/** The key that hashes a day's callers and sites, and whether this call made it. */
interface SiteKey {
  key: Buffer;
  fresh: boolean;
}

/** The first moment after the UTC date `day`, when its sites are deleted. */
const endOf = (day: string): number =>
  Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;

/** The STATE binding as `globalState` asks it, so the tests can fake it. */
export interface StateNamespace<T> {
  getByName: (name: string) => T;
  jurisdiction: (jurisdiction: "eu") => { getByName: (name: string) => T };
}

/** The bindings and variables `globalState` reads, in both Workers. */
export interface StateEnv<T> {
  STATE: StateNamespace<T>;
  /**
   * "eu" in both configurations. "none" asks for the object without a jurisdiction, for workerd run
   * locally, which has none ("Jurisdiction restrictions are not implemented in workerd"): .dev.vars
   * sets it for `hosted:dev`, `site:dev` and the workerd tests. Any other value, or none at all,
   * keeps the object in the EU, so that a mistake in a configuration cannot move it out.
   */
  STATE_JURISDICTION?: string;
}

/**
 * The one HostedState, "global", in the EU jurisdiction (issue #78): Cloudflare runs it and keeps
 * its data in the EU, and a Worker anywhere may still call it. While a day's key exists, the codes
 * of that day's sites are pseudonymous personal data, and RIVI's privacy policy keeps data in the
 * EU where it can. Both Workers ask for the object here, in this file, so that the website, which
 * deploys from main, waits for the MCP server's deploy (deploy-site.yml) and never counts in
 * another object than the MCP server.
 */
export const globalState = <T>(env: StateEnv<T>): T =>
  (env.STATE_JURISDICTION === "none"
    ? env.STATE
    : env.STATE.jurisdiction("eu")
  ).getByName("global");

/**
 * What every isolate of the Worker shares: the day's count of outgoing requests, for the daily
 * limit (the rate limiting binding counts per 10 or 60 seconds only), the sites each caller audited
 * today, for the daily cap on sites (issue #73), and OpenAI's ChatGPT connector ranges, which a
 * Cron Trigger refreshes. One object, named "global" in the EU jurisdiction (`globalState`), holds
 * them.
 *
 * The website's Worker binds this class too (wrangler.site.jsonc), so its form counts in the same
 * day, but the object runs the code the MCP server last deployed. The website deploys from main,
 * so its deploy waits while this file differs from the last release's (deploy-site.yml).
 */
export class HostedState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Who audited what today, as keyed hashes; the day's key is the one row of site_key.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sites (caller TEXT NOT NULL, site TEXT NOT NULL, PRIMARY KEY (caller, site)) WITHOUT ROWID"
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS site_key (day TEXT NOT NULL, key BLOB NOT NULL)"
    );
  }

  /** The requests counted for `day`; a day not stored yet has none. */
  async requests(day: string): Promise<number> {
    const stored = await this.ctx.storage.get<DayCount>("requests");

    return stored?.day === day ? stored.count : 0;
  }

  /** Adds `count` requests to `day` and answers the day's total. A new day starts from zero. */
  async addRequests(day: string, count: number): Promise<number> {
    const total = (await this.requests(day)) + count;
    await this.ctx.storage.put<DayCount>("requests", { day, count: total });

    return total;
  }

  /**
   * Whether `caller` may audit `site` on `day`: yes for a site it already audited that day, and for
   * a new one while it has audited fewer than `limit`, which then counts. The object stores neither:
   * both are hashed with a random key made for the day, which goes with the day's rows. The check
   * and the insert run with no await between them, so two calls cannot both take the last site.
   */
  async admitSite(
    day: string,
    caller: string,
    site: string,
    limit: number
  ): Promise<boolean> {
    const { key, fresh } = this.siteKey(day);

    const hash = (value: string) =>
      createHmac("sha256", key).update(value).digest("base64url");

    const who = hash(`caller:${caller}`);
    const what = hash(`site:${site}`);
    const { sql } = this.ctx.storage;

    const known =
      sql
        .exec("SELECT 1 FROM sites WHERE caller = ? AND site = ?", who, what)
        .toArray().length > 0;

    const count = sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM sites WHERE caller = ?",
        who
      )
      .one().n;

    const admitted = known || count < limit;

    if (admitted && !known) {
      sql.exec("INSERT INTO sites (caller, site) VALUES (?, ?)", who, what);
    }

    if (fresh) {
      await this.ctx.storage.setAlarm(endOf(day));
    }

    return admitted;
  }

  /** At the end of the day its sites go, and the key that hashed them. */
  override alarm(): void {
    this.forgetSites();
  }

  /** The key that hashes `day`'s callers and sites, made on the day's first call. */
  private siteKey(day: string): SiteKey {
    const { sql } = this.ctx.storage;

    const [stored] = sql
      .exec<{ day: string; key: ArrayBuffer }>("SELECT day, key FROM site_key")
      .toArray();

    if (stored?.day === day) {
      return { key: Buffer.from(stored.key), fresh: false };
    }

    // A new day: the last day's sites go with its key, should its alarm not have run yet.
    this.forgetSites();

    const key = randomBytes(32);
    sql.exec("INSERT INTO site_key (day, key) VALUES (?, ?)", day, key);

    return { key, fresh: true };
  }

  private forgetSites(): void {
    this.ctx.storage.sql.exec("DELETE FROM sites");
    this.ctx.storage.sql.exec("DELETE FROM site_key");
  }

  async openAiRanges(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("openai-ranges")) ?? [];
  }

  async setOpenAiRanges(ranges: string[]): Promise<void> {
    await this.ctx.storage.put("openai-ranges", ranges);
  }
}
