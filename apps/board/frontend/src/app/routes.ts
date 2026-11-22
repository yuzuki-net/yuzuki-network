import { Bell, Gauge, GearSix, GlobeHemisphereEast, HardDrives, LinkSimple, LockKey, Pulse, ShieldCheck, Signpost, UsersThree, Wallet, type Icon } from "@phosphor-icons/react";
import { lazy, type ComponentType } from "react";
import type { Translator } from "../i18n";
import type { Permission } from "../features/session/model";

export type Area = "personal" | "admin";
type Path = `/${string}`;
type Access = Permission | "announcements.read" | "settings.read";

export type Route = {
  path: Path; area: Area; permission?: Access; feature?: "announcements";
  labelKey: string; label: string; groupKey: string; group: string; icon: Icon;
  page: ComponentType; preload: () => Promise<{ default: ComponentType }>;
};

const modules = import.meta.glob<{ default: ComponentType }>(["../pages/*/index.tsx", "!../pages/{home,login,register}/index.tsx"]);

function route(spec: Omit<Route, "page" | "preload">, name: string): Route {
  const preload = () => {
    const loader = modules[`../pages/${name}/index.tsx`];
    return loader ? loader() : Promise.reject(Error(`Missing workspace module: ${name}`));
  };
  return { ...spec, preload, page: lazy(preload) };
}

const workspace = { groupKey: "group.workspace", group: "Workspace" };
const access = { groupKey: "group.access", group: "Access and usage" };
const infra = { groupKey: "group.infrastructure", group: "Infrastructure" };
const activity = { groupKey: "group.activity", group: "Activity" };

export const routes: Route[] = [
  route({ path: "/workspace", area: "personal", labelKey: "overview", label: "Overview", icon: Gauge, ...workspace }, "overview"),
  route({ path: "/workspace/subscriptions", area: "personal", labelKey: "subscriptions", label: "Subscriptions", icon: LinkSimple, permission: "subscriptions.read", ...workspace }, "subscriptions"),
  route({ path: "/workspace/announcements", area: "personal", labelKey: "announcements", label: "Announcements", icon: Bell, feature: "announcements", ...activity }, "announcements"),
  route({ path: "/workspace/security", area: "personal", labelKey: "security", label: "Account settings", icon: ShieldCheck, ...workspace }, "security"),
  route({ path: "/admin", area: "admin", labelKey: "overview", label: "Overview", icon: Gauge, ...workspace }, "admin"),
  route({ path: "/admin/users", area: "admin", labelKey: "users", label: "Users", icon: UsersThree, permission: "users.read", ...access }, "accounts"),
  route({ path: "/admin/roles", area: "admin", labelKey: "roles", label: "Roles and permissions", icon: LockKey, permission: "roles.read", ...access }, "roles"),
  route({ path: "/admin/quotas", area: "admin", labelKey: "quotas", label: "Quotas", icon: Wallet, permission: "quotas.read", ...access }, "quotas"),
  route({ path: "/admin/nodes", area: "admin", labelKey: "nodes", label: "Nodes", icon: GlobeHemisphereEast, permission: "nodes.read", ...infra }, "nodes"),
  route({ path: "/admin/servers", area: "admin", labelKey: "servers", label: "Servers", icon: HardDrives, permission: "nodes.read", ...infra }, "servers"),
  route({ path: "/admin/routing", area: "admin", labelKey: "routing", label: "Routing", icon: Signpost, permission: "routing.read", ...infra }, "routing"),
  route({ path: "/admin/announcements", area: "admin", labelKey: "announcements", label: "Announcements", icon: Bell, permission: "announcements.read", ...activity }, "admin-announcements"),
  route({ path: "/admin/audit", area: "admin", labelKey: "audit", label: "Audit log", icon: Pulse, permission: "audit.read", ...activity }, "audit"),
  route({ path: "/admin/settings", area: "admin", labelKey: "settings", label: "System settings", icon: GearSix, permission: "settings.read", ...workspace }, "settings"),
];

export function labelRoute(route: Route, t: Translator) {
  return { ...route, label: t(route.labelKey, route.label), group: t(route.groupKey, route.group) };
}
