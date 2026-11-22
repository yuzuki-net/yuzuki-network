# Design

## Board and Node

Board manages accounts, roles, quotas, physical nodes, core instances, subscription endpoints and routing revisions. Node runs configured core binaries, applies the desired configuration, collects traffic statistics and reports deployment status. Existing clients consume remote configurations.

A physical node can host several core instances. Each instance has a server core and can expose several endpoints. The server core determines configuration, deployment and accounting. The target format determines how each eligible endpoint is represented in a subscription.

| URL query | Body |
| --- | --- |
| `f=0` | xray-core JSON |
| `f=1` | sing-box JSON |
| `f=2` | mihomo YAML |

The default route is `/documents/{token}`. Board derives all three formats from the same account-authorized inventory. A node configured to cover all formats needs one compatible endpoint for each target before it can be enabled. An endpoint can use a common protocol description, target-specific native fragments, or both. This keeps native protocol and transport options available when their schemas differ.

The common schema covers VLESS, VMess, Trojan, Shadowsocks, Shadowsocks 2022, SOCKS5, HTTP, Hysteria2, Hysteria v1, TUIC, AnyTLS and NaiveProxy. Availability depends on the client format and the installed core version. The editor shows the compatible targets, and `config/cores.toml` records the tested versions and listener templates.

## Frontend Design System & Architecture

The frontend combines **Cloudflare Dashboard / Kumo UI** (`@cloudflare/kumo` + Tailwind CSS v4 + `@phosphor-icons/react`) visual precision with **V2Board-style proxy panel** immediate usability.

### 1. Visual Language & Tokens
- **Kumo Semantic Surfaces**: All surfaces, borders, and typography use Kumo's `light-dark()` semantic tokens (`bg-kumo-canvas`, `bg-kumo-base`, `bg-kumo-elevated`, `bg-kumo-recessed`, `bg-kumo-tint`, `border-kumo-line`, `text-kumo-strong`, `text-kumo-default`, `text-kumo-subtle`). Hardcoded light-only hex backgrounds or borders are forbidden.
- **Color Modes**: Full first-class `light`, `dark`, and `system` color modes driven via `data-mode="light" | "dark"` on `<html>`, initialized before React hydration to prevent flash-of-unstyled-content (FOUC). ECharts visualizations read active Kumo CSS variables dynamically.
- **Brand Accent**: Defaults to **Emerald Green (`emerald`)** and supports operator-configurable presets (`emerald`, `teal`, `orange`, `blue`, `indigo`, `rose`, `slate`) or a validated custom Hex accent (`custom`). Accent variables (`--brand-accent`, `--brand-accent-soft`, `--brand-accent-strong`, `--brand-accent-fg`) tint brand marks, active navigation indicators, hero graphics, and primary accents without overriding Kumo's semantic status colors (`success`, `warning`, `danger`, `info`).
- **Spacing & Alignment Grid**: Strict 4px/8px grid (`gap-4`/`gap-6`, `p-5`/`p-6`). Maximum workspace width `1400px`. Zero negative-margin alignment hacks. All toolbar controls share uniform height (`h-9`) and baseline alignment. All modals use a 3-zone structure (sticky header with close button, scrollable body, sticky footer).

### 2. Component Policy
- **Reuse Kumo First**: Whenever `@cloudflare/kumo` ships a component (`Sidebar`, `Breadcrumbs`, `CommandPalette`, `Button`, `Input`, `InputGroup`, `SensitiveInput`, `Select`, `Switch`, `Checkbox`, `TagInput`, `DatePicker`, `Tabs`, `Table`, `Pagination`, `Toolbar`, `Dialog`, `DropdownMenu`, `Popover`, `Tooltip`, `Badge`, `Banner`, `Meter`, `Collapsible`, `LayerCard`, `Empty`, `Loader`, `Toast`, `CodeBlock`, `ClipboardText`, `InlineCopyText`, `TimeseriesChart`, `BubbleMap`), it MUST be used directly rather than reimplemented.
- **Kumo-Styled Extensions (`src/components/kumo-ext/`)**: Components absent from Kumo (`BrandMark`, `KpiStatCard`, `QrCodeModal`, `StepGuide`, `ConfirmDeleteDialog`, `CodePreview`, `FieldHint`, `VisualJsonBridge`) are built strictly using Kumo tokens, Base UI primitives, and Tailwind v4 utilities so they look indistinguishable from native Kumo components.

