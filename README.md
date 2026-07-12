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

Most Alexa MCP servers focus on **control** (announcements/TTS, volume, running routines, lists,
groups). This one is deliberately narrow and complementary — it focuses on the **audit &
cleanup** gap that nothing else covers and that **Amazon's own app can no longer do**
(bulk-deleting smart-home devices was removed from the Alexa web app):

| Capability | This server |
|---|---|
| List routines | ✅ |
| Inspect a routine's triggers & action sequence | ✅ |
| **Delete a routine** | ✅ (write-gated; endpoint unverified — see limitations) |
| List smart-home devices (with source + reachability) | ✅ |
| **Delete a smart-home device** (orphan cleanup) | ✅ (write-gated) |
| List scenes / smart-home entities | ✅ |
| Activity history | ✅ |
| Announcements / TTS / volume / lists | ❌ (use a control-focused server or Home Assistant) |

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
| `alexa_trigger_routine` | Execute a routine | **yes** |
| `alexa_delete_routine` | Delete a routine (endpoint unverified — see limitations) | **yes** |
| `alexa_delete_smarthome_device` | Delete a smart-home device (orphan cleanup) | **yes** |

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
