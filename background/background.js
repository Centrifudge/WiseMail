/**
 * background.js — Service worker de l'extension ComplianceGuard
 *
 * Rôle : pont entre le content script (interface Gmail) et les APIs d'IA.
 * Reçoit les messages ANALYZE_EMAIL et GET_SETTINGS, appelle le provider
 * configuré (Google Gemini, OpenAI ou Anthropic), et renvoie le résultat
 * structuré au content script.
 *
 * Réglementations couvertes : AMF, CMF (Art. L533-x), MIF II, RGPD,
 * LCB-FT, PRIIPS — focus droit français et européen.
 */

// ─── Configuration par défaut ─────────────────────────────────────────────────

/**
 * URL d'endpoint Google Gemini. Le placeholder {model} est remplacé
 * dynamiquement par le nom du modèle choisi dans les paramètres.
 */
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

/**
 * Modèle par défaut : Gemini 3.1 Flash-Lite Preview.
 * Choisi pour son rapport vitesse/qualité sur des tâches d'analyse textuelle.
 * Peut être remplacé dans les paramètres de l'extension.
 */
const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

/**
 * Alias de migration pour les anciens identifiants de modèles qui ne sont plus
 * acceptés par l'API Google Gemini.
 */
const LEGACY_MODEL_ALIASES = {
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
};

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

async function getExtensionSettings() {
  const settings = await browser.storage.local.get([
    "apiKey", "jurisdiction", "autoScan", "endpoint", "provider", "model"
  ]);

  const provider = settings.provider || "google";
  const rawModel = settings.model || DEFAULT_MODEL;
  const rawEndpoint = settings.endpoint || DEFAULT_ENDPOINT;
  const useGoogleNormalization = shouldNormalizeGoogleSettings(provider, rawEndpoint);
  const normalizedModel = useGoogleNormalization ? normalizeModelName(rawModel) : rawModel;
  const normalizedEndpoint = useGoogleNormalization ? normalizeEndpointTemplate(rawEndpoint) : rawEndpoint;
  const migratedSettings = {};

  if (settings.model && settings.model !== normalizedModel) {
    migratedSettings.model = normalizedModel;
  }
  if (settings.endpoint && settings.endpoint !== normalizedEndpoint) {
    migratedSettings.endpoint = normalizedEndpoint;
  }
  if (Object.keys(migratedSettings).length > 0) {
    browser.storage.local.set(migratedSettings);
  }

  return {
    ...settings,
    provider,
    model: normalizedModel,
    endpoint: normalizedEndpoint,
  };
}

// ─── Prompt système ───────────────────────────────────────────────────────────

/**
 * Instructions envoyées à l'IA avant chaque analyse.
 *
 * Le prompt demande à l'IA de retourner UNIQUEMENT du JSON valide
 * (pas de markdown, pas de blocs de code) afin de faciliter le parsing.
 *
 * Structure de réponse attendue :
 *   {
 *     riskScore          : entier 0-100
 *     issues             : liste des problèmes détectés (type, severity, description, quote, regulation)
 *     requiredDisclaimers: mentions légales à insérer (id, text, regulation, jurisdiction)
 *     correctedEmail     : version complète de l'e-mail avec corrections intégrées
 *     summary            : résumé en une phrase
 *   }
 *
 * Types de problèmes reconnus :
 *   MENTION_PERFORMANCES_PASSEES | GARANTIE_RENDEMENT | ABSENCE_MISE_EN_GARDE
 *   VIOLATION_RGPD | INFORMATION_TROMPEUSE | ABSENCE_MENTION_AMF
 *   VIOLATION_LCBFT | CONFLIT_INTERETS | MANQUEMENT_REGLEMENTAIRE
 */
