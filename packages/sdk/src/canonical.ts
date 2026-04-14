import { keccak256, toUtf8Bytes } from "ethers";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([lhs], [rhs]) =>
      lhs.localeCompare(rhs),
    );

    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalizeJson(entry)]));
  }

  throw new TypeError(`Unsupported JSON value: ${String(value)}`);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function normalizeHex(hex: string): `0x${string}` {
  const prefixed = hex.startsWith("0x") ? hex : `0x${hex}`;
  return prefixed.toLowerCase() as `0x${string}`;
}

export function keccak256Json(value: unknown): `0x${string}` {
  return keccak256(toUtf8Bytes(canonicalStringify(value))) as `0x${string}`;
}

export function keccak256Hex(hex: string): `0x${string}` {
  return keccak256(normalizeHex(hex)) as `0x${string}`;
}
