# WiseMail Subscription Backend — API Contract

## Overview

The extension communicates with `https://api.wisemail.app/v1/` for license verification.
No other backend calls are made by the extension at this time; checkout is handled by
redirecting the user to `https://wisemail.app/subscribe?plan=annual|monthly` in a new tab.

---

## Plans and Pricing

| Plan    | Price     | Billing       |
|---------|-----------|---------------|
| annual  | €899.99   | Once per year |
| monthly | €83.33    | Every month (€999.99 / year total) |

---

## Endpoints

### POST `/v1/license/verify`

Called by the extension when the user clicks **Verify** after entering a license key.

#### Request

```json
{
  "license_key": "WISE-XXXX-XXXX-XXXX"
}
```

| Field         | Type   | Required | Description                     |
|---------------|--------|----------|---------------------------------|
| `license_key` | string | yes      | The license key to verify       |

#### Response — valid key

HTTP 200

```json
{
  "valid": true,
  "plan": "annual",
  "expires_at": "2027-04-29T00:00:00Z",
  "message": "Subscription active."
}
```

| Field        | Type             | Description                                         |
|--------------|------------------|-----------------------------------------------------|
| `valid`      | boolean          | `true` if the key is valid and the subscription is active |
| `plan`       | `"annual"` \| `"monthly"` | The billing plan                          |
| `expires_at` | ISO 8601 string  | UTC timestamp of subscription expiry                |
| `message`    | string           | Human-readable status message (shown in the UI)     |

#### Response — invalid / expired key

HTTP 200 (or 402)

```json
{
  "valid": false,
  "message": "License key not found."
}
```

```json
{
  "valid": false,
  "message": "Subscription expired on 2026-01-01."
}
```

| Field     | Type    | Description                                              |
|-----------|---------|----------------------------------------------------------|
| `valid`   | boolean | `false`                                                  |
| `message` | string  | Reason shown directly in the extension UI — keep it short |

#### Response — server error

HTTP 5xx — the extension displays a generic connectivity error to the user; no specific
JSON structure is required, but returning `{ "error": "..." }` is recommended for logs.

---

## Notes

### What the extension stores after a successful verification

```
browser.storage.local:
  licenseKey            string   — raw key entered by user
  subscriptionStatus    "active" | "expired"
  subscriptionPlan      "annual" | "monthly"
  subscriptionExpiresAt ISO 8601 string
```

The extension does **not** re-verify automatically after the first successful check.
The backend should provide a separate webhook or the checkout flow should prompt users
to re-enter their key if they renew.

### Security considerations

- License keys should be single-use-per-device or use a seat-based model; the extension
  does not send any device fingerprint today, but a `device_id` field can be added later.
- The verify endpoint should be rate-limited (e.g. 10 req / IP / minute) to prevent brute-force.
- HTTPS is assumed; the extension will refuse plain HTTP endpoints.

### Checkout flow (no backend involvement from the extension)

1. User clicks a pricing button → extension opens `https://wisemail.app/subscribe?plan=annual|monthly`.
2. Payment processor (e.g. Stripe) handles checkout.
3. After payment the thank-you page shows the generated license key.
4. User copies the key and pastes it in the extension's **License Key** field.
5. Extension calls `/v1/license/verify` to activate.
