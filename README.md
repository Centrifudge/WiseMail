# WiseMail

AI-powered compliance checker for financial email communications. Analyses outbound emails for regulatory issues (MiFID II, AMF, SEC/FINRA, FCA, ASIC, GDPR), generates required disclaimers, and flags spelling errors — all inline in Gmail and Outlook Web.

---

## Features

- **Compliance scanning** — detects misleading claims, missing risk warnings, past-performance misuse, guarantee language, GDPR issues
- **Multi-jurisdiction** — covers FR (AMF/CMF), EU (MiFID II / PRIIPs / GDPR), US (SEC/FINRA), UK (FCA), AU (ASIC), cross-border
- **Inline highlights** — problematic text is underlined directly in the compose window with wavy coloured underlines
- **One-click fixes** — issue-level replacements and a "Fix All" full-email correction
- **Auto-disclaimer generation** — exact legal disclaimer text, ready to insert
- **Spelling & grammar** — flagged as zero-risk suggestions, no compliance impact
- **Attachment scanning** — extracts text from PDF, DOCX, TXT, CSV and scans it alongside the email body
- **Keyboard shortcut** — `Alt+Shift+C` to scan from anywhere
- **Gmail + Outlook Web** — both webmail clients supported

---

## Installation (Firefox)

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this folder

### API key setup

The extension supports Google (Gemini), OpenAI, and Anthropic models. Get an API key from your preferred provider:

- **Google Gemini** (default, free tier available): [AI Studio](https://makersuite.google.com/app/apikey)
- **OpenAI**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Anthropic**: [console.anthropic.com](https://console.anthropic.com/)

Then click the WiseMail toolbar icon → **Configure API Key & Settings**, paste the key, and save.

---

## Usage

Inside Gmail or Outlook Web while composing an email:

- Click the **Compliance** button in the compose toolbar, or
- Press `Alt + Shift + C`, or
- Click the extension icon → **Scan Current Email**

Auto-scan can be enabled in settings to run 1 second after you stop typing.

### Result severity

| Severity | Meaning |
|----------|---------|
| Critical (red) | Must fix — regulatory violation |
| Warning (yellow) | Should fix — potential compliance issue |
| Info (blue) | Best-practice suggestion |
| Zero-risk (green) | Spelling / grammar only |

---

## Architecture

```
manifest.json               MV2, Firefox-first
background/
  system-prompt.js          Default system prompt + JSON output contract (globalThis)
  skills-library.js         Built-in compliance skills + jurisdiction list (globalThis)
  api.js                    AI provider callers: Google, OpenAI, Anthropic
  background.js             Service worker: settings, skill routing, analysis
content/
  attachment-parser.js      PDF + DOCX text extractors (loaded before content.js)
  content.js                Gmail/Outlook DOM injection, panel, toast, highlights
  content.css               All injected UI styles + dark-mode overrides
popup/
  popup.html / .js          Toolbar popup
options/
  options.html / .js        Settings page (API key, model, jurisdictions, skills editor)
icons/
```

See `CLAUDE.md` for data flow, storage keys, and development notes.

---

## Regulations covered

| Regulation | Jurisdiction |
|-----------|-------------|
| AMF / ACPR / Code monétaire et financier | FR |
| MiFID II Art. 24–25, PRIIPs, GDPR | EU |
| SEC Rule 156, FINRA Rule 2210 | US |
| FCA COBS 4 | UK |
| ASIC RG 234 | AU |

---

## Privacy

Email content is sent to the AI provider you configure. Your API key is stored locally in browser storage only. No data is sent to any WiseMail server.

---

*WiseMail v1.1 — Not a substitute for qualified legal advice.*
