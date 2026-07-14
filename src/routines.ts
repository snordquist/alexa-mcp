import type AlexaRemote from "alexa-remote2";

/**
 * Helpers for the Alexa routine WRITE API (create / update), reverse-engineered
 * from the Alexa Android app and verified end-to-end (2026-07-14).
 *
 * Two non-obvious rules the server enforces:
 *  1. A trigger's `payload` is a JSON STRING (double-encoded), not an object.
 *  2. A node's `operationPayload` must be the VALIDATE-NORMALIZED object — you
 *     must POST the action to /api/behaviors/operation/validate first and embed
 *     the returned payload.
 *
 * Endpoints (all non-`v2`):
 *   create  POST   /api/behaviors/automations
 *   update  PUT    /api/behaviors/automations/{behaviorId}
 *   delete  DELETE /api/behaviors/automations/{behaviorId}
 */

const T_JAVA = "com.amazon.alexa.behaviors.model.Trigger";
const UTTER_PAYLOAD = "com.amazon.alexa.behaviors.model.CustomUtteranceTriggerPayload";
const SEQUENCE = "com.amazon.alexa.behaviors.model.Sequence";
const SERIAL_NODE = "com.amazon.alexa.behaviors.model.SerialNode";
const OP_NODE = "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode";

/** skillId per action type (auto-derived like the app does from its catalog). */
const ACTION_SKILL: Record<string, string> = {
  "Alexa.TextCommand": "amzn1.ask.1p.tellalexa",
  "Alexa.SmartHome.Batch": "amzn1.ask.1p.smarthome",
  "AlexaAnnouncement": "amzn1.ask.1p.messaging",
  "Alexa.Notifications.SendMobilePush": "amzn1.ask.1p.alexanotifications",
  "Alexa.Music.PlaySearchPhrase": "amzn1.ask.1p.music",
  "Alexa.Sound": "amzn1.ask.1p.sound",
  "Alexa.System.Wait": "amzn1.ask.1p.alexa-system",
};

export interface AccountContext {
  customerId: string;
  marketplaceId: string;
  locale: string;
  echoDeviceType?: string;
  echoSerial?: string;
}

function raw<T = any>(
  alexa: AlexaRemote,
  method: string,
  path: string,
  data?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    (alexa as any).httpsGet(
      true,
      path,
      (err: any, body: any) => (err ? reject(err) : resolve(body)),
      { method, data, headers: { "Content-Type": "application/json", "Routines-Version": "3.0.264101" } },
    );
  });
}

