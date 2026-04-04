import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { createRequire } from "module";

const app = express();
const port = 8787;
const require = createRequire(import.meta.url);
const axeScriptPath = require.resolve("axe-core/axe.min.js");
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "llama3.2:3b";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ada-vision-api",
    aiProvider: "ollama",
    ollamaModel
  });
});

async function runOllamaPrompt(prompt) {
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
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return String(data.response || "").trim();
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED" || String(error.message || "").includes("fetch failed")) {
      throw new Error(
        "Cannot reach Ollama at http://127.0.0.1:11434. Start Ollama app and run: ollama pull llama3.2:3b"
      );
    }
    throw error;
  }
}

app.post("/api/ai/summary", async (req, res) => {
  const { rawReport, buildingName, verbosity = "standard" } = req.body ?? {};
  if (!rawReport || typeof rawReport !== "string") {
    return res.status(400).json({ error: "rawReport is required." });
  }

  const verbosityGuide =
    verbosity === "concise"
      ? "Use 2 short sentences."
      : verbosity === "detailed"
        ? "Use 4-6 sentences with clear recommendations."
        : "Use 3-4 sentences in plain English.";

  const prompt = `You are an ADA compliance assistant.
Summarize the inspection report into plain English.
${verbosityGuide}
Mention pass/fail status for ramp and door, and next action if non-compliant.
Building: ${buildingName || "Unknown building"}

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
    const axeResults = await page.evaluate(async () => {
      return window.axe.run(document);
    });
    const violations = axeResults.violations.map(normalizeViolation);
    const failedChecks = axeResults.violations.map(normalizeRuleResult);
    const passedChecks = axeResults.passes.map(normalizeRuleResult);

    return res.json({
      url: targetUrl,
      scannedAt: new Date().toISOString(),
      counts: {
        violations: axeResults.violations.length,
        passes: axeResults.passes.length,
        incomplete: axeResults.incomplete.length,
        inapplicable: axeResults.inapplicable.length
      },
      failedChecks,
      passedChecks,
      violations
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
  console.log(`Axe scan API running on http://localhost:${port}`);
});
