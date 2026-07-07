import assert from "node:assert/strict";
import test from "node:test";
import { detectPii, hasCompletionPii, piiScore, redact } from "../src/pii";

test("detects valid SSNs and rejects invalid area/group/serial values", () => {
  assert.deepEqual(detectPii("Customer SSN is 123-45-6789.", "completion"), [
    { type: "ssn", confidence: 1, field: "completion" },
  ]);
  assert.equal(detectPii("Numbers 000-12-3456, 666-12-3456, 912-12-3456", "completion").length, 0);
  assert.equal(detectPii("Numbers 123-00-6789 and 123-45-0000", "completion").length, 0);
  assert.equal(detectPii("Order 123-45-67890 is not an SSN", "completion").length, 0);
});

test("detects credit cards with Luhn validation", () => {
  const valid = detectPii("Card 4242 4242 4242 4242 expires soon", "completion");
  assert.equal(valid[0].type, "credit_card");
  assert.equal(valid[0].confidence, 1);
  assert.equal(detectPii("Card 4242 4242 4242 4241 is invalid", "completion").length, 0);
});

test("detects email and international phone findings", () => {
  const findings = detectPii("Write to avery@example.test or call +44 20 7946 0958.", "completion");
  assert.deepEqual(findings.map((finding) => finding.type).sort(), ["email", "phone"]);
  assert.equal(piiScore(findings), 0.5);
  assert.equal(hasCompletionPii(findings), true);
});

test("clean text yields no findings and completion-only flags", () => {
  assert.deepEqual(detectPii("The reset link is on the sign-in page.", "completion"), []);
  assert.equal(piiScore([]), 0);
  const promptOnly = detectPii("My SSN is 123-45-6789", "prompt");
  assert.equal(promptOnly.length, 1);
  assert.equal(hasCompletionPii(promptOnly), false);
});

test("redaction removes raw values without corrupting other text", () => {
  const text = "SSN 123-45-6789, card 4242 4242 4242 4242, email avery@example.test, phone +44 20 7946 0958.";
  const redacted = redact(text);
  assert.equal(redacted.includes("123-45-6789"), false);
  assert.equal(redacted.includes("4242 4242 4242 4242"), false);
  assert.equal(redacted.includes("avery@example.test"), false);
  assert.equal(redacted.includes("+44 20 7946 0958"), false);
  assert.ok(redacted.includes("[redacted:ssn]"));
  assert.ok(redacted.includes("[redacted:card]"));
  assert.ok(redacted.includes("[redacted:email]"));
  assert.ok(redacted.includes("[redacted:phone]"));
});
