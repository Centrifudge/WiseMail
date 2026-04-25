// background.js — ComplianceGuard, focus droit français + EU

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const DEFAULT_MODEL    = "gemini-2.0-flash-lite";

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

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "ANALYZE_EMAIL") return analyzeEmail(message.emailText, message.jurisdiction, message.recipientEmail, message.senderDomain);
  if (message.type === "GET_SETTINGS")  return browser.storage.local.get(["apiKey", "jurisdiction", "autoScan", "endpoint", "provider", "model"]);
});

async function analyzeEmail(emailText, jurisdiction = "FR", recipientEmail = "", senderDomain = "") {
  const settings = await browser.storage.local.get(["apiKey", "endpoint", "provider", "model"]);

  const apiKey   = settings.apiKey;
  const provider = settings.provider || "google";
  const model    = settings.model    || DEFAULT_MODEL;
  const endpoint = (settings.endpoint || DEFAULT_ENDPOINT).replace("{model}", model);

  if (!apiKey) {
    return { error: "NO_API_KEY", message: "Veuillez configurer votre clé API dans les paramètres de l'extension." };
  }

  const contextLines = [];
  if (jurisdiction)    contextLines.push(`Juridiction principale : ${jurisdiction}`);
  if (recipientEmail)  contextLines.push(`Destinataire : ${recipientEmail}`);
  if (senderDomain)    contextLines.push(`Domaine expéditeur : ${senderDomain} (informations non sensibles)`);

  const userPrompt = contextLines.join("\n") + "\n\nE-mail à analyser :\n---\n" + emailText + "\n---";

  try {
    if (provider === "google") return await callGoogle(endpoint, apiKey, userPrompt);
    if (provider === "openai")    return await callOpenAI(endpoint, apiKey, model, userPrompt);
    if (provider === "anthropic") return await callAnthropic(endpoint, apiKey, model, userPrompt);
    return await callOpenAI(endpoint, apiKey, model, userPrompt);
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

// ── OpenAI / compatible ───────────────────────────────────────────────────────
async function callOpenAI(endpoint, apiKey, model, userPrompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 2048,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: "API_ERROR", message: err.error?.message || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return parseJSON(data.choices?.[0]?.message?.content || "");
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
async function callAnthropic(endpoint, apiKey, model, userPrompt) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 2048,
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

// ── JSON parser ───────────────────────────────────────────────────────────────
function parseJSON(raw) {
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return { success: true, result: JSON.parse(cleaned) };
  } catch {
    return { error: "PARSE_ERROR", message: "Impossible de lire la réponse de l'IA.", raw };
  }
}
