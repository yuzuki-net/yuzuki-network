export const quotaPath = "/api/v1/admin/quotas";
export const quotaPlansPath = "/api/v1/admin/quota-plans";
export const personalQuotaPath = "/api/v1/me/quota";

export type RoleLinkLimits = {
  xray: number | null;
  sing_box: number | null;
  mihomo: number | null;
  universal: number | null;
};
export type CountTuple = [number, number, number, number];
export const inheritedLinkLimits: RoleLinkLimits = {
  xray: null,
  sing_box: null,
  mihomo: null,
  universal: null,
};

export type DurationKind = "unlimited" | "hours" | "days" | "months" | "years";
export type ResetMode = "none" | "cycle";
export type QuotaState = "available" | "scheduled" | "expired" | "exhausted" | "inactive";

export type QuotaPlan = {
  id: string;
  name: string;
  description: string;
  built_in: boolean;
  quota_bytes: string | null;
  duration_kind: DurationKind;
  duration_value: number | null;
  reset_mode: ResetMode;
  max_devices: number | null;
  link_limits: RoleLinkLimits;
  priority: number;
  created_at: string;
};

export type QuotaPlanInput = {
  name: string;
  description: string;
  quota_bytes: string | null;
  duration_kind: DurationKind;
  duration_value: number | null;
  reset_mode: ResetMode;
  max_devices: number | null;
  link_limits: RoleLinkLimits;
  priority: number;
};

export type QuotaGrant = {
  id: string;
  account_id: string;
  plan_id: string | null;
  name: string;
  quota_bytes: string | null;
  used_bytes: string;
  remaining_bytes: string | null;
  duration_kind: DurationKind;
  duration_value: number | null;
  reset_mode: ResetMode;
  anchor_at: string;
  cycle_index: number;
  starts_at: string;
  cycle_starts_at: string;
  cycle_ends_at: string | null;
  expires_at: string | null;
  max_devices: number | null;
  priority: number;
  revoked: boolean;
  state: QuotaState;
  created_at: string;
};

export type GrantInput = {
  plan_id?: string | null;
  name?: string | null;
  quota_bytes?: string | null;
  duration_kind?: DurationKind;
  duration_value?: number | null;
  reset_mode?: ResetMode;
  starts_at?: string | null;
  expires_at?: string | null;
  max_devices?: number | null;
  priority?: number;
  replace_existing?: boolean;
};

export type QuotaPolicyInput = {
  max_devices: number | null;
  link_limits: RoleLinkLimits;
};

export type QuotaStatus = {
  quota_bytes: string | null;
  used_bytes: string;
  remaining_bytes: string | null;
  lifetime_used_bytes: string;
  eligible: boolean;
  state: QuotaState;
  window_starts_at: string | null;
  window_ends_at: string | null;
  max_devices: number | null;
  override_max_devices: number | null;
  link_limits: RoleLinkLimits;
  grants: QuotaGrant[];
};

export type QuotaDetails = QuotaStatus & {
  active_devices: number;
  effective_link_limits: CountTuple;
  inherited_link_limits: CountTuple;
  can_edit: boolean;
};

export function quotaPolicyPath(account: string) {
  return `${quotaPath}/${account}/policy`;
}

export function quotaGrantsPath(account: string) {
  return `${quotaPath}/${account}/grants`;
}
