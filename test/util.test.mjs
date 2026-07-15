import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenAppliances, collectRoutineTargets } from "../dist/util.js";

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
