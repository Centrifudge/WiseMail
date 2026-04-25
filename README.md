# ⚖ ComplianceGuard — Firefox Extension

**Grammarly for financial compliance.** Analyzes emails from salespeople and fund managers for regulatory issues, adds required disclaimers, and flags GDPR/data privacy concerns — powered by Google Gemini AI.

---

## Features

- 🔴 **Compliance scanning** — detects missing disclaimers, misleading claims, past performance warnings, unsubstantiated guarantees
- 🛡 **Multi-jurisdiction** — covers MiFID II (EU), SEC/FINRA (US), FCA (UK), ASIC (AU), GDPR
- 📋 **Auto-disclaimer generation** — generates the exact legally-required disclaimer text, ready to copy or insert
- 🔵 **GDPR flagging** — detects names, emails, and personal data that may require consent handling
- 🟢 **Spelling & grammar** — flags typos and grammar mistakes as zero-risk suggestions with one-click corrections
- ⚡ **Keyboard shortcut** — `Alt+Shift+C` to scan any email instantly
- 📧 **Gmail + Outlook Web** — works on both major webmail clients

---

## Installation

### 1. Install in Firefox (Development Mode)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on…"**
3. Navigate to this folder and select **`manifest.json`**
4. The extension is now active — look for the shield icon in your toolbar

### 2. Get a Google Gemini API Key (Free)

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Create API key"**
4. Copy the key (starts with `AIza...`)

### 3. Configure the Extension

1. Click the **⚖ ComplianceGuard** icon in Firefox toolbar
2. Click **"Configure API Key & Settings"**
3. Paste your Gemini API key
4. Select your primary jurisdiction
5. Click **Save Settings**

---

## Usage

### In Gmail or Outlook Web:

**Option A — Compose toolbar button:**
1. Open or compose an email
2. Click the **"Compliance"** button in the toolbar (appears automatically)
3. The analysis panel opens on the right

**Option B — Keyboard shortcut:**
- Press `Alt + Shift + C` anywhere on Gmail/Outlook

**Option C — Popup:**
- Click the extension icon → "Scan Current Email"

### Reading results:

| Color | Meaning |
|-------|---------|
| 🔴 Red (Critical) | Must fix before sending — regulatory violation |
| 🟡 Yellow (Warning) | Should fix — potential compliance issue |
| 🔵 Blue (Info) | Informational — best practice suggestion |
| 🟢 Green (Zero-risk) | Spelling / grammar suggestion — no compliance impact |

The **risk score (0–100)** represents overall compliance risk. Scores above 70 indicate high regulatory exposure.

---

## Example Detections

**Email:** *"Our fund returned +18% last year. This is a once-in-a-lifetime opportunity — invest now!"*

**Flags:**
- 🔴 `PAST_PERFORMANCE` — "Our fund returned +18% last year" lacks MiFID II/SEC required disclaimer
- 🔴 `MISLEADING_CLAIM` — "once-in-a-lifetime opportunity" constitutes undue pressure (MiFID II Art. 24)
- 🟡 `DISCLAIMER_MISSING` — No capital risk warning

**Generated disclaimers:**
- MiFID II: *"Past performance is not a reliable indicator of future results..."*
- SEC Rule 156: *"Past performance does not guarantee future results..."*

---

## Regulations Covered

| Regulation | Jurisdiction | Coverage |
|-----------|-------------|---------|
| MiFID II Art. 24, 25 | EU | Suitability, disclosure, inducements |
| GDPR Art. 6, 13 | EU | Personal data, consent, lawful basis |
| SEC Rule 156 | US | Investment company advertising |
| FINRA Rule 2210 | US | Communications with the public |
| FCA COBS 4 | UK | Financial promotions |
| ASIC RG 234 | AU | Advertising financial products |

---

## Architecture

```
.
├── manifest.json          # Extension manifest (MV2, Firefox-compatible)
├── background/
│   └── background.js      # Gemini API calls, message routing
├── content/
│   ├── content.js         # Gmail/Outlook DOM injection, UI rendering
│   └── content.css        # Panel & button styles
├── popup/
│   ├── popup.html         # Toolbar popup
│   └── popup.js
├── options/
│   ├── options.html       # Settings page
│   └── options.js
└── icons/
    ├── icon48.png
    └── icon96.png
```

---

## Roadmap

- [x] Spelling & grammar suggestions (zero-risk, green)
- [ ] Chrome/Edge support (MV3 migration)
- [ ] Custom rule sets per firm
- [ ] Bulk email scanning
- [ ] Audit log export (CSV/PDF)
- [ ] Team policy configuration via dashboard
- [ ] Outlook desktop client plugin
- [ ] Salesforce / CRM integration

---

## Privacy

- Email content is sent to the **Google Gemini API** for analysis
- Your API key is stored locally in browser storage
- No data is sent to any third-party servers
- Review [Google's AI data usage policy](https://ai.google.dev/gemini-api/terms) before use in production

---

*ComplianceGuard v1.0 — Not a substitute for qualified legal advice.*
