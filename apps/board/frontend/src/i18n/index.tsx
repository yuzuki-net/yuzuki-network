import { KumoLocaleProvider } from "@cloudflare/kumo";
import { createContext, useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { Translations, supportedLocale, type Locale, type Parameters, type Translator } from "./catalog";

export { localeNames, supportedLocale, type Locale, type Translator } from "./catalog";
export const messages = new Translations();

export function english(namespace: string, key: string, fallback: string, parameters?: Parameters) {
  return messages.get(namespace, key, fallback, parameters, "en");
}

const LocaleStore = createContext(messages);
const preference = "yuzuki.locale";

let accountLocalePersister: ((locale: Locale) => void) | null = null;

export function setAccountLocalePersister(persister: ((locale: Locale) => void) | null) {
  accountLocalePersister = persister;
}

export function applySyncedLocale(locale: Locale) {
  try {
    localStorage.setItem(preference, locale);
  } catch {
    /* Storage can be disabled by the browser. */
  }
  if (messages.snapshot().locale !== locale) {
    void messages.choose(locale);
  }
}

function preferredLocale(): Locale {
  try {
    const persisted = localStorage.getItem(preference);
    const locale = persisted && supportedLocale(persisted);
    if (locale) return locale;
  } catch { /* Storage can be disabled by the browser. */ }
  return navigator.languages.map(supportedLocale).find((locale) => locale !== undefined) ?? "en";
}

export function startLocale() {
  return messages.choose(preferredLocale());
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(messages.subscribe, messages.snapshot);
  useLayoutEffect(() => {
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.direction;
  }, [state.locale, state.direction]);
  const t: Translator = (key, fallback, values) => messages.get("common", key, fallback, values);
  return <LocaleStore.Provider value={messages}>
    <KumoLocaleProvider translations={{
      breadcrumbs: { label: t("breadcrumbs", "Breadcrumb"), copy: t("copy", "Copy"), copyTooltip: t("copy", "Copy") },
      label: { optional: t("optional", "optional"), tooltip: t("moreInformation", "More information") },
      layerDialog: { close: t("close", "Close"), cancel: t("cancel", "Cancel") },
    }}>{children}</KumoLocaleProvider>
  </LocaleStore.Provider>;
}

export function useT(namespace: string): Translator {
  const store = useContext(LocaleStore);
  useSyncExternalStore(store.subscribe, store.snapshot);
  return (key, fallback, parameters) => store.get(namespace, key, fallback, parameters);
}

export function useLocale() {
  const store = useContext(LocaleStore);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return { ...state, changeLocale(locale: Locale) {
    try { localStorage.setItem(preference, locale); } catch { /* The active tab still uses the chosen language. */ }
    void store.choose(locale);
    accountLocalePersister?.(locale);
  } };
}
