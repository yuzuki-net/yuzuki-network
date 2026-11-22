DROP VIEW IF EXISTS account_quota_status;
DROP TABLE IF EXISTS message_jobs, announcement_receipts, announcements, panel_settings,
    observed_sources, observed_instances, device_fingerprint_key,
    server_locations, server_usage_hours, server_usage_days, server_usage_minutes,
    server_core_tasks, subscription_devices, subscription_links, account_quota_policy,
    account_quotas, routing_policy, routing_revisions, usage_events, proxy_node_roles,
    proxy_nodes, server_identities, servers, access_audit, account_permissions,
    account_roles, role_permissions, roles, quota_plans, sessions, accounts;
DROP FUNCTION IF EXISTS yuzuki_quota_window(timestamptz, integer, boolean, timestamptz),
    accumulate_server_usage(), accumulate_server_usage_hour();
