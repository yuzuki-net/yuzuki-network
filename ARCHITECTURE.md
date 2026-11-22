# Architecture

## Workspace

- `apps/board` is the Tokio/Axum control plane backed by PostgreSQL and SeaORM.
- `apps/node` manages local core processes and keeps a SQLite usage outbox.
- `crates/protocol` defines the versioned control messages and shared core identifiers.
- `crates/core-config` defines endpoint representations, template expansion and native routing compilers.
- `apps/client` is reserved for a future client.

Board's controllers handle routing, browser sessions, method authorization and DTOs. Services own account, inventory, subscription, routing and quota workflows. Views define browser-facing JSON. Infrastructure includes configuration, database entities and migrations, TLS, HTTP error mapping and embedded files.

```text
yuzuki-net/
├── {DESIGN,ARCHITECTURE,DEVELOPMENT}.md
├── {Cargo.toml,Cargo.lock}
├── config/{board.example,node.example,cores}.toml
├── apps/
│   ├── board/
│   │   ├── {Cargo.toml,build.rs}
│   │   ├── frontend/
│   │   │   ├── {package.json,bun.lock,vite.config.ts}
│   │   │   ├── {index,login,register,workspace,admin}.html
│   │   │   ├── src/
│   │   │   │   ├── app/{mount.tsx,query.ts,router.tsx,routes.ts,shell.tsx}
│   │   │   │   ├── assets/{maps,scripts,styles}/
│   │   │   │   ├── components/{console-ui,copy-value,data-table,secret-field}/
│   │   │   │   ├── entries/{home,login,public,register,workspace}.tsx
│   │   │   │   ├── features/{access,dashboard,directory,nodes,portal,quotas,routing,session,subscriptions}/
│   │   │   │   ├── i18n/locales/{en,zh-CN,ja,ru,fa}/
│   │   │   │   ├── layout/console/
│   │   │   │   └── pages/
│   │   │   │       ├── {home,login,register}/
│   │   │   │       ├── {overview,subscriptions,announcements,security}/
│   │   │   │       ├── {admin,accounts,roles,quotas,nodes,routing,audit,admin-announcements}/
│   │   │   │       └── settings/{index.tsx,branding.tsx,homepage.tsx,features.tsx,style.css}
│   │   │   └── tests/{features,i18n}/
│   │   ├── src/
│   │   │   ├── {app.rs,lib.rs,main.rs}
│   │   │   ├── controllers/
│   │   │   ├── extensions/
│   │   │   ├── infra/{config,error,frontend,migration,network,postgres,transport}/
│   │   │   ├── services/{access,accounts,announcements,auth,dashboard,messages,nodes,quotas,settings,subscriptions}/
│   │   │   └── views/
│   │   └── tests/{controllers,infra,integration.rs}
│   ├── node/
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── {app.rs,lib.rs,main.rs}
│   │   │   ├── extensions/
│   │   │   ├── infra/
│   │   │   └── services/{control,metering,runtime}/
│   │   └── tests/infra
│   └── client/{Cargo.toml,src/main.rs}
└── crates/
    ├── core-config/{Cargo.toml,src,tests}
    └── protocol/{Cargo.toml,src,tests}
```

## Administration and permissions

`services/access/permissions.rs` defines the permission catalog. The router associates each HTTP method and route with its required points. Board resolves the session and its permissions from one PostgreSQL snapshot. Sensitive user and role mutations serialize their authorization checks and writes, and append an audit event in the same transaction. Subscription issuance and downloads require access independently. The node deployment query uses the same subscription permission when deriving the entitled account set.

The public site and console build separately. The personal and administration workspaces use a shared console shell. Its route manifest carries access requirements and lazy page modules. Kumo renders navigation, breadcrumbs, command search and the account menu. The shell stays mounted while a page loads and TanStack Query caches its data. Feature modules own queries and editing forms. Page modules compose them, and reusable UI goes in `components/<name>/`. Session permissions filter visible routes and actions. Individual account details include allowed actions for the current operator and target. Mutation handlers recheck both sides inside their transaction.

The subscription status and renderer use the same enabled node, instance and endpoint selection. The status response carries counts and uses the published policy to report whether an endpoint is required. Named links are scoped to an account and one target format, with independent revocation. Board's initial PostgreSQL migration defines the full schema and seeds the built-in Member role and initial routing policy.

## Dashboard and announcements

The accepted usage ledger feeds per-node minute, hour and day rollups in PostgreSQL. Recent trend queries use minutes. The seven-day trend combines full hours with partial hours from minute data. The worker prunes minute and hour rollups after eight days and keeps the daily totals. Session activity, subscription refresh devices and native online sources have distinct time windows. The dashboard queries the groups allowed by the operator's current permissions. Node locations are optional and manually assigned.

Announcements use the PostgreSQL message queue. A publish request writes the queued state and job in one transaction. Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, and each delivery and its completion marker commit together. Failed deliveries roll back to a savepoint and retry with bounded backoff. Workspace members have per-account read receipts.

## Extension interfaces

| Interface | Built-in implementation |
| --- | --- |
| `EndpointCodec` | Portable protocol descriptions with target-specific encoding |
| `RoutingCompiler` | Registry of three core-native compilers |
| `SubscriptionRenderer` | Board's JSON and YAML renderer |
| `QuotaLedger` | PostgreSQL transaction covering deduplication and quota totals |
| `CoreRuntime` | Runtime registry with xray-core, sing-box and mihomo CLI adapters |
| `UsageCollector` | Native cumulative counters and optional online source reports |
| `ControlTransport` | Node WSS transport |

Interfaces live with the consuming module. Applications assemble concrete implementations in their startup and extension modules. A future out-of-process extension can implement a port through an adapter. Its versioned wire contract can evolve separately from the Rust trait.

Console translations use flat JSON catalogs grouped by locale and namespace. Extensions can register a catalog immediately or attach a lazy loader. English is the fallback. Public builds include only the public and common catalogs. Board includes a stable `code` in JSON validation and conflict responses alongside the existing `error` message. The console translates known codes. Errors reported by installed cores retain their diagnostic text.

## Control flow

1. An administrator generates a single-use enrollment token. Node generates its own key and sends a CSR via HTTPS. Board signs a 24-hour client certificate and records its fingerprint against the node.
2. Node connects using TLS 1.3 mutual authentication and WebSocket subprotocol `yuzuki.node.v1`. A new session fences the previous connection in PostgreSQL. The client renews its certificate before expiry.
3. Board derives a revision from the desired enabled instances and entitled accounts. Node validates candidate configurations with the installed binaries, preserves matching processes, and applies changed configurations. A failed startup triggers rollback. Board extends the lease only after the current configuration is applied. The agent reports its binary versions during negotiation and sends observed instance state in each heartbeat. Board fences report updates and session releases with the active session ID.
4. Node samples cumulative counters and writes differences and event IDs to SQLite in one transaction. Board validates that the reporting node owns the core instance and commits usage and quota updates atomically. An acknowledgement lets Node remove the corresponding outbox rows.
5. Board includes the installation key in the WSS welcome. Agents hash each observed account and source address under that key before sending snapshots. Board accepts only reports for the current session and its instances. Fresh snapshots expire after 20 seconds and duplicate account/source pairs across nodes count once.

xray-core and compatible sing-box builds can report named user counters through their local gRPC statistics APIs. mihomo can attribute its cumulative traffic endpoint to an account when the entire instance is dedicated to that account. Keep core control APIs bound to loopback. Board checks a node's access at upgrade and while refreshing its session. Use a dedicated control listener or route its TLS connection through a TCP proxy.
