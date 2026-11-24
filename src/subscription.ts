/**
 * What the premium server (issue #229) answers when a feature needs a subscription the account
 * lacks. Its own module, as each error class is.
 */
import { WEBSITE_URL } from "./brand.js";
import { ExpectedError } from "./core/errors.js";

/**
 * What a paid feature answers on the premium server for an account without a subscription:
 * `render: true` ("Rendering"), or `lighthouse: true` ("Lab performance", issue #222).
 */
export class SubscriptionNeededError extends ExpectedError {
  override name = "SubscriptionNeededError";

  constructor(feature = "Rendering") {
    super(
      `${feature} needs a subscription. Subscribe at ${WEBSITE_URL}/account.`,
      { reason: "subscription" }
    );
  }
}
