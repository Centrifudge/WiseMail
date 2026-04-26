/**
 * WiseMail skills library.
 *
 * These skills are the business layer actually applied by the AI:
 * jurisdiction-specific law, cross-border rules, and internal policies.
 * They serve as defaults and can be edited from the extension options page.
 */

globalThis.WISEMAIL_JURISDICTION_OPTIONS = [
  { value: "FR", label: "France" },
  { value: "EU", label: "European Union" },
  { value: "US", label: "United States" },
  { value: "UK", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "Global", label: "Global / Cross-border" },
];

globalThis.WISEMAIL_DEFAULT_SKILLS = [
  {
    id: "law-fr-financial-communications",
    name: "French financial communications law",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["FR"],
    summary: "AMF, ACPR and CMF rules for financial promotions sent by French entities.",
    content: `Apply French financial communication rules cumulatively:
- Communications must be fair, clear and not misleading under the Code monetaire et financier.
- Do not promise or imply guaranteed returns, guaranteed capital protection or certain appreciation unless this is legally documented and approved.
- Material risks, especially risk of capital loss, fees, conflicts of interest and product limitations must be disclosed in a balanced manner.
- If the sender acts as a regulated or licensed entity, the entity name, regulatory status and other mandatory legal mentions must be included when relevant.
- Past performance or performance examples must never be framed as a prediction of future performance.
- Avoid urgency, pressure, omission of risks, omission of legal status or any wording that would be considered aggressive or deceptive marketing under AMF guidance.`,
  },
  {
    id: "law-eu-mifid-gdpr-priips",
    name: "EU MiFID / PRIIPs / GDPR",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["EU"],
    summary: "MiFID II information duties, PRIIPs KID expectations and GDPR constraints.",
    content: `Apply EU-wide financial communication rules cumulatively:
- Under MiFID II, information must be fair, clear, not misleading and appropriate for the intended audience.
- Marketing communications must clearly distinguish benefits from risks and must not over-emphasize upside.
- Where retail products are discussed, check whether the message should reference the availability of a KID / key information document or other pre-contractual disclosures.
- If suitability, appropriateness, profiling or investor categorisation is implicated, require careful wording and no implied approval without process.
- Any personal data mention or processing implication must remain consistent with GDPR principles: purpose limitation, data minimisation and lawful basis.
- When several EU rules conflict with a looser local practice, apply the stricter investor-protection reading.`,
  },
  {
    id: "law-us-sec-finra",
    name: "US SEC / FINRA communications",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["US"],
    summary: "SEC and FINRA standards for fair, balanced and non-misleading investment communications.",
    content: `Apply United States financial promotion rules cumulatively:
- Communications must be fair, balanced and not misleading under SEC and FINRA expectations.
- Do not state or imply guaranteed investment returns, risk-free performance or certainty of outcome.
- Performance claims, model returns and projections need balanced caveats and must not omit material conditions, assumptions or risks.
- Testimonials, insider access claims, scarcity tactics and sensational wording materially increase compliance risk.
- Include or recommend relevant risk disclosures where a reasonable investor would need them to understand the message.
- Where securities or investment advice are implicated, avoid language that could be read as a personalized recommendation without required process.`,
  },
  {
    id: "law-uk-fca-cobs",
    name: "UK FCA financial promotions",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["UK"],
    summary: "FCA-style fair, clear and not misleading standards for UK recipients or UK-led campaigns.",
    content: `Apply United Kingdom financial promotion rules cumulatively:
- Financial promotions must be fair, clear and not misleading.
- Risks and limitations must be prominent enough compared with benefits and not buried in the wording.
- Avoid implied certainty, inappropriate urgency, incomplete fee presentation or omission of eligibility restrictions.
- Keep audience appropriateness in mind: retail-facing communications must be especially cautious and balanced.
- If an approval, authorization or regulated status matters for the message, require accurate wording and avoid overstatement.`,
  },
  {
    id: "law-au-asic",
    name: "Australian ASIC promotions",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["AU"],
    summary: "ASIC-style anti-misleading, anti-hype and balanced risk disclosure expectations.",
    content: `Apply Australian financial communication rules cumulatively:
- Marketing must not be misleading or deceptive and must not create an unrealistic impression of likely returns.
- Prominent disclosure of risks, assumptions, investor suitability limits and material conditions is required when relevant.
- Avoid hype, urgency, certainty language, hidden conditions or omission of downside scenarios.
- Where products are complex or retail-directed, require extra care with warnings and pre-investment information.`,
  },
  {
    id: "law-global-cross-border",
    name: "Cross-border baseline",
    type: "law",
    builtin: true,
    enabled: true,
    alwaysApply: false,
    jurisdictions: ["Global"],
    summary: "Baseline rules for multi-jurisdiction communications and the strictest compatible reading.",
    content: `Apply this cross-border baseline whenever the communication spans more than one jurisdiction:
- Apply all relevant jurisdiction skills cumulatively, not alternatively.
- When rules differ, use the strictest investor-protection interpretation that remains internally consistent.
- Do not silently drop local legal mentions, risk warnings or licensing references required by one side of the transaction.
- If the message crosses borders, avoid assumptions that one country's lighter marketing practice overrides another country's stricter rule set.
- Internal company policy, if provided, is mandatory and cumulative with legal rules.`,
  },
  {
    id: "policy-gender-neutral-language",
    name: "Company policy — Gender-neutral language",
    type: "policy",
    builtin: true,
    enabled: true,
    alwaysApply: true,
    jurisdictions: [],
    summary: "Forbids gendered pronouns, titles and role names in all communications. Requires neutral alternatives.",
    content: `Apply this company policy to every email, regardless of jurisdiction:
- Do not use gendered pronouns (he, she, him, her, his, hers) when referring to an unspecified or generic individual. Use "they/them" or rewrite the sentence to avoid the pronoun.
- Do not use gendered salutations or titles (Mr., Mrs., Miss, Madam, Sir) when the recipient's preference is unknown. Use the person's name directly (e.g. "Dear Alex") or a neutral title.
- Do not use gendered role names. Replace with neutral equivalents:
    salesman → salesperson, chairman → chair, stewardess → flight attendant, manpower → workforce, etc.
- Avoid language that stereotypes professional roles or traits by gender.
- When both a gendered and a neutral form exist, always use the neutral form.
- Flag every violation with type MANQUEMENT_REGLEMENTAIRE, severity "warning", and include the exact text in quote and the neutral replacement in suggestedFix.`,
  },
  {
    id: "policy-internal-template",
    name: "Internal company policy template",
    type: "policy",
    builtin: true,
    enabled: false,
    alwaysApply: true,
    jurisdictions: [],
    summary: "Fill this with internal wording restrictions, approval flows and mandatory clauses.",
    content: `Replace this template with your internal policy. Example structure:
- Forbidden claims and expressions.
- Mandatory legal mentions or signatures.
- Approval workflow before sending.
- Product, client or geography restrictions.
- Escalation path when compliance is uncertain.`,
  },
];
