/** Pure helpers shared across tools (kept dependency-free + unit-tested). */

/**
 * Flattens the nested phoenix structure (getSmarthomeDevices) into an appliance
 * list and dedupes by applianceId.
 */
export function flattenAppliances(root: unknown): any[] {
  const acc: any[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (o.applianceId && o.friendlyName !== undefined) {
      acc.push(o);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(root);
  const m = new Map<string, any>();
  for (const a of acc) if (!m.has(a.applianceId)) m.set(a.applianceId, a);
  return [...m.values()];
}

/**
 * A device reference found in a routine action.
 * - `smarthome`: `operationPayload.target` is an applianceId / entityId / groupId string.
 * - `echo`: an Echo serial number from an object target such as AlexaAnnouncement's
 *   `{customerId, devices: [{deviceSerialNumber, deviceTypeId}]}`.
 */
export type RoutineTarget = { kind: "smarthome" | "echo"; target: string; op: string };

/** Collects all device references in a routine's action sequence. */
export function collectRoutineTargets(routine: any): RoutineTarget[] {
  const out: RoutineTarget[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (String(n["@type"] || "").endsWith("OpaquePayloadOperationNode")) {
      const p = n.operationPayload || {};
      const op = (p.operations || []).map((o: any) => o.type).join(",") || n.type;
      if (typeof p.target === "string" && p.target) {
        out.push({ kind: "smarthome", target: p.target, op });
      } else if (p.target && typeof p.target === "object") {
        // Object target: customerId alone means all devices; `devices` names Echos.
        for (const d of Array.isArray(p.target.devices) ? p.target.devices : []) {
          if (typeof d?.deviceSerialNumber === "string" && d.deviceSerialNumber) {
            out.push({ kind: "echo", target: d.deviceSerialNumber, op });
          }
        }
      }
    }
    for (const k of ["startNode", "nodesToExecute", "nodes"]) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v) walk(v);
    }
  };
  walk(routine?.sequence?.startNode);
  return out;
}

/** Placeholders (ALEXA_CURRENT_DSN, …) and skill/automation ids are not device references. */
const isPlaceholderTarget = (t: string) => /^ALEXA_|CURRENT|^amzn1\./i.test(t);

/**
 * Returns the routine's device references that do not resolve: smart-home targets
 * missing from `validIds`, and Echo serials missing from `validSerials`.
 */
export function findDanglingTargets(
  routine: any,
  validIds: Set<string>,
  validSerials: Set<string>,
): RoutineTarget[] {
  return collectRoutineTargets(routine).filter((t) => {
    if (isPlaceholderTarget(t.target)) return false;
    if (t.kind === "echo" && validSerials.size === 0) {
      // An empty device list is more likely a bad API response than an account with no Echos.
      throw new Error(`Routine "${routine?.name}" targets Echo ${t.target}, but getDevices returned no devices`);
    }
    return t.kind === "echo" ? !validSerials.has(t.target) : !validIds.has(t.target);
  });
}
