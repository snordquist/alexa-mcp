/**
 * Non-interactive self-check.  Run:  npm run doctor
 *
 * Checks WITHOUT any network/login:
 *  - which configuration is in effect (env overrides),
 *  - whether a token already exists,
 *  - which URL you would open when logging in.
 * A wiring smoke test before starting the real login.
 */
import { networkInterfaces } from "node:os";
import { defaultConfig } from "./alexa.js";
import { AUTH_PATH, loadAuth } from "./store.js";

function lanIps(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const cfg = defaultConfig();
const auth = loadAuth();

console.log("alexa-mcp doctor");
console.log("----------------");
console.log("Configuration (overridable via env):");
console.log(`  amazonPage        = ${cfg.amazonPage}`);
console.log(`  acceptLanguage    = ${cfg.acceptLanguage}`);
console.log(`  proxyOwnIp        = ${cfg.proxyOwnIp}`);
console.log(`  proxyPort         = ${cfg.proxyPort}`);
console.log(`  proxyListenBind   = ${cfg.proxyListenBind}`);
console.log(`  refresh every     = ${(cfg.cookieRefreshIntervalMs / 86400000).toFixed(1)} days`);
console.log(`  usePushConnection = ${cfg.usePushConnection}`);
console.log("");
console.log(`Auth file: ${AUTH_PATH}`);
if (auth) {
  const keys = Object.keys(auth);
  const tokenDate = (auth as any).tokenDate as number | undefined;
  console.log(`  present (${keys.length} fields)`);
  console.log(`    has refreshToken: ${keys.includes("refreshToken")}`);
  console.log(`    has macDms:       ${keys.includes("macDms")}`);
  console.log(`    has deviceSerial: ${keys.includes("deviceSerial")}`);
  if (tokenDate) {
    const ageDays = (Date.now() - tokenDate) / 86400000;
    console.log(`    tokenDate:        ${ageDays.toFixed(1)} days ago`);
  }
  console.log("  -> Ready. `npm run smoke` lists devices + routines.");
} else {
  console.log("  none yet. Login needed: `npm run auth`");
  const ips = lanIps();
  console.log("");
  console.log("  Open this in your browser when logging in (on THIS machine):");
  console.log(`    http://${cfg.proxyOwnIp}:${cfg.proxyPort}/`);
  if (ips.length && cfg.proxyOwnIp === "127.0.0.1") {
    console.log("");
    console.log("  To log in from ANOTHER device, set");
    console.log(`    ALEXA_MCP_PROXY_IP=<one of these IPs: ${ips.join(", ")}>`);
    console.log("  because proxyOwnIp must exactly match the URL in the browser.");
  }
}
