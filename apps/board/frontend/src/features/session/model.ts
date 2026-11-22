import type { QuotaStatus, RoleLinkLimits } from "../quotas/model";

export type Permission =
  | "subscriptions.read" | "subscriptions.manage"
  | "users.read" | "users.create" | "users.update" | "users.credentials"
  | "roles.read" | "roles.manage" | "roles.assign" | "audit.read"
  | "quotas.read" | "quotas.manage"
  | "nodes.read" | "nodes.manage" | "nodes.enroll"
  | "routing.read" | "routing.edit" | "routing.publish"
  | "announcements.read" | "announcements.manage" | "settings.read" | "settings.manage";

export type RoleSummary = {
  id: string;
  name: string;
  built_in: boolean;
  locked: boolean;
};

export type Role = {
  id: string;
  name: string;
  description: string;
  built_in: boolean;
  locked: boolean;
  member_count?: number;
  permissions: Permission[];
  default_quota_plan_id?: string | null;
  default_quota_plan_name?: string | null;
  link_limits?: RoleLinkLimits;
};

export type Point = { key: Permission; group: string; label: string };
export type Access = { owner: boolean; roles: Role[]; permissions: Permission[]; overrides: Partial<Record<Permission, boolean>> };
export type Account = {
  id: string; email: string; display_name: string; locale?: import("../../i18n").Locale | null; created_at: string; admin: boolean;
  active: boolean; quota_bytes: string | null; used_bytes: string;
  roles?: RoleSummary[];
  quota?: QuotaStatus;
  status_editable?: boolean; quota_editable?: boolean;
};
export type Session = Account & { access: Access; admin_workspace: boolean };

export function can(access: Access, ...points: Permission[]) {
  return points.every((point) => access.permissions.includes(point));
}

export function displayName(account: Account) {
  return account.display_name || account.email;
}
