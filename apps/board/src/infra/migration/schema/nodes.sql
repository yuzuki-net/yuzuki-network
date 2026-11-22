-- Managed hosts / agents (decoupled from subscription proxy nodes)
CREATE TABLE servers (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    remark text NOT NULL DEFAULT '',
    default_host text,
    enrollment_hash text UNIQUE,
    enrollment_expires_at timestamptz,
    session_id uuid,
    last_seen_at timestamptz,
    applied_revision text,
    deployment_error text,
    capabilities jsonb NOT NULL DEFAULT '[]',
    runtime_status jsonb,
    host_info jsonb,
    config_warnings jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX servers_deleted_at ON servers (deleted_at);

CREATE TABLE server_identities (
    fingerprint text PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX server_identities_server ON server_identities (server_id);

CREATE TABLE server_core_tasks (
    id uuid PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    core text CHECK (core IS NULL OR core IN ('xray', 'sing-box', 'mihomo')),
    action text NOT NULL CHECK (action IN ('install', 'remove', 'probe')),
    target_version text,
    download_url text,
    stage text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    message text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_core_tasks_server_created
    ON server_core_tasks (server_id, created_at DESC);

CREATE TABLE server_locations (
    server_id uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

-- Unified proxy nodes (V2Board / XBoard style first-class lines)
CREATE TABLE proxy_nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('managed', 'relay', 'external', 'custom')),
    server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
    parent_id uuid REFERENCES proxy_nodes(id) ON DELETE CASCADE,
    core text CHECK (core IS NULL OR core IN ('xray', 'sing-box', 'mihomo')),
    enabled boolean NOT NULL DEFAULT true,
    show boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    rate double precision NOT NULL DEFAULT 1.0 CHECK (rate >= 0.0 AND rate <= 100.0),
    tags text[] NOT NULL DEFAULT '{}',
    visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'roles')),
    protocol text,
    host text NOT NULL DEFAULT '',
    port integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
    listen_port integer CHECK (listen_port IS NULL OR listen_port BETWEEN 1 AND 65535),
    protocol_config jsonb NOT NULL DEFAULT '{}',
    meter_enabled boolean NOT NULL DEFAULT true,
    meter_port integer CHECK (meter_port IS NULL OR meter_port BETWEEN 1024 AND 65535),
    meter_config jsonb,
    native_server_config jsonb,
    native_client_overrides jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX proxy_nodes_server ON proxy_nodes (server_id) WHERE deleted_at IS NULL;
CREATE INDEX proxy_nodes_parent ON proxy_nodes (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX proxy_nodes_sort ON proxy_nodes (sort_order, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX proxy_nodes_deleted_at ON proxy_nodes (deleted_at);
CREATE UNIQUE INDEX proxy_nodes_meter_port_active
    ON proxy_nodes (server_id, meter_port)
    WHERE deleted_at IS NULL AND server_id IS NOT NULL AND meter_port IS NOT NULL;

CREATE TABLE proxy_node_roles (
    node_id uuid NOT NULL REFERENCES proxy_nodes(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, role_id)
);
CREATE INDEX proxy_node_roles_by_role ON proxy_node_roles (role_id);

-- Usage ledger is intentionally decoupled from live servers/proxy_nodes FKs so
-- soft-deleted & hard-deleted infrastructure never blocks deletion or breaks history.
CREATE TABLE usage_events (
    server_id uuid NOT NULL,
    event_id uuid NOT NULL,
    node_id uuid NOT NULL,
    account_id uuid NOT NULL REFERENCES accounts(id),
    uploaded bigint NOT NULL CHECK (uploaded >= 0),
    downloaded bigint NOT NULL CHECK (downloaded >= 0),
    rate double precision NOT NULL DEFAULT 1.0 CHECK (rate >= 0.0),
    billed_bytes bigint NOT NULL CHECK (billed_bytes >= 0),
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, event_id)
);
CREATE INDEX usage_events_account ON usage_events (account_id);
CREATE INDEX usage_events_node ON usage_events (node_id);
CREATE INDEX usage_events_received_at ON usage_events (received_at);

CREATE TABLE server_usage_minutes (
    bucket timestamptz NOT NULL,
    server_id uuid NOT NULL,
    uploaded numeric NOT NULL,
    downloaded numeric NOT NULL,
    PRIMARY KEY (bucket, server_id)
);

CREATE TABLE server_usage_hours (
    bucket timestamptz NOT NULL,
    server_id uuid NOT NULL,
    uploaded numeric NOT NULL,
    downloaded numeric NOT NULL,
    PRIMARY KEY (bucket, server_id)
);

CREATE TABLE server_usage_days (
    server_id uuid NOT NULL,
    bucket date NOT NULL,
    uploaded numeric NOT NULL,
    downloaded numeric NOT NULL,
    PRIMARY KEY (server_id, bucket)
);

CREATE FUNCTION accumulate_server_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO server_usage_minutes VALUES (
        date_trunc('minute', NEW.received_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        NEW.server_id, NEW.uploaded, NEW.downloaded
    ) ON CONFLICT (bucket, server_id) DO UPDATE SET
        uploaded = server_usage_minutes.uploaded + EXCLUDED.uploaded,
        downloaded = server_usage_minutes.downloaded + EXCLUDED.downloaded;

    INSERT INTO server_usage_days VALUES (
        NEW.server_id, (NEW.received_at AT TIME ZONE 'UTC')::date,
        NEW.uploaded, NEW.downloaded
    ) ON CONFLICT (server_id, bucket) DO UPDATE SET
        uploaded = server_usage_days.uploaded + EXCLUDED.uploaded,
        downloaded = server_usage_days.downloaded + EXCLUDED.downloaded;
    RETURN NEW;
END
$$;

CREATE TRIGGER usage_dashboard_rollup AFTER INSERT ON usage_events
FOR EACH ROW EXECUTE FUNCTION accumulate_server_usage();

CREATE FUNCTION accumulate_server_usage_hour() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO server_usage_hours VALUES (
        date_bin(INTERVAL '1 hour', NEW.received_at, '2000-01-01T00:00:00Z'::timestamptz),
        NEW.server_id, NEW.uploaded, NEW.downloaded
    ) ON CONFLICT (bucket, server_id) DO UPDATE SET
        uploaded = server_usage_hours.uploaded + EXCLUDED.uploaded,
        downloaded = server_usage_hours.downloaded + EXCLUDED.downloaded;
    RETURN NEW;
END
$$;

CREATE TRIGGER usage_dashboard_hour AFTER INSERT ON usage_events
FOR EACH ROW EXECUTE FUNCTION accumulate_server_usage_hour();

CREATE TABLE device_fingerprint_key (
    id smallint PRIMARY KEY CHECK (id = 1),
    key bytea NOT NULL CHECK (octet_length(key) = 32)
);

CREATE TABLE observed_instances (
    node_id uuid PRIMARY KEY REFERENCES proxy_nodes(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observed_instances_server ON observed_instances (server_id);

CREATE TABLE observed_sources (
    node_id uuid NOT NULL REFERENCES observed_instances(node_id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    PRIMARY KEY (node_id, account_id, fingerprint)
);
