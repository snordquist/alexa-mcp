# alexa-mcp

**The cleanup-focused Alexa MCP server.** An [MCP](https://modelcontextprotocol.io) server
that lets an AI assistant (Claude Code, Claude Desktop, …) **audit and clean up** your Amazon
Alexa account: list and inspect **routines**, list **smart-home devices** and **delete the
orphans** that pile up over time, plus read scenes and activity history.

It talks to Amazon's internal Alexa cloud API via
[`alexa-remote2`](https://github.com/Apollon77/alexa-remote).

> ### ⚠️ Disclaimer
> This project is **not affiliated with, endorsed by, or supported by Amazon.** There is **no
> official public API** for managing Alexa routines or smart-home devices — this tool uses the
> same **undocumented, reverse-engineered** endpoints the Alexa app uses, and may break at any
> time when Amazon changes them. Using it may violate Amazon's Terms of Service. **Use at your
> own risk**, against your own account only. The **login** happens on Amazon's real sign-in page
> (including 2FA); your credentials go only to Amazon — the local proxy only captures the
> resulting session token afterwards.

## Why this exists (vs. other Alexa MCP servers)

Other Alexa MCP servers focus on **control** (announcements/TTS, volume, lists). This one does
that **and** the things nothing else does — full **routine CRUD** (create/update/enable-disable/
delete) and **audit & cleanup** that **Amazon's own app can no longer do** (bulk-deleting
smart-home devices was removed from the Alexa web app). All reverse-engineered from the Alexa app
and verified end-to-end.

| Capability | This server |
|---|---|
| List / inspect routines (triggers + action sequence) | ✅ |
| **Create / update / enable-disable / delete routines** | ✅ (write-gated; verified) |
| Find routines with **broken references** (dangling targets) | ✅ |
| List smart-home devices (with source + reachability) | ✅ |
| **Delete a smart-home device** (orphan cleanup, reference-safe) | ✅ (write-gated) |
| Scenes, groups (list/create/delete), activity history | ✅ |
| Announcements / TTS / SSML, media transport, volume, DND | ✅ (write-gated) |
| Shopping / to-do lists (read + add) | ✅ |

It is **read-only by default**. Destructive tools are only registered when you explicitly opt in.

## Requirements

- **Node ≥ 20** (compiles with `tsc` to `dist/`, then runs on plain Node — no bundler).
- An Amazon account with **app-based 2FA** (SMS/email OTP no longer works with Amazon's login).
- Log in from a device/browser **without** the Alexa app installed (otherwise Amazon deep-links
  into the app instead of finishing the web login).

## Quick start

```bash
git clone https://github.com/snordquist/alexa-mcp.git
cd alexa-mcp
npm install
npm run doctor      # shows config + the login URL (no network)
npm run auth        # ONE-TIME: starts a local proxy, browser login incl. 2FA
npm run smoke       # lists devices, routines, scenes (read-only)
```

### `npm run auth` in detail

1. It starts a local proxy and prints a URL (default `http://127.0.0.1:3456/`).
2. Open that URL **in a browser on the same machine** and log in to your Amazon account (2FA).
3. On success the token (cookie + `refreshToken`) is written to `./.auth/alexa.json`
   (git-ignored) and refreshed automatically afterwards (every 4 days).
4. A smoke test (device list) runs. Done.

**Logging in from another device?** `proxyOwnIp` must match the URL in your browser exactly:

```bash
ALEXA_MCP_PROXY_IP=192.168.x.x npm run auth   # then open http://192.168.x.x:3456/
```

## Use as an MCP server

Read-only (recommended for auditing):

```bash
claude mcp add alexa -- node /ABSOLUTE/PATH/alexa-mcp/dist/index.js
```

With destructive tools enabled (delete routines / devices):

```bash
claude mcp add alexa --env ALEXA_MCP_ALLOW_WRITE=1 -- node /ABSOLUTE/PATH/alexa-mcp/dist/index.js
```

(Run `npm run build` first.)

## Tools

| Tool | Purpose | Writes |
|---|---|---|
| `alexa_list_devices` | Registered Echos / apps / Fire TVs | no |
| `alexa_list_routines` | All routines: id, name, status, triggers | no |
| `alexa_get_routine` | One routine as raw JSON (incl. action sequence) | no |
| `alexa_list_scenes` | Smart-home entities incl. scenes | no |
| `alexa_get_activity` | Activity history (customer-history-records) | no |
| `alexa_list_smarthome_devices` | Smart-home devices with source (skill/Matter) + entity id — find orphans | no |
| `alexa_audit_broken_references` | Find routines whose action targets a device/scene/group that no longer exists | no |
| `alexa_get_volumes` | Current speaker volume of every device | no |
| `alexa_get_do_not_disturb` | Do-Not-Disturb status per device | no |
| `alexa_query_device` | Live state of smart-home devices/groups by applianceId | no |
| `alexa_list_groups` | Smart-home groups (rooms/spaces) with members | no |
| `alexa_list_lists` | Shopping / to-do / custom lists | no |
| `alexa_get_list_items` | Items of a list by id | no |
| `alexa_get_player_info` | Now-playing / media player state of a device | no |
| `alexa_create_routine` | Create a routine (voice- or time-triggered) with one or more actions | **yes** |
| `alexa_update_routine` | Update a routine in place (full re-spec) | **yes** |
| `alexa_set_routine_enabled` | Enable/disable a routine by id (rebuilds + PUTs with flipped status) | **yes** |
| `alexa_trigger_routine` | Execute a routine now | **yes** |
| `alexa_delete_routine` | Delete a routine + verify | **yes** |
| `alexa_delete_smarthome_device` | Delete a smart-home device (orphan cleanup) — refuses if referenced by a routine/group unless `force`, and verifies removal | **yes** |
| `alexa_speak` | Make a device speak / announce (`speak` \| `announcement` \| `ssml`) | **yes** |
| `alexa_text_command` | Run a typed command as if spoken to a device | **yes** |
| `alexa_set_volume` | Set an Echo's speaker volume (0–100) | **yes** |
| `alexa_set_do_not_disturb` | Enable/disable Do-Not-Disturb on a device | **yes** |
| `alexa_media_control` | Media transport: play/pause/next/previous/forward/rewind/shuffle/repeat | **yes** |
| `alexa_add_list_item` | Add an item to a list | **yes** |
| `alexa_create_group` | Create a smart-home group (room/space) | **yes** |
| `alexa_delete_group` | Delete a smart-home group (members untouched) | **yes** |

Most write tools also accept `dryRun: true` to preview the request/plan without executing.

Routine **create/update** were reverse-engineered from the Alexa app and verified end-to-end; see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the exact write-API (the trigger `payload` is
double-encoded and the action `operationPayload` must be `/operation/validate`-normalized — the
tools handle both). Example create:

```json
{ "name": "Gute Nacht Ansage", "triggerUtterance": "gute nacht",
  "actions": [ { "type": "Alexa.TextCommand", "operationPayload": { "text": "schlaf gut" } } ],
  "confirm": true }
```

Write tools are only registered when `ALEXA_MCP_ALLOW_WRITE=1`, and each destructive call also
requires an explicit `confirm: true` argument.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ALEXA_MCP_AMAZON_PAGE` | `amazon.de` | Login region (e.g. `amazon.com`, `amazon.co.uk`) |
| `ALEXA_MCP_ACCEPT_LANGUAGE` | `de-DE` | Accept-Language header |
| `ALEXA_MCP_PROXY_IP` | `127.0.0.1` | Must match the URL you open during login |
| `ALEXA_MCP_PROXY_PORT` | `3456` | Proxy port for the login |
| `ALEXA_MCP_PROXY_BIND` | `0.0.0.0` | Proxy bind address |
| `ALEXA_MCP_REFRESH_MS` | `345600000` (4 d) | Token refresh interval |
| `ALEXA_MCP_ALLOW_WRITE` | – | `1` enables the destructive tools |
| `ALEXA_MCP_AUTH_PATH` | `.auth/alexa.json` | Token file location |

## Security & privacy

- The session token is stored **only** in `./.auth/alexa.json` (mode `0600`, git-ignored). It is
  never logged or committed. Treat that file like a password.
- The login proxy binds to `0.0.0.0` by default so you can log in from another device; set
  `ALEXA_MCP_PROXY_BIND=127.0.0.1` to keep it local-only.
- To fully sign out, delete `./.auth/alexa.json` (and remove the registered "device" from
  *Amazon → Manage Your Content and Devices*).

## Known limitations

- **Unofficial API** — can break whenever Amazon changes it.
- **Routine deletion endpoint is unverified.** `alexa_delete_routine` attempts
  `DELETE /api/behaviors/v2/automations/{id}`, which is not documented or confirmed. Verify the
  real request via browser DevTools before relying on it.
- **Device deletion may not be permanent** if the underlying source still advertises the device:
  a skill that is still linked (and whose backend responds) or a Matter bridge will re-add it on
  the next discovery. Orphans whose backend is gone (unlinked skill, removed integration) stay
  deleted.
- **Matter duplicate devices** (the same device appearing once per Alexa Echo/hub that acts as a
  Matter controller) are an Alexa-side artifact, not a bridge misconfiguration. Deleting the
  redundant copies works, but new ones can reappear if the Matter bridge is re-commissioned.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the auth flow, endpoint reference, and
implementation notes.

## License

[MIT](./LICENSE) © Sascha Nordquist
