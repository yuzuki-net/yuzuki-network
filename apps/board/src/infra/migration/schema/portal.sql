CREATE TABLE panel_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    value jsonb NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0)
);

CREATE TABLE announcements (
    id uuid PRIMARY KEY,
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    status text NOT NULL CHECK (status IN ('draft', 'queued', 'published', 'archived')),
    display_mode text NOT NULL DEFAULT 'normal' CHECK (display_mode IN ('normal', 'fullscreen')),
    starts_at timestamptz,
    ends_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid NOT NULL REFERENCES accounts(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX announcements_published ON announcements (published_at DESC, id DESC)
    WHERE status = 'published';

CREATE TABLE announcement_receipts (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, announcement_id)
);

CREATE TABLE message_jobs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_at timestamptz,
    failed_at timestamptz,
    CHECK (completed_at IS NULL OR failed_at IS NULL)
);
CREATE INDEX message_jobs_pending ON message_jobs (available_at, id)
    WHERE completed_at IS NULL AND failed_at IS NULL;
CREATE INDEX announcements_updated ON announcements (updated_at DESC, id DESC);
CREATE INDEX announcement_latest_job ON message_jobs ((payload->>'announcement_id'), id DESC)
    WHERE kind = 'announcement.publish';
