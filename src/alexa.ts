import AlexaRemote from "alexa-remote2";
import { loadAuth, saveAuth, CookieData } from "./store.js";

/**
 * Central alexa-remote2 initialization.
 *
 * Two ways, one code path:
 *  - First login: no `.auth/alexa.json` present -> proxy mode. The library
 *    starts a local HTTP proxy that serves Amazon's REAL login page (incl. 2FA)
 *    and then captures the cookie + refreshToken.
 *  - Subsequent starts: `formerRegistrationData` from the file -> no login
 *    needed; the library refreshes the token itself (cookieRefreshInterval).
 *
 * On every `cookie` event we write `alexa.cookieData` back to disk so the
 * refreshed token stays persisted.
 */

export interface AlexaConfig {
  amazonPage: string;        // e.g. "amazon.de"
  acceptLanguage: string;    // e.g. "de-DE"
  proxyOwnIp: string;        // IP/host the browser reaches the proxy at
  proxyPort: number;
  proxyListenBind?: string;  // "0.0.0.0" to be reachable from other devices
  cookieRefreshIntervalMs: number;
  usePushConnection: boolean; // push connection; not needed for pure auditing
  logger?: (msg: string) => void;
}

export function defaultConfig(): AlexaConfig {
  return {
    amazonPage: process.env.ALEXA_MCP_AMAZON_PAGE ?? "amazon.de",
    acceptLanguage: process.env.ALEXA_MCP_ACCEPT_LANGUAGE ?? "de-DE",
    proxyOwnIp: process.env.ALEXA_MCP_PROXY_IP ?? "127.0.0.1",
    proxyPort: Number(process.env.ALEXA_MCP_PROXY_PORT ?? 3456),
    proxyListenBind: process.env.ALEXA_MCP_PROXY_BIND ?? "0.0.0.0",
    cookieRefreshIntervalMs: Number(
      process.env.ALEXA_MCP_REFRESH_MS ?? 4 * 24 * 60 * 60 * 1000, // 4 days
    ),
    usePushConnection: (process.env.ALEXA_MCP_WS_MQTT ?? "false") === "true",
    logger: undefined,
  };
}

/** Detects the "Please open http://…" login prompt from alexa-cookie2. */
function isProxyPrompt(err: Error): boolean {
  return /please open|login to amazon/i.test(err.message ?? "");
}

function extractUrl(err: Error): string | undefined {
  return (err.message ?? "").match(/https?:\/\/\S+/)?.[0]?.replace(/\.$/, "");
}

export interface InitResult {
  alexa: AlexaRemote;
  /** true if loaded from a persisted token (no interactive login needed). */
  fromStoredToken: boolean;
}

/**
 * Initializes alexa-remote2 and resolves once the init callback fires without
 * an error (i.e. after a successful login or token reload).
 *
 * @param interactive  When false and no token exists -> reject instead of
 *                     starting a proxy (the MCP server must never pop a login
 *                     prompt; it should fail loudly and tell the user to run
 *                     `npm run auth`).
 */
export function initAlexa(
  cfg: AlexaConfig = defaultConfig(),
  interactive = false,
): Promise<InitResult> {
  const stored = loadAuth();

  if (!stored && !interactive) {
    return Promise.reject(
      new Error(
        "No Alexa auth found (.auth/alexa.json). Run `npm run auth` first to log in once.",
      ),
    );
  }

  const alexa = new AlexaRemote();

  // Write the token back on every refresh/login.
  // The 'cookie' event fires on the first login AND on every 4-day refresh
  // (setCookie() emits it). cookieData is the complete formerRegistrationData
  // object (refreshToken, macDms, deviceSerial, …).
  alexa.on("cookie", () => {
    const data = (alexa as unknown as { cookieData?: CookieData }).cookieData;
    if (data && typeof data === "object" && Object.keys(data).length > 0) {
      saveAuth(data);
      (cfg.logger ?? (() => {}))("[alexa] Token updated and persisted.");
    }
  });

  return new Promise<InitResult>((resolvePromise, reject) => {
    // NOTE: alexa-remote2 has NO 'ready' event. Success is signalled by the
    // init callback firing WITHOUT an error. That callback is also called AGAIN
    // on every automatic refresh (default every 4 days) — hence the settled
    // guard (resolve the promise only once).
    let settled = false;

    alexa.init(
      {
        // Replay the persisted registration (no login needed).
        // setCookie() accepts the full object as `cookie`.
        cookie: stored as any,
        formerRegistrationData: stored as any,
        proxyOnly: true,
        proxyOwnIp: cfg.proxyOwnIp,
        proxyPort: cfg.proxyPort,
        proxyListenBind: cfg.proxyListenBind,
        proxyLogLevel: "warn",
        bluetooth: false,
        notifications: false,
        logger: cfg.logger,
        amazonPage: cfg.amazonPage,
        acceptLanguage: cfg.acceptLanguage,
        usePushConnection: cfg.usePushConnection,
        cookieRefreshInterval: cfg.cookieRefreshIntervalMs,
      } as any,
      (err?: Error) => {
        if (settled) {
          // Re-fired by the refresh timer: just log; the promise is long resolved.
          if (err) (cfg.logger ?? console.error)(`[alexa] refresh error: ${err.message}`);
          return;
        }
        // alexa-cookie2 calls this callback TWICE: first with the
        // "Please open http://…" prompt (once the proxy is listening), then
        // again with the real result AFTER the user logs in. During an
        // interactive login do NOT treat the prompt as a failure — keep waiting
        // for the second callback (the proxy server keeps the event loop alive).
        if (err && interactive && isProxyPrompt(err)) {
          (cfg.logger ?? console.error)(
            `\n>>> Open this in your browser now:\n>>> ${extractUrl(err) ?? err.message}\n`,
          );
          return;
        }
        settled = true;
        if (err) {
          if (!interactive && isProxyPrompt(err)) {
            reject(new Error("Alexa token expired/invalid — re-login needed: `npm run auth`."));
          } else {
            reject(err);
          }
          return;
        }
        resolvePromise({ alexa, fromStoredToken: !!stored });
      },
    );
  });
}