### 3. UX & Information Architecture Principles
- **Explicit Guidance**: Technical terms, status pills, icon-only actions, and disabled controls expose clear Kumo `Tooltip` explanations so users never guess what a setting affects or why an action is unavailable.
- **Immediate Overview Utility**:
  - *Personal overview* acts as a ready-to-use connection center: segmented format picker, one-click subscription creation/copy, one-click client import URI schemes (Clash Verge / Mihomo, Sing-box, Shadowrocket, v2rayN / Hiddify), SVG QR code modal, transfer allowance meter with reset countdown, device status, support/docs links, and inline unread announcement banner.
  - *Administration overview* acts as an operations cockpit: KPI stat cards with drill-down links, actionable health banners, compact quick-action bar (find user, create user, register node, publish announcement, test routing), time-series transfer chart, and interactive node map—eliminating redundant navigation card grids.
- **Visual Interactive Workflows Over Raw JSON**: Routing rules, native routing overlays, node agent `node.toml` setup, core instance listeners/metering, and protocol endpoint overrides all default to structured visual forms, presets, tag inputs, and interactive templates, keeping formatted/validated source editors as an optional expert view.
- **Deeply Customizable System Settings**: Administrators customize branding (name, tagline, built-in icon or light/dark custom logo URLs, favicon, footer links), appearance (default mode, theme toggle permission, accent color/custom hex, density, radius, default sidebar state), public portal & auth pages (hero badge/style/headline/description/CTA, highlight cards, auth notices, terms/privacy URLs), subscription UX (external subscription base URL, default format, enabled client import schemes, QR toggle, support/doc cards), workspace features & maintenance banners, plus JSON export/import and factory reset.

## Public site

The built-in public site is Meridian, an operations portal inspired by Cloudflare's clean layout and Kumo tokens. Its visitor-facing routes are the root, login, optionally registration, public assets and their necessary APIs. Invalid subscription credentials and anonymous workspace requests receive an empty 404. Authenticated requests for known console pages can show a generic path back to the workspace with status 404.

Board embeds a public Vite build and a shared console build using React and Kumo. Console page modules load on demand. Operators can overlay public HTML and assets through `--public-dir`, `YUZUKI_PUBLIC_DIR`, `public_dir` in the configuration, or `./public` at launch, in that order. Individual missing files fall back to the embedded site. The public session API provides sign-in state and the default workspace destination.

## Access control

Accounts created by `board create-admin` are owners. Board assigns the built-in Member role to new regular accounts. Owners have every permission point. Other accounts receive the union of assigned roles, then their account-level Allow or Deny overrides are applied.

Separate permission points govern actions such as reading users, creating users, editing quotas and publishing routing revisions. Navigation and controls use the current session's effective permissions. Board checks the same points on each request, including direct page requests and downloads through previously issued subscription links. Managers can assign only points they hold, and the administration interface protects owner access and direct self-assignment. The audit log records user, credential, quota and role changes.

## Routing and quotas

Each account can keep separately named addresses for the three subscription formats. The default allowance is one link per format. A role can specify an explicit allowance for any format. The highest explicit setting among assigned roles applies, and an account override takes precedence. If the allowance drops, the earliest links remain usable and the rest are paused until a slot becomes available.

Lifetime plans count total transfer. Timed plans have a starting instant and a duration. A one-time plan expires at the end of its window, and a recurring plan starts a new usage window at each multiple of the duration. Usage is attributed by Board receipt time. Lifetime totals keep accumulating across windows, and the current window controls subscription and node entitlement.

Subscription-device limits apply to identities observed when a client refreshes its configuration. Board gives priority to a client device identifier and falls back to the requesting socket address and user agent. A successful refresh occupies or renews its slot for 30 days. Releasing a slot allows another client to use it. The dashboard also displays online source counts from supported Xray and dedicated Mihomo instances. Devices sharing one source address count once per account. Stock sing-box does not expose that attribution.

Policies combine ordered exact-domain, domain-suffix and CIDR rules with an explicit default action. Advanced policy fields are configured as structured overlays or native fragments per target core. The panel supports saving a draft, testing common rules against a destination, publishing a revision and restoring an earlier revision.

Quotas count cumulative upload plus download bytes. A missing limit is unlimited and a limit of zero grants no allowance. A suspended or exhausted account loses subscription access and is removed from Node's next managed configuration. Account binding depends on the server template. A template with a fixed shared credential remains a shared endpoint.

Enforcement is periodic. Node samples the core, durably queues usage and receives a new configuration. A disconnected Node stops its managed instances after the control lease expires.
