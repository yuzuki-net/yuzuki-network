import { describe, expect, test } from "bun:test";
import { encodeQrMatrix } from "../../src/components/kumo-ext/qr-code";

describe("encodeQrMatrix", () => {
  test("encodes a short URL into a valid square version-2+ matrix with finder patterns", () => {
    const matrix = encodeQrMatrix("https://example.net/documents/abc123?f=2");
    expect(matrix).not.toBeNull();
    const size = matrix!.length;
    expect((size - 17) % 4).toBe(0);
    expect(matrix!.every((row) => row.length === size)).toBe(true);
    // Top-left 7x7 finder border & center
    expect(matrix![0][0]).toBe(true);
    expect(matrix![0][6]).toBe(true);
    expect(matrix![6][0]).toBe(true);
    expect(matrix![3][3]).toBe(true);
    expect(matrix![1][1]).toBe(false);
    // Top-right & bottom-left finder corners
    expect(matrix![0][size - 1]).toBe(true);
    expect(matrix![size - 1][0]).toBe(true);
  });

  test("encodes long subscription URLs up to 200+ bytes", () => {
    const url = `https://sub.example.net/documents/${"a".repeat(128)}?f=1`;
    const matrix = encodeQrMatrix(url);
    expect(matrix).not.toBeNull();
    expect(matrix!.length).toBeGreaterThanOrEqual(41);
  });

  test("returns null when payload exceeds version-10 capacity", () => {
    expect(encodeQrMatrix("x".repeat(400))).toBeNull();
  });
});
