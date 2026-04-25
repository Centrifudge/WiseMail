/**
 * content.js — Script injecté dans Gmail (et Outlook) par ComplianceGuard
 *
 * Rôle : surveiller la fenêtre de composition, déclencher les analyses
 * de conformité et afficher les résultats sans perturber l'interface Gmail.
 *
 * Deux modes de déclenchement :
 *   1. Automatique — l'utilisateur s'arrête de taper pendant 2 secondes :
 *      un toast compact apparaît avec les problèmes détectés et un bouton
 *      "Corriger" pour appliquer la version corrigée en un clic.
 *   2. Manuel — clic sur le bouton "Conformité" dans la barre d'outils
 *      ou raccourci Alt+Maj+C : ouvre le panneau complet de détails.
 *
 * Architecture :
 *   - Un MutationObserver surveille le DOM pour détecter l'ouverture
 *     d'une fenêtre de composition (Gmail les crée dynamiquement).
 *   - Toute communication avec l'IA passe par browser.runtime.sendMessage
 *     vers background.js (seul contexte autorisé à faire des requêtes réseau).
 */

(function () {
  "use strict";

  // ─── État global du script ────────────────────────────────────────────────

  let activePanel = null;     // Référence au div du panneau complet (null si fermé)
  let activeToast = null;     // Référence au div du toast de suggestion (null si fermé)
  let debounceTimer = null;   // Timer du debounce de frappe (2 secondes)
  let lastAnalyzedText = "";  // Dernier texte envoyé à l'analyse, pour éviter les doublons
  let isAnalyzing = false;    // Verrou pour ne pas lancer deux analyses en parallèle
  let panelManualPosition = null;
  const highlightedIssueSpans = new Map();

  const COMPOSE_SELECTOR = '[role="textbox"][aria-label*="Message Body"], [g_editable="true"], .Am.Al.editable';

  function getComposeElement() {
    return document.querySelector(COMPOSE_SELECTOR);
  }

  function getComposeContainer() {
    const compose = getComposeElement();
    if (!compose) return null;
    return (
      compose.closest('[role="dialog"]') ||
      compose.closest('.AD') ||
      compose.closest('.aDh') ||
      compose.parentElement
    );
  }

  function getSubjectField() {
    const composeContainer = getComposeContainer();
    if (!composeContainer) return null;
    return (
      composeContainer.querySelector('input[name="subjectbox"]') ||
      composeContainer.querySelector('input[placeholder="Objet"]') ||
      composeContainer.querySelector('input[placeholder="Subject"]')
    );
  }

  function extractSubjectText() {
    return getSubjectField()?.value?.trim() || "";
  }

  function setSubjectText(subjectText) {
    const subjectField = getSubjectField();
    if (!subjectField || !subjectText) return;

    subjectField.focus();
    subjectField.value = subjectText;
    subjectField.dispatchEvent(new Event("input", { bubbles: true }));
    subjectField.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampPanelPosition(panel, position) {
    const margin = 16;
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
    return {
      left: clamp(position.left, margin, maxLeft),
      top: clamp(position.top, margin, maxTop)
    };
  }

  function applyPanelPosition(panel, position, persist = false) {
    const safePosition = clampPanelPosition(panel, position);
    panel.style.left = `${safePosition.left}px`;
    panel.style.top = `${safePosition.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (persist) {
      panelManualPosition = safePosition;
    }
  }

  function rectanglesOverlap(a, b) {
    return !(
      a.right <= b.left ||
      a.left >= b.right ||
      a.bottom <= b.top ||
      a.top >= b.bottom
    );
  }

  function choosePanelPosition(panel) {
    const composeContainer = getComposeContainer();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const margin = 16;
    const fallback = {
      left: Math.max(margin, window.innerWidth - panelWidth - margin),
      top: Math.max(88, window.innerHeight - panelHeight - 96)
    };

    if (!composeContainer) return fallback;

    const rect = composeContainer.getBoundingClientRect();
    const candidates = [
      { left: rect.left - panelWidth - margin, top: rect.top, priority: 0 },
      { left: rect.right + margin, top: rect.top, priority: 1 },
      { left: rect.left, top: rect.top - panelHeight - margin, priority: 2 },
      { left: rect.left, top: rect.bottom + margin, priority: 3 },
      { left: rect.left - panelWidth - margin, top: rect.bottom - panelHeight, priority: 4 },
      { left: rect.right + margin, top: rect.bottom - panelHeight, priority: 5 },
      fallback
    ];

    const composeRect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    };

    let best = null;
    for (const candidate of candidates) {
      const safe = clampPanelPosition(panel, candidate);
      const panelRect = {
        left: safe.left,
        top: safe.top,
        right: safe.left + panelWidth,
        bottom: safe.top + panelHeight
      };
      const overlapsCompose = rectanglesOverlap(panelRect, composeRect);
      const score = overlapsCompose ? 100 + (candidate.priority || 0) : (candidate.priority || 0);
      if (!best || score < best.score) {
        best = { score, position: safe };
      }
    }

    return best?.position || fallback;
  }

  function positionPanel(panel) {
    if (panelManualPosition) {
      applyPanelPosition(panel, panelManualPosition);
      return;
    }
    applyPanelPosition(panel, choosePanelPosition(panel));
  }

  function enablePanelDragging(panel) {
    const header = panel.querySelector(".cg-header");
    if (!header || header.dataset.cgDragBound) return;
    header.dataset.cgDragBound = "true";

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, a")) return;

      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      panel.classList.add("cg-panel-dragging");

      const onMove = (moveEvent) => {
        applyPanelPosition(panel, {
          left: moveEvent.clientX - offsetX,
          top: moveEvent.clientY - offsetY
        }, true);
      };

      const onUp = () => {
        panel.classList.remove("cg-panel-dragging");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
  }

  function normalizeIssueQuote(quote) {
    return (quote || "")
      .replace(/^[\s"'“”«»]+|[\s"'“”«»]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getIssueQuoteVariants(quote) {
    const trimmed = (quote || "").trim();
    const normalized = normalizeIssueQuote(quote);
    const variants = new Set([trimmed, normalized]);
    return [...variants].filter((variant) => variant && variant.length >= 4);
  }

  function rememberHighlightedSpan(issueIndex, span) {
    const key = String(issueIndex);
    const spans = highlightedIssueSpans.get(key) || [];
    spans.push(span);
    highlightedIssueSpans.set(key, spans);
  }

  function clearInlineHighlights() {
    highlightedIssueSpans.clear();
    document.querySelectorAll(".cg-inline-issue").forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent || ""));
    });
    getComposeElement()?.normalize();
  }

  function wrapIssueMatchesInTextNode(textNode, issue, issueIndex, variants) {
    const original = textNode.nodeValue || "";
    const lowerText = original.toLowerCase();
    let cursor = 0;
    let hasMatch = false;
    let matchCount = 0;
    const fragment = document.createDocumentFragment();

    while (cursor < original.length) {
      let matchIndex = -1;
      let matchLength = 0;

      for (const variant of variants) {
        const index = lowerText.indexOf(variant.toLowerCase(), cursor);
        if (index !== -1 && (matchIndex === -1 || index < matchIndex || (index === matchIndex && variant.length > matchLength))) {
          matchIndex = index;
          matchLength = variant.length;
        }
      }

      if (matchIndex === -1) {
        fragment.appendChild(document.createTextNode(original.slice(cursor)));
        break;
      }

      if (matchIndex > cursor) {
        fragment.appendChild(document.createTextNode(original.slice(cursor, matchIndex)));
      }

      const span = document.createElement("span");
      span.className = `cg-inline-issue cg-inline-issue-${issue.severity || "warning"}`;
      span.dataset.issueIndex = String(issueIndex);
      span.title = issue.description || "Problème de conformité";
      span.textContent = original.slice(matchIndex, matchIndex + matchLength);
      fragment.appendChild(span);
      rememberHighlightedSpan(issueIndex, span);

      cursor = matchIndex + matchLength;
      hasMatch = true;
      matchCount += 1;
    }

    if (!hasMatch) return 0;

    textNode.parentNode.replaceChild(fragment, textNode);
    return matchCount;
  }

  function highlightIssueQuote(issue, issueIndex) {
    const compose = getComposeElement();
    if (!compose) return 0;

    const variants = getIssueQuoteVariants(issue.quote);
    if (!variants.length) return 0;

    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".cg-inline-issue")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    let currentNode;
    while ((currentNode = walker.nextNode())) {
      textNodes.push(currentNode);
    }

    let highlightedCount = 0;
    for (const textNode of textNodes) {
      if (!textNode.parentNode) continue;
      highlightedCount += wrapIssueMatchesInTextNode(textNode, issue, issueIndex, variants);
    }
    return highlightedCount;
  }

  function highlightIssuesInCompose(result) {
    clearInlineHighlights();

    const issues = (result?.issues || [])
      .map((issue, index) => ({ issue, index, quote: normalizeIssueQuote(issue.quote) }))
      .filter(({ quote }) => quote.length >= 4)
      .sort((a, b) => b.quote.length - a.quote.length);

    for (const { issue, index } of issues) {
      highlightIssueQuote(issue, index);
    }
  }

  function focusIssueInCompose(issueIndex) {
    const key = String(issueIndex);
    const compose = getComposeElement();
    const target = (highlightedIssueSpans.get(key) || []).find((span) => span.isConnected);
    if (!compose || !target) return;

    target.classList.remove("cg-inline-issue-pulse");
    void target.offsetWidth;
    target.classList.add("cg-inline-issue-pulse");
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

    compose.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function parseCorrectedEmailParts(resultOrText) {
    const result = typeof resultOrText === "string"
      ? { correctedEmail: resultOrText }
      : (resultOrText || {});

    let subject = (result.correctedSubject || "").trim();
    let body = (result.correctedEmail || "").trim();

    if (!body) {
      return { subject, body: "" };
    }

    const explicitSubjectMatch = body.match(/^\s*(?:Objet|Subject)\s*:\s*(.+)\n+/i);
    if (explicitSubjectMatch) {
      if (!subject) {
        subject = explicitSubjectMatch[1].trim();
      }
      body = body.slice(explicitSubjectMatch[0].length).trim();
    }

    return { subject, body };
  }

  // ─── Détection du client mail ─────────────────────────────────────────────

  /** Identifie Gmail ou Outlook à partir du hostname courant. */
  function getEmailClient() {
    if (location.hostname.includes("mail.google.com")) return "gmail";
    if (location.hostname.includes("outlook")) return "outlook";
    return "unknown";
  }

  // ─── Extraction du contenu de l'e-mail ───────────────────────────────────

  /**
   * Lit le texte de l'e-mail actuellement ouvert ou en cours de rédaction.
   * Gère les deux modes Gmail : fenêtre de composition et volet de lecture.
   * Plusieurs sélecteurs CSS sont tentés en cascade car Gmail change
   * régulièrement ses noms de classes internes.
   */
  function extractEmailText() {
    if (getEmailClient() === "gmail") {
      // Mode composition : zone de saisie éditable
      const compose = getComposeElement();
      if (compose) return compose.innerText || compose.textContent || "";

      // Mode lecture : volet de lecture avec sujet + corps
      const subject = document.querySelector('h2.hP');
      const body    = document.querySelector('.ii.gt');
      if (body) return (subject?.innerText || "") + "\n" + body.innerText;
    }

    if (getEmailClient() === "outlook") {
      const compose  = document.querySelector('[aria-label="Message body, press Alt+F10 to exit"], .dFCbN');
      if (compose) return compose.innerText || "";
      const reading  = document.querySelector('[role="document"] .allowTextSelection');
      if (reading) return reading.innerText || "";
    }

    return "";
  }

  // ─── Extraction de l'adresse du destinataire ──────────────────────────────

  /**
   * Lit l'adresse e-mail du champ "À" dans la fenêtre de composition Gmail.
   * Ces informations sont transmises à l'IA pour contextualiser l'analyse
   * (ex. : client retail vs investisseur professionnel).
   *
   * Stratégie en deux temps :
   *   1. Cherche les "chips" de destinataires (éléments .vO avec data-hovercard-id)
   *   2. Fallback sur le champ aria-label="À" si les chips ne sont pas encore rendus
   */
  function extractRecipientEmail() {
    // Les chips Gmail contiennent l'adresse dans data-hovercard-id ou l'attribut email
    const toChips = document.querySelectorAll('.vO[data-hovercard-id], .aB .vO');
    for (const chip of toChips) {
      const email = chip.dataset.hovercardId || chip.getAttribute('email');
      if (email && email.includes('@')) return email;
    }

    // Fallback : champ texte brut (avant que Gmail transforme l'adresse en chip)
    const toField = document.querySelector('[aria-label="À"], [aria-label="To"], [name="to"]');
    if (toField) {
      const match = toField.value?.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (match) return match[0];
    }

    return "";
  }

  // ─── Extraction du domaine de l'expéditeur ────────────────────────────────

  /**
   * Retourne uniquement le domaine de l'adresse Gmail connectée (ex. "margot-groupe.com").
   * Cette information est considérée comme non sensible et permet à l'IA de savoir
   * si l'expéditeur appartient à une entité financière réglementée, ce qui
   * renforce les critères d'analyse appliqués.
   */
  function getSenderDomain() {
    const accountEl = document.querySelector('[data-email]');
    if (accountEl) {
      const email = accountEl.dataset.email;
      if (email && email.includes('@')) return email.split('@')[1];
    }
    return "";
  }

  // ─── Barre d'outils de composition ───────────────────────────────────────

  /**
   * Localise la barre d'outils de formatage dans la fenêtre de composition Gmail.
   * Plusieurs sélecteurs sont testés car la structure DOM varie selon
   * la version de Gmail et le mode d'affichage (fenêtre flottante vs plein écran).
   */
  function findComposeToolbar() {
    return (
      document.querySelector('.btC .gU.Up') ||
      document.querySelector('.aDh') ||
      document.querySelector('[data-tooltip="More formatting options"]')?.closest('.btC')
    );
  }

  // ─── Injection du bouton "Conformité" ─────────────────────────────────────

  /**
   * Insère le bouton ComplianceGuard dans la barre d'outils de composition.
   * Idempotent : ne fait rien si le bouton est déjà présent (détecté via son id).
   * Le clic ferme le toast automatique s'il est affiché, puis ouvre le panneau complet.
   */
  function injectScanButton(toolbar) {
    if (document.getElementById("cg-scan-btn")) return;

    const btn = document.createElement("button");
    btn.id    = "cg-scan-btn";
    btn.title = "ComplianceGuard — Vérifier la conformité";
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Conformité
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // Empêche Gmail de capturer le clic et de fermer la fenêtre
      removeToast();
      triggerScan(true);
    });
    toolbar.appendChild(btn);
  }

  // ─── Écoute de la frappe (déclenchement automatique) ─────────────────────

  /**
   * Attache un écouteur "input" sur la zone de texte de composition.
   * Un attribut data-cgListening est posé sur le nœud DOM pour garantir
   * qu'un seul écouteur est enregistré, même si le MutationObserver
   * appelle cette fonction plusieurs fois.
   *
   * Logique du debounce :
   *   - Chaque frappe réinitialise le timer à 2 secondes.
   *   - Quand le timer expire (l'utilisateur a arrêté de taper), on vérifie :
   *       · Le texte fait au moins 30 caractères (évite les e-mails vides)
   *       · Le texte est différent du dernier analysé (évite les doublons)
   *       · Aucune analyse n'est déjà en cours (verrou isAnalyzing)
   */
  function attachComposeListener() {
    const compose = getComposeElement();
    if (!compose || compose.dataset.cgListening) return;
    compose.dataset.cgListening = "true";

    compose.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const text = compose.innerText || compose.textContent || "";
        if (text.trim().length >= 30 && text !== lastAnalyzedText && !isAnalyzing) {
          triggerAutoScan(text);
        }
      }, 2000); // 2 secondes d'inactivité avant analyse
    });
  }

  // ─── Analyse automatique ──────────────────────────────────────────────────

  /**
   * Déclenche une analyse silencieuse (sans état de chargement dans le panneau).
   * Si la clé API n'est pas configurée, on abandonne silencieusement
   * plutôt que d'afficher une erreur à chaque frappe.
   * En cas de problèmes détectés (critiques ou avertissements), affiche le toast.
   *
   * @param {string} text - Texte de l'e-mail capturé après le debounce
   */
  async function triggerAutoScan(text) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    clearInlineHighlights();
    lastAnalyzedText = text;
    removeToast();

    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });
    // Pas de clé API → on n'embête pas l'utilisateur avec une erreur répétée
    if (!settings.apiKey) { isAnalyzing = false; return; }

    const response = await browser.runtime.sendMessage({
      type: "ANALYZE_EMAIL",
      emailText:      text,
      jurisdiction:   settings.jurisdiction || "FR",
      subjectText:    extractSubjectText(),
      recipientEmail: extractRecipientEmail(),
      senderDomain:   getSenderDomain()
    });

    isAnalyzing = false;

    if (response.success && response.result) {
      highlightIssuesInCompose(response.result);
      showPanel({ success: true, result: response.result, emailText: text, autoOpened: true });
    } else {
      clearInlineHighlights();
    }
  }

  // ─── Analyse manuelle (panneau complet) ───────────────────────────────────

  /**
   * Déclenche une analyse avec affichage du panneau complet.
   * Appelé par le bouton dans la barre d'outils et le raccourci clavier.
   * Affiche immédiatement un état de chargement pendant que la requête s'effectue.
   *
   * @param {boolean} showFullPanel - Si false, analyse sans afficher le panneau
   */
  async function triggerScan(showFullPanel = true) {
    const text = extractEmailText();
    if (!text || text.trim().length < 20) {
      if (showFullPanel) {
        showPanel({ error: "EMPTY", message: "Aucun contenu d'e-mail détecté. Rédigez ou ouvrez un e-mail." });
      }
      return;
    }

    if (showFullPanel) showPanel({ loading: true });

    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });

    const response = await browser.runtime.sendMessage({
      type: "ANALYZE_EMAIL",
      emailText:      text,
      jurisdiction:   settings.jurisdiction || "FR",
      subjectText:    extractSubjectText(),
      recipientEmail: extractRecipientEmail(),
      senderDomain:   getSenderDomain()
    });

    if (response.success && response.result) {
      highlightIssuesInCompose(response.result);
    } else {
      clearInlineHighlights();
    }

    if (showFullPanel) showPanel({ ...response, emailText: text });
  }

  // ─── Toast de suggestion ──────────────────────────────────────────────────

  /**
   * Affiche un bandeau compact en bas à gauche de l'écran.
   * Le toast résume les problèmes détectés et propose trois actions :
   *   - "Corriger" : applique directement la version corrigée dans la zone de texte
   *   - "Détails"  : ouvre le panneau complet
   *   - "✕"        : ferme le toast
   *
   * Le toast se ferme automatiquement après 12 secondes.
   *
   * @param {object} result - Objet résultat retourné par l'IA (structure JSON)
   */
  function showCorrectionToast(result) {
    removeToast(); // Ferme un éventuel toast précédent

    const critical       = (result.issues || []).filter(i => i.severity === "critical").length;
    const warnings       = (result.issues || []).filter(i => i.severity === "warning").length;
    const hasCorrection  =
      (result.correctedEmail && result.correctedEmail.length > 10) ||
      (result.correctedSubject && result.correctedSubject.trim().length > 0);
    const hasDisclaimers = result.requiredDisclaimers?.length > 0;

    // Construction du résumé coloré des problèmes
    const parts = [];
    if (critical > 0) parts.push(`<span class="cg-toast-critical">${critical} critique${critical > 1 ? "s" : ""}</span>`);
    if (warnings > 0) parts.push(`<span class="cg-toast-warning">${warnings} avertissement${warnings > 1 ? "s" : ""}</span>`);

    activeToast = document.createElement("div");
    activeToast.id = "cg-toast";
    activeToast.innerHTML = `
      <div class="cg-toast-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          <path d="M12 8v4m0 4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="cg-toast-body">
        <p class="cg-toast-title">Problèmes de conformité détectés</p>
        <p class="cg-toast-counts">${parts.join(" · ")}</p>
      </div>
      <div class="cg-toast-actions">
        ${(hasCorrection || hasDisclaimers)
          ? `<button class="cg-toast-btn cg-toast-accept" id="cg-toast-accept">Corriger</button>`
          : ""}
        <button class="cg-toast-btn cg-toast-details" id="cg-toast-details">Détails</button>
        <button class="cg-toast-btn cg-toast-dismiss" id="cg-toast-close">✕</button>
      </div>
    `;

    document.body.appendChild(activeToast);

    activeToast.querySelector("#cg-toast-close")?.addEventListener("click", removeToast);

    // "Corriger" : préfère la version corrigée complète, sinon insère les mentions légales
    activeToast.querySelector("#cg-toast-accept")?.addEventListener("click", () => {
      if (hasCorrection) {
        applyEmailCorrection(result);
      } else if (result.requiredDisclaimers?.length) {
        insertDisclaimersIntoCompose(result.requiredDisclaimers);
      }
      removeToast();
    });

    // "Détails" : ferme le toast et ouvre le panneau complet avec les résultats déjà calculés
    activeToast.querySelector("#cg-toast-details")?.addEventListener("click", () => {
      removeToast();
      showPanel({ success: true, result, emailText: lastAnalyzedText });
    });

    // Auto-dismiss après 12 secondes pour ne pas bloquer l'interface indéfiniment
    setTimeout(() => { if (activeToast) removeToast(); }, 12000);
  }

  /** Retire le toast du DOM et libère la référence. */
  function removeToast() {
    if (activeToast) { activeToast.remove(); activeToast = null; }
  }

  // ─── Correction de l'e-mail ───────────────────────────────────────────────

  /**
   * Remplace le contenu entier de la zone de composition par le texte corrigé
   * fourni par l'IA. Utilise execCommand("insertText") pour rester compatible
   * avec le système d'annulation (Ctrl+Z) de Gmail.
   *
   * @param {string} correctedText - Version corrigée complète de l'e-mail
   */
  function applyEmailCorrection(resultOrText) {
    const { subject, body } = parseCorrectedEmailParts(resultOrText);
    const compose = getComposeElement();
    if (subject) {
      setSubjectText(subject);
    }
    if (compose && body) {
      clearInlineHighlights();
      compose.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, body);
      lastAnalyzedText = body;
    }
  }

  // ─── Insertion des mentions légales ───────────────────────────────────────

  /**
   * Ajoute les mentions légales à la fin du texte de l'e-mail en cours de rédaction,
   * séparées par une ligne de démarcation.
   * Utilisée quand l'IA n'a pas fourni de version corrigée complète
   * mais a identifié des mentions légales manquantes.
   *
   * @param {Array<{regulation: string, text: string}>} disclaimers - Liste des mentions à insérer
   */
  function insertDisclaimersIntoCompose(disclaimers) {
    if (!disclaimers.length) return;

    const text = "\n\n─────────────────────────────\nMENTIONS LÉGALES OBLIGATOIRES :\n\n" +
      disclaimers.map(d => `[${d.regulation}] ${d.text}`).join("\n\n");

    const compose = getComposeElement();
    if (compose) {
      clearInlineHighlights();
      compose.focus();
      // Déplace le curseur à la fin du document avant d'insérer
      const sel   = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(compose);
      range.collapse(false); // false = fin du contenu
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
    }
  }

  // ─── Panneau de résultats complet ─────────────────────────────────────────

  /**
   * Crée et affiche le panneau de résultats dans le DOM de Gmail.
   * Le panneau est recréé à chaque appel (pas de mise à jour partielle)
   * pour simplifier la gestion d'état. Les écouteurs d'événements sont
   * rattachés après insertion dans le DOM.
   *
   * @param {object} state - État à afficher : {loading} | {error, message} | {success, result}
   */
  function showPanel(state) {
    removePanel();
    activePanel = document.createElement("div");
    activePanel.id = "cg-panel";
    activePanel.innerHTML = buildPanelHTML(state);
    document.body.appendChild(activePanel);
    positionPanel(activePanel);
    enablePanelDragging(activePanel);

    activePanel.querySelector("#cg-close")?.addEventListener("click", removePanel);

    // Boutons "Copier" des mentions légales individuelles
    activePanel.querySelectorAll(".cg-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.text).then(() => {
          btn.textContent = "Copié !";
          setTimeout(() => btn.textContent = "Copier", 1500);
        });
      });
    });

    // Bouton "Insérer toutes les mentions"
    activePanel.querySelector("#cg-insert-all")?.addEventListener("click", () => {
      insertDisclaimersIntoCompose(state.result?.requiredDisclaimers || []);
    });

    // Bouton "Appliquer" la correction complète
    activePanel.querySelector("#cg-apply-correction")?.addEventListener("click", () => {
      if ((state.result?.correctedEmail && state.result.correctedEmail.length > 10) ||
          (state.result?.correctedSubject && state.result.correctedSubject.trim().length > 0)) {
        applyEmailCorrection(state.result);
        activePanel.querySelector("#cg-apply-correction").textContent = "Tout corrigé ✓";
      }
    });

    activePanel.querySelectorAll(".cg-issue-focus-btn").forEach((button) => {
      button.addEventListener("click", () => {
        focusIssueInCompose(button.dataset.issueIndex);
      });
    });

    // Bouton "Ouvrir les paramètres" depuis l'état d'erreur NO_API_KEY
    activePanel.querySelector("#cg-open-settings")?.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "OPEN_SETTINGS" });
    });
  }

  /** Retire le panneau du DOM et libère la référence. */
  function removePanel() {
    if (activePanel) { activePanel.remove(); activePanel = null; }
  }

  // ─── Construction du HTML du panneau ──────────────────────────────────────

  /**
   * Génère le HTML du panneau en fonction de l'état courant.
   * Trois états possibles :
   *   1. loading  — spinner + message d'attente
   *   2. error    — message d'erreur avec action de récupération
   *   3. résultat — score de risque, liste des problèmes, mentions légales
   *
   * Note : le HTML est généré côté client et inséré via innerHTML.
   * Les données provenant de l'IA (issues, disclaimers) sont du texte
   * non interprété comme HTML — risque XSS limité mais à garder en tête
   * si l'on ouvre l'outil à des e-mails malveillants.
   *
   * @param {object} state
   * @returns {string} HTML complet du panneau
   */
  function buildPanelHTML(state) {
    // ── État : chargement ───────────────────────────────────────────────────
    if (state.loading) {
      return `
        <div class="cg-header">
          <div class="cg-logo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
              <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            ComplianceGuard
          </div>
          <button id="cg-close" class="cg-close-btn" aria-label="Fermer">✕</button>
        </div>
        <div class="cg-loading">
          <div class="cg-spinner"></div>
          <p class="cg-loading-title">Analyse en cours…</p>
          <p class="cg-loading-sub">AMF · MIF II · RGPD · CMF</p>
        </div>
      `;
    }

    // ── État : erreur ────────────────────────────────────────────────────────
    if (state.error) {
      const messages = {
        NO_API_KEY:    `<p>Aucune clé API configurée.</p><button id="cg-open-settings" class="cg-settings-link">Ouvrir les paramètres →</button>`,
        EMPTY:         `<p>${state.message}</p>`,
        API_ERROR:     `<p>Erreur API : ${state.message}</p>`,
        PARSE_ERROR:   `<p>Réponse illisible. Veuillez réessayer.</p>`,
        NETWORK_ERROR: `<p>Erreur réseau : ${state.message}</p>`
      };
      return `
        <div class="cg-header">
          <div class="cg-logo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            </svg>
            ComplianceGuard
          </div>
          <button id="cg-close" class="cg-close-btn">✕</button>
        </div>
        <div class="cg-error">
          <div class="cg-error-icon">⚠</div>
          ${messages[state.error] || `<p>${state.message}</p>`}
        </div>
      `;
    }

    // ── État : résultats ─────────────────────────────────────────────────────
    const r = state.result;
    if (!r) return `<div class="cg-header"><button id="cg-close" class="cg-close-btn">✕</button></div><p class="cg-pad">Aucun résultat.</p>`;

    // Score de risque : 0-39 = conforme, 40-69 = modéré, 70-100 = élevé
    const score      = r.riskScore ?? 0;
    const scoreClass = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
    const scoreLabel = score >= 70 ? "Risque élevé" : score >= 40 ? "Risque modéré" : "Conforme";

    const indexedIssues = (r.issues || []).map((issue, index) => ({ ...issue, __index: index }));
    const criticals = indexedIssues.filter(i => i.severity === "critical");
    const warnings  = indexedIssues.filter(i => i.severity === "warning");
    const infos     = indexedIssues.filter(i => i.severity === "info");

    // Correspondance entre les types de problèmes (codes IA) et les libellés affichés
    const typeLabel = {
      MENTION_PERFORMANCES_PASSEES: "Performances passées",
      GARANTIE_RENDEMENT:           "Garantie de rendement",
      ABSENCE_MISE_EN_GARDE:        "Avertissement absent",
      VIOLATION_RGPD:               "Violation RGPD",
      INFORMATION_TROMPEUSE:        "Information trompeuse",
      ABSENCE_MENTION_AMF:          "Mention AMF absente",
      VIOLATION_LCBFT:              "Violation LCB-FT",
      CONFLIT_INTERETS:             "Conflit d'intérêts",
      MANQUEMENT_REGLEMENTAIRE:     "Manquement réglementaire",
      // Codes hérités de l'ancienne version (rétrocompatibilité)
      DISCLAIMER_MISSING:           "Mention légale absente",
      GDPR_VIOLATION:               "Violation RGPD",
      DATA_PRIVACY:                 "Données personnelles"
    };

    /** Génère le HTML pour un groupe de problèmes d'une même sévérité. */
    function renderIssues(issues, cls) {
      return issues.map(issue => `
        <div class="cg-issue cg-issue-${cls}">
          <div class="cg-issue-top">
            <span class="cg-issue-type">${typeLabel[issue.type] || issue.type}</span>
            <span class="cg-issue-reg">${issue.regulation || ""}</span>
          </div>
          <p class="cg-issue-desc">${issue.description}</p>
          ${issue.quote ? `<blockquote class="cg-issue-quote">${issue.quote}</blockquote>` : ""}
          ${issue.quote
            ? `<div class="cg-issue-actions"><button class="cg-issue-focus-btn" data-issue-index="${issue.__index}">Modifier ce passage</button></div>`
            : ""}
        </div>
      `).join("");
    }

    // HTML des mentions légales avec bouton "Copier" individuel
    const disclaimersHTML = (r.requiredDisclaimers || []).map(d => `
      <div class="cg-disclaimer">
        <div class="cg-disclaimer-top">
          <span class="cg-disclaimer-reg">${d.regulation}</span>
          <span class="cg-disclaimer-jur">${d.jurisdiction}</span>
        </div>
        <p class="cg-disclaimer-text">${d.text}</p>
        <button class="cg-copy-btn" data-text="${d.text.replace(/"/g, '&quot;')}">Copier</button>
      </div>
    `).join("");

    // La correction complète est disponible si l'IA a fourni un e-mail réécrit
    const hasCorrection =
      (r.correctedEmail && r.correctedEmail.length > 10) ||
      (r.correctedSubject && r.correctedSubject.trim().length > 0);

    return `
      <div class="cg-header">
        <div class="cg-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          ComplianceGuard
        </div>
        <button id="cg-close" class="cg-close-btn" aria-label="Fermer">✕</button>
      </div>

      <!-- Score de risque global -->
      <div class="cg-score-section">
        <div class="cg-score-ring cg-score-${scoreClass}">
          <span class="cg-score-num">${score}</span>
        </div>
        <div class="cg-score-info">
          <p class="cg-score-label cg-score-label-${scoreClass}">${scoreLabel}</p>
          <p class="cg-summary">${r.summary || ""}</p>
        </div>
      </div>

      <!-- Bannière de correction rapide (si l'IA a produit une version corrigée) -->
      ${hasCorrection ? `
        <div class="cg-correction-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
          </svg>
          Une correction complète est disponible
          <button id="cg-apply-correction" class="cg-correction-btn">Corriger tout</button>
        </div>
      ` : ""}

      <!-- Liste des problèmes détectés, groupés par sévérité -->
      ${r.issues?.length ? `
        <div class="cg-section">
          <div class="cg-section-title">Problèmes <span class="cg-badge">${r.issues.length}</span></div>
          ${criticals.length ? `<p class="cg-group-label cg-group-critical">Critiques (${criticals.length})</p>${renderIssues(criticals, "critical")}` : ""}
          ${warnings.length  ? `<p class="cg-group-label cg-group-warning">Avertissements (${warnings.length})</p>${renderIssues(warnings, "warning")}` : ""}
          ${infos.length     ? `<p class="cg-group-label cg-group-info">Informations (${infos.length})</p>${renderIssues(infos, "info")}` : ""}
        </div>
      ` : `
        <div class="cg-section">
          <div class="cg-clean">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
            </svg>
            Aucun problème de conformité détecté
          </div>
        </div>
      `}

      <!-- Mentions légales à insérer dans l'e-mail -->
      ${r.requiredDisclaimers?.length ? `
        <div class="cg-section">
          <div class="cg-section-title">
            Mentions légales obligatoires
            <span class="cg-badge">${r.requiredDisclaimers.length}</span>
          </div>
          ${disclaimersHTML}
          <button id="cg-insert-all" class="cg-insert-btn">Insérer toutes les mentions</button>
        </div>
      ` : ""}

      <div class="cg-footer">
        ComplianceGuard · Droit français &amp; européen
      </div>
    `;
  }

  // ─── Observation du DOM ───────────────────────────────────────────────────

  /**
   * Lance un MutationObserver sur document.body pour détecter
   * l'apparition dynamique de la barre d'outils de composition.
   * Gmail crée la fenêtre de composition de manière asynchrone —
   * sans cet observateur, le bouton ne serait jamais injecté.
   */
  function observe() {
    const mo = new MutationObserver(() => {
      const toolbar = findComposeToolbar();
      if (toolbar) {
        injectScanButton(toolbar);
        attachComposeListener();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Raccourci clavier ────────────────────────────────────────────────────

  /**
   * Alt+Maj+C (Windows/Linux) — déclenche le scan manuel.
   * Ce raccourci ne rentre pas en conflit avec les raccourcis Gmail natifs.
   */
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.key === "C") {
      removeToast();
      triggerScan(true);
    }
  });

  window.addEventListener("resize", () => {
    if (!activePanel) return;
    if (panelManualPosition) {
      applyPanelPosition(activePanel, panelManualPosition);
      return;
    }
    positionPanel(activePanel);
  });

  // ─── Messages entrants depuis le popup ────────────────────────────────────

  /** Le popup peut déclencher un scan en cliquant sur son bouton principal. */
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_SCAN") {
      removeToast();
      triggerScan(true);
    }
  });

  // ─── Démarrage ────────────────────────────────────────────────────────────
  observe();

})();
