/**
 * @file ADA Vision local API (Express).
 * @summary Backend for sensor ingest, latest-reading polling, Ollama-backed AI summaries, and axe website scans.
 *
 * @description
 * - {@link POST /api/sensors/ingest} — Accepts normalized readings from `pyBridge/bluetooth_to_localhost.py`.
 * - {@link GET /api/sensors/latest} — Returns last ingested reading for the web app poll loop.
 * - {@link POST /api/ai/summary} — Builds a grounded prompt (numeric pass/fail facts) and calls Ollama.
 * - {@link POST /api/ai/website-report} — Plain-language accessibility narrative from scan results.
 * - {@link POST /api/websites/scan} — Puppeteer + axe-core against a target URL.
 *
 * Environment:
 * - `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
 * - `OLLAMA_MODEL` (default `qwen2.5:0.5b`)
 */

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { createRequire } from "module";

const app = express();
const port = 8787;
const require = createRequire(import.meta.url);
const axeScriptPath = require.resolve("axe-core/axe.min.js");
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
/** @type {object | null} Last successful {@link POST /api/sensors/ingest} payload (in-memory). */
let latestSensorReading = null;
const HIGH_CONFIDENCE_IMPACTS = new Set(["serious", "critical"]);
const SUPPRESSED_RULE_IDS = new Set([
  "color-contrast",
  "landmark-one-main",
  "aria-required-children"
]);

/**
 * Stable key for comparing rule presence across repeated scans.
 * @param {import("axe-core").Result} rule
 * @returns {string}
 */
function ruleStabilityKey(rule) {
  const impact = String(rule?.impact || "none").toLowerCase();
  return `${String(rule?.id || "").toLowerCase()}::${impact}`;
}

/**
 * Suppress known noisy rules in demo mode so pass/fail focuses on high-confidence blockers.
 * @param {import("axe-core").Result} rule
 * @returns {boolean}
 */
function isSuppressedRule(rule) {
  return SUPPRESSED_RULE_IDS.has(String(rule?.id || "").toLowerCase());
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * Shapes one axe violation for the client / AI prompts.
 * @param {import("axe-core").Result} violation
 * @returns {object}
 */
function normalizeViolation(violation) {
  return {
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary
    }))
  };
}

/**
 * Compact rule summary (pass or fail bucket) with element counts.
 * @param {import("axe-core").Result} rule
 * @returns {object}
 */
function normalizeRuleResult(rule) {
  return {
    id: rule.id,
    impact: rule.impact || "none",
    description: rule.description,
    help: rule.help,
    helpUrl: rule.helpUrl,
    affectedElements: Array.isArray(rule.nodes) ? rule.nodes.length : 0
  };
}

/**
 * Flatten grouped check buckets into a single list with status labels.
 * @param {object} args
 * @param {Array<object>} args.failedChecks
 * @param {Array<object>} args.advisoryChecks
 * @param {Array<object>} args.passedChecks
 * @param {Array<object>} args.incompleteChecks
 * @param {Array<object>} args.inapplicableChecks
 * @returns {Array<object>}
 */
function buildAllChecks({
  failedChecks,
  advisoryChecks,
  passedChecks,
  incompleteChecks,
  inapplicableChecks
}) {
  return [
    ...failedChecks.map((item) => ({ ...item, status: "failed_high_confidence" })),
    ...advisoryChecks.map((item) => ({ ...item, status: "advisory" })),
    ...passedChecks.map((item) => ({ ...item, status: "passed" })),
    ...incompleteChecks.map((item) => ({ ...item, status: "incomplete" })),
    ...inapplicableChecks.map((item) => ({ ...item, status: "inapplicable" }))
  ];
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ada-vision-api",
    aiProvider: "ollama",
    ollamaModel
  });
});

/**
 * POST to Ollama `/api/generate` with low temperature; 45s abort.
 * @param {string} prompt Full user/system prompt text.
 * @returns {Promise<string>} Trimmed model response text.
 * @throws {Error} On HTTP errors, timeouts, or unreachable Ollama.
 */
