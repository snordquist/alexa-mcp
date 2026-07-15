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

/** Collects all device-target ids referenced by a routine's action sequence. */
export function collectRoutineTargets(routine: any): { target: string; op: string }[] {
  const out: { target: string; op: string }[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (String(n["@type"] || "").endsWith("OpaquePayloadOperationNode")) {
      const p = n.operationPayload || {};
      if (p.target) out.push({ target: p.target, op: (p.operations || []).map((o: any) => o.type).join(",") || n.type });
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
