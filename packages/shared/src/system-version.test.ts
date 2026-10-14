import { expect, test } from "bun:test";
import { assertImagePairCompatible, assertSystemCompatible, parseSystemVersion, requiredSystemVersion, requiredSystemVersionLabel, systemVersion, systemVersionLabel } from "./system-version.ts";

test("legacy images are version zero; canonical bounded version labels are accepted", () => {
  expect(parseSystemVersion(undefined)).toBe(0);
  for (const value of ["0", "1", "2147483647"]) expect(parseSystemVersion(value)).toBe(Number(value));
  expect(() => assertImagePairCompatible(undefined, null)).not.toThrow();
  expect(requiredSystemVersion).toBeLessThanOrEqual(systemVersion);
});

for (const label of ["", " ", "-1", "+1", "01", "1.1", "1e3", "Infinity", "2147483648", "9999999999999999999999"]) {
  test(`invalid compatibility label ${JSON.stringify(label)} is rejected`, () => {
    expect(() => parseSystemVersion(label)).toThrow("Invalid System compatibility version");
  });
}

test("an incompatible pair is refused, including old unversioned System images", () => {
  expect(() => assertSystemCompatible(1, 2)).toThrow("needs installation compatibility version 2");
  expect(() => assertImagePairCompatible({ [requiredSystemVersionLabel]: "1" }, {})).toThrow("provides 0");
  expect(() => assertImagePairCompatible({ [requiredSystemVersionLabel]: "1" }, { [systemVersionLabel]: "2" })).not.toThrow();
  expect(() => assertImagePairCompatible({}, { [systemVersionLabel]: "1" })).not.toThrow();
});
