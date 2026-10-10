import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrigger,
  buildSequence,
  buildBody,
  actionNode,
  accountContext,
  writeRoutine,
} from "../dist/routines.js";

const ctx = { customerId: "CUST1", marketplaceId: "MKT1", locale: "de-DE" };

test("utterance trigger double-encodes its payload", () => {
  const t = buildTrigger({ kind: "utterance", utterance: "gute nacht" }, ctx);
  assert.equal(t["@type"], "com.amazon.alexa.behaviors.model.Trigger");
  assert.equal(t.type, "CustomUtterance");
  assert.equal(t.id, null);
  // payload MUST be a JSON string, not an object (the bug that caused "Input failed to validate")
  assert.equal(typeof t.payload, "string");
  const p = JSON.parse(t.payload);
  assert.equal(p["@type"], "com.amazon.alexa.behaviors.model.CustomUtteranceTriggerPayload");
  assert.equal(p.utterance, "gute nacht");
  assert.deepEqual(p.utterances, ["gute nacht"]);
  assert.equal(p.customerId, "CUST1");
  assert.equal(p.locale, "de-DE");
});

test("schedule trigger builds RRULE + HHMMSS trigger time", () => {
  const t = buildTrigger({ kind: "schedule", time: "9:05", days: ["SA", "SU"], timeZoneId: "Europe/Berlin" }, ctx);
  assert.equal(t.type, "AbsoluteTimeSchedule");
  assert.equal(t.skillId, "amzn1.ask.1p.routines.schedule");
  const p = JSON.parse(t.payload);
  assert.equal(p.schedule.triggerTime, "090500");
  assert.equal(p.schedule.recurrence, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU");
  assert.equal(p.schedule.timeZoneId, "Europe/Berlin");
  assert.equal(p.customer["@id"], "CUST1");
});

test("schedule trigger without days is daily", () => {
  const t = buildTrigger({ kind: "schedule", time: "07:10" }, ctx);
  const p = JSON.parse(t.payload);
  assert.equal(p.schedule.triggerTime, "071000");
  assert.equal(p.schedule.recurrence, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,MO,TU,WE,TH,FR,SA");
});

test("actionNode auto-derives skillId + keeps operationPayload as an object", () => {
  const n = actionNode("Alexa.TextCommand", { text: "hi" });
  assert.equal(n["@type"], "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode");
  assert.equal(n.skillId, "amzn1.ask.1p.tellalexa");
  assert.equal(typeof n.operationPayload, "object"); // NOT stringified (single-encoded)
  assert.equal(n.context, null);
});

test("buildSequence: single action = startNode directly, multi = SerialNode", () => {
  const a = actionNode("Alexa.TextCommand", { text: "a" });
  const b = actionNode("Alexa.TextCommand", { text: "b" });
  const single = buildSequence([a]);
  assert.equal(single.startNode["@type"], "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode");
  const multi = buildSequence([a, b]);
  assert.equal(multi.startNode["@type"], "com.amazon.alexa.behaviors.model.SerialNode");
  assert.equal(multi.startNode.nodesToExecute.length, 2);
});

test("buildBody stringifies sub-fields + omits behaviorId on create", () => {
  const trigger = buildTrigger({ kind: "utterance", utterance: "x" }, ctx);
  const seq = buildSequence([actionNode("Alexa.TextCommand", { text: "x" })]);
  const create = buildBody({ name: "R", status: "ENABLED", trigger, sequence: seq });
  assert.equal(typeof create.triggerJson, "string");
  assert.ok(Array.isArray(create.triggerJsonList) && typeof create.triggerJsonList[0] === "string");
  assert.equal(typeof create.sequenceJson, "string");
  assert.equal(create.status, "ENABLED");
  assert.equal("behaviorId" in create, false);
  // update includes behaviorId
  const upd = buildBody({ name: "R", status: "DISABLED", trigger, sequence: seq, behaviorId: "id1" });
  assert.equal(upd.behaviorId, "id1");
});

// Stand-in for alexa-remote2: one Echo, validate echoes the payload back as VALID,
// the routine write answers `writeResponse`; every request is recorded in `calls`.
const fakeAlexa = (writeResponse) => {
  const calls = [];
  return {
    calls,
    getDevices(cb) {
      cb(null, { devices: [{ deviceFamily: "ECHO", deviceOwnerCustomerId: "CUST1", deviceType: "DT1", serialNumber: "SN1" }] });
    },
    httpsGet(_noCheck, path, cb, flags) {
      calls.push({ path, flags });
      if (path === "/api/behaviors/operation/validate") {
        const { operationPayload } = JSON.parse(flags.data);
        return cb(null, { result: "VALID", operationPayload });
      }
      cb(null, writeResponse);
    },
  };
};

const routineSpec = {
  name: "R",
  trigger: { kind: "utterance", utterance: "what time is it" },
  actions: [{ type: "Alexa.TextCommand", operationPayload: { text: "what time is it" } }],
};

test("writeRoutine throws when Alexa rejects the write with a message", async () => {
  for (const message of ["Input failed to validate.", "Object not found."]) {
    await assert.rejects(writeRoutine(fakeAlexa({ message }), routineSpec), {
      message: `Alexa rejected the routine write: ${message}`,
    });
  }
  const ok = await writeRoutine(fakeAlexa({ automationId: "amzn1.alexa.automation.x" }), routineSpec);
  assert.equal(ok.automationId, "amzn1.alexa.automation.x");
});

test("routine writes declare a UTF-8 JSON body", async () => {
  const alexa = fakeAlexa({ automationId: "amzn1.alexa.automation.x" });
  await writeRoutine(alexa, routineSpec);
  assert.ok(alexa.calls.length >= 2);
  for (const { flags } of alexa.calls) {
    assert.equal(flags.headers["Content-Type"], "application/json; charset=utf-8");
  }
});

test("locale and schedule timezone default to the env configuration", async () => {
  const keys = ["ALEXA_MCP_ACCEPT_LANGUAGE", "ALEXA_MCP_TIMEZONE"];
  const saved = keys.map((k) => process.env[k]);
  process.env.ALEXA_MCP_ACCEPT_LANGUAGE = "en-US";
  process.env.ALEXA_MCP_TIMEZONE = "America/New_York";
  try {
    const c = await accountContext(fakeAlexa({}));
    assert.equal(c.locale, "en-US");
    const p = JSON.parse(buildTrigger({ kind: "schedule", time: "07:00" }, c).payload);
    assert.equal(p.schedule.timeZoneId, "America/New_York");
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});
