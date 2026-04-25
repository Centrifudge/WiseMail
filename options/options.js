// options.js

const PROVIDER_DEFAULTS = {
  google:    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  openai:    "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  custom:    ""
};

const PROVIDER_FOR_MODEL = {
  "gemini-3.1-flash-lite":       "google",
  "gemini-2.0-flash-lite":       "google",
  "gemini-3.1-pro-preview":      "google",
  "gemini-3-flash":              "google",
  "gemini-2.5-pro":              "google",
  "gemini-2.5-flash":            "google",
  "gemini-2.0-flash":            "google",
  "gpt-4o":                      "openai",
  "gpt-4o-mini":                 "openai",
  "o3":                          "openai",
  "claude-sonnet-4-6":           "anthropic",
  "claude-opus-4-6":             "anthropic",
};

let currentProvider = "google";

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await browser.storage.local.get([
    "apiKey", "endpoint", "provider", "model", "customModel",
    "jurisdiction", "autoScan", "showPanel"
  ]);

  // ── Restore saved values ──────────────────────────────────
  if (settings.apiKey)   document.getElementById("apiKey").value = settings.apiKey;
  if (settings.jurisdiction) document.getElementById("jurisdiction").value = settings.jurisdiction;
  document.getElementById("autoScan").checked  = !!settings.autoScan;
  document.getElementById("showPanel").checked = settings.showPanel !== false;

  // Provider tab
  currentProvider = settings.provider || "google";
  setActiveProviderTab(currentProvider);

  // Endpoint
  const savedEndpoint = settings.endpoint || PROVIDER_DEFAULTS[currentProvider];
  document.getElementById("endpoint").value = savedEndpoint;

  // Model
  const savedModel = settings.model || "gemini-3.1-flash-lite";
  const modelSelect = document.getElementById("modelPreset");
  const knownValues = Array.from(modelSelect.options).map(o => o.value);
  if (knownValues.includes(savedModel)) {
    modelSelect.value = savedModel;
  } else {
    modelSelect.value = "custom";
    document.getElementById("customModel").value = savedModel;
  }
  toggleCustomModel(modelSelect.value === "custom");

  if (settings.customModel) document.getElementById("customModel").value = settings.customModel;

  // ── Provider tab clicks ───────────────────────────────────
  document.getElementById("provider-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".provider-tab");
    if (!tab) return;
    const provider = tab.dataset.provider;
    currentProvider = provider;
    setActiveProviderTab(provider);
    // Only auto-fill endpoint if it still matches a known default (don't overwrite custom edits)
    document.getElementById("endpoint").value = PROVIDER_DEFAULTS[provider] || "";
  });

  // ── Reset endpoint button ─────────────────────────────────
  document.getElementById("reset-endpoint").addEventListener("click", () => {
    document.getElementById("endpoint").value = PROVIDER_DEFAULTS[currentProvider] || "";
  });

  // ── Model select ──────────────────────────────────────────
  modelSelect.addEventListener("change", () => {
    const val = modelSelect.value;
    toggleCustomModel(val === "custom");
    // Auto-switch provider tab when a preset model is chosen
    if (val !== "custom" && PROVIDER_FOR_MODEL[val]) {
      const p = PROVIDER_FOR_MODEL[val];
      currentProvider = p;
      setActiveProviderTab(p);
      document.getElementById("endpoint").value = PROVIDER_DEFAULTS[p];
    }
  });

  // ── Save ──────────────────────────────────────────────────
  document.getElementById("save-btn").addEventListener("click", async () => {
    const modelVal = modelSelect.value === "custom"
      ? document.getElementById("customModel").value.trim()
      : modelSelect.value;

    await browser.storage.local.set({
      apiKey:      document.getElementById("apiKey").value.trim(),
      endpoint:    document.getElementById("endpoint").value.trim(),
      provider:    currentProvider,
      model:       modelVal,
      customModel: document.getElementById("customModel").value.trim(),
      jurisdiction: document.getElementById("jurisdiction").value,
      autoScan:    document.getElementById("autoScan").checked,
      showPanel:   document.getElementById("showPanel").checked
    });

    const msg = document.getElementById("saved-msg");
    msg.style.opacity = "1";
    setTimeout(() => msg.style.opacity = "0", 2500);
  });
});

function setActiveProviderTab(provider) {
  document.querySelectorAll(".provider-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });
}

function toggleCustomModel(show) {
  document.getElementById("custom-model-wrap").classList.toggle("hidden", !show);
}