async function runOllamaPrompt(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.2
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return String(data.response || "").trim();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Ollama request timed out after 45 seconds.");
    }
    if (error?.cause?.code === "ECONNREFUSED" || String(error.message || "").includes("fetch failed")) {
      throw new Error(
        `Cannot reach Ollama at ${ollamaBaseUrl}. Start Ollama app and run: ollama pull ${ollamaModel}`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * AI compliance summary: injects computed door/ramp pass-fail so the model cannot contradict measurements.
 *
 * Request body:
 * - `rawReport` (string, required) — inspection text from the app.
 * - `buildingName`, `verbosity` — tune output length.
 * - `minDoorWidth`, `minSlopeRatio`, `minDoorHeight`, `minPathwayWidth` — ADA thresholds from UI.
 * - Latest observed door/ramp/height/pathway values — grounding for the model.
 */
app.post("/api/ai/summary", async (req, res) => {
  const {
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
  } = req.body ?? {};
  if (!rawReport || typeof rawReport !== "string") {
    return res.status(400).json({ error: "rawReport is required." });
  }

  /** @param {unknown} value */
  const toNumberOrNull = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const ruleDoorWidth = toNumberOrNull(minDoorWidth);
  const ruleSlopeRatio = toNumberOrNull(minSlopeRatio);
  const ruleDoorHeight = toNumberOrNull(minDoorHeight);
  const rulePathwayWidth = toNumberOrNull(minPathwayWidth);
  const observedDoorWidth = toNumberOrNull(latestDoorWidth);
  const observedRampAngle = toNumberOrNull(latestRampAngle);
  const observedSlopeRatio = toNumberOrNull(latestSlopeRatio);
  const observedDoorHeight = toNumberOrNull(latestDoorHeight);
  const observedPathwayWidth = toNumberOrNull(latestPathwayWidth);

  // Door: wider is better — pass when observed >= minimum clear width.
  const doorPass =
    ruleDoorWidth != null && observedDoorWidth != null ? observedDoorWidth >= ruleDoorWidth : null;
  // Ramp: ratio is run:rise as 1:X — larger X is flatter/better — pass when observed >= minimum.
  const rampPass =
    ruleSlopeRatio != null && observedSlopeRatio != null ? observedSlopeRatio >= ruleSlopeRatio : null;
  // Taller opening / wider path are better — same ">=" pattern as door width.
  const doorHeightPass =
    ruleDoorHeight != null && observedDoorHeight != null ? observedDoorHeight >= ruleDoorHeight : null;
  const pathwayPass =
    rulePathwayWidth != null && observedPathwayWidth != null
      ? observedPathwayWidth >= rulePathwayWidth
      : null;

  const verbosityGuide =
    verbosity === "concise"
      ? "Use 2 short sentences."
      : verbosity === "detailed"
        ? "Use 4-6 sentences with clear recommendations."
        : "Use 3-4 sentences in plain English.";

  const prompt = `You are an ADA compliance assistant.
Summarize the inspection report into plain English for a student demo.
${verbosityGuide}
CRITICAL RULES:
- Door compliance rule: PASS if door width >= minimum door width; FAIL if door width is below minimum.
- Ramp compliance rule: PASS if ramp ratio (run:rise, 1:X) is >= minimum ratio; FAIL if ratio is below minimum.
- Door height rule: PASS if clear opening height >= minimum door height; FAIL if lower.
- Pathway rule: PASS if clear pathway width >= minimum pathway width; FAIL if lower.
- Do not contradict the numeric facts provided below.
- If either check fails, clearly say "Non-compliant".
- If both checks pass, clearly say "Compliant".

Building: ${buildingName || "Unknown building"}
Minimum door width (in): ${ruleDoorWidth ?? "unknown"}
Minimum ramp ratio (1:X): ${ruleSlopeRatio ?? "unknown"}
Minimum door height (in): ${ruleDoorHeight ?? "unknown"}
Minimum pathway width (in): ${rulePathwayWidth ?? "unknown"}
Observed door width (in): ${observedDoorWidth ?? "unknown"}
Observed ramp angle (deg): ${observedRampAngle ?? "unknown"}
Observed ramp ratio (1:X): ${observedSlopeRatio ?? "unknown"}
Observed door height (in): ${observedDoorHeight ?? "unknown"}
Observed pathway width (in): ${observedPathwayWidth ?? "unknown"}
Computed door result: ${doorPass == null ? "unknown" : doorPass ? "PASS" : "FAIL"}
Computed ramp result: ${rampPass == null ? "unknown" : rampPass ? "PASS" : "FAIL"}
Computed door height result: ${doorHeightPass == null ? "unknown" : doorHeightPass ? "PASS" : "FAIL"}
Computed pathway result: ${pathwayPass == null ? "unknown" : pathwayPass ? "PASS" : "FAIL"}

Report:
${rawReport}`;

  try {
    const text = await runOllamaPrompt(prompt);
    return res.json({ text: text || "Summary unavailable." });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to generate AI summary.",
      details: error.message
    });
  }
});

