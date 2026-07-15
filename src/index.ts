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
import { flattenAppliances, collectRoutineTargets } from "./util.js";

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

// Some read endpoints (lists, notifications) intermittently return an empty
// body -> alexa-remote2 surfaces "no JSON"/"no body". Retry those transients.
async function callRetry<T>(fn: (cb: (err: any, body: T) => void) => void, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await call(fn); }
    catch (e: any) {
      if (i >= tries - 1 || !/no json|no body/i.test(e?.message ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(msg: string) {
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
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

// -- Control read tools (parity with control-focused servers) ---------------
server.registerTool(
  "alexa_get_volumes",
  { title: "Get device volumes", description: "Current speaker volume of every device.", inputSchema: {} },
  async () => {
    try { const alexa = await getAlexa(); return ok(await call((cb) => (alexa as any).getAllDeviceVolumes(cb))); }
    catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_get_do_not_disturb",
  { title: "Get Do-Not-Disturb status", description: "Do-Not-Disturb state per device.", inputSchema: {} },
  async () => {
    try { const alexa = await getAlexa(); return ok(await call((cb) => (alexa as any).getDoNotDisturb(cb))); }
    catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_query_device",
  {
    title: "Query smart-home device state",
    description: "Live state of smart-home devices/groups by applianceId (or entityId).",
    inputSchema: { applianceIds: z.array(z.string()).min(1), entityType: z.enum(["APPLIANCE", "GROUP"]).optional() },
  },
  async ({ applianceIds, entityType }) => {
    try {
      const alexa = await getAlexa();
      const res = entityType
        ? await call((cb) => (alexa as any).querySmarthomeDevices(applianceIds, entityType, cb))
        : await call((cb) => (alexa as any).querySmarthomeDevices(applianceIds, cb));
      return ok(res);
    } catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_list_groups",
  { title: "List smart-home groups", description: "Smart-home groups (rooms/spaces) with members.", inputSchema: {} },
  async () => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => alexa.getSmarthomeGroups(cb));
      const groups = (res?.applianceGroups ?? []).map((g: any) => ({
        name: g.name, groupId: g.groupId ?? g.entityId, applianceIds: g.applianceIds, type: g.type,
      }));
      return ok(groups);
    } catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_list_lists",
  { title: "List shopping/to-do lists", description: "Alexa lists (shopping list, to-do, custom).", inputSchema: {} },
  async () => {
    try {
      const alexa = await getAlexa();
      const res: any = await callRetry((cb) => (alexa as any).getListsV2(cb));
      const arr = res?.lists ?? (Array.isArray(res) ? res : Object.values(res ?? {}));
      // getListsV2 returns `id` as a single-element array — normalize to a string listId.
      const lists = (arr as any[]).filter((l) => l && typeof l === "object").map((l: any) => ({
        listId: Array.isArray(l.id) ? l.id[0] : (l.id ?? l.listId),
        name: l.name,
        type: l.type,
      }));
      return ok(lists);
    } catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_get_list_items",
  {
    title: "Get items of a list",
    description: "Items of a list by listId (from alexa_list_lists).",
    inputSchema: { listId: z.string() },
  },
  async ({ listId }) => {
    try {
      const alexa = await getAlexa();
      // v1 returns PLAINTEXT item names (`value`); v2's `encryptedItemName` is ciphertext.
      const res: any = await callRetry((cb) => (alexa as any).getListItems(listId, {}, cb));
      const items = (Array.isArray(res) ? res : Object.values(res ?? {})).filter(
        (v: any) => v && typeof v === "object" && v.id,
      );
      return ok(items.map((i: any) => ({ itemId: i.id, value: i.value, completed: i.completed, version: i.version })));
    } catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_get_player_info",
  {
    title: "Now playing / player state",
    description: "Current media player state (now playing, progress, provider) for a device.",
    inputSchema: { device: z.string() },
  },
  async ({ device }) => {
    try {
      const alexa = await getAlexa();
      const res: any = await call((cb) => (alexa as any).getPlayerInfo(device, cb));
      return ok(res?.playerInfo ?? res);
    } catch (e: any) { return fail(hint(e)); }
  },
);

server.registerTool(
  "alexa_list_notifications",
  {
    title: "List reminders / alarms / timers",
    description: "All notifications (reminders, alarms, timers) with id, type, time, label, status.",
    inputSchema: { type: z.enum(["Reminder", "Alarm", "Timer"]).optional() },
  },
  async ({ type }) => {
    try {
      const alexa = await getAlexa();
      // uncached read; retry the transient empty-body ("no JSON") error.
      const res: any = await callRetry((cb) => (alexa as any).getNotifications(false, cb));
      let list = res?.notifications ?? [];
      if (type) list = list.filter((n: any) => n.type === type);
      const mapped = list.map((n: any) => ({
        id: n.id, type: n.type, status: n.status,
        label: n.reminderLabel ?? n.timerLabel ?? n.alarmLabel,
        date: n.originalDate, time: n.originalTime,
        device: n.deviceSerialNumber, recurrence: n.recurringPattern,
      }));
      return ok({ count: mapped.length, notifications: mapped });
    } catch (e: any) { return fail(hint(e)); }
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
    dryRun: z.boolean().optional(),
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
          dryRun: a.dryRun,
        });
        return ok(a.dryRun ? res : { created: res?.automationId, name: a.name, response: res });
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
          dryRun: a.dryRun,
        });
        return ok(a.dryRun ? res : { updated: a.automationId, name: a.name, response: res });
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
        dryRun: z.boolean().optional(),
        confirm: z.literal(true),
      },
    },
    async ({ automationId, enabled, dryRun }) => {
      try {
        const alexa = await getAlexa();
        const res = await setRoutineEnabled(alexa, automationId, enabled, dryRun);
        return ok(dryRun ? res : { automationId, requested: enabled ? "ENABLED" : "DISABLED", status: (res as any).status });
      } catch (e: any) {
        return fail(hint(e));
      }
    },
  );

  // -- Control write tools (parity) ----------------------------------------
  server.registerTool(
    "alexa_speak",
    {
      title: "Make a device speak / announce",
      description:
        "Makes an Echo say something. mode 'speak' = plain TTS, 'announcement' = the chime + " +
        "'announcement on all/one device', 'ssml' = SSML markup in text. device = Echo name or serial.",
      inputSchema: {
        device: z.string(),
        text: z.string(),
        mode: z.enum(["speak", "announcement", "ssml"]).optional(),
        confirm: z.literal(true),
      },
    },
    async ({ device, text, mode }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => alexa.sendSequenceCommand(device, mode ?? "speak", text, cb));
        return ok({ device, mode: mode ?? "speak", said: text });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_text_command",
    {
      title: "Send a text command to Alexa",
      description: "Runs a typed command as if spoken to the device (e.g. 'wie spät ist es').",
      inputSchema: { device: z.string(), text: z.string(), confirm: z.literal(true) },
    },
    async ({ device, text }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => alexa.sendSequenceCommand(device, "textCommand", text, cb));
        return ok({ device, command: text });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_set_volume",
    {
      title: "Set device volume",
      description: "Sets an Echo's speaker volume (0–100). device = name or serial.",
      inputSchema: { device: z.string(), volume: z.number().int().min(0).max(100), confirm: z.literal(true) },
    },
    async ({ device, volume }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => alexa.sendSequenceCommand(device, "volume", volume, cb));
        return ok({ device, volume });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_set_do_not_disturb",
    {
      title: "Set Do-Not-Disturb",
      description: "Enables/disables Do-Not-Disturb on a device. device = name or serial.",
      inputSchema: { device: z.string(), enabled: z.boolean(), confirm: z.literal(true) },
    },
    async ({ device, enabled }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => (alexa as any).setDoNotDisturb(device, enabled, cb));
        return ok({ device, doNotDisturb: enabled });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_add_list_item",
    {
      title: "Add an item to a list",
      description: "Adds an item (text) to a list by listId (from alexa_list_lists).",
      inputSchema: { listId: z.string(), value: z.string(), confirm: z.literal(true) },
    },
    async ({ listId, value }) => {
      try {
        const alexa = await getAlexa();
        const res = await call((cb) => (alexa as any).addListItem(listId, value, cb));
        return ok({ listId, added: value, result: res });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_media_control",
    {
      title: "Media transport control",
      description:
        "Controls media playback on a device: play, pause, next, previous, forward, rewind, " +
        "shuffle, repeat. For shuffle/repeat pass value:true/false. device = name or serial. " +
        "Verified on Echo Show.",
      inputSchema: {
        device: z.string(),
        command: z.enum(["play", "pause", "next", "previous", "forward", "rewind", "shuffle", "repeat"]),
        value: z.boolean().optional(),
        confirm: z.literal(true),
      },
    },
    async ({ device, command, value }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => alexa.sendCommand(device, command as any, (value ?? null) as any, cb));
        return ok({ device, command, value: value ?? null });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_create_group",
    {
      title: "Create a smart-home group",
      description:
        "Creates a smart-home group (room/space) via POST /api/phoenix/group and returns its " +
        "groupId. Pass applianceIds (from alexa_list_smarthome_devices) to add members, or none " +
        "for an empty group. Requires confirm:true.",
      inputSchema: {
        name: z.string(),
        applianceIds: z.array(z.string()).optional(),
        confirm: z.literal(true),
      },
    },
    async ({ name, applianceIds }) => {
      try {
        const alexa = await getAlexa();
        const body = { name, applianceIds: applianceIds ?? [], type: "SPACE", defaults: [], childIds: [] };
        const result = await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            "/api/phoenix/group",
            (err: any, b: any) => (err ? reject(err) : resolve(b ?? { success: true })),
            { method: "POST", data: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
          );
        });
        if (result?.success !== true) return fail(`Create returned: ${JSON.stringify(result)}`);
        // Re-query to return the assigned groupId.
        const g: any = await call((cb) => alexa.getSmarthomeGroups(cb));
        const created = (g?.applianceGroups ?? []).find((x: any) => x.name === name);
        return ok({ created: name, groupId: created?.groupId, members: applianceIds ?? [] });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_delete_group",
    {
      title: "Delete a smart-home group",
      description: "Deletes a smart-home group by groupId (from alexa_list_groups). The member " +
        "devices are NOT deleted — only the group. Requires confirm:true.",
      inputSchema: { groupId: z.string(), confirm: z.literal(true) },
    },
    async ({ groupId }) => {
      try {
        const alexa = await getAlexa();
        await call((cb) => (alexa as any).deleteSmarthomeGroup(groupId, cb));
        return ok({ deletedGroup: groupId });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  // -- List item update/delete (read-before-write for version + text) -------
  // v1 getListItems returns plaintext {id, value, completed, version}; match by id.
  const findListItem = async (alexa: AlexaRemote, listId: string, itemId: string) => {
    const res: any = await callRetry((cb) => (alexa as any).getListItems(listId, {}, cb));
    const arr = (Array.isArray(res) ? res : Object.values(res ?? {})).filter((v: any) => v && typeof v === "object" && v.id);
    return arr.find((x: any) => x.id === itemId);
  };

  server.registerTool(
    "alexa_update_list_item",
    {
      title: "Update a list item",
      description:
        "Edits a list item's text and/or marks it complete. Reads the item first for its required " +
        "version (optimistic concurrency). Pass value (new text) and/or completed (true/false).",
      inputSchema: {
        listId: z.string(), itemId: z.string(),
        value: z.string().optional(), completed: z.boolean().optional(),
        confirm: z.literal(true),
      },
    },
    async ({ listId, itemId, value, completed }) => {
      try {
        const alexa = await getAlexa();
        const item = await findListItem(alexa, listId, itemId);
        if (!item) return fail(`No item ${itemId} in list ${listId}`);
        const opts: any = { version: item.version, value: value ?? item.value };
        if (completed !== undefined) opts.completed = completed;
        await call((cb) => (alexa as any).updateListItem(listId, itemId, opts, cb));
        return ok({ updated: itemId, value: opts.value, completed });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_delete_list_item",
    {
      title: "Delete a list item",
      description: "Removes an item from a list (reads its version first). Requires confirm:true.",
      inputSchema: { listId: z.string(), itemId: z.string(), confirm: z.literal(true) },
    },
    async ({ listId, itemId }) => {
      try {
        const alexa = await getAlexa();
        const item = await findListItem(alexa, listId, itemId);
        if (!item) return fail(`No item ${itemId} in list ${listId}`);
        await call((cb) => (alexa as any).deleteListItem(listId, itemId, { version: item.version }, cb));
        return ok({ deleted: itemId });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  // -- Smart-home device enable/disable ------------------------------------
  server.registerTool(
    "alexa_set_smarthome_enablement",
    {
      title: "Enable/disable a smart-home device",
      description:
        "Enables or disables a smart-home device by applianceId (from alexa_list_smarthome_devices). " +
        "Disabled devices stay in Alexa but are inactive. Requires confirm:true.",
      inputSchema: { applianceId: z.string(), enabled: z.boolean(), confirm: z.literal(true) },
    },
    async ({ applianceId, enabled }) => {
      try {
        const alexa = await getAlexa();
        // The lib interpolates the applianceId raw; SKILL ids contain #/= and
        // break the URL (empty non-2xx -> "no body"). Encode it (like delete).
        const path = `/api/phoenix/v2/appliance/${encodeURIComponent(applianceId)}/enablement`;
        const res: any = await new Promise((resolve, reject) => {
          (alexa as any).httpsGet(
            true, path,
            (err: any, b: any) => (err ? reject(err) : resolve(b ?? { success: true })),
            { method: "PUT", data: JSON.stringify({ applianceId, enabled }), headers: { "Content-Type": "application/json" } },
          );
        });
        return ok({ applianceId, enabled, success: res?.success !== false });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  // -- Group update (read-modify-write; PUT is full-replace) ----------------
  server.registerTool(
    "alexa_update_group",
    {
      title: "Update a smart-home group",
      description:
        "Renames a group and/or sets its members. NOTE: applianceIds is a full REPLACE list — " +
        "the tool reads the current group and preserves fields you don't pass (so a rename keeps " +
        "members). Requires confirm:true.",
      inputSchema: {
        groupId: z.string(),
        name: z.string().optional(),
        applianceIds: z.array(z.string()).optional(),
        confirm: z.literal(true),
      },
    },
    async ({ groupId, name, applianceIds }) => {
      try {
        const alexa = await getAlexa();
        const g: any = await call((cb) => alexa.getSmarthomeGroups(cb));
        const cur = (g?.applianceGroups ?? []).find((x: any) => (x.groupId ?? x.entityId) === groupId);
        if (!cur) return fail(`No group ${groupId}`);
        const body = {
          name: name ?? cur.name,
          applianceIds: applianceIds ?? cur.applianceIds ?? [],
          type: cur.type ?? "SPACE",
        };
        const result = await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            `/api/phoenix/group/${encodeURIComponent(groupId)}`,
            (err: any, b: any) => (err ? reject(err) : resolve(b ?? { success: true })),
            { method: "PUT", data: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
          );
        });
        if (result?.success !== true) return fail(`Update returned: ${JSON.stringify(result)}`);
        return ok({ updated: groupId, name: body.name, memberCount: body.applianceIds.length });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  // -- Reminders / alarms (notifications) ----------------------------------
  const parseWhen = (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; };

  server.registerTool(
    "alexa_create_reminder",
    {
      title: "Create a reminder",
      description:
        "Creates a reminder on a device. when = ISO datetime (e.g. 2026-07-20T07:30:00), local " +
        "time. device = Echo name or serial. Requires confirm:true.",
      inputSchema: { device: z.string(), label: z.string(), when: z.string(), confirm: z.literal(true) },
    },
    async ({ device, label, when }) => {
      try {
        const alexa = await getAlexa();
        const d = parseWhen(when);
        if (!d) return fail("Invalid 'when' — use an ISO datetime like 2026-07-20T07:30:00");
        const obj = (alexa as any).createNotificationObject(device, "Reminder", label, d, "ON");
        const created: any = await call((cb) => (alexa as any).createNotification(obj, cb));
        return ok({ createdReminder: created?.id, label, when });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_create_alarm",
    {
      title: "Create an alarm",
      description:
        "Creates an alarm on a device (it WILL ring). when = ISO datetime, must be < 1 year out " +
        "(Amazon rejects beyond that). device = Echo name or serial. Requires confirm:true.",
      inputSchema: { device: z.string(), when: z.string(), label: z.string().optional(), confirm: z.literal(true) },
    },
    async ({ device, when, label }) => {
      try {
        const alexa = await getAlexa();
        const d = parseWhen(when);
        if (!d) return fail("Invalid 'when' — use an ISO datetime like 2026-07-20T07:30:00");
        const obj = (alexa as any).createNotificationObject(device, "Alarm", label ?? "Alarm", d, "ON");
        const created: any = await call((cb) => (alexa as any).createNotification(obj, cb));
        return ok({ createdAlarm: created?.alarmToken ?? created?.id, when });
      } catch (e: any) { return fail(hint(e)); }
    },
  );

  server.registerTool(
    "alexa_delete_notification",
    {
      title: "Delete a reminder / alarm / timer",
      description: "Deletes a notification by id (from alexa_list_notifications). Requires confirm:true.",
      inputSchema: { id: z.string(), confirm: z.literal(true) },
    },
    async ({ id }) => {
      try {
        const alexa = await getAlexa();
        const res: any = await callRetry((cb) => (alexa as any).getNotifications(false, cb));
        const notif = (res?.notifications ?? []).find((n: any) => n.id === id);
        if (!notif) return fail(`No notification ${id}`);
        await call((cb) => (alexa as any).deleteNotification(notif, cb));
        return ok({ deleted: id });
      } catch (e: any) { return fail(hint(e)); }
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
