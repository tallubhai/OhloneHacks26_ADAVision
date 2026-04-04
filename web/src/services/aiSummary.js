async function postAiRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = payload?.details ? ` ${payload.details}` : "";
    throw new Error(`${payload?.error || "AI request failed."}${details}`);
  }

  return String(payload?.text || "").trim();
}

export async function generateAiSummary({
  rawReport,
  buildingName,
  verbosity = "standard"
}) {
  const text = await postAiRequest("/api/ai/summary", {
    rawReport,
    buildingName,
    verbosity
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
