# WiseMail — Claude Code Guide

## Project type
Firefox browser extension (Manifest V2). No build step — plain HTML/CSS/JS files loaded directly by Firefox.

## Architecture

```
manifest.json          MV2 manifest; declares scripts, permissions, options_ui
background/
  system-prompt.js     Sets globalThis.WISEMAIL_DEFAULT_SYSTEM_PROMPT + WISEMAIL_SYSTEM_PROMPT_CONTRACT
  skills-library.js    Sets globalThis.WISEMAIL_DEFAULT_SKILLS + WISEMAIL_JURISDICTION_OPTIONS
  api.js               Pure API callers: callGoogle / callOpenAI / callAnthropic / parseJSON
  background.js        Service worker: settings, skill resolution, analysis orchestration
content/
  attachment-parser.js Pure text extractors: cgExtractPDFText / cgExtractDocxText (no IIFE)
  content.js           Gmail/Outlook DOM injection (IIFE): scan trigger, panel, toast, highlights
  content.css          All injected UI styles; dark-mode overrides via @media prefers-color-scheme
popup/
  popup.html / .js     Toolbar popup — scan button + link that calls browser.runtime.openOptionsPage()
options/
  options.html / .js   Full settings page — API key, provider, model, jurisdiction, skills editor
icons/                 Extension icons
```

## Data flow

1. User triggers scan (button / shortcut / auto-debounce)
2. `content.js` calls `browser.runtime.sendMessage({ type: "ANALYZE_EMAIL", ... })`
3. `background.js` resolves settings, selects applicable skills, calls AI API via `api.js`
4. AI returns JSON; `background.js` parses and enriches it with `appliedSkills` + `analysisContext`
5. `content.js` receives the result, renders the panel and highlights inline issues

## Key globals (set by background scripts, available to all background scripts)

| Global | Set in | Used in |
|--------|--------|---------|
| `WISEMAIL_DEFAULT_SYSTEM_PROMPT` | system-prompt.js | background.js, options.js |
| `WISEMAIL_SYSTEM_PROMPT_CONTRACT` | system-prompt.js | background.js |
| `WISEMAIL_DEFAULT_SKILLS` | skills-library.js | background.js, options.js |
| `WISEMAIL_JURISDICTION_OPTIONS` | skills-library.js | options.js |

## Storage keys (browser.storage.local)

`apiKey`, `provider`, `model`, `endpoint`, `customModel`, `jurisdiction`, `counterpartyJurisdiction`, `autoScan`, `showPanel`, `systemPrompt`, `skills`

## Message types (content ↔ background)

| type | direction | payload |
|------|-----------|---------|
| `ANALYZE_EMAIL` | content → background | emailText, jurisdiction, subjectText, recipientEmail, senderDomain, attachments |
| `GET_SETTINGS` | content → background | — |
| `OPEN_SETTINGS` | content → background | — |
| `TRIGGER_SCAN` | popup → content | — |

## Providers

Three supported: `google` (Gemini, default), `openai`, `anthropic`. Each has a dedicated caller in `api.js`. The endpoint URL for Google uses a `{model}` placeholder replaced at call time.

## Skill system

Skills have: `id`, `name`, `type` (law|policy), `builtin`, `enabled`, `alwaysApply`, `jurisdictions[]`, `summary`, `content`.

- Built-in skills are in `skills-library.js`; user edits are stored in `browser.storage.local`
- `mergeSkillsWithDefaults` in `background.js` merges stored + default skills on every analysis
- FR jurisdiction auto-expands to include EU; Global expands to all jurisdictions

## Model migration

`LEGACY_MODEL_ALIASES` in both `background.js` and `options.js` maps old model names to current ones. Run normalization on load and save migrated values back to storage.

## Content script split

`content/attachment-parser.js` is loaded BEFORE `content/content.js` in the manifest. It defines `cgExtractPDFText` and `cgExtractDocxText` as plain functions (no IIFE) in content-script scope, which `content.js` (IIFE) then calls directly.

## Reloading during development

In Firefox: `about:debugging` → This Firefox → WiseMail → Reload. The options page opens as a full tab (`open_in_tab: true` in manifest).

## Coding conventions

- No build tooling — keep all JS as vanilla ES2020+
- Background scripts use `globalThis` to share data between script files
- Content script uses a single IIFE to avoid polluting the page scope
- CSS class prefix: `cg-` (legacy name ComplianceGuard, do not rename — breaks storage/DOM)
- All AI output must be English (enforced in system prompt)
- Issue types are in French (MENTION_PERFORMANCES_PASSEES, etc.) — AI-facing identifiers, not user-facing
