import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../dist/alexa.js";

test("proxy login page language comes from ALEXA_MCP_PROXY_LANGUAGE, default en_US", () => {
  const saved = process.env.ALEXA_MCP_PROXY_LANGUAGE;
  try {
    delete process.env.ALEXA_MCP_PROXY_LANGUAGE;
    assert.equal(defaultConfig().proxyLanguage, "en_US");
    process.env.ALEXA_MCP_PROXY_LANGUAGE = "de_DE";
    assert.equal(defaultConfig().proxyLanguage, "de_DE");
  } finally {
    if (saved === undefined) delete process.env.ALEXA_MCP_PROXY_LANGUAGE;
    else process.env.ALEXA_MCP_PROXY_LANGUAGE = saved;
  }
});
