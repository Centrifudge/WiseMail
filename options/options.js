const PROVIDER_DEFAULTS = {
  google: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  custom: "",
};

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";
const DEFAULT_SYSTEM_PROMPT =
  globalThis.WISEMAIL_DEFAULT_SYSTEM_PROMPT ||
  globalThis.WISEMAIL_SYSTEM_PROMPT ||
  "";
const DEFAULT_SKILLS = Array.isArray(globalThis.WISEMAIL_DEFAULT_SKILLS)
  ? globalThis.WISEMAIL_DEFAULT_SKILLS
  : [];
const JURISDICTIONS = Array.isArray(globalThis.WISEMAIL_JURISDICTION_OPTIONS)
  ? globalThis.WISEMAIL_JURISDICTION_OPTIONS
  : [
      { value: "FR", label: "France" },
      { value: "EU", label: "European Union" },
      { value: "US", label: "United States" },
      { value: "UK", label: "United Kingdom" },
      { value: "AU", label: "Australia" },
      { value: "Global", label: "Global / Cross-border" },
    ];

const LEGACY_MODEL_ALIASES = {
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
};

const PROVIDER_FOR_MODEL = {
  "gemini-3.1-flash-lite-preview": "google",
  "gemini-3.1-pro-preview": "google",
  "gemini-3-flash-preview": "google",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "gemini-2.5-flash-lite": "google",
  "gemini-2.0-flash": "google",
  "gemini-2.0-flash-lite": "google",
  "gemini-3.1-flash-lite": "google",
  "gemini-3-flash": "google",
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "o3": "openai",
  "claude-sonnet-4-6": "anthropic",
  "claude-opus-4-6": "anthropic",
};

let currentProvider = "google";
let skillsState = [];

function normalizeModelName(model = DEFAULT_MODEL) {
  return LEGACY_MODEL_ALIASES[model] || model;
}

function normalizeEndpointTemplate(endpoint = "") {
  let normalized = endpoint;
  for (const [legacyModel, currentModel] of Object.entries(LEGACY_MODEL_ALIASES)) {
    normalized = normalized.split(legacyModel).join(currentModel);
  }
  return normalized;
}

function shouldNormalizeGoogleSettings(provider, endpoint) {
  return provider === "google" || endpoint.includes("generativelanguage.googleapis.com");
}

function normalizeJurisdiction(code = "") {
  const normalized = String(code || "").trim();
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  if (upper === "GLOBAL") return "Global";
  return JURISDICTIONS.some((item) => item.value === upper) ? upper : "";
}

function normalizeSkill(skill, index = 0) {
  return {
    id: String(skill?.id || `skill-${index}`),
    name: String(skill?.name || `Skill ${index + 1}`).trim(),
    type: skill?.type === "policy" ? "policy" : "law",
    builtin: !!skill?.builtin,
    enabled: skill?.enabled !== false,
    alwaysApply: !!skill?.alwaysApply,
    jurisdictions: [...new Set(
      (Array.isArray(skill?.jurisdictions) ? skill.jurisdictions : [])
        .map(normalizeJurisdiction)
        .filter(Boolean)
    )],
    summary: String(skill?.summary || "").trim(),
    content: String(skill?.content || "").trim(),
  };
}

function mergeSkillsWithDefaults(storedSkills) {
  const defaults = DEFAULT_SKILLS.map((skill, index) => normalizeSkill(skill, index));
  if (!Array.isArray(storedSkills) || !storedSkills.length) {
    return JSON.parse(JSON.stringify(defaults));
  }

  const normalizedStored = storedSkills.map((skill, index) => normalizeSkill(skill, index));
  const storedById = new Map(normalizedStored.map((skill) => [skill.id, skill]));
  const merged = defaults.map((defaultSkill) => {
    const saved = storedById.get(defaultSkill.id);
    return saved ? { ...defaultSkill, ...saved } : defaultSkill;
  });

  for (const skill of normalizedStored) {
    if (!merged.some((item) => item.id === skill.id)) {
      merged.push(skill);
    }
  }

  return merged;
}

function createSkillId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function flashSavedMessage(text = "✓ Settings saved") {
  const msg = document.getElementById("saved-msg");
  msg.textContent = text;
  msg.style.opacity = "1";
  clearTimeout(flashSavedMessage.timeoutId);
  flashSavedMessage.timeoutId = setTimeout(() => {
    msg.style.opacity = "0";
  }, 2500);
}