/** Turn axe-style violation list into a structured plain-text report via Ollama. */
app.post("/api/ai/website-report", async (req, res) => {
  const { url, violations = [], counts = {} } = req.body ?? {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required." });
  }

  const prompt = `You are an accessibility consultant.
Write a detailed but easy-to-understand accessibility report in plain text.
Length target: 120-180 words.
Do not use markdown, code blocks, or backticks.
Use EXACT section headers and keep each section short:
Executive Summary:
What Passed:
What Failed:
Why It Matters:
Recommended Fixes:

Website: ${url}
Counts: ${JSON.stringify(counts)}
Violations: ${JSON.stringify(Array.isArray(violations) ? violations.slice(0, 15) : [])}`;

  try {
    const text = await runOllamaPrompt(prompt);
    return res.json({ text: text || "Website report unavailable." });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to generate website AI report.",
      details: error.message
    });
  }
});

/** Generate per-check explanations for detailed scan mode. */
app.post("/api/ai/website-detail-report", async (req, res) => {
  const { url, checks = [] } = req.body ?? {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required." });
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    return res.status(400).json({ error: "checks array is required." });
  }

  const sanitizedChecks = checks
    .map((item) => ({
      id: String(item?.id || ""),
      status: String(item?.status || "unknown"),
      impact: String(item?.impact || "none"),
      help: String(item?.help || ""),
      description: String(item?.description || ""),
      affectedElements: Number(item?.affectedElements || 0)
    }))
    .filter((item) => item.id);

  if (sanitizedChecks.length === 0) {
    return res.status(400).json({ error: "checks array has no valid entries." });
  }

  const chunkSize = 35;
  const chunks = [];
  for (let i = 0; i < sanitizedChecks.length; i += chunkSize) {
    chunks.push(sanitizedChecks.slice(i, i + chunkSize));
  }

  try {
    const sections = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const prompt = `You are an accessibility QA analyst.
Explain EACH check in the list with one short practical sentence.
Output format MUST be exactly one line per check:
<id> | <status> | <impact> | <explanation sentence>
Do not skip any checks. Keep same check order.
No markdown, no bullets, no numbering.

Website: ${url}
Chunk: ${index + 1} of ${chunks.length}
Checks:
${JSON.stringify(chunk)}`;

      const text = await runOllamaPrompt(prompt);
      sections.push(text || "");
    }

    return res.json({
      text: sections.join("\n").trim() || "Detailed AI explanation unavailable."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to generate detailed AI website report.",
      details: error.message
    });
  }
});

/**
 * Ingest one reading from the Python Bluetooth bridge. Validates ranges to match bridge rules.
 * Updates in-memory `latestSensorReading` for {@link GET /api/sensors/latest}.
 */
app.post("/api/sensors/ingest", (req, res) => {
  const { ramp_angle: rampAngleRaw, door_width: doorWidthRaw, source = "bluetooth-bridge", raw } = req.body ?? {};

  const rampAngle = Number(rampAngleRaw);
  const doorWidth = Number(doorWidthRaw);

  if (!Number.isFinite(rampAngle) || !Number.isFinite(doorWidth)) {
    return res.status(400).json({
      error: "Invalid payload. Expected numeric ramp_angle and door_width."
    });
  }

  if (rampAngle <= 0 || rampAngle >= 89.9) {
    return res.status(400).json({
      error: "ramp_angle must be between 0 and 89.9 degrees."
    });
  }

  if (doorWidth <= 0) {
    return res.status(400).json({
      error: "door_width must be positive."
    });
  }

  latestSensorReading = {
    id: Date.now(),
    receivedAt: new Date().toISOString(),
    rampAngle: Number(rampAngle.toFixed(2)),
    doorWidth: Number(doorWidth.toFixed(2)),
    source: String(source),
    raw: typeof raw === "string" ? raw : ""
  };

  return res.json({
    ok: true,
    reading: latestSensorReading
  });
});

