CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL DEFAULT '',
    locale text CHECK (locale IS NULL OR locale IN ('en', 'zh-CN', 'ja', 'ru', 'fa')),
    password_hash text NOT NULL,
    admin boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    access_id uuid NOT NULL UNIQUE,
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_account_id ON sessions (account_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);
CREATE UNIQUE INDEX sessions_id_key ON sessions (id);
CREATE INDEX sessions_last_seen ON sessions (last_seen_at DESC);

-- Standalone reusable Quota Plan definitions (supports unlimited/fixed bytes,
-- arbitrary calendar units: hours/days/months/years or unlimited duration,
-- one-time vs cycle reset, device & link limits).
CREATE TABLE quota_plans (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    built_in boolean NOT NULL DEFAULT false,
    quota_bytes bigint CHECK (quota_bytes >= 0),
    duration_kind text NOT NULL DEFAULT 'unlimited'
        CHECK (duration_kind IN ('unlimited', 'hours', 'days', 'months', 'years')),
    duration_value integer CHECK (duration_value BETWEEN 1 AND 36500),
    reset_mode text NOT NULL DEFAULT 'none'
        CHECK (reset_mode IN ('none', 'cycle')),
    max_devices integer CHECK (max_devices BETWEEN 0 AND 1000),
    max_links_xray integer CHECK (max_links_xray BETWEEN 0 AND 100),
    max_links_sing_box integer CHECK (max_links_sing_box BETWEEN 0 AND 100),
    max_links_mihomo integer CHECK (max_links_mihomo BETWEEN 0 AND 100),
    max_links_universal integer CHECK (max_links_universal BETWEEN 0 AND 100),
    priority integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((duration_kind = 'unlimited') = (duration_value IS NULL)),
    CHECK (reset_mode <> 'cycle' OR duration_kind <> 'unlimited')
);
CREATE UNIQUE INDEX quota_plan_names ON quota_plans (lower(name));

CREATE TABLE roles (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    built_in boolean NOT NULL DEFAULT false,
    locked boolean NOT NULL DEFAULT false,
    default_quota_plan_id uuid REFERENCES quota_plans(id) ON DELETE SET NULL,
    max_links_xray integer CHECK (max_links_xray BETWEEN 0 AND 100),
    max_links_sing_box integer CHECK (max_links_sing_box BETWEEN 0 AND 100),
    max_links_mihomo integer CHECK (max_links_mihomo BETWEEN 0 AND 100),
    max_links_universal integer CHECK (max_links_universal BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX role_names ON roles (lower(name));

CREATE TABLE role_permissions (
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission text NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE account_roles (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, role_id)
);
CREATE INDEX account_roles_by_role ON account_roles (role_id);

CREATE TABLE account_permissions (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    permission text NOT NULL,
    allowed boolean NOT NULL,
    PRIMARY KEY (account_id, permission)
);

CREATE TABLE access_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid NOT NULL REFERENCES accounts(id),
    action text NOT NULL,
    target text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    target_label text
);

-- Seed built-in Unlimited quota plan
INSERT INTO quota_plans (
    id, name, description, built_in, quota_bytes, duration_kind, duration_value, reset_mode
) VALUES (
    '00000000-0000-4000-8000-000000000100',
    'Unlimited',
    'Unlimited transfer with no expiration.',
    true, NULL, 'unlimited', NULL, 'none'
);

-- Built-in locked Administrator role (read-only, assigned to all N admin accounts)
INSERT INTO roles (
    id, name, description, built_in, locked, default_quota_plan_id
) VALUES (
    '00000000-0000-4000-8000-000000000000', 'Administrator',
    'Full administrative access across the control plane and all proxy nodes.',
    true, true, '00000000-0000-4000-8000-000000000100'
);

-- Built-in Member role (default template for new regular users)
INSERT INTO roles (
    id, name, description, built_in, locked, default_quota_plan_id
) VALUES (
    '00000000-0000-4000-8000-000000000001', 'Member',
    'Standard access to personal subscriptions.',
    true, false, '00000000-0000-4000-8000-000000000100'
);

INSERT INTO role_permissions VALUES
    ('00000000-0000-4000-8000-000000000000', 'subscriptions.read'),
    ('00000000-0000-4000-8000-000000000000', 'subscriptions.manage'),
    ('00000000-0000-4000-8000-000000000000', 'users.read'),
    ('00000000-0000-4000-8000-000000000000', 'users.create'),
    ('00000000-0000-4000-8000-000000000000', 'users.update'),
    ('00000000-0000-4000-8000-000000000000', 'users.credentials'),
    ('00000000-0000-4000-8000-000000000000', 'roles.read'),
    ('00000000-0000-4000-8000-000000000000', 'roles.manage'),
    ('00000000-0000-4000-8000-000000000000', 'roles.assign'),
    ('00000000-0000-4000-8000-000000000000', 'audit.read'),
    ('00000000-0000-4000-8000-000000000000', 'quotas.read'),
    ('00000000-0000-4000-8000-000000000000', 'quotas.manage'),
    ('00000000-0000-4000-8000-000000000000', 'nodes.read'),
    ('00000000-0000-4000-8000-000000000000', 'nodes.manage'),
    ('00000000-0000-4000-8000-000000000000', 'nodes.enroll'),
    ('00000000-0000-4000-8000-000000000000', 'routing.read'),
    ('00000000-0000-4000-8000-000000000000', 'routing.edit'),
    ('00000000-0000-4000-8000-000000000000', 'routing.publish'),
    ('00000000-0000-4000-8000-000000000000', 'announcements.read'),
    ('00000000-0000-4000-8000-000000000000', 'announcements.manage'),
    ('00000000-0000-4000-8000-000000000000', 'settings.read'),
    ('00000000-0000-4000-8000-000000000000', 'settings.manage'),
    ('00000000-0000-4000-8000-000000000001', 'subscriptions.read'),
    ('00000000-0000-4000-8000-000000000001', 'subscriptions.manage');
