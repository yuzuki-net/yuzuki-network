export type Status = "draft" | "queued" | "published" | "archived";
export type DisplayMode = "normal" | "fullscreen";

export type Notice = {
  id: string;
  title: string;
  body: string;
  display_mode: DisplayMode;
  starts_at: string | null;
  ends_at: string | null;
  published_at: string;
  read: boolean;
};

export type AdminNotice = {
  id: string;
  title: string;
  body: string;
  status: Status;
  display_mode: DisplayMode;
  starts_at: string | null;
  ends_at: string | null;
  revision: number;
  updated_at: string;
  published_at: string | null;
  failed: boolean;
};

export type Page<T> = { items: T[]; total: number; page_size: number };
export type Inbox = Page<Notice> & { unread: number };
export type UnreadSummary = { unread: number; fullscreen: Notice[] };

export const ADMIN_ANNOUNCEMENTS = "/api/v1/admin/announcements";
export const INBOX = "/api/v1/me/announcements";
export const UNREAD = "/api/v1/me/announcements/unread";

export type ScheduleState = "always" | "scheduled" | "active" | "expired";

export function scheduleState(
  startsAt: string | null,
  endsAt: string | null,
  now = Date.now(),
): ScheduleState {
  if (!startsAt && !endsAt) return "always";
  const startMs = startsAt ? Date.parse(startsAt) : null;
  const endMs = endsAt ? Date.parse(endsAt) : null;
  if (endMs !== null && !Number.isNaN(endMs) && endMs <= now) return "expired";
  if (startMs !== null && !Number.isNaN(startMs) && startMs > now) return "scheduled";
  return "active";
}
