import { test } from "node:test";
import assert from "node:assert/strict";
// a deliberately failing check for the Clawd CI-wake live test; this PR is closed unmerged
test("ci wake test", () => assert.equal(1 + 1, 3));
