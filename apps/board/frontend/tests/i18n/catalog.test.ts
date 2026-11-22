import { Glob } from "bun";
import { expect, test } from "bun:test";
import { Translations, supportedLocale } from "../../src/i18n/catalog";

test("looks up namespaced entries, translates interpolations and falls back to English", async () => {
  const service = new Translations();
  service.register("common", "en", { heading: "Overview", total: "{n} results" });
  service.register("plugin.example", "en", { heading: "Reports" });
  service.addLoader("common", "zh-CN", async () => ({ heading: "概览", total: "{n} 条结果" }));
  await service.choose("zh-CN");
  expect(service.get("common", "total", undefined, { n: 2 })).toBe("2 条结果");
  expect(service.get("common", "total", undefined, { n: 2 }, "en")).toBe("2 results");
  expect(service.snapshot().locale).toBe("zh-CN");
  expect(service.get("plugin.example", "heading")).toBe("Reports");
  expect(service.get("unknown", "missing", "Fallback")).toBe("Fallback");
  expect(service.get("common", "toString", "Fallback")).toBe("Fallback");
});

test("keeps latest language when catalog fetches complete out of order", async () => {
  const service = new Translations();
  let resolve: (catalog: Record<string, string>) => void = () => {};
  service.addLoader("common", "ja", () => new Promise((accept) => { resolve = accept; }));
  const old = service.choose("ja");
  await service.choose("fa");
  resolve({ heading: "概要" });
  await old;
  expect(service.snapshot().locale).toBe("fa");
  expect(service.snapshot().direction).toBe("rtl");
  expect(supportedLocale("zh-Hans-CN")).toBe("zh-CN");
  expect(supportedLocale("fa-IR")).toBe("fa");
});

test("handles a shared lazy loader independently in each namespace", async () => {
  const service = new Translations();
  const loader = async () => ({ title: "報告" });
  service.addLoader("plugin.first", "ja", loader);
  service.addLoader("plugin.second", "ja", loader);
  await service.choose("ja");
  expect(service.get("plugin.first", "title")).toBe("報告");
  expect(service.get("plugin.second", "title")).toBe("報告");
});

test("bundled languages supply the English keys and interpolation values", async () => {
  const locales = new URL("../../src/i18n/locales/", import.meta.url).pathname;
  const tokens = (value: string) => [...value.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  for await (const filename of new Glob("*.json").scan({ cwd: locales + "en" })) {
    const baseline: Record<string, string> = await Bun.file(locales + "en/" + filename).json();
    for (const locale of ["zh-CN", "ja", "ru", "fa"]) {
      const localized: Record<string, string> = await Bun.file(locales + locale + "/" + filename).json();
      expect(Object.keys(localized).sort(), `${locale}/${filename}`).toEqual(Object.keys(baseline).sort());
      for (const [key, value] of Object.entries(baseline)) {
        expect(tokens(localized[key]), `${locale}/${filename}/${key}`).toEqual(tokens(value));
      }
    }
  }
});
