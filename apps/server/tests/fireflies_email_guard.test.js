import test from "node:test";
import assert from "node:assert/strict";
import { filterFirefliesRecipients } from "../src/rag/firefliesIngest.js";

const originalBlocklist = process.env.FIREFLIES_EMAIL_BLOCKLIST;

test.after(() => {
  if (originalBlocklist === undefined) {
    delete process.env.FIREFLIES_EMAIL_BLOCKLIST;
  } else {
    process.env.FIREFLIES_EMAIL_BLOCKLIST = originalBlocklist;
  }
});

test("fireflies email blocklist blocks default address", () => {
  delete process.env.FIREFLIES_EMAIL_BLOCKLIST;
  const { allowed, blocked } = filterFirefliesRecipients([
    "jeff.barnes@inova.org",
    "other@example.com"
  ]);
  assert.deepEqual(allowed, ["other@example.com"]);
  assert.deepEqual(blocked, ["jeff.barnes@inova.org"]);
});

test("fireflies email blocklist respects env list", () => {
  process.env.FIREFLIES_EMAIL_BLOCKLIST = "blocked@example.com";
  const { allowed, blocked } = filterFirefliesRecipients([
    "blocked@example.com",
    "ok@example.com"
  ]);
  assert.deepEqual(allowed, ["ok@example.com"]);
  assert.deepEqual(blocked, ["blocked@example.com"]);
});
