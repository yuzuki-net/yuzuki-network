# Development

## Build and test

Use Rust with edition 2024 support, Bun, and PostgreSQL. A C compiler is needed for native dependencies. Go core binaries are runtime and integration-test inputs.

```sh
cargo build --workspace --locked
cargo test --workspace --locked

cd apps/board/frontend
bun install --frozen-lockfile
bun --bun run typecheck
bun test
bun --bun run build
```

The Board build invokes Bun to install locked dependencies, type-check the UI and compile the public site and console. Set `BUN` to an absolute executable path if needed. Test modules under `tests/` mirror their application modules. Set `YUZUKI_TEST_DATABASE_URL` to an isolated test database to run the Board's database integration suite.

Run PostgreSQL 14 Alpine in Podman for integration and access-control tests.

```sh
podman run --rm -d --name yuzuki-test-db \
  -p 127.0.0.1:55437:5432 \
  -e POSTGRES_USER=yuzuki -e POSTGRES_PASSWORD=local-test-only \
  -e POSTGRES_DB=yuzuki_test docker.io/library/postgres:14-alpine
podman exec yuzuki-test-db pg_isready -U yuzuki -d yuzuki_test
YUZUKI_TEST_DATABASE_URL=postgres://yuzuki:local-test-only@127.0.0.1:55437/yuzuki_test \
  cargo test --workspace --locked
podman stop yuzuki-test-db
```

Set `YUZUKI_XRAY`, `YUZUKI_SING_BOX` and `YUZUKI_MIHOMO` before running the Rust tests to check target formats against the native parsers. The protocol traffic matrix exercises Hysteria2 between the pinned versions in `config/cores.toml`, including Salamander.

For the process-level matrix, set `YUZUKI_MATRIX_DATABASE_URL` to a fresh test database. The harness needs the three cores, OpenSSL, curl and psql. Set `YUZUKI_XRAY`, `YUZUKI_SING_BOX` and `YUZUKI_MIHOMO` to the tested binaries if they are outside `PATH`.

```sh
cargo build --workspace --locked
bun apps/board/tests/infra/core-matrix.ts
```

The harness enrolls a Node with a temporary CA, applies three VLESS-over-TLS listeners on loopback, and opens a TCP stream for each server-core and subscription-format combination. It checks traffic attribution, Xray and Mihomo online source reporting, dashboard totals and withdrawal after quota exhaustion. Set `YUZUKI_MATRIX_SING_BOX_STATS=1` to include sing-box metering when the binary was built with the V2Ray statistics API.

Set `YUZUKI_MATRIX_RESTART=1` to stop Board, wait for the node lease to expire, then check reconnection and redeployment against the same database.
Set `YUZUKI_MATRIX_HOLD_SECONDS` to keep the Xray test stream open and sample online status and traffic counters throughout the interval.

## Board setup

Create an empty UTF-8 PostgreSQL database and copy `config/board.example.toml` to `config/board.local.toml`. Set `YUZUKI_DATABASE_URL` and supply the administrator password through `YUZUKI_ADMIN_PASSWORD`.

```sh
cargo run --locked -p board -- --config config/board.local.toml migrate
cargo run --locked -p board -- --config config/board.local.toml create-admin --email admin@example.net
cargo run --locked -p board -- --config config/board.local.toml serve
```

Use an HTTPS reverse proxy for the browser-facing site, with secure cookies enabled. For local HTTP development, set `secure_cookies = false`. Avoid logging full subscription paths in the reverse proxy. Public replacements may provide `index.html`, `login.html`, `register.html` and `assets/`. Custom forms send JSON `{ "email": "...", "password": "..." }` to `/auth/login` or `/auth/register` and include the header `x-workspace-request: 1`. After a successful login, `GET /auth/session` returns `signed_in: true` and the default `workspace` path.

Successful login also returns `X-Workspace-Path` with the destination `/workspace` or `/admin`. The built-in form uses this header to open the workspace immediately.

For subscription device attribution through a reverse proxy, set `trusted_proxies` to the exact addresses of your proxy hops and configure them to append or replace `X-Forwarded-For`. Board uses the first untrusted address when reading from the right. Without a trusted proxy configuration, Board uses the connected socket address.

