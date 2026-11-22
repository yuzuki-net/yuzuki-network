export const localeNames = {
  en: "English",
  "zh-CN": "简体中文",
  ja: "日本語",
  ru: "Русский",
  fa: "فارسی",
} as const;

export type Locale = keyof typeof localeNames;
export type Parameters = Readonly<Record<string, string | number | bigint>>;
export type Catalog = Readonly<Record<string, string>>;
export type Translator = (key: string, fallback?: string, parameters?: Parameters) => string;
type Loader = () => Promise<Catalog>;
type CatalogLoad = { loader: Loader; promise: Promise<void> };
type Snapshot = { locale: Locale; direction: "ltr" | "rtl"; revision: number; loading: boolean };

const fallbackLocale = "en";
const pattern = /^[a-z][a-z0-9._-]*$/;

export function supportedLocale(language: string): Locale | undefined {
  const prefix = language.trim().split(/[-_]/)[0].toLowerCase();
  if (prefix === "zh") return "zh-CN";
  if (prefix === "en" || prefix === "ja" || prefix === "ru" || prefix === "fa") return prefix;
  return undefined;
}

export class Translations {
  private state: Snapshot = { locale: fallbackLocale, direction: "ltr", revision: 0, loading: false };
  private requested: Locale = fallbackLocale;
  private readonly listeners = new Set<() => void>();
  private readonly catalogs = new Map<Locale, Map<string, Catalog>>();
  private readonly loaders = new Map<Locale, Map<string, Loader>>();
  private readonly pending = new Map<string, CatalogLoad>();
  private loadId = 0;

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  register(namespace: string, locale: Locale, values: Catalog) {
    if (!pattern.test(namespace)) throw Error(`Invalid translation namespace: ${namespace}`);
    const namespaces = this.catalogs.get(locale) ?? new Map();
    namespaces.set(namespace, { ...namespaces.get(namespace), ...values });
    this.catalogs.set(locale, namespaces);
    if (locale === this.state.locale || locale === fallbackLocale) this.update({});
  }

  addLoader(namespace: string, locale: Locale, loader: Loader) {
    if (!pattern.test(namespace)) throw Error(`Invalid translation namespace: ${namespace}`);
    const namespaces = this.loaders.get(locale) ?? new Map();
    namespaces.set(namespace, loader);
    this.loaders.set(locale, namespaces);
    if (locale === this.requested || locale === fallbackLocale) void this.load(namespace, locale, loader);
  }

  private load(namespace: string, locale: Locale, loader: Loader) {
    const key = `${locale}/${namespace}`;
    const existing = this.pending.get(key);
    if (existing?.loader === loader) return existing.promise;
    const promise = Promise.resolve().then(loader).then((catalog) => {
      if (this.loaders.get(locale)?.get(namespace) === loader) this.register(namespace, locale, catalog);
    }).catch((error: unknown) => {
      if (this.pending.get(key)?.loader === loader) this.pending.delete(key);
      console.error(`Could not load translations for ${locale}/${namespace}`, error);
    });
    this.pending.set(key, { loader, promise });
    return promise;
  }

  async choose(locale: Locale) {
    const request = ++this.loadId;
    this.requested = locale;
    this.update({ loading: true });
    const available = this.loaders.get(locale);
    if (available) await Promise.all([...available].map(([namespace, loader]) => this.load(namespace, locale, loader)));
    if (request !== this.loadId) return;
    this.update({ locale, direction: locale === "fa" ? "rtl" : "ltr", loading: false });
  }

  get(namespace: string, key: string, fallback = key, parameters?: Parameters, locale = this.state.locale): string {
    const lookup = (language: Locale) => {
      const catalog = this.catalogs.get(language)?.get(namespace);
      return catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
    };
    const message = lookup(locale) ?? lookup(fallbackLocale) ?? fallback;
    if (!parameters) return message;
    return message.replace(/\{([\w.-]+)\}/g, (placeholder: string, name: string) => {
      if (!Object.hasOwn(parameters, name)) return placeholder;
      const value = parameters[name];
      return typeof value === "string" ? value : new Intl.NumberFormat(locale).format(value);
    });
  }

  private update(changes: Partial<Snapshot>) {
    this.state = { ...this.state, ...changes, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener();
  }
}
