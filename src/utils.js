/**
 * Shared utilities for email filtering
 */

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in ms (doubles each retry)
 */
export async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on auth errors or not found
      if (error.code === 401 || error.code === 404) {
        throw error;
      }

      // Rate limit error - back off more aggressively
      if (error.code === 429 || error.message?.includes('Rate Limit')) {
        const delay = baseDelay * Math.pow(2, attempt + 2);
        console.warn(`Rate limited. Waiting ${delay}ms before retry ${attempt + 1}/${maxRetries}`);
        await sleep(delay);
        continue;
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Process items in batches with rate limiting
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each batch
 * @param {number} batchSize - Number of items per batch
 * @param {number} delayBetweenBatches - Delay between batches in ms
 */
export async function processBatches(items, processor, batchSize = 50, delayBetweenBatches = 100) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const result = await withRetry(() => processor(batch));
    results.push(result);

    if (i + batchSize < items.length) {
      await sleep(delayBetweenBatches);
    }
  }
  return results;
}

/**
 * Extract domain from email address
 */
export function extractDomain(email) {
  const match = email.match(/@([^>\s]+)/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Extract email address from a "From" header value
 */
export function extractEmail(fromField) {
  const match = fromField.match(/<(.+?)>/) || fromField.match(/([^\s]+@[^\s]+)/);
  return match ? match[1].toLowerCase() : fromField.toLowerCase();
}

/**
 * Check if email matches a protected sender (supports both exact match and domain match)
 * @param {string} email - Email address to check
 * @param {string[]} protectedSenders - List of protected senders (emails or domains)
 */
export function isProtectedSender(email, protectedSenders) {
  const emailLower = email.toLowerCase();
  const domain = extractDomain(emailLower);

  return protectedSenders.some(sender => {
    const senderLower = sender.toLowerCase().trim();

    // Exact email match
    if (emailLower === senderLower) {
      return true;
    }

    // Domain match (if sender is just a domain like "chase.com")
    if (!senderLower.includes('@') && domain.endsWith(senderLower)) {
      return true;
    }

    // Domain suffix match (e.g., sender "@chase.com" matches "alerts@info.chase.com")
    if (senderLower.startsWith('@')) {
      const senderDomain = senderLower.slice(1);
      return domain === senderDomain || domain.endsWith('.' + senderDomain);
    }

    // Email domain match
    const senderDomain = extractDomain(senderLower);
    if (senderDomain && domain === senderDomain) {
      return true;
    }

    return false;
  });
}

/**
 * Protected domains that should never be filtered aggressively
 */
export const PROTECTED_DOMAINS = [
  'chase.com',
  'capitalone.com',
  'paypal.com',
  'venmo.com',
  'mercury.com',
  'rippling.com',
  'uber.com',
  'lyft.com',
  'doordash.com',
  'google.com',
  'github.com',
  'apple.com',
  'citi.com',
  'amex.com',
  'americanexpress.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'sutterhealth.org',
  'united.com',
  'delta.com',
  'southwest.com',
  'aa.com'
];

/**
 * Check if an email is from a domain that should always be protected
 */
export function isFromProtectedDomain(email) {
  const domain = extractDomain(email);
  return PROTECTED_DOMAINS.some(pd => domain === pd || domain.endsWith('.' + pd));
}

/**
 * Rate limiter class for API calls
 */
export class RateLimiter {
  constructor(requestsPerSecond = 10) {
    this.minInterval = 1000 / requestsPerSecond;
    this.lastRequest = 0;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await sleep(this.minInterval - elapsed);
    }
    this.lastRequest = Date.now();
  }
}
