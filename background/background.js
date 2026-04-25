/**
 * background.js — WiseMail service worker
 *
 * Responsibilities:
 * - load stored settings
 * - resolve the effective system prompt
 * - automatically select applicable compliance skills
 * - call the configured AI provider
 * - return parseable JSON to the content script
 */

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

const LEGACY_MODEL_ALIASES = {
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
};

const DEFAULT_SYSTEM_PROMPT =
  globalThis.WISEMAIL_DEFAULT_SYSTEM_PROMPT ||
  globalThis.WISEMAIL_SYSTEM_PROMPT ||
  "";
const SYSTEM_PROMPT_CONTRACT = globalThis.WISEMAIL_SYSTEM_PROMPT_CONTRACT || "";
const DEFAULT_SKILLS = Array.isArray(globalThis.WISEMAIL_DEFAULT_SKILLS)
  ? globalThis.WISEMAIL_DEFAULT_SKILLS
  : [];
const JURISDICTION_CODES = ["FR", "EU", "US", "UK", "AU", "Global"];

if (!DEFAULT_SYSTEM_PROMPT) {
  throw new Error("WiseMail default system prompt is missing.");
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeModelName(model = DEFAULT_MODEL) {
  return LEGACY_MODEL_ALIASES[model] || model;
}

function normalizeEndpointTemplate(endpoint = DEFAULT_ENDPOINT) {
  let normalized = endpoint;
  for (const [legacyModel, currentModel] of Object.entries(LEGACY_MODEL_ALIASES)) {
    normalized = normalized.split(legacyModel).join(currentModel);
  }
  return normalized;
}

function shouldNormalizeGoogleSettings(provider, endpoint) {
  return provider === "google" || endpoint.includes("generativelanguage.googleapis.com");
}

function normalizeJurisdictionCode(code = "") {
  const normalized = String(code || "").trim();
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (upper === "GLOBAL") return "Global";
  return JURISDICTION_CODES.includes(upper) ? upper : "";
}

function normalizeSkill(skill, index = 0) {
  const normalizedType = skill?.type === "policy" ? "policy" : "law";
  const rawJurisdictions = Array.isArray(skill?.jurisdictions) ? skill.jurisdictions : [];
  const jurisdictions = [...new Set(
    rawJurisdictions
      .map(normalizeJurisdictionCode)
      .filter(Boolean)
  )];

  return {
    id: String(skill?.id || `skill-${index}`),
    name: String(skill?.name || `Skill ${index + 1}`).trim(),
    type: normalizedType,
    builtin: !!skill?.builtin,
    enabled: skill?.enabled !== false,
    alwaysApply: !!skill?.alwaysApply,
    jurisdictions,
    summary: String(skill?.summary || "").trim(),
    content: String(skill?.content || "").trim(),
  };
}

function mergeSkillsWithDefaults(storedSkills) {
  const defaults = DEFAULT_SKILLS.map((skill, index) => normalizeSkill(skill, index));
  if (!Array.isArray(storedSkills) || !storedSkills.length) {
    return cloneJSON(defaults);
  }

  const normalizedStored = storedSkills.map((skill, index) => normalizeSkill(skill, index));
  const storedById = new Map(normalizedStored.map((skill) => [skill.id, skill]));
  const merged = defaults.map((defaultSkill) => {
    const savedSkill = storedById.get(defaultSkill.id);
    return savedSkill ? { ...defaultSkill, ...savedSkill } : defaultSkill;
  });

  for (const skill of normalizedStored) {
    if (!merged.some((item) => item.id === skill.id)) {
      merged.push(skill);
    }
  }

  return merged;
}

function inferJurisdictionFromEmail(email = "") {
  const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
  if (!domain) return "";
  if (domain.endsWith(".fr")) return "FR";
  if (domain.endsWith(".eu")) return "EU";
  if (domain.endsWith(".us")) return "US";
  if (domain.endsWith(".co.uk") || domain.endsWith(".uk")) return "UK";
  if (domain.endsWith(".com.au") || domain.endsWith(".au")) return "AU";
  return "";
}

function expandJurisdictions(codes) {
  const expanded = new Set();
  for (const rawCode of codes) {
    const code = normalizeJurisdictionCode(rawCode);
    if (!code) continue;
    expanded.add(code);
    if (code === "FR") {
      expanded.add("EU");
    }
    if (code === "Global") {
      JURISDICTION_CODES.forEach((value) => expanded.add(value));
    }
  }
  return [...expanded];
}

function resolveApplicableContext(settings, runtimeJurisdiction, recipientEmail) {
  const primaryJurisdiction =
    normalizeJurisdictionCode(runtimeJurisdiction) ||
    normalizeJurisdictionCode(settings.jurisdiction) ||
    "FR";
  const configuredCounterparty = normalizeJurisdictionCode(settings.counterpartyJurisdiction);
  const inferredCounterparty = inferJurisdictionFromEmail(recipientEmail);
  const counterpartyJurisdiction = configuredCounterparty || inferredCounterparty;
  const applicableJurisdictions = expandJurisdictions([
    primaryJurisdiction,
    counterpartyJurisdiction,
  ]);

  return {
    primaryJurisdiction,
    counterpartyJurisdiction,
    inferredCounterpartyJurisdiction: inferredCounterparty,
    applicableJurisdictions,
  };
}

function resolveApplicableSkills(skills, context) {
  const applicableJurisdictions = new Set(context.applicableJurisdictions);
  return skills
    .filter((skill) => skill.enabled && skill.content)
    .filter((skill) => {
      if (skill.alwaysApply) return true;
      if (skill.jurisdictions.includes("Global") && context.applicableJurisdictions.length > 1) {
        return true;
      }
      if (!skill.jurisdictions.length) return false;
      return skill.jurisdictions.some((jurisdiction) => applicableJurisdictions.has(jurisdiction));
    })
    .map((skill) => {
      const matchedJurisdictions = skill.jurisdictions.filter((jurisdiction) =>
        applicableJurisdictions.has(jurisdiction)
      );
      const reason = skill.alwaysApply
        ? "Always include this skill."
        : skill.jurisdictions.includes("Global") && context.applicableJurisdictions.length > 1
          ? `Cross-border context detected: ${context.applicableJurisdictions.join(", ")}`
        : `Matched jurisdictions: ${matchedJurisdictions.join(", ") || context.primaryJurisdiction}`;
      return {
        id: skill.id,
        name: skill.name,
        type: skill.type,
        jurisdictions: skill.jurisdictions,
        summary: skill.summary,
        content: skill.content,
        reason,
      };
    });
}

function buildSkillPrompt(skills) {
  if (!skills.length) {
    return "No external skills were selected. Use conservative financial compliance judgment.";
  }

  return skills.map((skill, index) => {
    const lines = [
      `[Skill ${index + 1}] ${skill.name}`,
      `Type: ${skill.type}`,
      `Why it applies: ${skill.reason}`,
    ];
    if (skill.summary) {
      lines.push(`Summary: ${skill.summary}`);
    }
    lines.push("Instructions:");
    lines.push(skill.content);
    return lines.join("\n");
  }).join("\n\n");
}

function resolveSystemPrompt(settings) {
  const promptBase = String(settings.systemPrompt || "").trim() || DEFAULT_SYSTEM_PROMPT;
  return [promptBase, SYSTEM_PROMPT_CONTRACT].filter(Boolean).join("\n\n");
}

async function getExtensionSettings() {
  const settings = await browser.storage.local.get([
    "apiKey",
    "jurisdiction",
    "counterpartyJurisdiction",
    "autoScan",
    "showPanel",
    "endpoint",
    "provider",
    "model",
    "systemPrompt",
    "skills",
  ]);

  const provider = settings.provider || "google";
  const rawModel = settings.model || DEFAULT_MODEL;
  const rawEndpoint = settings.endpoint || DEFAULT_ENDPOINT;
  const useGoogleNormalization = shouldNormalizeGoogleSettings(provider, rawEndpoint);
  const normalizedModel = useGoogleNormalization ? normalizeModelName(rawModel) : rawModel;
  const normalizedEndpoint = useGoogleNormalization ? normalizeEndpointTemplate(rawEndpoint) : rawEndpoint;
  const normalizedJurisdiction = normalizeJurisdictionCode(settings.jurisdiction) || "FR";
  const normalizedCounterparty = normalizeJurisdictionCode(settings.counterpartyJurisdiction);
  const mergedSkills = mergeSkillsWithDefaults(settings.skills);

  const migratedSettings = {};
  if (settings.model && settings.model !== normalizedModel) {
    migratedSettings.model = normalizedModel;
  }
  if (settings.endpoint && settings.endpoint !== normalizedEndpoint) {
    migratedSettings.endpoint = normalizedEndpoint;
  }
  if (settings.jurisdiction !== normalizedJurisdiction) {
    migratedSettings.jurisdiction = normalizedJurisdiction;
  }
  if ((settings.counterpartyJurisdiction || "") !== normalizedCounterparty) {
    migratedSettings.counterpartyJurisdiction = normalizedCounterparty;
  }
  if (JSON.stringify(settings.skills || []) !== JSON.stringify(mergedSkills)) {
    migratedSettings.skills = mergedSkills;
  }
  if (Object.keys(migratedSettings).length > 0) {
    await browser.storage.local.set(migratedSettings);
  }

  return {
    ...settings,
    provider,
    model: normalizedModel,
    endpoint: normalizedEndpoint,
    jurisdiction: normalizedJurisdiction,
    counterpartyJurisdiction: normalizedCounterparty,
    systemPrompt: settings.systemPrompt || "",
    skills: mergedSkills,
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "ANALYZE_EMAIL") {
    return analyzeEmail(
      message.emailText,
      message.jurisdiction,
      message.subjectText,
      message.recipientEmail,
      message.senderDomain,
      message.attachments || []
    );
  }
  if (message.type === "GET_SETTINGS") {
    return getExtensionSettings();
  }
  if (message.type === "OPEN_SETTINGS") {
    return browser.runtime.openOptionsPage();
  }
});

