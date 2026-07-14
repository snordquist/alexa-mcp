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

### Routine write API — create / update / delete (reverse-engineered)

No open-source library implements these; they were recovered by decompiling the Alexa Android
app (routines live in a React Native **Hermes bytecode** bundle, disassembled with `hermes-dec`).
**Note the path is the non-`v2` `/api/behaviors/automations`** — the `v2` path is GET-only (POST
to it returns 404).

| Op | Method + path |
|---|---|
| Create | `POST /api/behaviors/automations` |
| Update | `PUT /api/behaviors/automations/{behaviorId}` |
| Delete | `DELETE /api/behaviors/automations/{behaviorId}` |
| Get one | `GET /api/behaviors/automations/{automationId}` |
| Validate an action payload | `POST /api/behaviors/operation/validate` |

`behaviorId` == `automationId`. Header `Routines-Version: <client-version>` is attached to writes
(plus `Content-Type: application/json`).

**The write body is NOT the read object.** It is a flat object whose sub-fields are **JSON
strings** with different key names (from the app's `Automation.serialize()`):

```jsonc
{
  "name": "…",
  "status": "ENABLED",              // | DISABLED
  "triggerJson":     "<JSON string of trigger.serialize()>",
  "triggerJsonList": ["<JSON string>", …],
  "sequenceJson":    "<JSON string of sequence.serialize()>"
  // optional (all stringified): conditionJson, tags, presentationDataList, personId, experience, groupId, identifiers
  // CREATE: omit behaviorId (server assigns amzn1.alexa.automation.<uuid>)
  // UPDATE: include behaviorId (also in the path)
}
```

- `trigger.serialize()` → `{"@type":"com.amazon.alexa.behaviors.model.Trigger","id":null,"skillId","type","payload"}`
  where **`payload` is itself a JSON STRING** (double-encoded). For a CustomUtterance trigger the
  decoded payload is `{"@type":"…CustomUtteranceTriggerPayload","locale","marketplaceId","utterance","utterances","customerId","person"}`.
- `sequence.serialize()` → `{"@type":"…Sequence","startNode": <node>}`; 1 action → `startNode` is
  the action node directly, ≥2 → `{"@type":"…SerialNode","nodesToExecute":[…]}`, 0 → a NOOP node.
- action node → `{"@type":"…OpaquePayloadOperationNode","type","skillId","operationPayload": <OBJECT, not stringified>,"context":null}`.
  `presentationDataList` is optional (only when requiresInput/warning/benefit set).
- The `operationPayload` must be **server-normalized** — post the action to
  `/api/behaviors/operation/validate` and embed the returned `operationPayload` object.

**Status: VERIFIED end-to-end** (create → update → delete round-trip succeeded live, 2026-07-14).
The two bugs that made hand-built bodies fail with `200 {"message":"Input failed to validate."}`:
(1) the trigger `payload` must be a **JSON string** (double-encoded), not an object; (2) the node
`operationPayload` must be the **validate-normalized** object, not a hand-made one.

Working recipe:
```
// A) normalize the action payload
POST /api/behaviors/operation/validate
  { "type":"Alexa.TextCommand",
    "operationPayload":"{\"deviceType\":\"…\",\"deviceSerialNumber\":\"…\",\"locale\":\"de-DE\",\"customerId\":\"…\",\"text\":\"…\"}" }
  → 200 { "result":"VALID", "operationPayload": <NORMALIZED OBJECT> }

// B) create (behaviorId omitted; include it + PUT for update)
POST /api/behaviors/automations
  { "name":"…", "status":"ENABLED",
    "triggerJson":     <stringify of {"@type":"…Trigger","id":null,"skillId":null,"type":"CustomUtterance","payload": <stringify of the CustomUtteranceTriggerPayload>}>,
    "triggerJsonList": [ <same string> ],
    "sequenceJson":    <stringify of {"@type":"…Sequence","startNode":{"@type":"…OpaquePayloadOperationNode","type":"Alexa.TextCommand","skillId":"amzn1.ask.1p.tellalexa","operationPayload": <NORMALIZED OBJECT>,"context":null}}> }
  → 200, returns the created Automation with a server-assigned automationId.
```
Header `Routines-Version` is sent but is not the blocker. The GraphQL/nexus path
(`/nexus/v1/graphql`, `batchUpdateAutomations`) is used only for read + bulk enable/disable + run;
create/update/delete are REST as above.

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
