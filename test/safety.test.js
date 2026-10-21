import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectCrisis, visibleHotlines } from "../public/js/safety.js";

const config = JSON.parse(readFileSync(new URL("../public/config/safety.json", import.meta.url)));

test("detects self-harm language", () => {
  assert.equal(detectCrisis("我真的不想活了", config.keywords), true);
  assert.equal(detectCrisis("有时候想自残", config.keywords), true);
});

test("detects abuse language", () => {
  assert.equal(detectCrisis("我爸爸经常家暴", config.keywords), true);
});

test("ignores spaces and punctuation inserted between characters", () => {
  assert.equal(detectCrisis("我想 自 杀。", config.keywords), true);
  assert.equal(detectCrisis("不想-活-了", config.keywords), true);
});

test("ordinary questions are not flagged", () => {
  assert.equal(detectCrisis("父母总问我钱花在哪里，我该怎么沟通？", config.keywords), false);
  assert.equal(detectCrisis("为什么不建议早恋", config.keywords), false);
});

test("only verified hotlines with a number are shown", () => {
  const shown = visibleHotlines([
    { name: "报警", number: "110", verified: true },
    { name: "未核实", number: "123", verified: false },
    { name: "空号码", number: "", verified: true },
  ]);
  assert.deepEqual(shown.map((h) => h.number), ["110"]);
});

test("shipped config only shows hotlines a person has verified", () => {
  for (const h of visibleHotlines(config.hotlines)) {
    assert.equal(h.verified, true);
    assert.ok(h.number);
  }
});