const SYSTEM_PROMPT = `Tu es ComplianceGuard, un expert en conformité réglementaire pour les communications financières, spécialisé dans le droit français et européen.

Analyse l'e-mail financier fourni et identifie les problèmes de conformité. Retourne UNIQUEMENT un objet JSON valide (sans markdown, sans blocs de code) avec cette structure exacte :

{
  "riskScore": <entier 0-100>,
  "issues": [
    {
      "type": "MENTION_PERFORMANCES_PASSEES" | "GARANTIE_RENDEMENT" | "ABSENCE_MISE_EN_GARDE" | "VIOLATION_RGPD" | "INFORMATION_TROMPEUSE" | "ABSENCE_MENTION_AMF" | "VIOLATION_LCBFT" | "CONFLIT_INTERETS" | "MANQUEMENT_REGLEMENTAIRE",
      "severity": "critical" | "warning" | "info",
      "description": "<explication courte en français>",
      "quote": "<texte exact de l'e-mail qui a déclenché ce problème, ou chaîne vide>",
      "regulation": "<nom de la réglementation, ex. : AMF DOC-2012-17, Art. L533-12 CMF, RGPD Art. 6, MIF II Art. 24>"
    }
  ],
  "requiredDisclaimers": [
    {
      "id": "<id court unique>",
      "text": "<texte complet de la mention légale à ajouter>",
      "regulation": "<nom de la réglementation>",
      "jurisdiction": "<FR|EU|Global>"
    }
  ],
  "correctedEmail": "<version corrigée complète de l'e-mail avec les mentions légales intégrées, ou chaîne vide si aucune correction n'est nécessaire>",
  "summary": "<résumé en une phrase du statut de conformité global>"
}

Réglementations à vérifier en priorité :

1. AMF (Autorité des marchés financiers) :
   - Toute mention de performances passées doit être suivie de : "Les performances passées ne préjugent pas des performances futures."
   - Interdiction des garanties de rendement ou de capital
   - Obligation d'information claire sur les risques
   - DOC-2012-17 : Communications commerciales

2. Code monétaire et financier (CMF) :
   - Art. L533-12 : Information client honnête, claire et non trompeuse
   - Art. L533-22 : Gestion des conflits d'intérêts
   - Art. L533-24 : Compte-rendu au client

3. MIF II / MiFID II (transposé en droit français) :
   - Art. 24 : Exigences d'information
   - Art. 25 : Adéquation et caractère approprié
   - Mentions obligatoires pour les communications commerciales

4. RGPD (Règlement Général sur la Protection des Données) :
   - Toute mention de données personnelles (nom, e-mail, numéro de compte) doit être signalée
   - Base légale du traitement
   - Droits des personnes

5. LCB-FT (Lutte contre le blanchiment de capitaux et le financement du terrorisme) :
   - Ordonnance n° 2016-1635
   - Vigilance sur les transactions suspectes

6. PRIIPS :
   - Obligation de KID (document d'informations clés) pour les produits packagés

7. Règles générales :
   - Toute affirmation non étayée sur les rendements futurs
   - Absence de mention des risques de perte en capital
   - Publicité trompeuse ou mensongère

Contexte de l'expéditeur : Le domaine de l'expéditeur est fourni — s'il s'agit d'une entité financière réglementée, applique des règles plus strictes.
`;

// ─── Routeur de messages ──────────────────────────────────────────────────────

/**
 * Point d'entrée unique pour les messages envoyés par le content script
 * ou le popup via browser.runtime.sendMessage().
 *
 * Messages gérés :
 *   ANALYZE_EMAIL — lance l'analyse de l'e-mail fourni
 *   GET_SETTINGS  — lit les paramètres stockés (clé API, modèle, juridiction…)
 */
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "ANALYZE_EMAIL") {
    return analyzeEmail(
      message.emailText,
      message.jurisdiction,
      message.recipientEmail,
      message.senderDomain
    );
  }
  if (message.type === "GET_SETTINGS") {
    return getExtensionSettings();
  }
});

// ─── Orchestrateur d'analyse ──────────────────────────────────────────────────

/**
 * Construit le prompt utilisateur enrichi du contexte (juridiction,
 * destinataire, domaine expéditeur) puis délègue à la fonction d'appel
 * correspondant au provider configuré.
 *
 * @param {string} emailText     - Corps de l'e-mail à analyser
 * @param {string} jurisdiction  - Code juridiction (FR, EU, US…)
 * @param {string} recipientEmail - Adresse e-mail du destinataire (peut être vide)
 * @param {string} senderDomain  - Domaine de l'expéditeur, ex. "margot-groupe.com" (non sensible)
 * @returns {Promise<{success: boolean, result: object}|{error: string, message: string}>}
 */
