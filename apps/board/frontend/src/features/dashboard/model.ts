export const dashboardUrl = "/api/v1/admin/dashboard";
export type TrafficRange = "1h" | "24h" | "7d";
export type Traffic = { uploaded: string; downloaded: string };
export type TrafficPoint = Traffic & { timestamp: string };
export type NodeLocation = { label: string; latitude: number; longitude: number };
export type Marker = NodeLocation & Traffic & { id: string; name: string; online: boolean };
export type Metrics = {
  as_of: string;
  accounts: { users: number; enabled_users: number; active_console_sessions: number; recent_subscription_devices: number } | null;
  infrastructure: null | {
    totals: Traffic; last_minute: Traffic; registered_nodes: number; online_agents: number;
    published_nodes: number; attention_nodes: number; locations: Marker[]; timeseries: TrafficPoint[];
    presence?: { sources: number; measured_instances: number; active_instances: number };
  };
};