Use the workspace picker in the Console sidebar to enter administration. Create roles under **Roles and permissions**, then open a user's **Permissions** tab to assign roles or set account-level overrides. Combine a section's read point with the action points the role needs. The `admin` path segment is reserved for the administration frontend.

Named links are listed in the subscription workspace across browser sessions. Create a separate link for each client format.

## Node setup

Configure the Board control listener with its TLS server key and certificate and a CA key and certificate for issuing node identities. Give Node the CA that issued the Board's **server** certificate. Copy `config/node.example.toml` to a local file and set the origin, CA and installed binary paths. The paths are interpreted from the process working directory.

Create a node in Board and open **Agent connection**. Generate the one-time enrollment token and set `YUZUKI_ENROLLMENT_TOKEN` for the enrollment command. Node keeps private state in a mode-0700 directory.

```sh
cargo run --locked -p node -- --config config/node.local.toml enroll
cargo run --locked -p node -- --config config/node.local.toml run
```

Wait for the agent heartbeat and check its reported binary versions. Add core instances and endpoints, then review client format coverage and publish the node. Board accepts mihomo server configuration in JSON or YAML. A server configuration template can turn the entitled account set into a native user list. For example, xray-core VLESS clients use this value in `settings.clients`.

```json
{"$yuzuki_users":{"id":"$yuzuki_access_id","email":"$yuzuki_access_id"}}
```

sing-box VLESS uses the keys `uuid` and `name`. In a dedicated mihomo instance `$yuzuki_single_user` denotes one account-bound value, and `$yuzuki_users` still expands to an array. Match the projected username or UUID to the core's native schema. Enable the corresponding native statistics API and set the instance meter to one of the following.

- `{"kind":"user_stats","addr":"127.0.0.1:10085"}` for xray-core or a sing-box build providing the V2Ray statistics API. Use the account UUID in the core's statistics name.
- `{"kind":"dedicated_traffic","addr":"127.0.0.1:19090","access_id":"<account UUID>","secret":"<local API secret>"}` for a whole mihomo instance dedicated to one account. Operators can look up the account binding in the `accounts.access_id` column.
- `null` for endpoints that only need process management.

A portable endpoint has `protocol`, `host`, `port` and optional `server_name` and `method` under `spec.portable`. Advanced endpoints can provide `spec.native`, keyed by `xray`, `sing-box` or `mihomo`. Each entry is `{"section":"outbound","config":{...}}`. sing-box also allows `"section":"endpoint"`. Use the exact value `"$yuzuki_access_id"` for fields bound to the current subscriber. Board assigns stable IDs as outbound tags. Configure common routing or add a native policy overlay. Validate advanced native fragments with the exact version of the consuming core before deployment.

The guided editor shows compatible targets before an endpoint is saved. Its templates cover Hysteria2, Hysteria v1, TUIC, AnyTLS, NaiveProxy, the Shadowsocks 2022 ciphers in the compatibility matrix, and the listed stream transports. Refer to `config/cores.toml` for requirements by protocol. Configure optional node markers from the node overview. The chart's map geometry comes from the Natural Earth 1:110m countries dataset. [Natural Earth v5.1.2](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson)

## Extend and verify

Define new endpoint encodings and protocol settings in `crates/core-config/src/protocols/`. Register target routing compilers in its core registry. Register process adapters in `apps/node/src/extensions/`; a statistics source can implement `UsageCollector` independently.

Add a feature's translated copy to `apps/board/frontend/src/i18n/locales/<locale>/<namespace>.json`. Use `useT("<namespace>")` in React and pass variables as named parameters. Extensions can call `messages.register(namespace, locale, translations)` or `messages.addLoader(namespace, locale, loader)`. Built-in locale files have matching keys and parameter names. Test Persian layouts in RTL. Add a lazy console route in `src/app/routes.ts` and enforce the required points in the Board router.

When changing a protocol, verify each applicable server-core and target-format pairing. Test configuration parsing and actual traffic for the supported pairing. Treat runtime build features, OS privileges, transport settings and credential support as separate capabilities. Native configuration support by itself verifies neither interoperability nor account-level metering.
