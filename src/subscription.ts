/**
 * What the premium server (issue #229) answers when a feature needs a subscription the account
 * lacks. Its own module, as each error class is.
 */
import { WEBSITE_URL } from "./brand.js";
import { ExpectedError } from "./core/errors.js";

/** What `render: true` answers on the premium server for an account without a subscription. */
export class SubscriptionNeededError extends ExpectedError {
  override name = "SubscriptionNeededError";

  constructor() {
    super(
      `Rendering needs a subscription. Subscribe at ${WEBSITE_URL}/account.`,
      { reason: "subscription" }
    );
  }
}
