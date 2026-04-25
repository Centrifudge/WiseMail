// background.js — multi-provider Gemini/OpenAI/Anthropic API handler

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const DEFAULT_MODEL    = "gemini-3.1-pro-preview";

const SYSTEM_PROMPT = `You are ComplianceGuard, an expert in global financial regulatory compliance including MiFID II (EU), SEC regulations (USA), FCA rules (UK), GDPR (EU data privacy), FINRA, and ASIC (Australia).

Analyze the following financial email for compliance issues. Return ONLY a valid JSON object (no markdown, no code blocks) with this exact structure:

{
  "riskScore": <0-100 integer>,
  "issues": [
    {
      "type": "DISCLAIMER_MISSING" | "GDPR_VIOLATION" | "MISLEADING_CLAIM" | "PAST_PERFORMANCE" | "UNSUBSTANTIATED_CLAIM" | "REGULATORY_BREACH" | "DATA_PRIVACY",
      "severity": "critical" | "warning" | "info",
      "description": "<short human-readable explanation>",
      "quote": "<exact text from email that triggered this, or empty string>",
      "regulation": "<regulation name e.g. MiFID II Art. 24, SEC Rule 156, GDPR Art. 6>"
    }
  ],
  "requiredDisclaimers": [
    {
      "id": "<unique short id>",
      "text": "<full disclaimer text to append>",
      "regulation": "<regulation name>",
      "jurisdiction": "<EU|US|UK|AU|Global>"
    }
  ],
  "summary": "<one sentence summary of overall compliance status>"
}

Be thorough. Flag:
- Any mention of past performance without the standard disclaimer
- Guarantees or predictions of returns
- Missing risk warnings
- Any personal data mentioned (names, emails, account numbers) that may be a GDPR concern
- Misleading or unsubstantiated claims
- Missing required regulatory disclosures
`;

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "ANALYZE_EMAIL") return analyzeEmail(message.emailText, message.jurisdiction);
  if (message.type === "GET_SETTINGS")   return browser.storage.local.get(["apiKey", "jurisdiction", "autoScan", "endpoint", "provider", "model"]);
});

async function analyzeEmail(emailText, jurisdiction = "EU") {
  const settings = await browser.storage.local.get(["apiKey", "endpoint", "provider", "model"]);

  const apiKey   = settings.apiKey;
  const provider = settings.provider || "google";
  const model    = settings.model    || DEFAULT_MODEL;
  const endpoint = (settings.endpoint || DEFAULT_ENDPOINT).replace("{model}", model);

  if (!apiKey) {
    return { error: "NO_API_KEY", message: "Please configure your API key in the extension settings." };
  }

  const userPrompt = `Jurisdiction context: ${jurisdiction}\n\nEmail to analyze:\n---\n${emailText}\n---`;

  try {
    let response;

    if (provider === "google") {
      response = await callGoogle(endpoint, apiKey, userPrompt);
    } else if (provider === "openai") {
      response = await callOpenAI(endpoint, apiKey, model, userPrompt);
    } else if (provider === "anthropic") {
      response = await callAnthropic(endpoint, apiKey, model, userPrompt);
    } else {
      // Custom — try OpenAI-compatible format as default
      response = await callOpenAI(endpoint, apiKey, model, userPrompt);
    }

    return response;
  } catch (e) {
    return { error: "NETWORK_ERROR", message: e.message };
  }
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGoogle(endpoint, apiKey, userPrompt) {
  const url = `${endpoint}?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseJSON(raw);
}

// ── OpenAI / OpenAI-compatible ────────────────────────────────────────────────
async function callOpenAI(endpoint, apiKey, model, userPrompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 2048,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || "";
  return parseJSON(raw);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function callAnthropic(endpoint, apiKey, model, userPrompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  const raw  = data.content?.[0]?.text || "";
  return parseJSON(raw);
}

// ── JSON parser ───────────────────────────────────────────────────────────────
function parseJSON(raw) {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return { success: true, result: JSON.parse(cleaned) };
  } catch {
    return { error: "PARSE_ERROR", message: "Could not parse AI response.", raw };
  }
}
