import assert from "node:assert/strict";
import test from "node:test";

import { callName, greeting } from "../src/modules/home/intent.ts";

test("greeting and callName", () => {
  assert.equal(greeting(9), "Good morning");
  assert.equal(greeting(14), "Good afternoon");
  assert.equal(greeting(20), "Good evening");
  assert.equal(callName("Nguyen Van Duy"), "Duy");
  assert.equal(callName("Ada Lovelace"), "Ada");
  assert.equal(callName(undefined), "");
});
