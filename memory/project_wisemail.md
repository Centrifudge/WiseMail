---
name: WiseMail project overview
description: Core facts about the WiseMail Firefox extension — architecture, tech stack, key files
type: project
---

WiseMail is a Firefox MV2 browser extension that adds AI-powered compliance checking to Gmail and Outlook Web. No build system — plain HTML/CSS/JS loaded directly.

**Why:** Helps financial professionals catch regulatory issues (MiFID II, AMF, SEC, etc.) before sending emails.

**How to apply:** Any change to the extension should be tested by reloading via about:debugging. All JS must be ES2020-compatible vanilla JS. No bundler, no npm.

Background scripts load in order: system-prompt.js → skills-library.js → api.js → background.js (each sets globals that the next depends on). Content scripts load: attachment-parser.js → content.js.

Key file: CLAUDE.md at the project root has the full architecture reference.
