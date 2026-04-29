/**
 * api.js — AI provider callers for WiseMail
 *
 * Pure functions with no dependency on browser storage or other background scripts.
 * Loaded before background.js by the manifest.
 */

const FETCH_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGoogle(endpoint, apiKey, systemPrompt, userPrompt) {
  const url = `${endpoint}?key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 3072 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseAIResponse(raw);
}

async function callOpenAI(endpoint, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 3072,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return parseAIResponse(data.choices?.[0]?.message?.content || "");
}

async function callAnthropic(endpoint, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 3072,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return parseAIResponse(data.content?.[0]?.text || "");
}

function parseAIResponse(raw) {
  const cleaned = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  try {
    return { success: true, result: JSON.parse(cleaned) };
  } catch {
    return { error: "PARSE_ERROR", message: "Could not parse the AI response.", raw };
  }
}
