import type { PiiFinding, PiiType } from "./types";

const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CARD_CANDIDATE = /(?:\d[ -]?){13,19}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)\+\d{1,3}(?:[ \t-]?\d{2,4}){2,5}(?!\d)/g;

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function matches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

export function detectPii(text: string | null, field: PiiFinding["field"]): PiiFinding[] {
  if (!text) return [];
  const findings = new Map<PiiType, PiiFinding>();
  const add = (type: PiiType, confidence: number) => {
    const current = findings.get(type);
    if (!current || current.confidence < confidence) {
      findings.set(type, { type, confidence, field });
    }
  };
  if (matches(text, SSN).length > 0) add("ssn", 1);
  for (const candidate of matches(text, CARD_CANDIDATE)) {
    if (luhn(candidate.replace(/[^0-9]/g, ""))) {
      add("credit_card", 1);
      break;
    }
  }
  if (matches(text, EMAIL).length > 0) add("email", 0.5);
  if (matches(text, PHONE).length > 0) add("phone", 0.4);
  return [...findings.values()];
}

export function piiScore(findings: PiiFinding[]): number {
  return findings.reduce((score, finding) => Math.max(score, finding.confidence), 0);
}

export function hasCompletionPii(findings: PiiFinding[]): boolean {
  return findings.some((finding) => finding.field === "completion");
}

export function summarizePii(findings: PiiFinding[]): string {
  return [...new Set(findings.map((finding) => finding.type))].join(", ") || "none";
}

export function redact(text: string): string {
  return text
    .replace(SSN, "[redacted:ssn]")
    .replace(CARD_CANDIDATE, (candidate) =>
      luhn(candidate.replace(/[^0-9]/g, "")) ? "[redacted:card]" : candidate,
    )
    .replace(EMAIL, "[redacted:email]")
    .replace(PHONE, "[redacted:phone]");
}
