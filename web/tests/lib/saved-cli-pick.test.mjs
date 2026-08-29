import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_CHANGED_EVENT,
  persistCliId,
  pickSoleInstalled,
} from "../../src/lib/saved-cli.mjs";

test("sole installed CLI is the default", () => {
  assert.equal(
    pickSoleInstalled([
      { id: "claude", installed: false },
      { id: "grok", installed: true },
    ]),
    "grok",
  );
});

test("zero or two installed CLIs stay unset", () => {
  assert.equal(pickSoleInstalled([]), null);
  assert.equal(
    pickSoleInstalled([
      { id: "claude", installed: true },
      { id: "grok", installed: true },
    ]),
    null,
  );
});

test("selecting a CLI persists it and notifies same-tab consumers", () => {
  const values = new Map([["career-ops:config", JSON.stringify({ logos: false })]]);
  const events = [];
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    dispatchEvent: (event) => events.push(event.type),
  } });

  try {
    assert.equal(persistCliId("codex"), true);
    assert.deepEqual(JSON.parse(values.get("career-ops:config")), {
      logos: false,
      mode: "cli",
      cliId: "codex",
    });
    assert.deepEqual(events, [CONFIG_CHANGED_EVENT]);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});
