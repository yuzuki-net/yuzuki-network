import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Check, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../i18n";

export type ColorMode = "system" | "light" | "dark";
export type ResolvedMode = "light" | "dark";
export type AccentPreset = "emerald" | "teal" | "orange" | "blue" | "indigo" | "rose" | "slate" | "custom";
export type Density = "comfortable" | "compact";
export type RadiusStyle = "sharp" | "default" | "rounded";

export type ThemeAppearance = {
  defaultMode?: ColorMode;
  allowModeSwitch?: boolean;
  accent?: AccentPreset;
  customHex?: string | null;
  density?: Density;
  radius?: RadiusStyle;
  faviconUrl?: string | null;
};

type ThemeState = {
  mode: ColorMode;
  resolved: ResolvedMode;
  allowSwitch: boolean;
  accent: AccentPreset;
  setMode: (mode: ColorMode) => void;
};

const STORAGE_KEY = "yuzuki.color-mode";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const ThemeContext = createContext<ThemeState>({
  mode: "system",
  resolved: "light",
  allowSwitch: true,
  accent: "emerald",
  setMode: () => {},
});

function readStoredMode(): ColorMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch { /* ignore storage restrictions */ }
  return null;
}

function systemMode(): ResolvedMode {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyCustomHex(hex?: string | null) {
  const root = document.documentElement;
  if (hex && HEX_RE.test(hex)) {
    root.style.setProperty("--brand-accent", hex);
    root.style.setProperty("--brand-accent-strong", `color-mix(in srgb, ${hex} 85%, black)`);
    root.style.setProperty("--brand-deep", `color-mix(in srgb, ${hex} 42%, black)`);
    root.style.setProperty("--brand-light", `color-mix(in srgb, ${hex} 55%, white)`);
  } else {
    root.style.removeProperty("--brand-accent");
    root.style.removeProperty("--brand-accent-strong");
    root.style.removeProperty("--brand-deep");
    root.style.removeProperty("--brand-light");
  }
}

export function initThemeEarly() {
  const stored = readStoredMode() ?? "system";
  const resolved: ResolvedMode = stored === "system" ? systemMode() : stored;
  document.documentElement.dataset.mode = resolved;
  if (!document.documentElement.dataset.accent) {
    document.documentElement.dataset.accent = "emerald";
  }
}

export function ThemeProvider({ appearance, children }: { appearance?: ThemeAppearance; children: ReactNode }) {
  const allowSwitch = appearance?.allowModeSwitch ?? true;
  const defaultMode: ColorMode = appearance?.defaultMode ?? "system";
  const [userMode, setUserMode] = useState<ColorMode | null>(() => readStoredMode());
  const [sys, setSys] = useState<ResolvedMode>(() => systemMode());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => setSys(event.matches ? "dark" : "light");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const mode: ColorMode = allowSwitch ? (userMode ?? defaultMode) : defaultMode;
  const resolved: ResolvedMode = mode === "system" ? sys : mode;
  const accent: AccentPreset = appearance?.accent ?? "emerald";

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = resolved;
    root.dataset.accent = accent;
    root.dataset.density = appearance?.density ?? "comfortable";
    root.dataset.radius = appearance?.radius ?? "default";
    applyCustomHex(accent === "custom" ? appearance?.customHex : null);
  }, [resolved, accent, appearance?.customHex, appearance?.density, appearance?.radius]);

  useEffect(() => {
    const href = appearance?.faviconUrl?.trim();
    if (!href) return;
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-yuzuki-favicon]");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.dataset.yuzukiFavicon = "1";
      document.head.append(link);
    }
    link.href = href;
  }, [appearance?.faviconUrl]);

  const setMode = useCallback((next: ColorMode) => {
    setUserMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);

  const value = useMemo(() => ({ mode, resolved, allowSwitch, accent, setMode }), [mode, resolved, allowSwitch, accent, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeSwitcher() {
  const { mode, resolved, allowSwitch, setMode } = useTheme();
  const t = useT("common");
  if (!allowSwitch) return null;
  const ActiveIcon = mode === "system" ? Desktop : resolved === "dark" ? Moon : Sun;
  const label = t("theme.label", "Color theme");
  const options: { value: ColorMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("theme.light", "Light"), icon: Sun },
    { value: "dark", label: t("theme.dark", "Dark"), icon: Moon },
    { value: "system", label: t("theme.system", "System"), icon: Desktop },
  ];
  return <DropdownMenu>
    <Tooltip content={label} render={
      <DropdownMenu.Trigger render={<Button variant="ghost" shape="square" icon={ActiveIcon} aria-label={label} />} />
    } />
    <DropdownMenu.Content align="end">
      <DropdownMenu.Group>
        <DropdownMenu.Label>{label}</DropdownMenu.Label>
        {options.map(({ value, label: text, icon: Icon }) => (
          <DropdownMenu.Item key={value} selected={mode === value} icon={Icon} onClick={() => setMode(value)}>
            <span>{text}</span>
            {mode === value && <Check size={15} className="ms-auto" aria-hidden />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu>;
}
