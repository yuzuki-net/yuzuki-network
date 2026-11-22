import { type Catalog, supportedLocale } from "./catalog";
import { messages } from "./index";

export function installCatalogs(eager: Record<string, Catalog>, lazy: Record<string, () => Promise<Catalog>> = {}) {
  for (const [path, catalog] of Object.entries(eager)) {
    const [, , language, file] = path.split("/");
    const locale = supportedLocale(language);
    if (locale) messages.register(file.slice(0, -5), locale, catalog);
  }
  for (const [path, loader] of Object.entries(lazy)) {
    const [, , language, file] = path.split("/");
    const locale = supportedLocale(language);
    if (locale && locale !== "en") messages.addLoader(file.slice(0, -5), locale, loader);
  }
}
