# Architecture & implementation notes

Technical notes for `alexa-mcp`, verified against `alexa-remote2@8.1.0`. Useful if you want to
extend it or understand the non-obvious bits of Amazon's internal Alexa API.

## Stack

- **TypeScript / Node ≥ 20.** Compiled with `tsc` to `dist/`, run on plain Node — no bundler,
  no `tsx`. (Node can strip types natively, but it does not rewrite `.js` import specifiers to
  `.ts`, so the compiled-output path is used.)
- **MCP:** `@modelcontextprotocol/sdk` (`McpServer` + `registerTool`, stdio transport).
  Tool input schemas are Zod *raw shapes* (a plain object of Zod fields, **not** `z.object(...)`).
- **Alexa client:** `alexa-remote2`, which bundles `alexa-cookie2` internally —
  `AlexaRemote.init()` drives the whole cookie/proxy/refresh lifecycle. You do not call
  `alexa-cookie2` directly.

## Authentication flow

The server never starts a login proxy itself — it only ever loads a persisted token. Logging in
is a separate one-time step (`npm run auth`).

### Proxy login (one-time)

`alexa-remote2` starts a local HTTP proxy that serves Amazon's real login page. After the user
logs in (including app-based 2FA), the library captures the session cookie + `refreshToken`.

Non-obvious behaviors verified in the source:

1. **There is no `'ready'` event.** The library emits only `'cookie'` and `'command'`. Success
   is signalled by the `init` callback firing **without an error**.
2. **The proxy login surfaces as a "double callback".** `alexa-cookie2` calls the same `init`
   callback **twice**: first with an *error* — `Please open http://<ip>:<port>/ …` — the moment
   the proxy starts listening, then **again** with the real result after the user logs in. The
   first "error" must be treated as a *waiting* signal, not a failure — otherwise the process
   exits and kills the proxy before the user can open the URL.
3. **The `init` callback re-fires on every token refresh** (default every 4 days), re-invoking
   the same callback. Guard against resolving your promise more than once.
4. **`proxyOwnIp` must byte-match the URL opened in the browser** (default `127.0.0.1`), or
   Amazon serves a dead-end "use the app" page.

### Token persistence

The full `formerRegistrationData` object is persisted verbatim (field-agnostic) to
`.auth/alexa.json`:

```
{ macDms{device_private_key, adp_token}, localCookie, frc, "map-md", deviceId,
  deviceSerial, refreshToken, tokenDate, amazonPage, csrf, deviceAppName, dataVersion }
```

Persisting only the cookie string would register a **new device** on every login (device-list
pollution + push lockouts), so the whole object is stored and reloaded as `cookie` /
`formerRegistrationData`. The `'cookie'` event fires on first login and on every refresh; the
server re-writes the file each time.

## Endpoint reference

| Purpose | Method + path | Library method |
|---|---|---|
| Devices | `GET /api/devices-v2/device?cached=true` | `getDevices` |
| Routines | `GET /api/behaviors/v2/automations?limit=` | `getAutomationRoutines(limit)` |
| Execute routine | `POST /api/behaviors/preview` | `executeAutomationRoutine(serial, routineObj)` |
| Smart-home entities / scenes | `GET /api/behaviors/entities?skillId=amzn1.ask.1p.smarthome` | `getSmarthomeEntities` |
| Smart-home devices | `GET /api/phoenix` (nested) | `getSmarthomeDevices` |
| Delete smart-home device | `DELETE /api/phoenix/appliance/{id}` | `deleteSmarthomeDevice` |
| Activity history | `GET …/alexa-privacy/apd/rvh/customer-history-records-v2` | `getCustomerHistoryRecords` |

Notes:

- **`executeAutomationRoutine` takes the whole routine object** (not an id) and replays its
  `.sequence` as a `PREVIEW` behavior on a target Echo — so a valid device serial is required.
- **`getActivities`/`getHistory` were removed in `alexa-remote2` v8** → use
  `getCustomerHistoryRecords`.
- **There is no routine-delete method** in the library and no documented endpoint. The tool
  attempts `DELETE /api/behaviors/v2/automations/{id}` via the generic `httpsGet(…, {method:
  'DELETE'})` escape hatch, but this is **unverified** — capture the real request via browser
  DevTools before relying on it.

### The `applianceId` URL-encoding requirement (important)

Smart-home `applianceId`s from a skill look like:

```
SKILL_<base64-skillId>_switch#<object-id>
```

They contain `#`, `=`, `+`, and sometimes `/`. `deleteSmarthomeDevice` interpolates the id
**raw** into the URL path, so the `#` truncates the path as a fragment — the DELETE then returns
`{"success":true}` but **deletes nothing** (a silent no-op). This server calls the endpoint with
`encodeURIComponent(applianceId)` to make deletion actually take effect. A `DELETE` that returns
an empty body is success, not an error.

## Where Alexa smart-home devices come from

Devices in Alexa's smart-home list carry a `manufacturerName` and an `applianceId` prefix that
reveal their source:

- **`SKILL_…`** — provided by a smart-home skill (e.g. a self-hosted "Home Assistant" skill, or
  vendor skills like Hue/tado/…). Removing a device from the skill's exposure filter does **not**
  remove it from Alexa; it lingers as an orphan until deleted here (or the skill re-advertises it
  on discovery).
- **`AAA_…`** — Matter devices (e.g. via a Matter bridge). Alexa can create **one entry per Echo
  hub that acts as a Matter controller** for the same endpoint (distinguishable by the
  `connectedVia` field) — this is an Alexa-side duplication, not a bridge fault. Deleting the
  redundant copies (keeping one) works and holds, but re-commissioning the bridge can bring them
  back.

Cross-reference the smart-home list against your source-of-truth (e.g. what your skill/bridge
currently exposes) to find orphans; the entity id is available in the device's
`friendlyDescription` for skill devices.

## Project layout

```
src/
  index.ts     # MCP server (stdio), tool registry, write-gating
  alexa.ts     # alexa-remote2 init: proxy/reload, single-resolve guard, cookie -> persist
  store.ts     # field-agnostic token persistence (.auth/alexa.json, 0600)
  auth-cli.ts  # `npm run auth`: interactive proxy login + smoke test
  doctor.ts    # `npm run doctor`: config / token / login-URL check (no network)
  smoke.ts     # `npm run smoke`: read devices/routines/scenes with the stored token
```
