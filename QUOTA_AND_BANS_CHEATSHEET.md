# Google Cloud Code Assist API: Quotas, Limits, and Bans

This document outlines the operational limits of the Google Cloud Code Assist (Gemini/Claude) endpoints used by the rotator. 

**Transparency Notice:** Google does not publish exact anti-abuse heuristics. The data below is derived from empirical log analysis and standard API security patterns.

---

## 1. HTTP 429: Rate Limiting (Normal)
A `429 Too Many Requests` indicates an account has hit its temporary speed limit or daily quota. 

*   **Behavior:** The server returns a `Retry-After` header or a body payload indicating a cooldown (ranging from a few seconds to 24 hours).
*   **Impact:** The account is temporarily paused. It is safe to use once the cooldown expires.
*   **Rotator Action:** Reads the delay, marks the account as `EXHAUSTED`, and rotates to the next available account.

## 2. HTTP 403: Terms of Service Violation (The Ban Hammer)
A `403 Permission Denied` with a Terms of Service (ToS) message indicates Google's anti-bot systems have flagged the account for abuse.

*   **Behavior:** Permanent suspension of the API service for that account.
*   **Impact:** Account is dead for API routing. Requires manual appeal via Google Cloud Console.
*   **Rotator Action:** Marks the account as `FLAGGED`, permanently removes it from rotation, and triggers a global **Protective Pause** (default 6 hours) to prevent other accounts from facing the same WAF/Anti-bot rules.

---

## 3. What Triggers a 403 ToS Ban? (Empirical Data)

Based on historical crash data and log analysis, bans are not triggered by merely hitting a quota, but by *how* the endpoint is accessed.

### Trigger A: The "Hammering" Effect (Patched)
The fastest way to trigger a 403 ToS ban is to ignore a 429 Rate Limit. 
*   **Historical failure:** An early version of the system received a `429 (Cooldown 3s)` but continued sending requests every second. Google's Web Application Firewall (WAF) interpreted this as a DDoS or aggressive scraping attack and escalated the 429 to a permanent 403 ToS ban within minutes.
*   **Fix:** The current rotator strictly respects the `Retry-After` header. If an account is in cooldown, no requests are forwarded to it.

### Trigger B: Extreme Unhuman Volume (The ~200 Rule)
Accounts that process too many requests in a 24-hour window without human-like pauses are flagged by heuristic analysis.
*   **Observed Threshold:** Accounts processing **~200 requests per day** consistently trigger WAF bans, even if they don't hammer 429s. 
*   *Note: This is an empirical observation from production logs, not an official Google hard limit.*

---

## 4. Capacity Planning & Safe Usage

To keep your account pool healthy, you must distribute traffic to stay below the heuristic radar. 

**The Math:**
Do not exceed an average of **80 to 100 requests per account, per day**.

*   **100 requests/day total:** 2-3 healthy accounts required.
*   **500 requests/day total:** 6-7 healthy accounts required.
*   **1200+ requests/day total (Heavy Agentic Work):** 15+ healthy accounts required.

### Best Practices for Operators
1.  **Monitor the Dashboard:** Keep an eye on each account's request counts (total and since the last rotation, in the account drawer) and its daily budget meters.
2.  **Do Not Retry Blindly:** If the rotator proxy returns a 503 (All accounts exhausted), your consuming agent **must** respect the `retryAfterMs` payload. Do not loop retries on the consumer side.
3.  **Use Proportional Pooling:** Configure `requestsPerRotation` (default: 5) to evenly distribute load across the active pool rather than draining one account to 0% before switching.