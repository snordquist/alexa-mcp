import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenAppliances, collectRoutineTargets, findDanglingTargets } from "../dist/util.js";

test("flattenAppliances walks the nested phoenix tree + dedupes by applianceId", () => {
  const phoenix = {
    locationDetails: {
      Default_Location: {
        amazonBridgeDetails: {
          amazonBridgeDetails: {
            bridgeA: { applianceDetails: { applianceDetails: {
              x: { applianceId: "A1", friendlyName: "Lamp", entityId: "e1" },
              y: { applianceId: "A2", friendlyName: "Plug", entityId: "e2" },
            } } },
            bridgeB: { applianceDetails: { applianceDetails: {
              z: { applianceId: "A1", friendlyName: "Lamp dup", entityId: "e1" }, // dup id
            } } },
          },
        },
      },
    },
  };
  const list = flattenAppliances(phoenix);
  assert.equal(list.length, 2); // A1 deduped
  assert.deepEqual(list.map((a) => a.applianceId).sort(), ["A1", "A2"]);
});

test("flattenAppliances tolerates junk / empty input", () => {
  assert.deepEqual(flattenAppliances(null), []);
  assert.deepEqual(flattenAppliances({}), []);
  assert.deepEqual(flattenAppliances({ a: 1, b: "x", c: [1, 2] }), []);
});

const routine = (name, ...targets) => ({
  name,
  automationId: "amzn1.alexa.automation." + name,
  sequence: {
    "@type": "com.amazon.alexa.behaviors.model.Sequence",
    startNode: {
      "@type": "com.amazon.alexa.behaviors.model.SerialNode",
      nodesToExecute: [
        {
          "@type": "com.amazon.alexa.behaviors.model.ParallelNode",
          nodesToExecute: targets.map((t) => ({
            "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
            type: "Alexa.SmartHome.Batch",
            operationPayload: { target: t, operations: [{ type: "sceneActivate" }] },
          })),
        },
      ],
    },
  },
});

test("collectRoutineTargets extracts nested action targets", () => {
  const t = collectRoutineTargets(routine("R", "dev-1", "dev-2"));
  assert.deepEqual(t.map((x) => x.target).sort(), ["dev-1", "dev-2"]);
  assert.equal(t[0].op, "sceneActivate");
});

test("collectRoutineTargets: no targets / malformed routine", () => {
  assert.deepEqual(collectRoutineTargets({}), []);
  assert.deepEqual(collectRoutineTargets({ sequence: { startNode: null } }), []);
});

test("broken-reference detection: target missing from the valid set", () => {
  // mirror the audit logic: a target not in the valid id universe is dangling
  const valid = new Set(["dev-1", "dev-2"]);
  const targets = collectRoutineTargets(routine("R", "dev-1", "dev-GONE"));
  const dangling = targets.filter((t) => !valid.has(t.target));
  assert.deepEqual(dangling.map((d) => d.target), ["dev-GONE"]);
});

// Announcement actions carry an object target ({customerId, devices?}), not an id string.
const announcement = (target) => ({
  "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
  type: "AlexaAnnouncement",
  operationPayload: { content: [], target },
});
const withNodes = (...nodes) => ({
  sequence: { startNode: { "@type": "com.amazon.alexa.behaviors.model.SerialNode", nodesToExecute: nodes } },
});

test("collectRoutineTargets: announcement to all devices yields no target", () => {
  const t = collectRoutineTargets(withNodes(announcement({ customerId: "C1" })));
  assert.deepEqual(t, []);
});

test("collectRoutineTargets: announcement to specific Echos yields one echo target per device", () => {
  const t = collectRoutineTargets(withNodes(announcement({
    customerId: "C1",
    devices: [
      { deviceSerialNumber: "SER1", deviceTypeId: "T1" },
      { deviceSerialNumber: "SER2", deviceTypeId: "T2" },
    ],
  })));
  assert.deepEqual(t, [
    { kind: "echo", target: "SER1", op: "AlexaAnnouncement" },
    { kind: "echo", target: "SER2", op: "AlexaAnnouncement" },
  ]);
});

test("collectRoutineTargets: string targets are smarthome targets", () => {
  const t = collectRoutineTargets(routine("R", "dev-1"));
  assert.equal(t[0].kind, "smarthome");
});

test("findDanglingTargets: announcements to existing Echos or to all devices are not dangling", () => {
  const r = withNodes(
    announcement({ customerId: "C1" }),
    announcement({ customerId: "C1", devices: [{ deviceSerialNumber: "SER1", deviceTypeId: "T1" }] }),
  );
  assert.deepEqual(findDanglingTargets(r, new Set(), new Set(["SER1"])), []);
});

test("findDanglingTargets: announcement to a removed Echo is dangling", () => {
  const r = withNodes(announcement({ customerId: "C1", devices: [{ deviceSerialNumber: "GONE", deviceTypeId: "T1" }] }));
  assert.deepEqual(findDanglingTargets(r, new Set(), new Set(["SER1"])), [
    { kind: "echo", target: "GONE", op: "AlexaAnnouncement" },
  ]);
});

test("findDanglingTargets: smarthome target missing from valid ids is dangling; placeholders are not", () => {
  const r = withNodes(
    ...routine("R", "dev-1", "dev-GONE", "ALEXA_CURRENT_DSN", "amzn1.ask.skill.x").sequence.startNode.nodesToExecute,
  );
  const d = findDanglingTargets(r, new Set(["dev-1"]), new Set());
  assert.deepEqual(d.map((x) => x.target), ["dev-GONE"]);
});

test("findDanglingTargets: empty Echo list is fine when no routine targets an Echo", () => {
  const r = withNodes(announcement({ customerId: "C1" }), ...routine("R", "dev-1").sequence.startNode.nodesToExecute);
  assert.deepEqual(findDanglingTargets(r, new Set(["dev-1"]), new Set()), []);
});

test("findDanglingTargets: empty Echo list throws when a routine targets an Echo", () => {
  const r = withNodes(announcement({ customerId: "C1", devices: [{ deviceSerialNumber: "SER1", deviceTypeId: "T1" }] }));
  assert.throws(() => findDanglingTargets(r, new Set(), new Set()), /getDevices returned no devices/);
});
