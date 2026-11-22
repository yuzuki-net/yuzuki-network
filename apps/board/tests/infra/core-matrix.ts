// Optional process-level integration test. Use a fresh, disposable PostgreSQL database.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const database = process.env.YUZUKI_MATRIX_DATABASE_URL;
if (!database) throw Error("Set YUZUKI_MATRIX_DATABASE_URL to an empty test database");
const root = await mkdtemp(join(tmpdir(), "yuzuki-matrix-"));
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
const board = join(target, "board");
const node = join(target, "node");
const cores = {
  xray: process.env.YUZUKI_XRAY ?? "xray",
  "sing-box": process.env.YUZUKI_SING_BOX ?? "sing-box",
  mihomo: process.env.YUZUKI_MIHOMO ?? "mihomo",
};
type Core = keyof typeof cores;
const names = Object.keys(cores) as Core[];
const ports = {
  board: 39851, control: 39852, api: 39853,
  xray: 39854, "sing-box": 39855, mihomo: 39856, meter: 39857, client: 39858,
  mihomoMeter: 39859, singBoxMeter: 39860,
};
const singBoxStats = process.env.YUZUKI_MATRIX_SING_BOX_STATS === "1";
const holdSeconds = Number(process.env.YUZUKI_MATRIX_HOLD_SECONDS ?? "0");
const processes: ReturnType<typeof Bun.spawn>[] = [];
const session = { "content-type": "application/json", "x-workspace-request": "1", cookie: "" };
const origin = `http://127.0.0.1:${ports.board}`;
const out = Bun.serve({
  port: ports.api, hostname: "127.0.0.1",
  fetch(request) {
    if (new URL(request.url).pathname !== "/active") return new Response("matrix-pass");
    const chunk = new TextEncoder().encode("active\n");
    let timer: Timer | undefined;
    const body = new ReadableStream({
      start(controller) { timer = setInterval(() => controller.enqueue(chunk), 250); },
      cancel() { clearInterval(timer); },
    });
    return new Response(body);
  },
});

function assert(value: unknown, description: string) {
  if (!value) throw Error(description);
}

function execute(command: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(command, { cwd: root, env, stderr: "pipe", stdout: "pipe" });
  if (!result.success) throw Error(`${command[0]} exited ${result.exitCode}\n${result.stderr.toString()}\n${result.stdout.toString()}`);
  return result.stdout.toString();
}

function spawn(command: string[]) {
  const process = Bun.spawn(command, {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, RUST_LOG: "warn", SSL_CERT_FILE: join(root, "ca.crt") },
  });
  processes.push(process);
  return process;
}

async function eventually(test: () => Promise<boolean>, message: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test().catch(() => false)) return;
    await Bun.sleep(300);
  }
  throw Error(message);
}