/** Return the last ingested reading (may be `reading: null` if none yet). */
app.get("/api/sensors/latest", (_req, res) => {
  return res.json({
    ok: true,
    reading: latestSensorReading
  });
});

/** Headless Chromium: load URL, inject axe-core, return violations and pass summaries. */
app.post("/api/websites/scan", async (req, res) => {
  const { url } = req.body ?? {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A valid URL is required." });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url).toString();
  } catch (_error) {
    return res.status(400).json({ error: "Invalid URL format." });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: 45000
    });

    await page.addScriptTag({ path: axeScriptPath });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const axeResults = await page.evaluate(async () => {
      const options = {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa"]
        },
        resultTypes: ["violations", "passes", "incomplete", "inapplicable"]
      };

      const first = await window.axe.run(document, options);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const second = await window.axe.run(document, options);
      return { first, second };
    });

    const firstViolations = axeResults.first.violations || [];
    const secondViolationKeys = new Set(
      (axeResults.second.violations || []).map((rule) => ruleStabilityKey(rule))
    );

    const stableViolationsRaw = firstViolations.filter((rule) =>
      secondViolationKeys.has(ruleStabilityKey(rule))
    );
    const unstableViolationsRaw = firstViolations.filter(
      (rule) => !secondViolationKeys.has(ruleStabilityKey(rule))
    );

    const suppressedViolationsRaw = stableViolationsRaw.filter((rule) => isSuppressedRule(rule));
    const unsuppressedViolationsRaw = stableViolationsRaw.filter((rule) => !isSuppressedRule(rule));
    const highConfidenceViolationsRaw = unsuppressedViolationsRaw.filter((rule) =>
      HIGH_CONFIDENCE_IMPACTS.has(String(rule.impact || "").toLowerCase())
    );
    const advisoryViolationsRaw = unsuppressedViolationsRaw.filter(
      (rule) => !HIGH_CONFIDENCE_IMPACTS.has(String(rule.impact || "").toLowerCase())
    );

    const violations = highConfidenceViolationsRaw.map(normalizeViolation);
    const advisoryViolations = [
      ...advisoryViolationsRaw,
      ...suppressedViolationsRaw,
      ...unstableViolationsRaw
    ].map(normalizeViolation);
    const failedChecks = highConfidenceViolationsRaw.map(normalizeRuleResult);
    const advisoryChecks = [
      ...advisoryViolationsRaw,
      ...suppressedViolationsRaw,
      ...unstableViolationsRaw
    ].map(normalizeRuleResult);
    const suppressedChecks = suppressedViolationsRaw.map(normalizeRuleResult);
    const passedChecks = axeResults.first.passes.map(normalizeRuleResult);
    const incompleteChecks = (axeResults.first.incomplete || []).map(normalizeRuleResult);
    const inapplicableChecks = (axeResults.first.inapplicable || []).map(normalizeRuleResult);
    const allChecks = buildAllChecks({
      failedChecks,
      advisoryChecks,
      passedChecks,
      incompleteChecks,
      inapplicableChecks
    });

    return res.json({
      url: targetUrl,
      scannedAt: new Date().toISOString(),
      scoring: {
        mode: "high-confidence",
        details:
          "Only stable unsuppressed serious/critical WCAG 2 A/AA issues are counted as violations. Noisy or unstable findings are advisory."
      },
      counts: {
        violations: highConfidenceViolationsRaw.length,
        advisory: advisoryViolationsRaw.length + suppressedViolationsRaw.length + unstableViolationsRaw.length,
        suppressed: suppressedViolationsRaw.length,
        unstable: unstableViolationsRaw.length,
        passes: axeResults.first.passes.length,
        incomplete: axeResults.first.incomplete.length,
        inapplicable: axeResults.first.inapplicable.length
      },
      failedChecks,
      advisoryChecks,
      suppressedChecks,
      passedChecks,
      incompleteChecks,
      inapplicableChecks,
      allChecks,
      violations,
      advisoryViolations
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to scan website.",
      details: error.message
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(port, () => {
  // Single process holds sensor memory + spawns Puppeteer per scan; dev/demo use only.
  console.log(`Axe scan API running on http://localhost:${port}`);
});