async function analyzeEmail(
  emailText,
  jurisdiction = "FR",
  subjectText = "",
  recipientEmail = "",
  senderDomain = "",
  attachments = []
) {
  const settings = await getExtensionSettings();
  const apiKey = settings.apiKey;
  const provider = settings.provider;
  const model = settings.model;
  const endpoint = settings.endpoint.replace("{model}", model);
  const systemPrompt = resolveSystemPrompt(settings);

  if (!apiKey) {
    return {
      error: "NO_API_KEY",
      message: "Please configure your API key in the extension settings.",
    };
  }

  const context = resolveApplicableContext(settings, jurisdiction, recipientEmail);
  const applicableSkills = resolveApplicableSkills(settings.skills, context);

  const contextLines = [
    `Primary sender jurisdiction: ${context.primaryJurisdiction}`,
    `Counterparty jurisdiction: ${context.counterpartyJurisdiction || "Unknown / not configured"}`,
    `All jurisdictions to apply cumulatively: ${context.applicableJurisdictions.join(", ")}`,
  ];

  if (subjectText) {
    contextLines.push(`Current subject: ${subjectText}`);
  }
  if (recipientEmail) {
    contextLines.push(`Recipient email: ${recipientEmail}`);
  }
  if (senderDomain) {
    contextLines.push(`Sender domain: ${senderDomain}`);
  }
  if (context.inferredCounterpartyJurisdiction && !settings.counterpartyJurisdiction) {
    contextLines.push(`Counterparty jurisdiction was inferred from recipient domain: ${context.inferredCounterpartyJurisdiction}`);
  }

  // Build attachment section: include extracted text or flag read errors
  const attachmentLines = [];
  if (attachments.length > 0) {
    attachmentLines.push("Attached documents:");
    for (const att of attachments) {
      attachmentLines.push(`--- [${att.name}] ---`);
      if (att.error) {
        attachmentLines.push(`ERROR: Could not read this attachment — ${att.error}. Flag this to the user with type ATTACHMENT_READ_ERROR.`);
      } else if (att.text) {
        attachmentLines.push(att.text.slice(0, 8000)); // cap at 8 k chars per attachment
      }
      attachmentLines.push("--- end attachment ---");
    }
  }

  const userPrompt = [
    "Analysis context:",
    ...contextLines,
    "",
    "Skills to apply (mandatory and cumulative):",
    buildSkillPrompt(applicableSkills),
    "",
    ...(attachmentLines.length ? [...attachmentLines, ""] : []),
    "Email to analyse:",
    "---",
    subjectText ? `Subject: ${subjectText}` : "",
    emailText,
    "---",
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n");

  try {
    let response;
    if (provider === "google") {
      response = await callGoogle(endpoint, apiKey, systemPrompt, userPrompt);
    } else if (provider === "openai") {
      response = await callOpenAI(endpoint, apiKey, model, systemPrompt, userPrompt);
    } else if (provider === "anthropic") {
      response = await callAnthropic(endpoint, apiKey, model, systemPrompt, userPrompt);
    } else {
      response = await callOpenAI(endpoint, apiKey, model, systemPrompt, userPrompt);
    }

    if (response.success && response.result) {
      response.result.appliedSkills = applicableSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        type: skill.type,
        reason: skill.reason,
      }));
      response.result.analysisContext = {
        primaryJurisdiction: context.primaryJurisdiction,
        counterpartyJurisdiction: context.counterpartyJurisdiction,
        applicableJurisdictions: context.applicableJurisdictions,
      };
    }

    return response;
  } catch (error) {
    return { error: "NETWORK_ERROR", message: error.message };
  }
}

async function callGoogle(endpoint, apiKey, systemPrompt, userPrompt) {
  const url = `${endpoint}?key=${apiKey}`;
  const res = await fetch(url, {
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
  return parseJSON(raw);
}

async function callOpenAI(endpoint, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch(endpoint, {
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
  return parseJSON(data.choices?.[0]?.message?.content || "");
}

async function callAnthropic(endpoint, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch(endpoint, {
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
  return parseJSON(data.content?.[0]?.text || "");
}

function parseJSON(raw) {
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