async function api(path: string, method = "GET", input?: unknown) {
  const response = await fetch(origin + path, { method, headers: session, body: input === undefined ? undefined : JSON.stringify(input) });
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

try {
  execute(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-days", "2",
    "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Yuzuki Test CA"]);
  execute(["openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc",
    "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1"]);
  await writeFile(join(root, "extensions"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
  execute(["openssl", "x509", "-req", "-days", "2", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-extfile", "extensions", "-out", "server.crt"]);
  const serverPem = await readFile(join(root, "server.crt"), "utf8");
  const keyPem = await readFile(join(root, "server.key"), "utf8");
  const fingerprint = execute(["openssl", "x509", "-in", "server.crt", "-noout", "-fingerprint", "-sha256"])
    .trim().split("=")[1].replaceAll(":", "");

  await writeFile(join(root, "board.toml"), `database_url = ${JSON.stringify(database)}
bind = "127.0.0.1:${ports.board}"
secure_cookies = false
[control]
bind = "127.0.0.1:${ports.control}"
certificate = "server.crt"
private_key = "server.key"
node_ca_certificate = "ca.crt"
node_ca_key = "ca.key"
`);
  await writeFile(join(root, "node.toml"), `board_url = "https://127.0.0.1:${ports.control}"
ca_certificate = "ca.crt"
state_dir = "node-state"
[binaries]
${names.map((core) => `${core} = ${JSON.stringify(cores[core])}`).join("\n")}
`);
  const email = "matrix@example.net";
  const password = "integration-matrix-password";
  execute([board, "--config", "board.toml", "create-admin", "--email", email], { ...process.env, YUZUKI_ADMIN_PASSWORD: password });
  const accessId = execute(["psql", database, "-Atc", "SELECT access_id FROM accounts WHERE email = 'matrix@example.net'"]).trim();
  assert(accessId.length === 36, "test account has no access ID");

  const boardProcess = spawn([board, "--config", "board.toml", "serve"]);
  await eventually(async () => (await fetch(origin)).ok, "Board did not start");
  const login = await fetch(origin + "/auth/login", { method: "POST", headers: session, body: JSON.stringify({ email, password }) });
  assert(login.status === 204, "login failed");
  session.cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const inventory = await api("/api/v1/admin/nodes", "POST", { name: "matrix", enabled: false, priority: 0, require_all_formats: true });
  const nodePath = `/api/v1/admin/nodes/${inventory.id}`;
  const enrollment = await api(nodePath + "/enrollment", "POST");
  execute([node, "--config", "node.toml", "enroll"], { ...process.env, YUZUKI_ENROLLMENT_TOKEN: enrollment.token });

  const inbound = (core: Core) => {
    const bind = "127.0.0.1";
    const port = ports[core];
    const id = "$yuzuki_access_id";
    const certificate = join(root, "server.crt");
    const key = join(root, "server.key");
    if (core === "xray") return {
      api: { tag: "api", listen: `127.0.0.1:${ports.meter}`, services: ["StatsService"] },
      stats: {},
      policy: { levels: { "0": { statsUserUplink: true, statsUserDownlink: true, statsUserOnline: true } } },
      inbounds: [{
        protocol: "vless", listen: bind, port,
        settings: { decryption: "none", clients: { $yuzuki_users: { id, email: id } } },
        streamSettings: { security: "tls", tlsSettings: { certificates: [{ certificateFile: certificate, keyFile: key }] } },
      }],
      outbounds: [{ protocol: "freedom", settings: {
        finalRules: [{ action: "allow", network: "tcp", ip: ["127.0.0.1/32"], port: ports.api }],
      } }],
    };
    if (core === "sing-box") return {
      inbounds: [{
        type: "vless", listen: bind, listen_port: port, users: { $yuzuki_users: { name: id, uuid: id } },
        tls: { enabled: true, certificate_path: certificate, key_path: key },
      }],
      outbounds: [{ type: "direct" }],
      ...(singBoxStats ? { experimental: { v2ray_api: {
        listen: `127.0.0.1:${ports.singBoxMeter}`,
        stats: { enabled: true, users: { $yuzuki_users: id } },
      } } } : {}),
    };
    return {
      "external-controller": `127.0.0.1:${ports.mihomoMeter}`,
      secret: "matrix-mihomo-stats",
      listeners: [{
        name: "vless", type: "vless", listen: bind, port, users: { $yuzuki_users: { username: id, uuid: id } },
        certificate: serverPem, "private-key": keyPem,
      }],
    };
  };

  const endpointTags = new Map<Core, string>();
  const metered = new Map<Core, string>();
  const meters = {
    xray: { kind: "user_stats", addr: `127.0.0.1:${ports.meter}` },
    "sing-box": singBoxStats ? { kind: "user_stats", addr: `127.0.0.1:${ports.singBoxMeter}` } : null,
    mihomo: { kind: "dedicated_traffic", addr: `127.0.0.1:${ports.mihomoMeter}`, access_id: accessId, secret: "matrix-mihomo-stats" },
  };
  for (const core of names) {
    const instance = await api(nodePath + "/instances", "POST", {
      name: core, core, config: inbound(core), enabled: true, meter: meters[core],
    });
    if (meters[core]) metered.set(core, instance.id);
    const endpoint = await api(`/api/v1/admin/instances/${instance.id}/endpoints`, "POST", {
      name: core, enabled: true, spec: { portable: { protocol: "vless", host: "127.0.0.1", port: ports[core], server_name: "localhost" } },
    });
    endpointTags.set(core, `matrix · ${core}`);
  }

  await api(nodePath, "PUT", { name: "matrix", enabled: true, priority: 0, require_all_formats: true });
  const agent = spawn([node, "--config", "node.toml", "run"]);
  await eventually(async () => (await api("/api/v1/admin/nodes"))[0]?.applied_revision, "Node did not apply the three server configs");
  await eventually(async () => {
    const [entry] = await api("/api/v1/admin/nodes");
    return entry.agent_session && entry.capabilities.length === names.length &&
      entry.runtime_status?.length === names.length && entry.runtime_status.every((status: { running: boolean }) => status.running);
  }, "Board did not receive the running status for all three server cores");
  console.log("Verified installed core versions and runtime reports");
  const originalRevision = (await api("/api/v1/admin/nodes"))[0].applied_revision;
  const subscriptions = await Promise.all(names.map((name, format) =>
    api("/api/v1/me/subscriptions", "POST", { name, format })));
  const observed = async () => (await api("/api/v1/admin/dashboard?range=1h")).infrastructure.presence;
  await eventually(async () => {
    const metrics = await observed();
    return metrics.active_instances === 3 && metrics.measured_instances === 2 && metrics.sources === 0;
  }, "Board did not report Xray and Mihomo coverage with zero active sources");

  for (const [format, core] of names.entries()) {
    const response = await fetch(`${origin}${subscriptions[format].path}`);
    assert(response.ok, `subscription ${format} failed`);
    const data = await response.text();
    for (const tag of endpointTags.values()) assert(data.includes(tag), `missing ${tag} in format ${format}`);
    const template = core === "mihomo" ? Bun.YAML.parse(data) : JSON.parse(data);
    for (const [source, tag] of endpointTags) {
      const config = structuredClone(template);
      let filename = "client.json";
      let command: string[];
      let check: string[];
      if (core === "xray") {
        config.inbounds[0].port = ports.client;
        config.routing.rules.at(-1).outboundTag = tag;
        delete config.routing.rules.at(-1).balancerTag;
        for (const outbound of config.outbounds) {
          if (outbound.streamSettings?.tlsSettings) {
            outbound.streamSettings.tlsSettings.certificates = [{ certificateFile: join(root, "ca.crt"), usage: "verify" }];
            // The Xray statistics service excludes the exact address 127.0.0.1.
            outbound.sendThrough = "127.0.0.2";
          }
        }
        command = [cores[core], "run", "-config", filename];
        check = [cores[core], "run", "-test", "-config", filename];
      } else if (core === "sing-box") {
        config.inbounds[0].listen_port = ports.client;
        config.outbounds.find((entry: { type: string }) => entry.type === "selector").default = tag;
        for (const outbound of config.outbounds) {
          if (outbound.tls) outbound.tls.certificate_path = join(root, "ca.crt");
        }
        command = [cores[core], "run", "-c", filename];
        check = [cores[core], "check", "-c", filename];
      } else {
        filename = "client.yaml";
        config["mixed-port"] = ports.client;
        config["proxy-groups"][0].proxies = [tag];
        for (const proxy of config.proxies) proxy.fingerprint = fingerprint;
        command = [cores[core], "-d", root, "-f", filename];
        check = [cores[core], "-t", "-d", root, "-f", filename];
      }
      // JSON is valid YAML and preserves the mihomo values yielded by the native subscription.
      await writeFile(join(root, filename), JSON.stringify(config));
      execute(check);
      const client = spawn(command);
      try {
        await eventually(async () => {
          const result = await Bun.$`curl --silent --fail --noproxy "" --socks5 ${`127.0.0.1:${ports.client}`} --max-time 2 ${`http://127.0.0.1:${ports.api}/probe`}`.quiet().nothrow();
          return result.exitCode === 0 && result.text() === "matrix-pass";
        }, `connection failed for format ${core} to server ${source}`);
        console.log(`Verified ${core} -> ${source}`);
        if (core === "xray" && (source === "xray" || source === "mihomo")) {
          const hold = source === "xray" && Number.isInteger(holdSeconds) && holdSeconds > 0 ? Math.min(holdSeconds, 1_800) : 0;
          const stream = Bun.spawn([
            "curl", "--silent", "--noproxy", "", "--socks5", `127.0.0.1:${ports.client}`,
            "--max-time", String(25 + hold), `http://127.0.0.1:${ports.api}/active`,
          ], { stdout: "ignore", stderr: "ignore" });
          try {
            await eventually(async () => (await observed()).sources === 1, `${source} source was not reported to Board`);
            assert(stream.exitCode === null, `${source} test stream closed before the sample`);
            if (hold) {
              const initial = (await api("/api/v1/admin/dashboard?range=1h")).infrastructure.totals;
              const stopAt = Date.now() + hold * 1_000;
              let samples = 0;
              while (Date.now() < stopAt) {
                await Bun.sleep(Math.min(5_000, stopAt - Date.now()));
                assert(stream.exitCode === null && (await observed()).sources === 1, "long-lived connection lost its source report");
                samples++;
              }
              const current = (await api("/api/v1/admin/dashboard?range=1h")).infrastructure.totals;
              assert(BigInt(current.downloaded) > BigInt(initial.downloaded), "long-lived connection did not update transfer totals");
              console.log(`Verified ${samples} consecutive source samples and increasing counters over ${hold}s`);
            }
          } finally {
            stream.kill();
            await stream.exited;
          }
          await eventually(async () => (await observed()).sources === 0, `${source} source did not retire after disconnect`);
          console.log(`Verified ${source} live source reporting and removal`);
        }
      } finally {
        client.kill();
        await client.exited;
      }
    }
  }
  for (const [core, instance] of metered) {
    await eventually(async () => {
      const usage = await api(`/api/v1/admin/instances/${instance}/usage`);
      return Number(usage.uploaded) > 0 && Number(usage.downloaded) > 0;
    }, `${core} traffic was not posted to Board`);
    console.log(`Verified ${core} instance usage`);
  }
  const usage = (await api("/api/v1/admin/dashboard?range=1h")).infrastructure;
  assert(Number(usage.totals.uploaded) > 0 && Number(usage.totals.downloaded) > 0, "dashboard omitted recorded traffic");
  assert(usage.timeseries.some((point: { uploaded: string }) => Number(point.uploaded) > 0), "dashboard series omitted recorded traffic");

  if (process.env.YUZUKI_MATRIX_RESTART === "1") {
    boardProcess.kill("SIGINT");
    await boardProcess.exited;
    const canReach = async () => {
      try {
        const stream = await Bun.connect({ hostname: "127.0.0.1", port: ports.xray, socket: { data() {} } });
        stream.end();
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "ECONNREFUSED") return false;
        throw error;
      }
    };
    assert(await canReach(), "agent discarded a still-valid lease on disconnect");
    await eventually(async () => !await canReach(), "agent did not stop workloads when the lease expired", 70_000);
    spawn([board, "--config", "board.toml", "serve"]);
    await eventually(async () => {
      const [entry] = await api("/api/v1/admin/nodes");
      return entry.agent_session && entry.applied_revision === originalRevision &&
        entry.runtime_status?.length === names.length && entry.runtime_status.every((status: { running: boolean }) => status.running) &&
        await canReach();
    }, "agent failed to reconnect and redeploy after Board restart", 40_000);
    assert(Number((await api("/api/v1/admin/dashboard?range=1h")).infrastructure.totals.downloaded) >= Number(usage.totals.downloaded),
      "restart discarded recorded traffic");
    console.log("Verified disconnected lease expiry, mutual TLS reconnection, re-deployment and persistence across Board restart");
  }

  const account = await api("/api/v1/me");
  await api(`/api/v1/admin/quotas/${account.id}/policy`, "PUT", { quota_bytes: "0", period: null, max_devices: null });
  const expired = await fetch(`${origin}${subscriptions[0].path}`);
  assert(expired.status === 404 && !(await expired.text()), "exhausted account retained its subscription");
  await eventually(async () => {
    const [current] = await api("/api/v1/admin/nodes");
    return current.applied_revision && current.applied_revision !== originalRevision;
  }, "Node did not apply the new quota configuration");
  try {
    const probe = await Bun.connect({
      hostname: "127.0.0.1",
      port: ports.mihomo,
      socket: { data() {} },
    });
    probe.end();
    throw Error("account-bound mihomo listener was left active");
  } catch (error) {
    if ((error as { code?: string }).code !== "ECONNREFUSED") throw error;
  }
  console.log("Verified quota revocation");
  agent.kill("SIGINT");
  await agent.exited;
  await eventually(async () => !(await api("/api/v1/admin/nodes"))[0].agent_session,
    "Board kept a retired agent session active");
  console.log("Verified agent disconnect reporting");
} finally {
  out.stop();
  for (const child of processes.reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    await child.exited;
  }
  await rm(root, { recursive: true, force: true });
}
