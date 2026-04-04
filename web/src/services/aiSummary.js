/**
 * @file aiSummary.js
 * @summary Browser-side client for the local Express AI routes (Ollama on the server).
 *
 * @description
 * The UI builds a textual ADA report and thresholds in `App.jsx`, then calls these helpers.
 * Requests go to same-origin `/api/ai/*` (Vite proxy → port 8787). Each call uses AbortController
 * so a stuck model does not hang the UI forever.
 */

/**
 * POST JSON to an AI endpoint and return the `text` field.
 *
 * @param {string} path Same-origin path, e.g. `/api/ai/summary`.
 * @param {Record<string, unknown>} body JSON-serializable request body.
 * @returns {Promise<string>} Trimmed assistant text from `{ text }`.
 * @throws {Error} On non-OK HTTP, JSON error payload, 30s timeout, or network failure.
 */
async function postAiRequest(path, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = payload?.details ? ` ${payload.details}` : "";
      throw new Error(`${payload?.error || "AI request failed."}${details}`);
    }

    return String(payload?.text || "").trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("AI request timed out after 30 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Request a plain-language building compliance summary grounded in numeric rules.
 *
 * The server recomputes pass/fail from thresholds vs latest measurements and injects those facts
 * into the Ollama prompt so the model stays consistent with the app.
 *
 * @param {object} options
 * @param {string} options.rawReport Full inspection report string from the UI.
 * @param {string} [options.buildingName] Display name for the prompt.
 * @param {"concise"|"standard"|"detailed"} [options.verbosity="standard"] Length hint (server-side).
 * @param {number} options.minDoorWidth Minimum clear door width (inches).
 * @param {number} options.minSlopeRatio Minimum acceptable ramp ratio 1:X (run:rise).
 * @param {number} options.minDoorHeight Minimum clear door height (inches).
 * @param {number} options.minPathwayWidth Minimum pathway width (inches).
 * @param {number|null} options.latestDoorWidth Observed door width (inches), or null if unknown.
 * @param {number|null} options.latestRampAngle Observed ramp angle (degrees).
 * @param {number|null} options.latestSlopeRatio Derived 1:X ratio from angle (matches `App.jsx` math).
 * @param {number|null} options.latestDoorHeight Observed door height when captured.
 * @param {number|null} options.latestPathwayWidth Observed pathway width when captured.
 * @returns {Promise<string>} User-facing string prefixed with `Summary:\n`.
 */
export async function generateAiSummary({
  rawReport,
  buildingName,
  verbosity = "standard",
  minDoorWidth,
  minSlopeRatio,
  minDoorHeight,
  minPathwayWidth,
  latestDoorWidth,
  latestRampAngle,
  latestSlopeRatio,
  latestDoorHeight,
  latestPathwayWidth
}) {
  const text = await postAiRequest("/api/ai/summary", {
    rawReport,
    buildingName,
    verbosity,
    minDoorWidth,
    minSlopeRatio,
    minDoorHeight,
    minPathwayWidth,
    latestDoorWidth,
    latestRampAngle,
    latestSlopeRatio,
    latestDoorHeight,
    latestPathwayWidth
  });
  return `Summary:\n${text || "Summary unavailable."}`;
}

/**
 * Generate a narrative website accessibility report from axe scan results (violations + counts).
 *
 * @param {object} options
 * @param {string} options.url Scanned page URL.
 * @param {unknown[]} [options.violations] Subset of axe violations (serialized).
 * @param {Record<string, unknown>} [options.counts] Pass/fail/incomplete counts from scan.
 * @returns {Promise<string>} Plain text report or fallback message.
 */
export async function generateAiWebsiteReport({
  url,
  violations,
  counts
}) {
  const text = await postAiRequest("/api/ai/website-report", {
    url,
    counts,
    violations
  });
  return text || "Website report unavailable.";
}
