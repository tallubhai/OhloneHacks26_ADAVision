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
