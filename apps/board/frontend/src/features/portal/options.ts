import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../../assets/scripts/api";
import { defaultBrand } from "../../assets/scripts/brand";
import type { BrandIconPreset } from "../../components/kumo-ext";
import type { AccentPreset, ColorMode, Density, RadiusStyle } from "../theme";
import type { Locale } from "../../i18n";

export type Accent = AccentPreset;
export type HeroStyle = "mesh" | "grid" | "minimal" | "none";
export type ClientPreset = "clash" | "singbox" | "shadowrocket" | "v2rayn" | "hiddify";
export type BannerVariant = "info" | "warning" | "error";

export type NavLink = {
  label: string;
  url: string;
  external: boolean;
};

export type HighlightCard = {
  icon: BrandIconPreset;
  title: string;
  description: string;
};

export type BrandingExtra = {
  tagline: string | null;
  icon_preset: BrandIconPreset;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  footer_links: NavLink[];
};

export type AppearanceConfig = {
  default_mode: ColorMode;
  allow_mode_switch: boolean;
  accent_custom_hex: string | null;
  density: Density;
  radius: RadiusStyle;
  sidebar_default_collapsed: boolean;
};

export type PortalCustomization = {
  hero_badge: string | null;
  hero_style: HeroStyle;
  primary_cta: string | null;
  highlights: HighlightCard[];
  auth_title: string | null;
  auth_subtitle: string | null;
  auth_notice: string | null;
  terms_url: string | null;
  privacy_url: string | null;
};

export type InfoNodePlacement = "prepend_to_group" | "append_to_group" | "dedicated_group";

export type InfoNodeFormats = {
  xray: boolean;
  sing_box: boolean;
  mihomo: boolean;
  universal: boolean;
};

export type SubscriptionInfoNodes = {
  enabled: boolean;
  formats: InfoNodeFormats;
  placement: InfoNodePlacement;
  group_name: string;
  show_traffic: boolean;
  show_expiry: boolean;
  show_website: boolean;
  custom_templates: string[];
};

export type SubscriptionUi = {
  base_url: string | null;
  default_format: 0 | 1 | 2 | 3;
  auto_provision_links: boolean;
  enabled_clients: ClientPreset[];
  show_qr_code: boolean;
  guide_url: string | null;
  support_links: NavLink[];
  include_userinfo_header: boolean;
  profile_update_interval_hours: number;
  include_filename_header: boolean;
  info_nodes: SubscriptionInfoNodes;
};

export type MaintenanceBanner = {
  enabled: boolean;
  variant: BannerVariant;
  title: string | null;
  message: string | null;
};

export type WorkspaceUi = {
  default_locale: Locale | null;
  enabled_locales: Locale[];
  allow_profile_edit: boolean;
  show_devices_card: boolean;
  maintenance_banner: MaintenanceBanner;
};

export type Panel = {
  name: string;
  copyright: string | null;
  url: string | null;
  features: { registration: boolean; announcements: boolean };
  landing: { headline: string | null; description: string | null; accent: Accent; show_features: boolean };
  branding: BrandingExtra;
  appearance: AppearanceConfig;
  portal: PortalCustomization;
  subscription: SubscriptionUi;
  workspace: WorkspaceUi;
};

export type PanelRecord = { panel: Panel; revision: number };
export type PortalOptions = {
  registration: boolean;
  signed_in: boolean;
  workspace: "/workspace" | "/admin" | null;
  panel: Panel;
};

export const PORTAL_OPTIONS = "/auth/options";
export const PANEL_SETTINGS = "/api/v1/admin/settings";

export const defaultPanel: Panel = {
  name: defaultBrand,
  copyright: null,
  url: null,
  features: { registration: false, announcements: true },
  landing: { headline: null, description: null, accent: "emerald", show_features: true },
  branding: {
    tagline: null,
    icon_preset: "circles",
    logo_url: null,
    logo_dark_url: null,
    favicon_url: null,
    footer_links: [],
  },
  appearance: {
    default_mode: "system",
    allow_mode_switch: true,
    accent_custom_hex: null,
    density: "comfortable",
    radius: "default",
    sidebar_default_collapsed: false,
  },
  portal: {
    hero_badge: null,
    hero_style: "mesh",
    primary_cta: null,
    highlights: [],
    auth_title: null,
    auth_subtitle: null,
    auth_notice: null,
    terms_url: null,
    privacy_url: null,
  },
  subscription: {
    base_url: null,
    default_format: 3,
    auto_provision_links: true,
    enabled_clients: ["clash", "singbox", "shadowrocket", "v2rayn", "hiddify"],
    show_qr_code: true,
    guide_url: null,
    support_links: [],
    include_userinfo_header: true,
    profile_update_interval_hours: 24,
    include_filename_header: true,
    info_nodes: {
      enabled: true,
      formats: { xray: true, sing_box: true, mihomo: true, universal: true },
      placement: "prepend_to_group",
      group_name: "",
      show_traffic: true,
      show_expiry: true,
      show_website: true,
      custom_templates: [],
    },
  },
  workspace: {
    default_locale: null,
    enabled_locales: [],
    allow_profile_edit: true,
    show_devices_card: true,
    maintenance_banner: {
      enabled: false,
      variant: "info",
      title: null,
      message: null,
    },
  },
};

export function normalizePanel(panel?: Partial<Panel> | null): Panel {
  if (!panel) return defaultPanel;
  const groupName = panel.subscription?.info_nodes?.group_name ?? "";
  return {
    ...defaultPanel,
    ...panel,
    features: { ...defaultPanel.features, ...panel.features },
    landing: { ...defaultPanel.landing, ...panel.landing },
    branding: { ...defaultPanel.branding, ...panel.branding },
    appearance: { ...defaultPanel.appearance, ...panel.appearance },
    portal: { ...defaultPanel.portal, ...panel.portal },
    subscription: {
      ...defaultPanel.subscription,
      ...panel.subscription,
      info_nodes: {
        ...defaultPanel.subscription.info_nodes,
        ...panel.subscription?.info_nodes,
        group_name: groupName.trim() === "📊 套餐信息" ? "" : groupName,
        formats: {
          ...defaultPanel.subscription.info_nodes.formats,
          ...panel.subscription?.info_nodes?.formats,
        },
      },
    },
    workspace: {
      ...defaultPanel.workspace,
      ...panel.workspace,
      maintenance_banner: {
        ...defaultPanel.workspace.maintenance_banner,
        ...panel.workspace?.maintenance_banner,
      },
    },
  };
}

export function usePortalOptions() {
  return useQuery({
    queryKey: [PORTAL_OPTIONS],
    queryFn: ({ signal }) => api<PortalOptions>(PORTAL_OPTIONS, "GET", undefined, signal),
    refetchOnWindowFocus: "always",
  });
}

export function useRefreshRestoredPortal() {
  const client = useQueryClient();
  useEffect(() => {
    function restore(event: PageTransitionEvent) {
      if (event.persisted) void client.invalidateQueries({ queryKey: [PORTAL_OPTIONS] });
    }
    addEventListener("pageshow", restore);
    return () => removeEventListener("pageshow", restore);
  }, [client]);
}
