import { DurableObject } from "cloudflare:workers";

/** The count of one day's outgoing requests, all callers together. */
interface DayCount {
  /** The UTC date, YYYY-MM-DD. */
  day: string;
  count: number;
}

/**
 * What every isolate of the Worker shares: the day's count of outgoing requests, for the daily
 * limit (the rate limiting binding counts per 10 or 60 seconds only), and OpenAI's ChatGPT
 * connector ranges, which a Cron Trigger refreshes. One object, named "global", holds both.
 */
export class HostedState extends DurableObject<Env> {
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

  async openAiRanges(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("openai-ranges")) ?? [];
  }

  async setOpenAiRanges(ranges: string[]): Promise<void> {
    await this.ctx.storage.put("openai-ranges", ranges);
  }
}
