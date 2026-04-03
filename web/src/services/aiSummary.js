export async function generateOpenAiSummary({
  rawReport,
  buildingName,
  verbosity = "standard"
}) {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
  const model = import.meta.env.VITE_OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error("Missing VITE_OPENAI_API_KEY in .env.local");
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
Building: ${buildingName}

Report:
${rawReport}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const text =
    data.output_text ||
    data.output?.[0]?.content?.[0]?.text ||
    "Summary unavailable.";

  return `Summary:\n${text.trim()}`;
}