function call<T = any>(fn: (cb: (e: any, b: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((e, b) => (e ? reject(e) : resolve(b))));
}

/** Resolves customerId / marketplace / a usable Echo from the account. */
export async function accountContext(
  alexa: AlexaRemote,
  locale = "de-DE",
  marketplaceId = process.env.ALEXA_MCP_MARKETPLACE_ID ?? "A1PA6795UKMFR9",
): Promise<AccountContext> {
  const res: any = await call((cb) => alexa.getDevices(cb));
  const devices = res?.devices ?? [];
  const echo = devices.find((d: any) => d.deviceFamily === "ECHO") ?? devices[0];
  return {
    customerId: echo?.deviceOwnerCustomerId,
    marketplaceId,
    locale,
    echoDeviceType: echo?.deviceType,
    echoSerial: echo?.serialNumber,
  };
}

/** Validate an action and return the server-normalized operationPayload (object). */
export async function validateOperation(
  alexa: AlexaRemote,
  type: string,
  operationPayload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body: any = await raw(alexa, "POST", "/api/behaviors/operation/validate",
    JSON.stringify({ type, operationPayload: JSON.stringify(operationPayload) }));
  if (body?.result && body.result !== "VALID") {
    throw new Error(`validate ${type}: ${body.result} ${body.message ?? ""}`.trim());
  }
  let op = body?.operationPayload;
  if (typeof op === "string") { try { op = JSON.parse(op); } catch { /* keep string */ } }
  // Some action types (e.g. SmartHome.Batch) return VALID with no normalized
  // payload — fall back to the caller's payload in that case.
  return (op ?? operationPayload) as Record<string, unknown>;
}

export interface UtteranceTrigger { kind: "utterance"; utterance: string; }
export interface ScheduleTrigger {
  kind: "schedule";
  time: string;          // "HH:MM"
  days?: string[];       // ["MO","TU",…]; omitted = daily
  timeZoneId?: string;   // e.g. "Europe/Berlin"
}
export type TriggerSpec = UtteranceTrigger | ScheduleTrigger;

/** Builds a trigger object with its double-encoded `payload` string. */
export function buildTrigger(spec: TriggerSpec, ctx: AccountContext): any {
  if (spec.kind === "utterance") {
    const payload = {
      "@type": UTTER_PAYLOAD,
      locale: ctx.locale,
      marketplaceId: ctx.marketplaceId,
      utterance: spec.utterance,
      utterances: [spec.utterance],
      customerId: ctx.customerId,
      person: null,
    };
    return { "@type": T_JAVA, id: null, skillId: null, type: "CustomUtterance", payload: JSON.stringify(payload) };
  }
  // schedule
  const [h, m] = spec.time.split(":");
  const triggerTime = `${h.padStart(2, "0")}${(m ?? "00").padStart(2, "0")}00`;
  const recurrence = spec.days?.length
    ? `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=${spec.days.join(",")}`
    : "RRULE:FREQ=DAILY;INTERVAL=1";
  const payload = {
    schedule: { "@type": "RRULE", triggerTime, triggerTimes: [], timeZoneId: spec.timeZoneId ?? "Europe/Berlin", recurrence },
    customer: { "@id": ctx.customerId, "@type": "ac:Person" },
  };
  return { "@type": T_JAVA, id: null, skillId: "amzn1.ask.1p.routines.schedule", type: "AbsoluteTimeSchedule", payload: JSON.stringify(payload) };
}

/** Builds an action node with a (validate-normalized) operationPayload object. */
export function actionNode(type: string, operationPayload: Record<string, unknown>, skillId?: string): any {
  return { "@type": OP_NODE, type, skillId: skillId ?? ACTION_SKILL[type] ?? null, operationPayload, context: null };
}

export function buildSequence(nodes: any[]): any {
  const startNode = nodes.length === 1 ? nodes[0] : { "@type": SERIAL_NODE, nodesToExecute: nodes };
  return { "@type": SEQUENCE, startNode };
}

/** Assembles the flat write body with stringified sub-fields. */
export function buildBody(opts: {
  name: string;
  status: "ENABLED" | "DISABLED";
  trigger: any;
  sequence: any;
  behaviorId?: string;
}): Record<string, unknown> {
  const triggerJson = JSON.stringify(opts.trigger);
  const body: Record<string, unknown> = {
    name: opts.name,
    status: opts.status,
    triggerJson,
    triggerJsonList: [triggerJson],
    sequenceJson: JSON.stringify(opts.sequence),
  };
  if (opts.behaviorId) body.behaviorId = opts.behaviorId;
  return body;
}

export interface ActionSpec {
  type: string;                              // e.g. "Alexa.TextCommand"
  operationPayload: Record<string, unknown>; // raw; will be validate-normalized
}

/**
 * Full create/update flow: fill account defaults into TextCommand-style
 * payloads, validate each action, assemble + send the body.
 * Returns the parsed API response.
 */
export async function writeRoutine(
  alexa: AlexaRemote,
  opts: {
    name: string;
    trigger: TriggerSpec;
    actions: ActionSpec[];
    status?: "ENABLED" | "DISABLED";
    behaviorId?: string; // present => update (PUT), absent => create (POST)
    ctx?: AccountContext;
  },
): Promise<any> {
  const ctx = opts.ctx ?? (await accountContext(alexa));
  if (!ctx.customerId) throw new Error("Could not resolve customerId from the account.");

  const nodes: any[] = [];
  for (const a of opts.actions) {
    const op: Record<string, unknown> = { ...a.operationPayload };
    // Convenience defaults for common fields.
    if (op.customerId == null) op.customerId = ctx.customerId;
    if (op.locale == null) op.locale = ctx.locale;
    if (a.type === "Alexa.TextCommand") {
      if (op.deviceSerialNumber == null && ctx.echoSerial) op.deviceSerialNumber = ctx.echoSerial;
      if (op.deviceType == null && ctx.echoDeviceType) op.deviceType = ctx.echoDeviceType;
    }
    const normalized = await validateOperation(alexa, a.type, op);
    nodes.push(actionNode(a.type, normalized));
  }

  const trigger = buildTrigger(opts.trigger, ctx);
  const sequence = buildSequence(nodes);
  const body = buildBody({ name: opts.name, status: opts.status ?? "ENABLED", trigger, sequence, behaviorId: opts.behaviorId });

  const path = opts.behaviorId
    ? `/api/behaviors/automations/${encodeURIComponent(opts.behaviorId)}`
    : "/api/behaviors/automations";
  const method = opts.behaviorId ? "PUT" : "POST";
  return raw(alexa, method, path, JSON.stringify(body));
}
