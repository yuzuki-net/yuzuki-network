import { expect, test } from "bun:test";
import { decimalInput, existingAmount, quotaAmount } from "../../../src/features/quotas/amount";

test("localized transfer inputs preserve the numeric amount", () => {
  expect(quotaAmount(decimalInput("1,5", "ru"), "GiB")).toBe(1_610_612_736n);
  expect(quotaAmount(decimalInput("۱٫۵", "fa"), "GiB")).toBe(1_610_612_736n);
  expect(() => quotaAmount(decimalInput("1 024", "ru"), "GiB")).toThrow("non-negative");
});

test("quota amounts round binary units to bytes and recover the user-entered amount", () => {
  expect(quotaAmount("1.1", "GiB")).toBe(1_181_116_006n);
  expect(existingAmount("1181116006")).toEqual({ value: "1.1", unit: "GiB" });
  expect(existingAmount("1181116007")).toEqual({ value: "1181116007", unit: "bytes" });
});

test("quota values preserve signed 64-bit precision and allow a pause at zero", () => {
  expect(quotaAmount("9223372036854775807", "bytes")).toBe(9_223_372_036_854_775_807n);
  expect(existingAmount("9223372036854775807")).toEqual({ value: "9223372036854775807", unit: "bytes" });
  expect(() => quotaAmount("9223372036854775808", "bytes")).toThrow("supported limit");
  expect(() => quotaAmount("1.5", "bytes")).toThrow("whole number");
  expect(quotaAmount("0", "GiB")).toBe(0n);
  expect(existingAmount(null)).toEqual({ value: "", unit: "GiB" });
});
