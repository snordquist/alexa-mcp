/**
 * Read-only smoke test against the live account.  Run:  npm run smoke
 *
 * Uses the persisted token (no login). Lists devices, routines and scenes —
 * enough to audit what your account exposes. Read-only.
 */
import { promisify } from "node:util";
import { initAlexa } from "./alexa.js";

async function main() {
  const { alexa } = await initAlexa(); // interactive=false -> errors if no token

  const getDevices = promisify(alexa.getDevices).bind(alexa);
  const getRoutines = promisify(alexa.getAutomationRoutines).bind(alexa);
  const getScenes = promisify(alexa.getSmarthomeEntities).bind(alexa);

  const devices: any = await getDevices();
  const devList = devices?.devices ?? [];
  console.log(`\nDevices (${devList.length}):`);
  for (const d of devList) console.log(`  - ${d.accountName}  [${d.deviceType}]  serial=${d.serialNumber}`);

  const routines: any = await getRoutines(2000);
  const rList = Array.isArray(routines) ? routines : [];
  console.log(`\nRoutines (${rList.length}):`);
  for (const r of rList) {
    const trig = (r.triggers ?? [])
      .map((t: any) => t?.type ?? t?.payload?.["@type"] ?? "?")
      .join(",");
    console.log(`  - ${r.name}   id=${r.automationId}   status=${r.status}   triggers=[${trig}]`);
  }

  const scenes: any = await getScenes();
  const sList = Array.isArray(scenes) ? scenes : [];
  const sceneLike = sList.filter(
    (e: any) => /scene|activity|group/i.test(String(e?.entityType ?? e?.type ?? "")),
  );
  console.log(`\nSmart-home entities (${sList.length}, of which scene-like ${sceneLike.length}):`);
  for (const s of sceneLike.slice(0, 40)) {
    console.log(`  - ${s.friendlyName ?? s.displayName ?? s.name}  [${s.entityType ?? s.type}]`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err?.message ?? err);
  process.exit(1);
});
