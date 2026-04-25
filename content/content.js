// content.js — ComplianceGuard injecté dans Gmail

(function () {
  "use strict";

  let activePanel = null;
  let activeToast = null;
  let debounceTimer = null;
  let lastAnalyzedText = "";
  let isAnalyzing = false;

  // ─── Détection du client mail ──────────────────────────────────────────────
  function getEmailClient() {
    if (location.hostname.includes("mail.google.com")) return "gmail";
    if (location.hostname.includes("outlook")) return "outlook";
    return "unknown";
  }

  // ─── Extraction du corps de l'e-mail ──────────────────────────────────────
  function extractEmailText() {
    if (getEmailClient() === "gmail") {
      const compose = document.querySelector('[role="textbox"][aria-label*="Message Body"], [g_editable="true"], .Am.Al.editable');
      if (compose) return compose.innerText || compose.textContent || "";
      const subject = document.querySelector('h2.hP');
      const body = document.querySelector('.ii.gt');
      if (body) return (subject?.innerText || "") + "\n" + body.innerText;
    }
    if (getEmailClient() === "outlook") {
      const compose = document.querySelector('[aria-label="Message body, press Alt+F10 to exit"], .dFCbN');
      if (compose) return compose.innerText || "";
      const reading = document.querySelector('[role="document"] .allowTextSelection');
      if (reading) return reading.innerText || "";
    }
    return "";
  }

  // ─── Extraction de l'e-mail du destinataire ───────────────────────────────
  function extractRecipientEmail() {
    // Cherche dans la fenêtre de composition Gmail
    const toChips = document.querySelectorAll('.vO[data-hovercard-id], .aB .vO');
    for (const chip of toChips) {
      const email = chip.dataset.hovercardId || chip.getAttribute('email');
      if (email && email.includes('@')) return email;
    }
    // Fallback : cherche via aria-label "À"
    const toField = document.querySelector('[aria-label="À"], [aria-label="To"], [name="to"]');
    if (toField) {
      const match = toField.value?.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (match) return match[0];
    }
    return "";
  }

  // ─── Domaine de l'expéditeur (non sensible) ───────────────────────────────
  function getSenderDomain() {
    // Extrait le domaine à partir de l'adresse Gmail connectée
    const accountEl = document.querySelector('[data-email]');
    if (accountEl) {
      const email = accountEl.dataset.email;
      if (email && email.includes('@')) return email.split('@')[1];
    }
    return "";
  }

  // ─── Barre d'outils de la fenêtre de composition ─────────────────────────
  function findComposeToolbar() {
    return (
      document.querySelector('.btC .gU.Up') ||
      document.querySelector('.aDh') ||
      document.querySelector('[data-tooltip="More formatting options"]')?.closest('.btC')
    );
  }

  // ─── Injection du bouton dans la barre d'outils ───────────────────────────
  function injectScanButton(toolbar) {
    if (document.getElementById("cg-scan-btn")) return;

    const btn = document.createElement("button");
    btn.id = "cg-scan-btn";
    btn.title = "ComplianceGuard — Vérifier la conformité";
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Conformité
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeToast();
      triggerScan(true);
    });
    toolbar.appendChild(btn);
  }

  // ─── Écoute de la frappe dans la fenêtre de composition ───────────────────
  function attachComposeListener() {
    const compose = document.querySelector('[role="textbox"][aria-label*="Message Body"], [g_editable="true"], .Am.Al.editable');
    if (!compose || compose.dataset.cgListening) return;
    compose.dataset.cgListening = "true";

    compose.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const text = compose.innerText || compose.textContent || "";
        if (text.trim().length >= 30 && text !== lastAnalyzedText && !isAnalyzing) {
          triggerAutoScan(text);
        }
      }, 2000);
    });
  }

  // ─── Scan automatique (discret) ───────────────────────────────────────────
  async function triggerAutoScan(text) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    lastAnalyzedText = text;

    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!settings.apiKey) { isAnalyzing = false; return; }

    const response = await browser.runtime.sendMessage({
      type: "ANALYZE_EMAIL",
      emailText: text,
      jurisdiction: settings.jurisdiction || "FR",
      recipientEmail: extractRecipientEmail(),
      senderDomain: getSenderDomain()
    });

    isAnalyzing = false;

    if (response.success && response.result) {
      const r = response.result;
      const critical = (r.issues || []).filter(i => i.severity === "critical").length;
      const warnings = (r.issues || []).filter(i => i.severity === "warning").length;
      if (critical > 0 || warnings > 0) {
        showCorrectionToast(r);
      }
    }
  }

  // ─── Scan manuel (ouvre le panneau complet) ───────────────────────────────
  async function triggerScan(showFullPanel = true) {
    const text = extractEmailText();
    if (!text || text.trim().length < 20) {
      if (showFullPanel) showPanel({ error: "EMPTY", message: "Aucun contenu d'e-mail détecté. Rédigez ou ouvrez un e-mail." });
      return;
    }

    if (showFullPanel) showPanel({ loading: true });

    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });

    const response = await browser.runtime.sendMessage({
      type: "ANALYZE_EMAIL",
      emailText: text,
      jurisdiction: settings.jurisdiction || "FR",
      recipientEmail: extractRecipientEmail(),
      senderDomain: getSenderDomain()
    });

    if (showFullPanel) showPanel({ ...response, emailText: text });
  }

  // ─── Toast de suggestion (auto-scan) ──────────────────────────────────────
  function showCorrectionToast(result) {
    removeToast();

    const critical = (result.issues || []).filter(i => i.severity === "critical").length;
    const warnings = (result.issues || []).filter(i => i.severity === "warning").length;
    const hasCorrection = result.correctedEmail && result.correctedEmail.length > 10;
    const hasDisclaimers = result.requiredDisclaimers?.length > 0;

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
        ${(hasCorrection || hasDisclaimers) ? `<button class="cg-toast-btn cg-toast-accept" id="cg-toast-accept">Corriger</button>` : ""}
        <button class="cg-toast-btn cg-toast-details" id="cg-toast-details">Détails</button>
        <button class="cg-toast-btn cg-toast-dismiss" id="cg-toast-close">✕</button>
      </div>
    `;

    document.body.appendChild(activeToast);

    activeToast.querySelector("#cg-toast-close")?.addEventListener("click", removeToast);

    activeToast.querySelector("#cg-toast-accept")?.addEventListener("click", () => {
      if (result.correctedEmail && result.correctedEmail.length > 10) {
        applyEmailCorrection(result.correctedEmail);
      } else if (result.requiredDisclaimers?.length) {
        insertDisclaimersIntoCompose(result.requiredDisclaimers);
      }
      removeToast();
    });

    activeToast.querySelector("#cg-toast-details")?.addEventListener("click", () => {
      removeToast();
      showPanel({ success: true, result, emailText: lastAnalyzedText });
    });

    // Auto-dismiss après 12 secondes
    setTimeout(() => { if (activeToast) removeToast(); }, 12000);
  }

  function removeToast() {
    if (activeToast) { activeToast.remove(); activeToast = null; }
  }

  // ─── Application de la correction complète ─────────────────────────────────
  function applyEmailCorrection(correctedText) {
    const compose = document.querySelector('[g_editable="true"], .Am.Al.editable, [role="textbox"]');
    if (compose) {
      compose.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, correctedText);
    }
  }

  // ─── Insertion des mentions légales ───────────────────────────────────────
  function insertDisclaimersIntoCompose(disclaimers) {
    if (!disclaimers.length) return;
    const text = "\n\n─────────────────────────────\nMENTIONS LÉGALES OBLIGATOIRES :\n\n" +
      disclaimers.map(d => `[${d.regulation}] ${d.text}`).join("\n\n");
    const compose = document.querySelector('[g_editable="true"], .Am.Al.editable, [role="textbox"]');
    if (compose) {
      compose.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(compose);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
    }
  }

  // ─── Panneau complet ───────────────────────────────────────────────────────
  function showPanel(state) {
    removePanel();
    activePanel = document.createElement("div");
    activePanel.id = "cg-panel";
    activePanel.innerHTML = buildPanelHTML(state);
    document.body.appendChild(activePanel);

    activePanel.querySelector("#cg-close")?.addEventListener("click", removePanel);

    activePanel.querySelectorAll(".cg-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.text).then(() => {
          btn.textContent = "Copié !";
          setTimeout(() => btn.textContent = "Copier", 1500);
        });
      });
    });

    activePanel.querySelector("#cg-insert-all")?.addEventListener("click", () => {
      insertDisclaimersIntoCompose(state.result?.requiredDisclaimers || []);
    });

    activePanel.querySelector("#cg-apply-correction")?.addEventListener("click", () => {
      if (state.result?.correctedEmail) {
        applyEmailCorrection(state.result.correctedEmail);
        activePanel.querySelector("#cg-apply-correction").textContent = "Correction appliquée ✓";
      }
    });

    activePanel.querySelector("#cg-open-settings")?.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "OPEN_SETTINGS" });
    });
  }

  function removePanel() {
    if (activePanel) { activePanel.remove(); activePanel = null; }
  }

  // ─── Construction du HTML du panneau ──────────────────────────────────────
  function buildPanelHTML(state) {
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

    if (state.error) {
      const messages = {
        NO_API_KEY: `<p>Aucune clé API configurée.</p><button id="cg-open-settings" class="cg-settings-link">Ouvrir les paramètres →</button>`,
        EMPTY:      `<p>${state.message}</p>`,
        API_ERROR:  `<p>Erreur API : ${state.message}</p>`,
        PARSE_ERROR:`<p>Réponse illisible. Veuillez réessayer.</p>`,
        NETWORK_ERROR:`<p>Erreur réseau : ${state.message}</p>`
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

    const r = state.result;
    if (!r) return `<div class="cg-header"><button id="cg-close" class="cg-close-btn">✕</button></div><p class="cg-pad">Aucun résultat.</p>`;

    const score = r.riskScore ?? 0;
    const scoreClass = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
    const scoreLabel = score >= 70 ? "Risque élevé" : score >= 40 ? "Risque modéré" : "Conforme";

    const criticals = (r.issues || []).filter(i => i.severity === "critical");
    const warnings  = (r.issues || []).filter(i => i.severity === "warning");
    const infos     = (r.issues || []).filter(i => i.severity === "info");

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
      DISCLAIMER_MISSING:           "Mention légale absente",
      GDPR_VIOLATION:               "Violation RGPD",
      DATA_PRIVACY:                 "Données personnelles"
    };

    function renderIssues(issues, cls) {
      return issues.map(issue => `
        <div class="cg-issue cg-issue-${cls}">
          <div class="cg-issue-top">
            <span class="cg-issue-type">${typeLabel[issue.type] || issue.type}</span>
            <span class="cg-issue-reg">${issue.regulation || ""}</span>
          </div>
          <p class="cg-issue-desc">${issue.description}</p>
          ${issue.quote ? `<blockquote class="cg-issue-quote">${issue.quote}</blockquote>` : ""}
        </div>
      `).join("");
    }

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

    const hasCorrection = r.correctedEmail && r.correctedEmail.length > 10;

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

      <div class="cg-score-section">
        <div class="cg-score-ring cg-score-${scoreClass}">
          <span class="cg-score-num">${score}</span>
        </div>
        <div class="cg-score-info">
          <p class="cg-score-label cg-score-label-${scoreClass}">${scoreLabel}</p>
          <p class="cg-summary">${r.summary || ""}</p>
        </div>
      </div>

      ${hasCorrection ? `
        <div class="cg-correction-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
          Une version corrigée est disponible
          <button id="cg-apply-correction" class="cg-correction-btn">Appliquer</button>
        </div>
      ` : ""}

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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
            Aucun problème de conformité détecté
          </div>
        </div>
      `}

      ${r.requiredDisclaimers?.length ? `
        <div class="cg-section">
          <div class="cg-section-title">Mentions légales obligatoires <span class="cg-badge">${r.requiredDisclaimers.length}</span></div>
          ${disclaimersHTML}
          <button id="cg-insert-all" class="cg-insert-btn">Insérer toutes les mentions</button>
        </div>
      ` : ""}

      <div class="cg-footer">
        ComplianceGuard · Droit français & européen
      </div>
    `;
  }

  // ─── Observation des mutations DOM ────────────────────────────────────────
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

  // ─── Raccourci clavier : Alt+Maj+C ───────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.key === "C") {
      removeToast();
      triggerScan(true);
    }
  });

  // ─── Message du popup ─────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_SCAN") { removeToast(); triggerScan(true); }
  });

  observe();
})();
