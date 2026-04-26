/**
 * content.js — Script injected into Gmail (and Outlook) by WiseMail
 *
 * Responsibilities:
 *   - Monitor the compose window, trigger compliance analyses,
 *     and display results without disrupting the Gmail interface.
 *
 * Two trigger modes:
 *   1. Automatic — user stops typing for 2 seconds: a compact toast appears
 *      with detected issues and a "Fix" button to apply the corrected version.
 *   2. Manual — click the "Compliance" toolbar button or press Alt+Shift+C:
 *      opens the full detail panel.
 *
 * Attachment scanning:
 *   - File inputs in the compose area are intercepted when they change.
 *   - PDFs are parsed with a basic text extractor (BT/ET blocks).
 *   - Extracted text is sent to the AI alongside the email body.
 *   - Read failures are shown as warnings in the results panel.
 *
 * Architecture:
 *   - A MutationObserver watches the DOM for compose windows and file inputs
 *     (both are created dynamically by Gmail).
 *   - The compose close is detected by the same observer: when the compose
 *     element disappears, the panel and toast are dismissed automatically.
 *   - When an in-panel fix is applied, a background re-analysis runs silently
 *     and replaces the panel results when ready (no loading flash).
 *   - All AI communication goes via browser.runtime.sendMessage to background.js.
 */

