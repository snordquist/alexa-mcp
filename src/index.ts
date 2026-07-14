#!/usr/bin/env node
/**
 * alexa-mcp — MCP server (stdio).
 *
 * Read-only by default. Destructive tools (trigger/delete) are only registered
 * when ALEXA_MCP_ALLOW_WRITE=1. The server NEVER starts a proxy login; if the
 * token is missing, the tools return a clear hint to run `npm run auth`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type AlexaRemote from "alexa-remote2";
import { initAlexa } from "./alexa.js";
import { writeRoutine, setRoutineEnabled, type TriggerSpec } from "./routines.js";

const ALLOW_WRITE = process.env.ALEXA_MCP_ALLOW_WRITE === "1";

// -- Lazy Alexa singleton ---------------------------------------------------
let alexaPromise: Promise<AlexaRemote> | null = null;
async function getAlexa(): Promise<AlexaRemote> {
  if (!alexaPromise) {
    alexaPromise = initAlexa(undefined, /* interactive */ false)
      .then((r) => r.alexa)
      .catch((err) => {
        alexaPromise = null; // retry on the next tool call
        throw err;
      });
  }
  return alexaPromise;
}

// Callback API -> Promise (the library uses (err, body) callbacks).
function call<T>(fn: (cb: (err: any, body: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, body) => (err ? reject(err) : resolve(body))),
  );
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(msg: string) {
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

/** Flattens the nested phoenix structure (getSmarthomeDevices) into an
 * appliance list and dedupes by applianceId. */
function flattenAppliances(root: unknown): any[] {
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
function collectRoutineTargets(routine: any): { target: string; op: string }[] {
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

const server = new McpServer({ name: "alexa-mcp", version: "0.1.0" });

// -- Read tools -------------------------------------------------------------
server.registerTool(
  "alexa_list_devices",
  {
    title: "List Alexa devices",
    description: "All registered Echos / apps / Fire TVs (name, type, serial number).",
    inputSchema: {},
  },
  async () => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => alexa.getDevices(cb));
      const devices = (res?.devices ?? []).map((d: any) => ({
        name: d.accountName,
        type: d.deviceType,
        serial: d.serialNumber,
        online: d.online,
        family: d.deviceFamily,
      }));
      return ok(devices);
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_list_routines",
  {
    title: "List Alexa routines",
    description:
      "All routines: automationId, name, status, trigger types. Use this to identify a " +
      "routine (e.g. a scheduled one that fires an unexpected scene).",
    inputSchema: { limit: z.number().int().positive().max(5000).optional() },
  },
  async ({ limit }) => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => alexa.getAutomationRoutines(limit ?? 2000, cb));
      const list = (Array.isArray(res) ? res : []).map((r: any) => ({
        automationId: r.automationId,
        name: r.name,
        status: r.status,
        triggers: (r.triggers ?? []).map((t: any) => ({
          type: t?.type,
          payload: t?.payload,
        })),
      }));
      return ok(list);
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_get_routine",
  {
    title: "Inspect an Alexa routine",
    description: "Raw JSON of one routine (incl. action sequence) by automationId.",
    inputSchema: { automationId: z.string() },
  },
  async ({ automationId }) => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => alexa.getAutomationRoutines(2000, cb));
      const found = (Array.isArray(res) ? res : []).find((r: any) => r.automationId === automationId);
      return found ? ok(found) : fail(`No routine with automationId=${automationId}`);
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_list_scenes",
  {
    title: "List scenes / smart-home entities",
    description: "Smart-home entities including scenes usable as routine actions.",
    inputSchema: { filter: z.string().optional() },
  },
  async ({ filter }) => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => alexa.getSmarthomeEntities(cb));
      let list = Array.isArray(res) ? res : [];
      if (filter) {
        const f = filter.toLowerCase();
        list = list.filter((e: any) => JSON.stringify(e).toLowerCase().includes(f));
      }
      const mapped = list.map((e: any) => ({
        name: e.friendlyName ?? e.displayName ?? e.name,
        entityType: e.entityType ?? e.type,
        id: e.id ?? e.entityId ?? e.applianceId,
      }));
      return ok(mapped);
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_get_activity",
  {
    title: "Activity history",
    description:
      "Activity history (customer-history-records-v2). Shows what fired when — useful to " +
      "confirm when a routine or command was triggered.",
    inputSchema: {
      startTimeMs: z.number().int().optional(),
      endTimeMs: z.number().int().optional(),
      recordType: z.string().optional(),
    },
  },
  async ({ startTimeMs, endTimeMs, recordType }) => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) =>
        alexa.getCustomerHistoryRecords(
          {
            startTime: startTimeMs ?? Date.now() - 24 * 60 * 60 * 1000,
            endTime: endTimeMs ?? Date.now(),
            recordType: recordType ?? "VOICE_HISTORY",
            maxRecordSize: 50,
          },
          cb,
        ),
      );
      return ok(res);
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_list_smarthome_devices",
  {
    title: "List smart-home devices (with source)",
    description:
      "All smart-home devices with applianceId, source (manufacturerName + applianceId prefix: " +
      "SKILL = a smart-home skill, AAA = Matter/Matter bridge) and — for skill devices — the " +
      "backing entity id. Use this to find orphaned devices (still in Alexa but no longer " +
      "exposed by their source).",
    inputSchema: {
      manufacturer: z.string().optional(),
      onlyManufacturer: z.string().optional(),
    },
  },
  async ({ manufacturer, onlyManufacturer }) => {
    try {
      const alexa = await getAlexa();
      const raw = await call((cb) => alexa.getSmarthomeDevices(cb));
      let list = flattenAppliances(raw).map((a: any) => ({
        applianceId: a.applianceId,
        friendlyName: a.friendlyName,
        manufacturerName: a.manufacturerName,
        source: String(a.applianceId).split("_")[0],
        entityId: a.entityId,
        haEntityId: /^SKILL/.test(a.applianceId)
          ? (a.friendlyDescription || "").replace(/ via .*$/, "").trim()
          : undefined,
        reachability: a.applianceNetworkState?.reachability,
      }));
      const mfr = onlyManufacturer ?? manufacturer;
      if (mfr) list = list.filter((d) => d.manufacturerName === mfr);
      return ok({ count: list.length, devices: list });
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

server.registerTool(
  "alexa_audit_broken_references",
  {
    title: "Audit routines for broken references",
    description:
      "Read-only. Scans every routine's action targets and reports any that point to a device, " +
      "scene or group that no longer exists (dangling references — e.g. after a device was " +
      "deleted). Catches routines silently broken by cleanup.",
    inputSchema: {},
  },
  async () => {
    try {
      const alexa = await getAlexa();
      const [devRaw, ents, groups, routines] = await Promise.all([
        call<any>((cb) => alexa.getSmarthomeDevices(cb)),
        call<any>((cb) => alexa.getSmarthomeEntities(cb)),
        call<any>((cb) => alexa.getSmarthomeGroups(cb)),
        call<any>((cb) => alexa.getAutomationRoutines(2000, cb)),
      ]);

      // Build the universe of valid target ids: appliances (applianceId +
      // entityId), smart-home entities, and groups.
      const valid = new Set<string>();
      for (const a of flattenAppliances(devRaw)) {
        if (a.applianceId) valid.add(a.applianceId);
        if (a.entityId) valid.add(a.entityId);
      }
      for (const e of Array.isArray(ents) ? ents : []) {
        for (const k of ["id", "entityId", "applianceId"]) if (e?.[k]) valid.add(e[k]);
      }
      for (const g of groups?.applianceGroups ?? []) {
        for (const k of ["groupId", "entityId", "applianceId", "id"]) if (g?.[k]) valid.add(g[k]);
      }

      // Targets that are placeholders / skill ids are not device references.
      const isSpecial = (t?: string) => !t || /^ALEXA_|CURRENT|^amzn1\./i.test(t);
      const collectTargets = (r: any) => {
        const out: { target: string; op: string }[] = [];
        const walk = (n: any) => {
          if (!n || typeof n !== "object") return;
          if (String(n["@type"] || "").endsWith("OpaquePayloadOperationNode")) {
            const p = n.operationPayload || {};
            if (p.target) {
              out.push({ target: p.target, op: (p.operations || []).map((o: any) => o.type).join(",") || n.type });
            }
          }
          for (const k of ["startNode", "nodesToExecute", "nodes"]) {
            const v = n[k];
            if (Array.isArray(v)) v.forEach(walk);
            else if (v) walk(v);
          }
        };
        walk(r.sequence?.startNode);
        return out;
      };

      const rList = Array.isArray(routines) ? routines : [];
      const broken = [];
      for (const r of rList) {
        const dangling = collectTargets(r).filter((t) => !isSpecial(t.target) && !valid.has(t.target));
        if (dangling.length) {
          broken.push({ name: r.name, automationId: r.automationId, status: r.status, dangling });
        }
      }
      return ok({
        routinesTotal: rList.length,
        healthy: rList.length - broken.length,
        brokenCount: broken.length,
        broken,
      });
    } catch (e: any) {
      return fail(hint(e));
    }
  },
);

// -- Write tools (gated) ----------------------------------------------------
if (ALLOW_WRITE) {
  server.registerTool(
    "alexa_delete_smarthome_device",
    {
      title: "Delete a smart-home device (reference-safe)",
      description:
        "Deletes a smart-home device (DELETE /api/phoenix/appliance/{id}) to clean up orphans. " +
        "SAFETY: refuses if the device is referenced by a routine or group (pass force:true to " +
        "override) and verifies afterwards that it is actually gone. The applianceId is " +
        "URL-encoded automatically (it contains #/=), otherwise the DELETE is a silent no-op. " +
        "Requires confirm:true.",
      inputSchema: {
        applianceId: z.string(),
        confirm: z.literal(true),
        force: z.boolean().optional(),
      },
    },
    async ({ applianceId, force }) => {
      try {
        const alexa = await getAlexa();

        // Resolve the device (to also match by its entityId, which is what
        // routines reference) and run the reference check.
        const before = flattenAppliances(await call((cb) => alexa.getSmarthomeDevices(cb)));
        const dev = before.find((a) => a.applianceId === applianceId);
        const entityId: string | undefined = dev?.entityId;
        const ids = new Set([applianceId, entityId].filter(Boolean) as string[]);

        const [routines, groups] = await Promise.all([
          call<any>((cb) => alexa.getAutomationRoutines(2000, cb)),
          call<any>((cb) => alexa.getSmarthomeGroups(cb)),
        ]);
        const refRoutines = (Array.isArray(routines) ? routines : [])
          .filter((r) => collectRoutineTargets(r).some((t) => ids.has(t.target)))
          .map((r) => ({ name: r.name, automationId: r.automationId }));
        const refGroups = (groups?.applianceGroups ?? [])
          .filter((g: any) => [...ids].some((id) => JSON.stringify(g).includes(id)))
          .map((g: any) => ({ name: g.name, id: g.groupId ?? g.entityId ?? g.applianceId }));

        if ((refRoutines.length || refGroups.length) && !force) {
          return fail(
            `Refusing to delete "${dev?.friendlyName ?? applianceId}": still referenced by ` +
              `${refRoutines.length} routine(s) and ${refGroups.length} group(s). Deleting would ` +
              `break them. Pass force:true to override.\n` +
              `routines: ${JSON.stringify(refRoutines)}\ngroups: ${JSON.stringify(refGroups)}`,
          );
        }

        const path = `/api/phoenix/appliance/${encodeURIComponent(applianceId)}`;
        const result = await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            path,
            (err: any, body: any) => (err ? reject(err) : resolve(body ?? { success: true })),
            { method: "DELETE" },
          );
        });

        // Verify: re-query and confirm the device is actually gone.
        const after = flattenAppliances(await call((cb) => alexa.getSmarthomeDevices(cb)));
        const stillThere = after.some((a) => a.applianceId === applianceId);

        return ok({
          deleted: applianceId,
          friendlyName: dev?.friendlyName,
          apiSuccess: result?.success === true,
          verifiedGone: !stillThere,
          note: stillThere ? "device still present after delete (may have respawned / no-op)" : undefined,
          wasReferenced: { routines: refRoutines, groups: refGroups },
          forced: !!force,
        });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  server.registerTool(
    "alexa_trigger_routine",
    {
      title: "Execute a routine",
      description:
        "Executes a routine (replays its sequence as a PREVIEW behavior). Needs a target Echo " +
        "(serial) — the first device is used if none is given.",
      inputSchema: {
        automationId: z.string(),
        deviceSerial: z.string().optional(),
      },
    },
    async ({ automationId, deviceSerial }) => {
      try {
        const alexa = await getAlexa();
        const routines: any = await call((cb) => alexa.getAutomationRoutines(2000, cb));
        const routine = (Array.isArray(routines) ? routines : []).find(
          (r: any) => r.automationId === automationId,
        );
        if (!routine) return fail(`No routine with automationId=${automationId}`);

        let serial = deviceSerial;
        if (!serial) {
          const dev: any = await call((cb) => alexa.getDevices(cb));
          serial = dev?.devices?.find((d: any) => d.deviceFamily === "ECHO")?.serialNumber
            ?? dev?.devices?.[0]?.serialNumber;
        }
        if (!serial) return fail("No target device found.");

        const result: any = await call((cb) => alexa.executeAutomationRoutine(serial!, routine, cb));
        return ok({ triggered: automationId, on: serial, result });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  server.registerTool(
    "alexa_delete_routine",
    {
      title: "Delete a routine",
      description:
        "Deletes a routine via DELETE /api/behaviors/automations/{id} (the non-v2 path; verified " +
        "end-to-end). Requires confirm:true.",
      inputSchema: {
        automationId: z.string(),
        confirm: z.literal(true),
      },
    },
    async ({ automationId }) => {
      try {
        const alexa = await getAlexa();
        // NOTE: the non-v2 path. `/api/behaviors/v2/automations/{id}` is GET-only (404 on DELETE).
        const path = `/api/behaviors/automations/${encodeURIComponent(automationId)}`;
        await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            path,
            (err: any, body: any) => (err ? reject(err) : resolve(body ?? { ok: true })),
            { method: "DELETE" },
          );
        });
        // Verify it's gone.
        const routines: any = await call((cb) => alexa.getAutomationRoutines(2000, cb));
        const stillThere = (Array.isArray(routines) ? routines : []).some(
          (r: any) => r.automationId === automationId,
        );
        return ok({ deleted: automationId, verifiedGone: !stillThere });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  const routineWriteShape = {
    name: z.string(),
    triggerUtterance: z.string().optional(),
    triggerTime: z.string().optional(),
    triggerDays: z.array(z.string()).optional(),
    triggerTimeZone: z.string().optional(),
    actions: z
      .array(z.object({ type: z.string(), operationPayload: z.record(z.any()) }))
      .min(1),
    status: z.enum(["ENABLED", "DISABLED"]).optional(),
    confirm: z.literal(true),
  } as const;

  const buildTriggerSpec = (a: any): TriggerSpec | null => {
    if (a.triggerUtterance) return { kind: "utterance", utterance: a.triggerUtterance };
    if (a.triggerTime)
      return { kind: "schedule", time: a.triggerTime, days: a.triggerDays, timeZoneId: a.triggerTimeZone };
    return null;
  };

  server.registerTool(
    "alexa_create_routine",
    {
      title: "Create a routine",
      description:
        "Creates a routine (POST /api/behaviors/automations, verified). Give a trigger — either " +
        "triggerUtterance (voice phrase) or triggerTime 'HH:MM' (+ optional triggerDays like " +
        "['MO','TU'] and triggerTimeZone) — and one or more actions {type, operationPayload}. " +
        "Each action's operationPayload is server-normalized via /operation/validate. For " +
        "Alexa.TextCommand pass operationPayload {text} (deviceType/deviceSerialNumber/locale/" +
        "customerId are auto-filled). Requires confirm:true.",
      inputSchema: routineWriteShape,
    },
    async (a) => {
      try {
        const alexa = await getAlexa();
        const trigger = buildTriggerSpec(a);
        if (!trigger) return fail("Provide triggerUtterance or triggerTime.");
        const res: any = await writeRoutine(alexa, {
          name: a.name,
          trigger,
          actions: a.actions as any,
          status: a.status,
        });
        return ok({ created: res?.automationId, name: a.name, response: res });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  server.registerTool(
    "alexa_update_routine",
    {
      title: "Update a routine",
      description:
        "Updates a routine (PUT /api/behaviors/automations/{id}, verified). Send the full desired " +
        "state: automationId + name + trigger (triggerUtterance or triggerTime) + actions. Same " +
        "action shape as alexa_create_routine. Requires confirm:true.",
      inputSchema: { automationId: z.string(), ...routineWriteShape },
    },
    async (a) => {
      try {
        const alexa = await getAlexa();
        const trigger = buildTriggerSpec(a);
        if (!trigger) return fail("Provide triggerUtterance or triggerTime.");
        const res: any = await writeRoutine(alexa, {
          name: a.name,
          trigger,
          actions: a.actions as any,
          status: a.status,
          behaviorId: a.automationId,
        });
        return ok({ updated: a.automationId, name: a.name, response: res });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  server.registerTool(
    "alexa_set_routine_enabled",
    {
      title: "Enable or disable a routine",
      description:
        "Enables or disables an existing routine (by automationId). Alexa has no status-only " +
        "endpoint, so this rebuilds the routine's write body from its current state and PUTs it " +
        "with the status flipped; verifies the new status. Works for voice/time-triggered " +
        "routines; exotic trigger/action types may not round-trip. Requires confirm:true.",
      inputSchema: {
        automationId: z.string(),
        enabled: z.boolean(),
        confirm: z.literal(true),
      },
    },
    async ({ automationId, enabled }) => {
      try {
        const alexa = await getAlexa();
        const { status } = await setRoutineEnabled(alexa, automationId, enabled);
        return ok({ automationId, requested: enabled ? "ENABLED" : "DISABLED", status });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );
}

function hint(e: any): string {
  const msg = e?.message ?? String(e);
  if (/\.auth\/alexa\.json|No Alexa auth|re-login needed/.test(msg)) {
    return `${msg}\n-> Log in once: run \`npm run auth\` in the alexa-mcp directory.`;
  }
  return msg;
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[alexa-mcp] ready (write=${ALLOW_WRITE ? "ON" : "off"}). ` +
    `${ALLOW_WRITE ? "" : "Set ALEXA_MCP_ALLOW_WRITE=1 for trigger/delete tools."}`,
);
