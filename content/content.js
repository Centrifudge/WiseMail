// content.js — injects ComplianceGuard UI into Gmail and Outlook

(function () {
  "use strict";

  let activePanel = null;
  let scanButton = null;
  let currentEmailText = "";

  // ─── Detect email client ───────────────────────────────────────────────────
  function getEmailClient() {
    if (location.hostname.includes("mail.google.com")) return "gmail";
    if (location.hostname.includes("outlook")) return "outlook";
    return "unknown";
  }

  // ─── Extract email body text ───────────────────────────────────────────────
  function extractEmailText() {
    const client = getEmailClient();

    if (client === "gmail") {
      // Gmail compose window
      const compose = document.querySelector('[role="textbox"][aria-label*="Message Body"], [g_editable="true"], .Am.Al.editable');
      if (compose) return compose.innerText || compose.textContent || "";

      // Gmail reading pane
      const reading = document.querySelector('.ii.gt .a3s.aiL, .a3s.aXjCH');
      if (reading) return reading.innerText || "";

      // Subject + body
      const subject = document.querySelector('h2.hP');
      const body = document.querySelector('.ii.gt');
      if (body) return (subject?.innerText || "") + "\n" + body.innerText;
    }

    if (client === "outlook") {
      const compose = document.querySelector('[aria-label="Message body, press Alt+F10 to exit"], .dFCbN');
      if (compose) return compose.innerText || "";

      const reading = document.querySelector('[role="document"] .allowTextSelection');
      if (reading) return reading.innerText || "";
    }

    return "";
  }

  // ─── Find compose toolbar (Gmail) ─────────────────────────────────────────
  function findComposeToolbar() {
    return (
      document.querySelector('.btC .gU.Up') ||
      document.querySelector('.aDh') ||
      document.querySelector('[data-tooltip="More formatting options"]')?.closest('.btC')
    );
  }

  // ─── Inject scan button into compose toolbar ───────────────────────────────
  function injectScanButton(toolbar) {
    if (document.getElementById("cg-scan-btn")) return;

    scanButton = document.createElement("div");
    scanButton.id = "cg-scan-btn";
    scanButton.title = "ComplianceGuard: Scan for compliance issues";
    scanButton.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Compliance</span>
    `;

    scanButton.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerScan();
    });

    toolbar.appendChild(scanButton);
  }

  // ─── Main scan trigger ─────────────────────────────────────────────────────
  async function triggerScan() {
    const text = extractEmailText();
    currentEmailText = text;

    if (!text || text.trim().length < 20) {
      showPanel({ error: "EMPTY", message: "No email content detected. Please open or compose an email first." });
      return;
    }

    showPanel({ loading: true, emailText: text });

    const settings = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });
    const jurisdiction = settings.jurisdiction || "EU";

    const response = await browser.runtime.sendMessage({
      type: "ANALYZE_EMAIL",
      emailText: text,
      jurisdiction
    });

    showPanel({ loading: false, ...response, emailText: text });
  }

  // ─── Panel rendering ───────────────────────────────────────────────────────
  function showPanel(state) {
    removePanel();
    activePanel = document.createElement("div");
    activePanel.id = "cg-panel";
    activePanel.innerHTML = buildPanelHTML(state);
    document.body.appendChild(activePanel);

    // Wire up close button
    activePanel.querySelector("#cg-close")?.addEventListener("click", removePanel);

    // Wire up copy disclaimer buttons
    activePanel.querySelectorAll(".cg-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.text;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => btn.textContent = "Copy", 1500);
        });
      });
    });

    // Wire up insert-all disclaimers button
    activePanel.querySelector("#cg-insert-all")?.addEventListener("click", () => {
      insertDisclaimersIntoCompose(state.result?.requiredDisclaimers || []);
    });
  }

  function removePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
  }

  function buildPanelHTML(state) {
    if (state.loading) {
      return `
        <div class="cg-header">
          <div class="cg-logo">⚖ ComplianceGuard</div>
          <button id="cg-close" class="cg-close-btn">✕</button>
        </div>
        <div class="cg-loading">
          <div class="cg-spinner"></div>
          <p>Analyzing for compliance issues…</p>
          <p class="cg-sub">Checking MiFID II · SEC · FCA · GDPR</p>
        </div>
      `;
    }

    if (state.error) {
      const messages = {
        NO_API_KEY: `<p>No API key configured.</p><p><a href="#" id="cg-open-settings">Open Settings →</a></p>`,
        EMPTY: `<p>${state.message}</p>`,
        API_ERROR: `<p>API error: ${state.message}</p>`,
        PARSE_ERROR: `<p>Could not parse AI response. Try again.</p>`,
        NETWORK_ERROR: `<p>Network error: ${state.message}</p>`
      };
      return `
        <div class="cg-header">
          <div class="cg-logo">⚖ ComplianceGuard</div>
          <button id="cg-close" class="cg-close-btn">✕</button>
        </div>
        <div class="cg-error">
          <div class="cg-error-icon">⚠</div>
          ${messages[state.error] || `<p>${state.message}</p>`}
        </div>
      `;
    }

    const r = state.result;
    if (!r) return `<div class="cg-header"><button id="cg-close" class="cg-close-btn">✕</button></div><p>No result.</p>`;

    const score = r.riskScore ?? 0;
    const scoreClass = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
    const scoreLabel = score >= 70 ? "High Risk" : score >= 40 ? "Medium Risk" : "Low Risk";

    const criticalIssues = (r.issues || []).filter(i => i.severity === "critical");
    const warningIssues = (r.issues || []).filter(i => i.severity === "warning");
    const infoIssues = (r.issues || []).filter(i => i.severity === "info");

    const issueIcon = { critical: "🔴", warning: "🟡", info: "🔵" };
    const typeLabel = {
      DISCLAIMER_MISSING: "Disclaimer Missing",
      GDPR_VIOLATION: "GDPR Violation",
      MISLEADING_CLAIM: "Misleading Claim",
      PAST_PERFORMANCE: "Past Performance",
      UNSUBSTANTIATED_CLAIM: "Unsubstantiated Claim",
      REGULATORY_BREACH: "Regulatory Breach",
      DATA_PRIVACY: "Data Privacy"
    };

    function renderIssues(issues) {
      return issues.map(issue => `
        <div class="cg-issue cg-issue-${issue.severity}">
          <div class="cg-issue-header">
            <span class="cg-issue-type">${typeLabel[issue.type] || issue.type}</span>
            <span class="cg-issue-reg">${issue.regulation || ""}</span>
          </div>
          <p class="cg-issue-desc">${issue.description}</p>
          ${issue.quote ? `<blockquote class="cg-issue-quote">"${issue.quote}"</blockquote>` : ""}
        </div>
      `).join("");
    }

    const disclaimersHTML = (r.requiredDisclaimers || []).map((d, i) => `
      <div class="cg-disclaimer">
        <div class="cg-disclaimer-header">
          <span class="cg-disclaimer-reg">${d.regulation}</span>
          <span class="cg-disclaimer-jur">${d.jurisdiction}</span>
        </div>
        <p class="cg-disclaimer-text">${d.text}</p>
        <button class="cg-copy-btn" data-text="${d.text.replace(/"/g, '&quot;')}">Copy</button>
      </div>
    `).join("");

    return `
      <div class="cg-header">
        <div class="cg-logo">⚖ ComplianceGuard</div>
        <button id="cg-close" class="cg-close-btn">✕</button>
      </div>

      <div class="cg-score-row">
        <div class="cg-score-ring cg-score-${scoreClass}">
          <span class="cg-score-num">${score}</span>
          <span class="cg-score-label">${scoreLabel}</span>
        </div>
        <p class="cg-summary">${r.summary || ""}</p>
      </div>

      ${r.issues?.length ? `
        <div class="cg-section">
          <div class="cg-section-title">
            Issues Found
            <span class="cg-badge">${r.issues.length}</span>
          </div>
          ${criticalIssues.length ? `<div class="cg-severity-group"><p class="cg-severity-label">${issueIcon.critical} Critical (${criticalIssues.length})</p>${renderIssues(criticalIssues)}</div>` : ""}
          ${warningIssues.length ? `<div class="cg-severity-group"><p class="cg-severity-label">${issueIcon.warning} Warnings (${warningIssues.length})</p>${renderIssues(warningIssues)}</div>` : ""}
          ${infoIssues.length ? `<div class="cg-severity-group"><p class="cg-severity-label">${issueIcon.info} Info (${infoIssues.length})</p>${renderIssues(infoIssues)}</div>` : ""}
        </div>
      ` : `<div class="cg-section"><p class="cg-clean">✓ No compliance issues detected</p></div>`}

      ${r.requiredDisclaimers?.length ? `
        <div class="cg-section">
          <div class="cg-section-title">
            Required Disclaimers
            <span class="cg-badge">${r.requiredDisclaimers.length}</span>
          </div>
          ${disclaimersHTML}
          <button id="cg-insert-all" class="cg-insert-btn">Insert All Disclaimers Into Email</button>
        </div>
      ` : ""}

      <div class="cg-footer">
        ComplianceGuard v1.0 · <a href="#" id="cg-settings-link">Settings</a>
      </div>
    `;
  }

  // ─── Insert disclaimers into compose window ────────────────────────────────
  function insertDisclaimersIntoCompose(disclaimers) {
    if (!disclaimers.length) return;
    const client = getEmailClient();
    const disclaimerText = "\n\n─────────────────────────────\nREQUIRED DISCLOSURES:\n\n" +
      disclaimers.map(d => `[${d.regulation}] ${d.text}`).join("\n\n");

    if (client === "gmail") {
      const compose = document.querySelector('[g_editable="true"], .Am.Al.editable, [role="textbox"]');
      if (compose) {
        compose.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(compose);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, disclaimerText);
      }
    }
  }

  // ─── Observe DOM for compose windows (Gmail dynamically creates them) ──────
  function observe() {
    const mo = new MutationObserver(() => {
      const toolbar = findComposeToolbar();
      if (toolbar) injectScanButton(toolbar);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Keyboard shortcut: Alt+Shift+C ───────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.key === "C") {
      triggerScan();
    }
  });

  // ─── Message from popup ────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_SCAN") triggerScan();
  });

  observe();
})();