function setActiveProviderTab(provider) {
  document.querySelectorAll(".provider-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
}

function toggleCustomModel(show) {
  document.getElementById("custom-model-wrap").classList.toggle("hidden", !show);
}

function populateJurisdictionSelect(selectId, { allowEmpty = false } = {}) {
  const select = document.getElementById(selectId);
  select.innerHTML = [
    allowEmpty ? `<option value="">Auto / infer from recipient domain</option>` : "",
    ...JURISDICTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`),
  ].join("");
}

function renderSkillJurisdictionCheckboxes() {
  const container = document.getElementById("skill-jurisdictions");
  container.innerHTML = JURISDICTIONS.map((item) => `
    <label class="checkbox-chip">
      <input type="checkbox" name="skill-jurisdiction" value="${item.value}">
      <span>${item.label}</span>
    </label>
  `).join("");
}

function setSkillJurisdictionSelection(values = []) {
  const selected = new Set(values);
  document.querySelectorAll('input[name="skill-jurisdiction"]').forEach((checkbox) => {
    checkbox.checked = selected.has(checkbox.value);
  });
}

function getSelectedSkillJurisdictions() {
  return [...document.querySelectorAll('input[name="skill-jurisdiction"]:checked')].map(
    (checkbox) => checkbox.value
  );
}

function renderSkills() {
  const container = document.getElementById("skills-list");
  if (!skillsState.length) {
    container.innerHTML = `<div class="empty-state">No skills configured.</div>`;
    return;
  }

  container.innerHTML = skillsState.map((skill) => {
    const tags = [
      `<span class="mini-tag">${skill.type}</span>`,
      skill.enabled ? `<span class="mini-tag mini-tag-live">enabled</span>` : `<span class="mini-tag">disabled</span>`,
      skill.alwaysApply ? `<span class="mini-tag">always include</span>` : "",
      skill.builtin ? `<span class="mini-tag">built-in</span>` : `<span class="mini-tag">custom</span>`,
      ...skill.jurisdictions.map((jurisdiction) => `<span class="mini-tag">${jurisdiction}</span>`),
    ].filter(Boolean).join("");

    return `
      <div class="skill-card ${skill.enabled ? "" : "skill-card-muted"}">
        <div class="skill-card-top">
          <div>
            <div class="skill-card-title">${escapeHtml(skill.name)}</div>
            <p class="skill-card-summary">${escapeHtml(skill.summary || "No summary provided.")}</p>
          </div>
          <div class="skill-card-actions">
            <button class="ghost-btn" data-skill-action="toggle" data-skill-id="${escapeHtml(skill.id)}">
              ${skill.enabled ? "Disable" : "Enable"}
            </button>
            <button class="ghost-btn" data-skill-action="edit" data-skill-id="${escapeHtml(skill.id)}">Edit</button>
            <button class="ghost-btn" data-skill-action="duplicate" data-skill-id="${escapeHtml(skill.id)}">Duplicate</button>
            ${skill.builtin ? "" : `<button class="ghost-btn danger-btn" data-skill-action="delete" data-skill-id="${escapeHtml(skill.id)}">Delete</button>`}
          </div>
        </div>
        <div class="skill-meta">${tags}</div>
      </div>
    `;
  }).join("");
}

function resetSkillForm() {
  document.getElementById("skillId").value = "";
  document.getElementById("skillName").value = "";
  document.getElementById("skillType").value = "policy";
  document.getElementById("skillSummary").value = "";
  document.getElementById("skillContent").value = "";
  document.getElementById("skillEnabled").checked = true;
  document.getElementById("skillAlwaysApply").checked = true;
  setSkillJurisdictionSelection([]);
  document.getElementById("skill-form-title").textContent = "Create / Update Skill";
  document.getElementById("skill-save-btn").textContent = "Add Skill";
}

function populateSkillForm(skill) {
  document.getElementById("skillId").value = skill.id;
  document.getElementById("skillName").value = skill.name;
  document.getElementById("skillType").value = skill.type;
  document.getElementById("skillSummary").value = skill.summary;
  document.getElementById("skillContent").value = skill.content;
  document.getElementById("skillEnabled").checked = skill.enabled;
  document.getElementById("skillAlwaysApply").checked = skill.alwaysApply;
  setSkillJurisdictionSelection(skill.jurisdictions);
  document.getElementById("skill-form-title").textContent = `Edit Skill: ${skill.name}`;
  document.getElementById("skill-save-btn").textContent = "Update Skill";
}

function readSkillForm() {
  const skillId = document.getElementById("skillId").value.trim();
  const existingSkill = skillsState.find((skill) => skill.id === skillId);

  return normalizeSkill({
    id: skillId || createSkillId(),
    builtin: existingSkill?.builtin || false,
    name: document.getElementById("skillName").value.trim(),
    type: document.getElementById("skillType").value,
    summary: document.getElementById("skillSummary").value.trim(),
    content: document.getElementById("skillContent").value.trim(),
    enabled: document.getElementById("skillEnabled").checked,
    alwaysApply: document.getElementById("skillAlwaysApply").checked,
    jurisdictions: getSelectedSkillJurisdictions(),
  }, skillsState.length);
}

async function saveAllSettings(message = "✓ Settings saved") {
  const modelSelect = document.getElementById("modelPreset");
  const rawModelVal = modelSelect.value === "custom"
    ? document.getElementById("customModel").value.trim()
    : modelSelect.value;
  const rawEndpointVal = document.getElementById("endpoint").value.trim();
  const useSavedGoogleNormalization = shouldNormalizeGoogleSettings(currentProvider, rawEndpointVal);
  const modelVal = useSavedGoogleNormalization ? normalizeModelName(rawModelVal) : rawModelVal;
  const endpointVal = useSavedGoogleNormalization
    ? normalizeEndpointTemplate(rawEndpointVal)
    : rawEndpointVal;

  await browser.storage.local.set({
    apiKey: document.getElementById("apiKey").value.trim(),
    endpoint: endpointVal,
    provider: currentProvider,
    model: modelVal,
    customModel: document.getElementById("customModel").value.trim(),
    jurisdiction: document.getElementById("jurisdiction").value,
    counterpartyJurisdiction: document.getElementById("counterpartyJurisdiction").value,
    autoScan: document.getElementById("autoScan").checked,
    showPanel: document.getElementById("showPanel").checked,
    systemPrompt: document.getElementById("systemPrompt").value.trim(),
    skills: skillsState,
  });

  flashSavedMessage(message);
}

document.addEventListener("DOMContentLoaded", async () => {
  populateJurisdictionSelect("jurisdiction");
  populateJurisdictionSelect("counterpartyJurisdiction", { allowEmpty: true });
  renderSkillJurisdictionCheckboxes();

  const settings = await browser.storage.local.get([
    "apiKey",
    "endpoint",
    "provider",
    "model",
    "customModel",
    "jurisdiction",
    "counterpartyJurisdiction",
    "autoScan",
    "showPanel",
    "systemPrompt",
    "skills",
  ]);

  if (settings.apiKey) {
    document.getElementById("apiKey").value = settings.apiKey;
  }
  document.getElementById("jurisdiction").value = normalizeJurisdiction(settings.jurisdiction) || "FR";
  document.getElementById("counterpartyJurisdiction").value = normalizeJurisdiction(settings.counterpartyJurisdiction);
  document.getElementById("autoScan").checked = settings.autoScan !== false;
  document.getElementById("showPanel").checked = settings.showPanel !== false;
  document.getElementById("systemPrompt").value = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  currentProvider = settings.provider || "google";
  setActiveProviderTab(currentProvider);

  const rawEndpoint = settings.endpoint || PROVIDER_DEFAULTS[currentProvider];
  const rawModel = settings.model || DEFAULT_MODEL;
  const useGoogleNormalization = shouldNormalizeGoogleSettings(currentProvider, rawEndpoint);
  const savedEndpoint = useGoogleNormalization ? normalizeEndpointTemplate(rawEndpoint) : rawEndpoint;
  const savedModel = useGoogleNormalization ? normalizeModelName(rawModel) : rawModel;

  document.getElementById("endpoint").value = savedEndpoint;

  const modelSelect = document.getElementById("modelPreset");
  const knownValues = Array.from(modelSelect.options).map((option) => option.value);
  if (knownValues.includes(savedModel)) {
    modelSelect.value = savedModel;
  } else {
    modelSelect.value = "custom";
    document.getElementById("customModel").value = savedModel;
  }
  toggleCustomModel(modelSelect.value === "custom");

  if (settings.customModel) {
    document.getElementById("customModel").value = settings.customModel;
  }

  skillsState = mergeSkillsWithDefaults(settings.skills);
  renderSkills();
  resetSkillForm();

  const migratedSettings = {};
  if (settings.model && settings.model !== savedModel) {
    migratedSettings.model = savedModel;
  }
  if (settings.endpoint && settings.endpoint !== savedEndpoint) {
    migratedSettings.endpoint = savedEndpoint;
  }
  if (JSON.stringify(settings.skills || []) !== JSON.stringify(skillsState)) {
    migratedSettings.skills = skillsState;
  }
  if (Object.keys(migratedSettings).length > 0) {
    await browser.storage.local.set(migratedSettings);
  }

  document.getElementById("provider-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".provider-tab");
    if (!tab) return;
    currentProvider = tab.dataset.provider;
    setActiveProviderTab(currentProvider);
    document.getElementById("endpoint").value = PROVIDER_DEFAULTS[currentProvider] || "";
  });

  document.getElementById("reset-endpoint").addEventListener("click", () => {
    document.getElementById("endpoint").value = PROVIDER_DEFAULTS[currentProvider] || "";
  });

  modelSelect.addEventListener("change", () => {
    const value = modelSelect.value;
    toggleCustomModel(value === "custom");
    if (value !== "custom" && PROVIDER_FOR_MODEL[value]) {
      currentProvider = PROVIDER_FOR_MODEL[value];
      setActiveProviderTab(currentProvider);
      document.getElementById("endpoint").value = PROVIDER_DEFAULTS[currentProvider];
    }
  });

  document.getElementById("reset-system-prompt").addEventListener("click", () => {
    document.getElementById("systemPrompt").value = DEFAULT_SYSTEM_PROMPT;
  });

  document.getElementById("save-btn").addEventListener("click", async () => {
    await saveAllSettings("✓ Settings saved");
  });

  document.getElementById("skill-save-btn").addEventListener("click", async () => {
    const skill = readSkillForm();
    if (!skill.name || !skill.content) {
      flashSavedMessage("Skill name and content are required");
      return;
    }

    const existingIndex = skillsState.findIndex((item) => item.id === skill.id);
    if (existingIndex >= 0) {
      skillsState[existingIndex] = { ...skillsState[existingIndex], ...skill };
    } else {
      skillsState.push(skill);
    }

    renderSkills();
    populateSkillForm(skill);
    await saveAllSettings("✓ Skill saved");
  });

  document.getElementById("skill-cancel-btn").addEventListener("click", () => {
    resetSkillForm();
  });

  document.getElementById("restore-skills-btn").addEventListener("click", async () => {
    const customSkills = skillsState.filter((skill) => !skill.builtin);
    skillsState = mergeSkillsWithDefaults(customSkills);
    renderSkills();
    resetSkillForm();
    await saveAllSettings("✓ Built-in skills restored");
  });

  document.getElementById("skills-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-skill-action]");
    if (!button) return;

    const action = button.dataset.skillAction;
    const skillId = button.dataset.skillId;
    const skill = skillsState.find((item) => item.id === skillId);
    if (!skill) return;

    if (action === "edit") {
      populateSkillForm(skill);
      return;
    }

    if (action === "toggle") {
      skill.enabled = !skill.enabled;
      renderSkills();
      if (document.getElementById("skillId").value === skill.id) {
        populateSkillForm(skill);
      }
      await saveAllSettings("✓ Skill updated");
      return;
    }

    if (action === "duplicate") {
      const copy = {
        ...skill,
        id: createSkillId(),
        builtin: false,
        name: `${skill.name} Copy`,
      };
      skillsState.push(copy);
      renderSkills();
      populateSkillForm(copy);
      await saveAllSettings("✓ Skill duplicated");
      return;
    }

    if (action === "delete" && !skill.builtin) {
      skillsState = skillsState.filter((item) => item.id !== skill.id);
      renderSkills();
      if (document.getElementById("skillId").value === skill.id) {
        resetSkillForm();
      }
      await saveAllSettings("✓ Skill deleted");
    }
  });
});