async function analyzeEmail(emailText, jurisdiction = "FR", recipientEmail = "", senderDomain = "") {
  const settings = await getExtensionSettings();

  const apiKey   = settings.apiKey;
  const provider = settings.provider;
  const model    = settings.model;
  // Injecte le nom du modèle dans l'URL endpoint (format Google : {model})
  const endpoint = settings.endpoint.replace("{model}", model);

  if (!apiKey) {
    return { error: "NO_API_KEY", message: "Veuillez configurer votre clé API dans les paramètres de l'extension." };
  }

  // Contexte additionnel transmis à l'IA pour affiner l'analyse :
  // - la juridiction oriente les réglementations prioritaires
  // - le destinataire permet de détecter si l'e-mail est envoyé à un client retail ou professionnel
  // - le domaine expéditeur aide à identifier une entité financière réglementée
  const contextLines = [];
  if (jurisdiction)   contextLines.push(`Juridiction principale : ${jurisdiction}`);
  if (recipientEmail) contextLines.push(`Destinataire : ${recipientEmail}`);
  if (senderDomain)   contextLines.push(`Domaine expéditeur : ${senderDomain} (informations non sensibles)`);

  const userPrompt = contextLines.join("\n") + "\n\nE-mail à analyser :\n---\n" + emailText + "\n---";

  try {
    if (provider === "google")    return await callGoogle(endpoint, apiKey, userPrompt);
    if (provider === "openai")    return await callOpenAI(endpoint, apiKey, model, userPrompt);
    if (provider === "anthropic") return await callAnthropic(endpoint, apiKey, model, userPrompt);
    // Provider inconnu → on tente le format OpenAI qui est le plus répandu
    return await callOpenAI(endpoint, apiKey, model, userPrompt);
  } catch (e) {
    return { error: "NETWORK_ERROR", message: e.message };
  }
}

// ─── Appels API ───────────────────────────────────────────────────────────────

/**
 * Appelle l'API Google Gemini (format generateContent).
 * La clé API est passée en query string (?key=…) plutôt qu'en header —
 * c'est le format requis par Google AI Studio.
 * Temperature à 0.1 pour des réponses déterministes et reproductibles.
 */
async function callGoogle(endpoint, apiKey, userPrompt) {
  const url = `${endpoint}?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Gemini fusionne system prompt + user prompt dans un seul "contents"
      contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + userPrompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  // Chemin de la réponse texte dans la structure Gemini
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseJSON(raw);
}

/**
 * Appelle une API compatible OpenAI (Chat Completions).
 * Utilisé pour OpenAI, mais aussi pour tout provider custom
 * qui expose le même format (LM Studio, Ollama, etc.).
 */
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
      // Le system prompt est séparé du message utilisateur, comme requis par l'API Chat
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
  return parseJSON(data.choices?.[0]?.message?.content || "");
}

/**
 * Appelle l'API Anthropic (Claude).
 * Différences notables vs OpenAI :
 *   - Authentification via x-api-key (pas Authorization: Bearer)
 *   - Le system prompt est un champ de premier niveau, pas un message
 *   - Header anthropic-version obligatoire
 */
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
  return parseJSON(data.content?.[0]?.text || "");
}

// ─── Parsing de la réponse ────────────────────────────────────────────────────

/**
 * Nettoie et parse la réponse brute de l'IA.
 *
 * Certains modèles encapsulent le JSON dans des blocs ```json … ```
 * même quand on leur demande de ne pas le faire — on les retire ici
 * avant le JSON.parse().
 *
 * @param {string} raw - Texte brut retourné par le modèle
 * @returns {{success: true, result: object}|{error: string, message: string, raw: string}}
 */
function parseJSON(raw) {
  const cleaned = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  try {
    return { success: true, result: JSON.parse(cleaned) };
  } catch {
    return { error: "PARSE_ERROR", message: "Impossible de lire la réponse de l'IA.", raw };
  }
}
