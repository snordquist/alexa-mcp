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
        entityId: /^SKILL/.test(a.applianceId)
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

// -- Write tools (gated) ----------------------------------------------------
if (ALLOW_WRITE) {
  server.registerTool(
    "alexa_delete_smarthome_device",
    {
      title: "Delete a smart-home device",
      description:
        "Deletes a smart-home device (DELETE /api/phoenix/appliance/{id}). Used to clean up " +
        "orphaned devices. NOTE: the applianceId must be URL-encoded (it contains #/=), " +
        "otherwise the DELETE is a silent no-op — done automatically here. Requires confirm:true.",
      inputSchema: {
        applianceId: z.string(),
        confirm: z.literal(true),
      },
    },
    async ({ applianceId }) => {
      try {
        const alexa = await getAlexa();
        const path = `/api/phoenix/appliance/${encodeURIComponent(applianceId)}`;
        const result = await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            path,
            (err: any, body: any) => (err ? reject(err) : resolve(body ?? { success: true })),
            { method: "DELETE" },
          );
        });
        const success = result?.success === true;
        return success
          ? ok({ deleted: applianceId, result })
          : fail(`DELETE returned no success flag: ${JSON.stringify(result)}`);
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
      title: "Delete a routine (UNVERIFIED endpoint)",
      description:
        "WARNING: the DELETE endpoint is undocumented by Amazon and unconfirmed in any library. " +
        "This tool ATTEMPTS DELETE /api/behaviors/v2/automations/{id}. Verify the real request " +
        "via browser DevTools before relying on it. Requires confirm:true.",
      inputSchema: {
        automationId: z.string(),
        confirm: z.literal(true),
      },
    },
    async ({ automationId }) => {
      try {
        const alexa = await getAlexa();
        const path = `/api/behaviors/v2/automations/${encodeURIComponent(automationId)}`;
        const result = await new Promise<any>((resolve, reject) => {
          (alexa as any).httpsGet(
            true,
            path,
            (err: any, body: any) => (err ? reject(err) : resolve(body ?? { ok: true })),
            { method: "DELETE" },
          );
        });
        return ok({ deleted: automationId, endpoint: path, note: "endpoint unverified", result });
      } catch (e: any) {
        return fail(
          `DELETE failed (endpoint may be wrong — verify via DevTools): ${hint(e)}`,
        );
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