(function () {
  "use strict";

  // ─── Global state ─────────────────────────────────────────────────────────

  let activePanel = null;
  let activeToast = null;
  let debounceTimer = null;
  let lastAnalyzedText = "";
  let lastFixedText = "";           // Text snapshot right after a fix was applied
  let isAnalyzing = false;
  let panelManualPosition = null;
  let composeCloseTimer = null;    // Debounce for compose-close detection
  let backgroundRescanRunning = false;

  const highlightedIssueSpans = new Map();
  // fileName → { text: string, error: string|null, size: number }
  const attachmentContent = new Map();

  async function sendMessage(msg) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (err) {
      const isDeadWorker = err?.message?.includes("Receiving end does not exist") ||
                           err?.message?.includes("Could not establish connection");
      if (!isDeadWorker) throw err;
      // Service worker was killed — wait briefly for Chrome to restart it, then retry once
      await new Promise(r => setTimeout(r, 300));
      return await browser.runtime.sendMessage(msg);
    }
  }

  const COMPOSE_SELECTOR = [
    // Gmail
    '[role="textbox"][aria-label*="Message Body"]',
    '[g_editable="true"]',
    '.Am.Al.editable',
    // Outlook Web — all variants (EN + FR aria-labels)
    '[aria-label*="Message body"][contenteditable="true"]',
    '[aria-label*="message body"][contenteditable="true"]',
    '[aria-label*="Corps du message"][contenteditable="true"]',
    '[aria-label*="corps du message"][contenteditable="true"]',
    'div[data-testid="compose-body-editor"]',
    '.dFCbN[contenteditable="true"]',
    // New Outlook (cloud.microsoft) — generic fallback inside compose pane
    '.ReadingPaneContent [contenteditable="true"]',
    '[class*="compose"] [contenteditable="true"]',
  ].join(", ");

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
    const root = composeContainer || document;
    return (
      // Gmail
      root.querySelector('input[name="subjectbox"]') ||
      root.querySelector('input[placeholder="Objet"]') ||
      root.querySelector('input[placeholder="Subject"]') ||
      // Outlook Web (classic + new, EN + FR)
      root.querySelector('input[aria-label="Add a subject"]') ||
      root.querySelector('input[aria-label="Ajouter un objet"]') ||
      root.querySelector('input[placeholder*="subject" i]') ||
      root.querySelector('input[placeholder*="objet" i]') ||
      document.querySelector('input[data-testid="compose-subject-input"]') ||
      document.querySelector('input[aria-label="Add a subject"]') ||
      document.querySelector('input[aria-label="Ajouter un objet"]')
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
    if (persist) panelManualPosition = safePosition;
  }

  function rectanglesOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
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

    const composeRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let best = null;
    for (const candidate of candidates) {
      const safe = clampPanelPosition(panel, candidate);
      const panelRect = { left: safe.left, top: safe.top, right: safe.left + panelWidth, bottom: safe.top + panelHeight };
      const overlapsCompose = rectanglesOverlap(panelRect, composeRect);
      const score = overlapsCompose ? 100 + (candidate.priority || 0) : (candidate.priority || 0);
      if (!best || score < best.score) best = { score, position: safe };
    }
    return best?.position || fallback;
  }

  function positionPanel(panel) {
    if (panelManualPosition) { applyPanelPosition(panel, panelManualPosition); return; }
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

      const onMove = (e) => applyPanelPosition(panel, { left: e.clientX - offsetX, top: e.clientY - offsetY }, true);
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

  // ─── PDF text extraction ──────────────────────────────────────────────────

  /**
   * Extracts plain text from a PDF ArrayBuffer using the BT/ET operator approach.
   * Works for PDFs with standard Type 1 / TrueType text encoding.
   * Returns an empty string for scanned images or encrypted documents.
   */
  function extractTextFromPDFBuffer(buffer) {
    let raw;
    try {
      // new Uint8Array(buffer) clones into content-script compartment to avoid Firefox Xray errors
      raw = new TextDecoder("latin1").decode(new Uint8Array(new Uint8Array(buffer)));
    } catch {
      return "";
    }

    const parts = [];
    const btEtRegex = /BT\s([\s\S]*?)ET/g;
    let block;
    while ((block = btEtRegex.exec(raw)) !== null) {
      // Match (string)Tj  or  [(string)]TJ  operators
      const tjRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;
      let match;
      while ((match = tjRegex.exec(block[1])) !== null) {
        const raw2 = match[1] || match[2] || "";
        const decoded = raw2
          .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
          .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")
          .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
        if (decoded.trim()) parts.push(decoded.trim());
      }
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // ─── Attachment interception ──────────────────────────────────────────────

  async function extractTextFromDocx(buffer) {
    // Clone buffer into content-script compartment to avoid Firefox Xray wrapper errors
    const raw = new Uint8Array(new Uint8Array(buffer));
    const target = "word/document.xml";
    let pos = 0;

    while (pos < raw.length - 30) {
      // ZIP local file header: PK\x03\x04
      if (raw[pos] !== 0x50 || raw[pos+1] !== 0x4b || raw[pos+2] !== 0x03 || raw[pos+3] !== 0x04) {
        pos++; continue;
      }
      const compMethod = raw[pos+8]  | (raw[pos+9]  << 8);
      const compSize   = raw[pos+18] | (raw[pos+19] << 8) | (raw[pos+20] << 16) | (raw[pos+21] << 24);
      const nameLen    = raw[pos+26] | (raw[pos+27] << 8);
      const extraLen   = raw[pos+28] | (raw[pos+29] << 8);
      const nameStart  = pos + 30;
      const fileName   = new TextDecoder().decode(raw.slice(nameStart, nameStart + nameLen));
      const dataStart  = nameStart + nameLen + extraLen;

      if (fileName === target) {
        const compData = raw.slice(dataStart, dataStart + compSize);
        let xml = "";

        if (compMethod === 0) {
          // Stored (uncompressed)
          xml = new TextDecoder().decode(compData);
        } else if (compMethod === 8) {
          // DEFLATE — decompress with native DecompressionStream
          try {
            const ds = new DecompressionStream("deflate-raw");
            const writer = ds.writable.getWriter();
            writer.write(compData);
            writer.close();
            const chunks = [];
            const reader = ds.readable.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            xml = new TextDecoder().decode(out);
          } catch {
            return "";
          }
        }

        // Strip XML tags and normalise whitespace
        return xml.replace(/<\/w:p>/gi, "\n")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim();
      }
      pos = dataStart + Math.max(compSize, 1);
    }
    return "";
  }

  async function processAttachment(file) {
    const name = file.name;
    const ext  = name.split(".").pop().toLowerCase();

    try {
      // Clone ArrayBuffer into content-script compartment before processing
      const rawBuffer = await file.arrayBuffer();
      const buffer = rawBuffer.slice(0);

      if (ext === "pdf" || file.type === "application/pdf") {
        const text = extractTextFromPDFBuffer(buffer);
        if (text.length > 20) {
          attachmentContent.set(name, { text, error: null, size: file.size });
        } else {
          attachmentContent.set(name, { text: "", error: "No extractable text — PDF may be scanned or image-based (text layer not found)", size: file.size });
        }

      } else if (ext === "txt" || file.type === "text/plain") {
        const text = await file.text();
        attachmentContent.set(name, { text: text.slice(0, 20000), error: null, size: file.size });

      } else if (ext === "csv" || file.type === "text/csv") {
        const text = await file.text();
        attachmentContent.set(name, { text: text.slice(0, 10000), error: null, size: file.size });

      } else if (ext === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const text = await extractTextFromDocx(buffer);
        if (text.length > 20) {
          attachmentContent.set(name, { text: text.slice(0, 20000), error: null, size: file.size });
        } else {
          attachmentContent.set(name, { text: "", error: "Could not extract text from this Word document (may be encrypted or image-based)", size: file.size });
        }

      } else {
        // Register unsupported type so the AI knows the file exists
        attachmentContent.set(name, { text: "", error: `Format .${ext} not supported for text extraction`, size: file.size });
      }
    } catch (err) {
      attachmentContent.set(name, { text: "", error: `Read error: ${err.message}`, size: file.size });
    }

    // Re-run analysis now that attachment content has changed
    const emailText = extractEmailText();
    if (emailText && emailText.trim().length >= 20) {
      triggerBackgroundRescan();
    }
  }

  function hookFileInput(input) {
    if (input.dataset.cgHooked) return;
    input.dataset.cgHooked = "true";
    input.addEventListener("change", () => {
      Array.from(input.files || []).forEach(processAttachment);
    });
  }

  /** Returns attachment data formatted for the AI prompt. */
  function getAttachmentsForAnalysis() {
    return Array.from(attachmentContent.entries()).map(([name, data]) => ({
      name,
      text: data.text,
      error: data.error,
    }));
  }

  // ─── Inline issue highlighting ────────────────────────────────────────────

  function normalizeIssueQuote(quote) {
    return (quote || "")
      .replace(/^[\s"'""«»]+|[\s"'""«»]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getIssueQuoteVariants(quote) {
    const trimmed = (quote || "").trim();
    const normalized = normalizeIssueQuote(quote);
    const variants = new Set([trimmed, normalized]);
    return [...variants].filter((v) => v && v.length >= 4);
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
      if (matchIndex > cursor) fragment.appendChild(document.createTextNode(original.slice(cursor, matchIndex)));

      const span = document.createElement("span");
      span.className = `cg-inline-issue cg-inline-issue-${issue.severity || "warning"}`;
      span.dataset.issueIndex = String(issueIndex);
      span.title = issue.description || "Compliance issue";
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
    while ((currentNode = walker.nextNode())) textNodes.push(currentNode);

    let count = 0;
    for (const node of textNodes) {
      if (!node.parentNode) continue;
      count += wrapIssueMatchesInTextNode(node, issue, issueIndex, variants);
    }
    return count;
  }

  function highlightIssuesInCompose(result) {
    clearInlineHighlights();
    const issues = (result?.issues || [])
      .map((issue, index) => ({ issue, index, quote: normalizeIssueQuote(issue.quote) }))
      .filter(({ quote }) => quote.length >= 4)
      .sort((a, b) => b.quote.length - a.quote.length);
    for (const { issue, index } of issues) highlightIssueQuote(issue, index);
  }

  function focusIssueInCompose(issueIndex) {
    const key = String(issueIndex);
    const compose = getComposeElement();
    const target = (highlightedIssueSpans.get(key) || []).find((s) => s.isConnected);
    if (!compose || !target) return false;

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
    return true;
  }

  // ─── Correction helpers ───────────────────────────────────────────────────

  function parseCorrectedEmailParts(resultOrText) {
    const result = typeof resultOrText === "string"
      ? { correctedEmail: resultOrText }
      : (resultOrText || {});
    let subject = (result.correctedSubject || "").trim();
    let body = (result.correctedEmail || "").trim();
    if (!body) return { subject, body: "" };

    const explicitSubjectMatch = body.match(/^\s*(?:Objet|Subject)\s*:\s*(.+)\n+/i);
    if (explicitSubjectMatch) {
      if (!subject) subject = explicitSubjectMatch[1].trim();
      body = body.slice(explicitSubjectMatch[0].length).trim();
    }
    return { subject, body };
  }

  function replaceFirstLiteralMatch(sourceText, needle, replacementText) {
    const index = sourceText.indexOf(needle);
    if (index === -1) return null;
    return sourceText.slice(0, index) + replacementText + sourceText.slice(index + needle.length);
  }

  function replaceIssueInSubject(issue, replacementText) {
    const subjectField = getSubjectField();
    if (!subjectField) return false;
    const current = subjectField.value || "";
    for (const variant of getIssueQuoteVariants(issue.quote)) {
      const updated = replaceFirstLiteralMatch(current, variant, replacementText);
      if (updated !== null) { setSubjectText(updated); return true; }
    }
    return false;
  }

  function replaceHighlightedIssue(issueIndex, replacementText) {
    const key = String(issueIndex);
    const target = (highlightedIssueSpans.get(key) || []).find((s) => s.isConnected);
    const compose = getComposeElement();
    if (!target || !compose) return false;

    compose.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    const replaced = document.execCommand("insertText", false, replacementText);
    selection.removeAllRanges();
    if (replaced || !target.isConnected) return true;

    target.replaceWith(document.createTextNode(replacementText));
    compose.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function replaceIssueFallbackInCompose(issue, replacementText) {
    const compose = getComposeElement();
    if (!compose) return false;
    const currentText = compose.innerText || compose.textContent || "";
    for (const variant of getIssueQuoteVariants(issue.quote)) {
      const updated = replaceFirstLiteralMatch(currentText, variant, replacementText);
      if (updated === null) continue;
      clearInlineHighlights();
      compose.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, updated);
      return true;
    }
    return false;
  }

  async function applySpecificIssueCorrection(result, issueIndex, button) {
    const issue = result?.issues?.[Number(issueIndex)];
    if (!issue) return;

    const replacementText = (issue.suggestedFix || "").trim();
    if (!replacementText) { focusIssueInCompose(issueIndex); return; }

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Applying...";

    const applied =
      replaceIssueInSubject(issue, replacementText) ||
      (focusIssueInCompose(issueIndex), replaceHighlightedIssue(issueIndex, replacementText)) ||
      replaceIssueFallbackInCompose(issue, replacementText);

    if (!applied) {
      button.textContent = "Not found";
      setTimeout(() => { button.disabled = false; button.textContent = originalLabel; }, 1200);
      return;
    }

    clearInlineHighlights();
    lastAnalyzedText = extractEmailText();
    removeToast();
    triggerBackgroundRescan();
    return true;
  }

  // ─── Email client detection ───────────────────────────────────────────────

  function getEmailClient() {
    const h = location.hostname;
    if (h.includes("mail.google.com")) return "gmail";
    if (h.includes("outlook") || h.includes("cloud.microsoft")) return "outlook";
    return "unknown";
  }

  // ─── Content extraction ───────────────────────────────────────────────────

  function extractEmailText() {
    if (getEmailClient() === "gmail") {
      const compose = getComposeElement();
      if (compose) return compose.innerText || compose.textContent || "";
      const subject = document.querySelector("h2.hP");
      const body = document.querySelector(".ii.gt");
      if (body) return (subject?.innerText || "") + "\n" + body.innerText;
    }
    if (getEmailClient() === "outlook") {
      const compose = getComposeElement();
      if (compose) return compose.innerText || "";
      const reading = document.querySelector('[role="document"] .allowTextSelection') ||
        document.querySelector('[role="document"][contenteditable="true"]');
      if (reading) return reading.innerText || "";
    }
    return "";
  }

  function extractRecipientEmail() {
    // Gmail chips
    const toChips = document.querySelectorAll('.vO[data-hovercard-id], .aB .vO');
    for (const chip of toChips) {
      const email = chip.dataset.hovercardId || chip.getAttribute("email");
      if (email && email.includes("@")) return email;
    }
    // Gmail / Outlook text field
    const toField = document.querySelector('[aria-label="À"], [aria-label="To"], [name="to"], [aria-label*="To" i][role="combobox"]');
    if (toField) {
      const match = toField.value?.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (match) return match[0];
    }
    // Outlook recipient pills
    const outlookPills = document.querySelectorAll('[data-testid="recipient-well"] [title*="@"], .ms-Persona-primaryText[title*="@"]');
    for (const pill of outlookPills) {
      const title = pill.getAttribute("title") || "";
      const match = title.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (match) return match[0];
    }
    return "";
  }

  function getSenderDomain() {
    const accountEl = document.querySelector("[data-email]");
    if (accountEl) {
      const email = accountEl.dataset.email;
      if (email && email.includes("@")) return email.split("@")[1];
    }
    return "";
  }

  // ─── Compose toolbar ──────────────────────────────────────────────────────

  function findComposeToolbar() {
    // Gmail
    const gmail = document.querySelector(".btC .gU.Up") ||
      document.querySelector(".aDh") ||
      document.querySelector('[data-tooltip="More formatting options"]')?.closest(".btC");
    if (gmail) return gmail;

    // New Outlook (cloud.microsoft) — anchor on the send button row
    const sendBtn = document.querySelector('button[aria-label*="Envoyer"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('[data-testid="compose-send-button"]');
    if (sendBtn) return sendBtn.closest('[role="toolbar"]') || sendBtn.parentElement;

    // Classic Outlook Web (office.com / live.com)
    return document.querySelector('[data-testid="compose-toolbar"]') ||
      document.querySelector('[aria-label="Compose toolbar"]') ||
      document.querySelector('.fui-Toolbar') ||
      document.querySelector('.ms-OverflowSet[role="menubar"]') ||
      null;
  }

  function injectScanButton(toolbar) {
    if (document.getElementById("cg-scan-btn")) return;
    const btn = document.createElement("button");
    btn.id = "cg-scan-btn";
    btn.title = "WiseMail — Check compliance";
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Compliance
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeToast();
      triggerScan(true);
    });
    toolbar.appendChild(btn);
  }

  // Fallback for email clients where no toolbar is found: render a floating button
  // pinned to the bottom-right of the compose area.
  function injectFloatingButton() {
    if (document.getElementById("cg-scan-btn")) return;
    const btn = document.createElement("button");
    btn.id = "cg-scan-btn";
    btn.title = "WiseMail — Check compliance";
    btn.className = "cg-floating-btn";
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Compliance
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeToast();
      triggerScan(true);
    });
    document.body.appendChild(btn);
  }

  // ─── Typing listener ──────────────────────────────────────────────────────

  function attachComposeListener() {
    const compose = getComposeElement();
    if (!compose || compose.dataset.cgListening) return;
    compose.dataset.cgListening = "true";

    compose.addEventListener("input", () => {
      // User is typing again — unlock Fix All for the new content
      const current = (compose.innerText || compose.textContent || "").trim();
      if (lastFixedText && current !== lastFixedText.trim()) lastFixedText = "";

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const settings = await sendMessage({ type: "GET_SETTINGS" });
        if (settings.autoScan === false) return;
        const text = compose.innerText || compose.textContent || "";
        if (text.trim().length >= 30 && text !== lastAnalyzedText && !isAnalyzing) {
          triggerAutoScan(text);
        }
      }, 1000);
    });
  }

  // ─── Automatic analysis ───────────────────────────────────────────────────

  async function triggerAutoScan(text) {
    if (isAnalyzing) return;
    isAnalyzing = true;
    clearInlineHighlights();
    lastAnalyzedText = text;
    removeToast();

    const settings = await sendMessage({ type: "GET_SETTINGS" });
    if (!settings.apiKey) { isAnalyzing = false; return; }

    const response = await sendMessage({
      type: "ANALYZE_EMAIL",
      emailText: text,
      jurisdiction: settings.jurisdiction || "FR",
      subjectText: extractSubjectText(),
      recipientEmail: extractRecipientEmail(),
      senderDomain: getSenderDomain(),
      attachments: getAttachmentsForAnalysis(),
    });

    isAnalyzing = false;

    if (response.success && response.result) {
      highlightIssuesInCompose(response.result);
      const attachments = getAttachmentsForAnalysis();
      if (settings.showPanel !== false) {
        showPanel({ success: true, result: response.result, emailText: text, autoOpened: true, attachments });
      } else {
        const hasRealIssues = (response.result.issues || []).some(i => i.severity !== "zero-risk");
        if (hasRealIssues || (response.result.requiredDisclaimers || []).length) {
          showCorrectionToast(response.result);
        }
      }
    } else {
      clearInlineHighlights();
    }
  }

  // ─── Manual analysis ──────────────────────────────────────────────────────

  async function triggerScan(showFullPanel = true) {
    const text = extractEmailText();
    if (!text || text.trim().length < 20) {
      if (showFullPanel) showPanel({ error: "EMPTY", message: "No email content detected. Compose or open an email." });
      return;
    }

    const attachments = getAttachmentsForAnalysis();
    if (showFullPanel) showPanel({ loading: true, attachments });

    try {
      const settings = await sendMessage({ type: "GET_SETTINGS" });

      const response = await sendMessage({
        type: "ANALYZE_EMAIL",
        emailText: text,
        jurisdiction: settings.jurisdiction || "FR",
        subjectText: extractSubjectText(),
        recipientEmail: extractRecipientEmail(),
        senderDomain: getSenderDomain(),
        attachments,
      });

      if (response.success && response.result) {
        highlightIssuesInCompose(response.result);
      } else {
        clearInlineHighlights();
      }

      if (showFullPanel) showPanel({ ...response, emailText: text, attachments });
    } catch (err) {
      clearInlineHighlights();
      if (showFullPanel) showPanel({ error: "NETWORK_ERROR", message: err.message || "Extension error — try reloading the page." });
    }
  }

  // ─── Background re-scan (after applying an in-panel fix) ─────────────────

  /**
   * Runs analysis silently while the current panel stays visible.
   * Shows a subtle "Re-analysing…" indicator in the footer.
   * Replaces the panel with fresh results when the scan completes.
   * Falls back to a full loading-panel scan when no panel is open.
   */
  async function triggerBackgroundRescan() {
    if (backgroundRescanRunning) return;

    if (!activePanel) {
      triggerScan(true);
      return;
    }

    backgroundRescanRunning = true;

    // Show subtle indicator so the user knows a rescan is running
    const footer = activePanel?.querySelector(".cg-footer");
    if (footer) {
      footer.innerHTML = `WiseMail · <span class="cg-footer-updating">Re-analysing…<span class="cg-footer-dots"></span></span>`;
    }

    const text = extractEmailText();
    const attachments = getAttachmentsForAnalysis();

    if (!text || text.trim().length < 20) {
      backgroundRescanRunning = false;
      if (footer) footer.textContent = "WiseMail · Compliance Analysis";
      return;
    }

    try {
      const settings = await sendMessage({ type: "GET_SETTINGS" });
      const response = await sendMessage({
        type: "ANALYZE_EMAIL",
        emailText: text,
        jurisdiction: settings.jurisdiction || "FR",
        subjectText: extractSubjectText(),
        recipientEmail: extractRecipientEmail(),
        senderDomain: getSenderDomain(),
        attachments,
      });

      backgroundRescanRunning = false;
      lastAnalyzedText = text;

      if (response.success && response.result) {
        highlightIssuesInCompose(response.result);
        showPanel({ ...response, emailText: text, attachments });
      } else {
        clearInlineHighlights();
        const currentFooter = activePanel?.querySelector(".cg-footer");
        if (currentFooter) currentFooter.textContent = "WiseMail · Compliance Analysis";
      }
    } catch (err) {
      backgroundRescanRunning = false;
      clearInlineHighlights();
      const currentFooter = activePanel?.querySelector(".cg-footer");
      if (currentFooter) currentFooter.textContent = "WiseMail · Error — try again";
    }
  }

  // ─── Toast ────────────────────────────────────────────────────────────────

  function showCorrectionToast(result) {
    removeToast();

    const critical = (result.issues || []).filter(i => i.severity === "critical").length;
    const warnings = (result.issues || []).filter(i => i.severity === "warning").length;
    const currentText = (extractEmailText() || "").trim();
    const alreadyFixed = lastFixedText && currentText === lastFixedText.trim();
    const hasCorrection = !alreadyFixed && (
      (result.correctedEmail && result.correctedEmail.length > 10) ||
      (result.correctedSubject && result.correctedSubject.trim().length > 0)
    );
    const hasDisclaimers = result.requiredDisclaimers?.length > 0;

    const parts = [];
    if (critical > 0) parts.push(`<span class="cg-toast-critical">${critical} critical</span>`);
    if (warnings > 0) parts.push(`<span class="cg-toast-warning">${warnings} warning${warnings > 1 ? "s" : ""}</span>`);

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
        <p class="cg-toast-title">Compliance issues detected</p>
        <p class="cg-toast-counts">${parts.join(" · ")}</p>
      </div>
      <div class="cg-toast-actions">
        ${(hasCorrection || hasDisclaimers) ? `<button class="cg-toast-btn cg-toast-accept" id="cg-toast-accept">Fix</button>` : ""}
        <button class="cg-toast-btn cg-toast-details" id="cg-toast-details">Details</button>
        <button class="cg-toast-btn cg-toast-dismiss" id="cg-toast-close">✕</button>
      </div>
    `;

    document.body.appendChild(activeToast);

    activeToast.querySelector("#cg-toast-close")?.addEventListener("click", removeToast);

    activeToast.querySelector("#cg-toast-accept")?.addEventListener("click", () => {
      if (hasCorrection) {
        applyEmailCorrection(result);
      } else if (result.requiredDisclaimers?.length) {
        insertDisclaimersIntoCompose(result.requiredDisclaimers);
      }
      removeToast();
    });

    activeToast.querySelector("#cg-toast-details")?.addEventListener("click", () => {
      removeToast();
      showPanel({ success: true, result, emailText: lastAnalyzedText, attachments: getAttachmentsForAnalysis() });
    });

    setTimeout(() => { if (activeToast) removeToast(); }, 12000);
  }

  function removeToast() {
    if (activeToast) { activeToast.remove(); activeToast = null; }
  }

  // ─── Email correction ─────────────────────────────────────────────────────

  function applyEmailCorrection(resultOrText) {
    const { subject, body } = parseCorrectedEmailParts(resultOrText);
    const compose = getComposeElement();
    if (subject) setSubjectText(subject);
    if (compose && body) {
      clearInlineHighlights();
      compose.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, body);
      lastAnalyzedText = body;
      lastFixedText = body;
    }
  }

  function insertDisclaimersIntoCompose(disclaimers) {
    if (!disclaimers.length) return;
    const text = "\n\n─────────────────────────────\nMANDATORY LEGAL DISCLAIMERS:\n\n" +
      disclaimers.map(d => `[${d.regulation}] ${d.text}`).join("\n\n");

    const compose = getComposeElement();
    if (compose) {
      clearInlineHighlights();
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

  // ─── Panel ────────────────────────────────────────────────────────────────

  function showPanel(state) {
    removePanel();
    activePanel = document.createElement("div");
    activePanel.id = "cg-panel";
    activePanel.innerHTML = buildPanelHTML(state);
    document.body.appendChild(activePanel);
    positionPanel(activePanel);
    enablePanelDragging(activePanel);

    activePanel.querySelector("#cg-close")?.addEventListener("click", removePanel);

    activePanel.querySelectorAll(".cg-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(btn.dataset.text).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => btn.textContent = "Copy", 1500);
        });
      });
    });

    activePanel.querySelector("#cg-insert-all")?.addEventListener("click", () => {
      insertDisclaimersIntoCompose(state.result?.requiredDisclaimers || []);
    });

    function clearDiffPreviews() {
      document.querySelectorAll("[data-cg-preview]").forEach(el => el.remove());
    }

    function applyDiff(key, issue) {
      (highlightedIssueSpans.get(key) || []).forEach(s => {
        s.classList.add("cg-inline-issue-hover");
        if (issue?.suggestedFix?.trim()) {
          s.classList.add("cg-inline-issue-del");
          const preview = document.createElement("span");
          preview.className = "cg-inline-fix-preview";
          preview.textContent = issue.suggestedFix;
          preview.dataset.cgPreview = "1";
          s.after(preview);
        }
      });
    }

    function clearDiff(key) {
      (highlightedIssueSpans.get(key) || []).forEach(s => {
        s.classList.remove("cg-inline-issue-hover", "cg-inline-issue-del");
      });
      clearDiffPreviews();
    }

    const applyBtn = activePanel.querySelector("#cg-apply-correction");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        if ((state.result?.correctedEmail && state.result.correctedEmail.length > 10) ||
            (state.result?.correctedSubject && state.result.correctedSubject.trim().length > 0)) {
          clearDiffPreviews();
          applyEmailCorrection(state.result);
          state = {
            ...state,
            result: { ...state.result, issues: [], correctedEmail: "", correctedSubject: "" },
          };
          showPanel(state);
        }
      });
      applyBtn.addEventListener("mouseenter", () => {
        highlightedIssueSpans.forEach((spans, key) => {
          const issue = state.result?.issues?.[Number(key)];
          applyDiff(key, issue);
        });
      });
      applyBtn.addEventListener("mouseleave", () => {
        highlightedIssueSpans.forEach((_, key) => clearDiff(key));
      });
    }

    activePanel.querySelector("#cg-reject-correction")?.addEventListener("click", () => {
      state = {
        ...state,
        result: { ...state.result, correctedEmail: "", correctedSubject: "" },
      };
      showPanel(state);
    });

    activePanel.querySelectorAll(".cg-issue-focus-btn").forEach((button) => {
      button.addEventListener("click", async () => {
        const issueIndex = Number(button.dataset.issueIndex);
        const issue = state.result?.issues?.[issueIndex];
        if (issue?.suggestedFix?.trim()) {
          clearDiffPreviews();
          const fixed = await applySpecificIssueCorrection(state.result, button.dataset.issueIndex, button);
          if (fixed && state.result?.issues) {
            state = {
              ...state,
              result: {
                ...state.result,
                issues: state.result.issues.filter((_, i) => i !== issueIndex),
              },
            };
            showPanel(state);
          }
          return;
        }
        focusIssueInCompose(button.dataset.issueIndex);
      });

      button.addEventListener("mouseenter", () => {
        const key = String(button.dataset.issueIndex);
        const issue = state.result?.issues?.[Number(key)];
        applyDiff(key, issue);
      });

      button.addEventListener("mouseleave", () => {
        clearDiff(String(button.dataset.issueIndex));
      });
    });

    activePanel.querySelectorAll(".cg-reject-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const issueIndex = Number(button.dataset.rejectIndex);
        const key = String(issueIndex);
        clearDiffPreviews();
        (highlightedIssueSpans.get(key) || []).forEach(s => { s.className = ""; });
        highlightedIssueSpans.delete(key);
        state = {
          ...state,
          result: {
            ...state.result,
            issues: state.result.issues.filter((_, i) => i !== issueIndex),
          },
        };
        showPanel(state);
      });
    });

    activePanel.querySelector("#cg-open-settings")?.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "OPEN_SETTINGS" });
    });
  }

  function removePanel() {
    if (activePanel) { activePanel.remove(); activePanel = null; }
  }

  // ─── Panel HTML builder ───────────────────────────────────────────────────

  function buildPanelHTML(state) {
    const attachments = state.attachments || [];

    // ── Loading ─────────────────────────────────────────────────────────────
    if (state.loading) {
      return `
        <div class="cg-header">
          <div class="cg-logo">
            <span class="cg-logo-wordmark">WiseMail</span>
          </div>
          <button id="cg-close" class="cg-close-btn" aria-label="Close">✕</button>
        </div>
        <div class="cg-loading">
          <div class="cg-spinner"></div>
          <p class="cg-loading-title">Analysing…</p>
          <p class="cg-loading-sub">AMF · MiFID II · GDPR · CMF${attachments.length ? ` · ${attachments.length} attachment${attachments.length > 1 ? "s" : ""}` : ""}</p>
        </div>
      `;
    }

    // ── Error ────────────────────────────────────────────────────────────────
    if (state.error) {
      const messages = {
        NO_API_KEY:    `<p>No API key configured.</p><button id="cg-open-settings" class="cg-settings-link">Open settings →</button>`,
        EMPTY:         `<p>${state.message}</p>`,
        API_ERROR:     `<p>API error: ${state.message}</p>`,
        PARSE_ERROR:   `<p>Unreadable response. Please try again.</p>`,
        NETWORK_ERROR: `<p>Network error: ${state.message}</p>`,
      };
      return `
        <div class="cg-header">
          <div class="cg-logo">
            <span class="cg-logo-wordmark">WiseMail</span>
          </div>
          <button id="cg-close" class="cg-close-btn">✕</button>
        </div>
        <div class="cg-error">
          <div class="cg-error-icon">⚠</div>
          ${messages[state.error] || `<p>${state.message}</p>`}
        </div>
      `;
    }

    // ── Results ──────────────────────────────────────────────────────────────
    const r = state.result;
    if (!r) return `<div class="cg-header"><button id="cg-close" class="cg-close-btn">✕</button></div><p class="cg-pad">No results.</p>`;

    const indexedIssues = (r.issues || []).map((issue, index) => ({ ...issue, __index: index }));
    const criticals  = indexedIssues.filter(i => i.severity === "critical");
    const warnings   = indexedIssues.filter(i => i.severity === "warning");
    const infos      = indexedIssues.filter(i => i.severity === "info");
    const zeroRisks  = indexedIssues.filter(i => i.severity === "zero-risk");

    const correctionSeverity = criticals.length ? "critical" : warnings.length ? "warning" : "ok";

    const typeLabel = {
      MENTION_PERFORMANCES_PASSEES: "Past performance",
      GARANTIE_RENDEMENT:           "Return guarantee",
      ABSENCE_MISE_EN_GARDE:        "Missing warning",
      VIOLATION_RGPD:               "GDPR violation",
      INFORMATION_TROMPEUSE:        "Misleading information",
      ABSENCE_MENTION_AMF:          "Missing AMF disclosure",
      VIOLATION_LCBFT:              "AML/CFT violation",
      CONFLIT_INTERETS:             "Conflict of interest",
      MANQUEMENT_REGLEMENTAIRE:     "Regulatory breach",
      SPELLING_GRAMMAR:             "Spelling / Grammar",
      ATTACHMENT_READ_ERROR:        "Attachment scan failed",
      DISCLAIMER_MISSING:           "Missing legal disclaimer",
      GDPR_VIOLATION:               "GDPR violation",
      DATA_PRIVACY:                 "Personal data",
    };

    function shortSkillName(name) {
      return name
        .replace(/\s*—\s*.+$/, "")
        .replace(/\b(law|promotions|communications|baseline|template)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
        .replace(/\s*\/\s*/g, "/");
    }

    function skillHasFail(skill, issues) {
      const realIssues = issues.filter(i => i.severity !== "zero-risk");
      if (!realIssues.length) return false;
      const stopWords = new Set(["the","and","for","law","of","in","a","an","to","with","or","by","per","eu","if"]);
      const tokens = skill.name
        .split(/[\s/\-·,|()]+/)
        .map(t => t.replace(/[^\w]/g, "").toLowerCase())
        .filter(t => t.length > 2 && !stopWords.has(t));
      return realIssues.some(issue => {
        const reg = (issue.regulation || "").toLowerCase();
        return tokens.some(token => reg.includes(token));
      });
    }

    const pillsHTML = (r.appliedSkills || []).map(skill => {
      const fail = skillHasFail(skill, indexedIssues);
      return `<span class="cg-law-pill ${fail ? "cg-law-pill-fail" : "cg-law-pill-pass"}">${fail ? "✗" : "✓"} ${shortSkillName(skill.name)}</span>`;
    }).join("");

    const lawCarouselHTML = (r.appliedSkills || []).length ? `
      <div class="cg-law-carousel">
        <div class="cg-law-track">
          ${pillsHTML}
          <span style="width:20px;flex-shrink:0" aria-hidden="true"></span>
          ${pillsHTML}
          <span style="width:20px;flex-shrink:0" aria-hidden="true"></span>
        </div>
      </div>
    ` : "";

    function renderIssues(issues, cls) {
      return issues.map(issue => `
        <div class="cg-issue cg-issue-${cls}">
          <div class="cg-issue-top">
            <span class="cg-issue-type">${typeLabel[issue.type] || issue.type}</span>
            <span class="cg-issue-reg">${issue.regulation || ""}</span>
          </div>
          <p class="cg-issue-desc">${issue.description}</p>
          ${issue.quote ? `<blockquote class="cg-issue-quote">${issue.quote}</blockquote>` : ""}
          <div class="cg-issue-actions">
            <button class="cg-reject-btn" data-reject-index="${issue.__index}">Reject</button>
            ${issue.quote && issue.suggestedFix?.trim() ? `<button class="cg-issue-focus-btn" data-issue-index="${issue.__index}">Fix this</button>` : ""}
          </div>
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
        <button class="cg-copy-btn" data-text="${d.text.replace(/"/g, "&quot;")}">Copy</button>
      </div>
    `).join("");

    const currentEmailText = (extractEmailText() || "").trim();
    const alreadyFixed = lastFixedText && currentEmailText === lastFixedText.trim();
    const hasCorrection = !alreadyFixed && (
      (r.correctedEmail && r.correctedEmail.length > 10) ||
      (r.correctedSubject && r.correctedSubject.trim().length > 0)
    );

    // Attachment scan status section
    const attachmentRowsHTML = attachments.map(att => `
      <div class="cg-attachment-row ${att.error ? "cg-attachment-error" : "cg-attachment-ok"}">
        <span class="cg-attachment-icon">${att.error ? "✗" : "✓"}</span>
        <span class="cg-attachment-name" title="${att.name}">${att.name}</span>
        <span class="cg-attachment-status">${att.error ? att.error : `${att.text.length.toLocaleString()} chars`}</span>
      </div>
    `).join("");

    return `
      <div class="cg-header">
        <div class="cg-logo">
          <span class="cg-logo-wordmark">WiseMail</span>
        </div>
        <button id="cg-close" class="cg-close-btn" aria-label="Close">✕</button>
      </div>

      ${lawCarouselHTML}

      ${hasCorrection ? `
        <div class="cg-correction-banner cg-correction-${correctionSeverity}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
          </svg>
          A complete correction is available
          <button id="cg-reject-correction" class="cg-correction-reject-btn">Reject</button>
          <button id="cg-apply-correction" class="cg-correction-btn">Fix All</button>
        </div>
      ` : ""}

      ${r.issues?.length ? `
        <details class="cg-skills-strip" open>
          <summary class="cg-skills-summary">
            <span class="cg-skills-summary-label">Issues</span>
            <span class="cg-badge">${r.issues.length}</span>
          </summary>
          <div class="cg-issues-body">
            ${criticals.length  ? `<p class="cg-group-label cg-group-critical">Critical (${criticals.length})</p>${renderIssues(criticals, "critical")}` : ""}
            ${warnings.length   ? `<p class="cg-group-label cg-group-warning">Warnings (${warnings.length})</p>${renderIssues(warnings, "warning")}` : ""}
            ${infos.length      ? `<p class="cg-group-label cg-group-info">Info (${infos.length})</p>${renderIssues(infos, "info")}` : ""}
            ${zeroRisks.length  ? `<p class="cg-group-label cg-group-zero-risk">Spelling / Grammar (${zeroRisks.length})</p>${renderIssues(zeroRisks, "zero-risk")}` : ""}
          </div>
        </details>
      ` : `
        <div class="cg-section">
          <div class="cg-clean">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
            </svg>
            No compliance issues detected
          </div>
        </div>
      `}

      ${attachments.length ? `
        <details class="cg-skills-strip cg-attachments-strip">
          <summary class="cg-skills-summary">
            <span class="cg-skills-summary-label">Attachments</span>
            <span class="cg-badge ${attachments.some(a => a.error) ? "cg-badge-warn" : ""}">${attachments.length}</span>
          </summary>
          <div class="cg-attachments-body">${attachmentRowsHTML}</div>
        </details>
      ` : ""}

      <div class="cg-footer">WiseMail · Compliance Analysis</div>
    `;
  }

  // ─── DOM observation ──────────────────────────────────────────────────────

  /**
   * Main MutationObserver:
   *   1. Injects the toolbar button and typing listener when Gmail opens a compose window.
   *   2. Hooks file inputs for PDF attachment scanning.
   *   3. Closes the panel/toast when the compose window is dismissed.
   */
  function observe() {
    // Hook any file inputs already in the DOM
    document.querySelectorAll('input[type="file"]').forEach(hookFileInput);

    const mo = new MutationObserver((mutations) => {
      // Hook newly added file inputs
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.('input[type="file"]')) hookFileInput(node);
          node.querySelectorAll?.('input[type="file"]').forEach(hookFileInput);
        }
      }

      const compose = getComposeElement();
      const toolbar = findComposeToolbar();
      if (toolbar) {
        injectScanButton(toolbar);
        attachComposeListener();
      } else if (compose && !document.getElementById("cg-scan-btn")) {
        // No toolbar found — inject floating button so Outlook/other clients still work
        injectFloatingButton();
        attachComposeListener();
      }

      // Hide floating button when compose is gone
      if (!compose && document.getElementById("cg-scan-btn")?.classList.contains("cg-floating-btn")) {
        document.getElementById("cg-scan-btn").remove();
      }

      // Detect compose window close: dismiss panel and reset state
      if (compose) {
        clearTimeout(composeCloseTimer);
      } else if (activePanel || activeToast) {
        clearTimeout(composeCloseTimer);
        composeCloseTimer = setTimeout(() => {
          if (!getComposeElement()) {
            removePanel();
            removeToast();
            lastAnalyzedText = "";
            attachmentContent.clear();
          }
        }, 500);
      }
    });

    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Keyboard shortcut ────────────────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.key === "C") {
      removeToast();
      triggerScan(true);
    }
  });

  window.addEventListener("resize", () => {
    if (!activePanel) return;
    if (panelManualPosition) { applyPanelPosition(activePanel, panelManualPosition); return; }
    positionPanel(activePanel);
  });

  // ─── Messages from popup ──────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TRIGGER_SCAN") {
      removeToast();
      triggerScan(true);
    }
  });

  // ─── Startup ──────────────────────────────────────────────────────────────
  observe();

})();
