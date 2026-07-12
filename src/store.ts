import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Persistence of the alexa-remote2 registration/cookie data.
 *
 * We store the complete `alexa.cookieData` object (refreshToken, macDms,
 * deviceSerial, csrf, localCookie, …) verbatim as JSON. Deliberately
 * field-agnostic: alexa-remote2 can read the object back 1:1 as
 * `formerRegistrationData`, no matter how its inner fields change across
 * library versions.
 *
 * The file lives under .auth/ and is git-ignored (it contains a long-lived
 * token — treat it like a password).
 */

export const AUTH_PATH = resolve(process.env.ALEXA_MCP_AUTH_PATH ?? ".auth/alexa.json");

export type CookieData = Record<string, unknown>;

export function loadAuth(path: string = AUTH_PATH): CookieData | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return undefined;
    return JSON.parse(raw) as CookieData;
  } catch (err) {
    console.error(`[store] Could not read ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

export function saveAuth(data: CookieData, path: string = AUTH_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function hasAuth(path: string = AUTH_PATH): boolean {
  const d = loadAuth(path);
  return !!d && Object.keys(d).length > 0;
}
