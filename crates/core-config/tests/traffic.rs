use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, UdpSocket},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use uuid::Uuid;
use yuzuki_core_config::{Core, cores::Registry, protocols::Endpoint, routing::Policy, templates};

const USER: &str = "bcecbca2-854e-4e5e-a79c-80fb9ad9aa13";
const TEST_BODY: &str = "Yuzuki protocol probe";
const SALAMANDER: &str = "fixture-salamander-password";

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Process {
    child: Child,
    log: PathBuf,
}
impl Process {
    fn start(binary: &str, core: Core, root: &Path, config: &Path, log: PathBuf) -> Self {
        let output = File::create(&log).unwrap();
        let mut command = Command::new(binary);
        match core {
            Core::Xray => command.arg("run").arg("-config").arg(config),
            Core::SingBox => command.arg("run").arg("-c").arg(config),
            Core::Mihomo => command.arg("-d").arg(root).arg("-f").arg(config),
        };
        let child = command
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap();
        Self { child, log }
    }

    fn status(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().unwrap()
    }

    fn output(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct ProbeServer {
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<()>>,
    port: u16,
}
impl ProbeServer {
    fn start() -> Self {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        server.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let pending = stop.clone();
        let task = thread::spawn(move || {
            while !pending.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = server.accept() else {
                    thread::sleep(Duration::from_millis(15));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(300)))
                    .unwrap();
                let mut buffer = [0; 1024];
                let _ = stream.read(&mut buffer);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{TEST_BODY}",
                    TEST_BODY.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Self {
            stop,
            task: Some(task),
            port,
        }
    }
}
impl Drop for ProbeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}

fn openssl(root: &Path, args: &[&str]) -> String {
    let result = Command::new("openssl")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "openssl: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

struct TestCertificate {
    certificate: PathBuf,
    key: PathBuf,
    fingerprint: String,
}

fn test_certificate(root: &Path) -> TestCertificate {
    openssl(
        root,
        &[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-keyout",
            "server.key",
            "-out",
            "server.crt",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
    );
    let fingerprint = openssl(
        root,
        &[
            "x509",
            "-in",
            "server.crt",
            "-noout",
            "-sha256",
            "-fingerprint",
        ],
    );
    TestCertificate {
        certificate: root.join("server.crt"),
        key: root.join("server.key"),
        fingerprint: fingerprint
            .split_once('=')
            .unwrap()
            .1
            .trim()
            .replace(':', ""),
    }
}

fn write_config(file: &Path, config: Value) {
    fs::write(file, serde_json::to_vec(&config).unwrap()).unwrap();
}

fn hysteria_listener(
    core: Core,
    port: u16,
    certificate: &TestCertificate,
    backend: u16,
    salamander: bool,
) -> Value {
    let key = &certificate.key;
    let cert = &certificate.certificate;
    let listener = match core {
        Core::Xray => {
            let mut config = json!({
                "inbounds":[{"protocol":"hysteria","listen":"127.0.0.1","port":port,
                    "settings":{"version":2,"users":{"$yuzuki_users":{"auth":"$yuzuki_access_id","email":"$yuzuki_access_id"}}},
                    "streamSettings":{"network":"hysteria","security":"tls","hysteriaSettings":{"version":2},
                        "tlsSettings":{"alpn":["h3"],"certificates":[{"certificateFile":cert,"keyFile":key}]}}}],
                "outbounds":[{"protocol":"freedom","settings":{"finalRules":[
                    {"action":"allow","network":"tcp","ip":["127.0.0.1/32"],"port":backend}]}}]
            });
            if salamander {
                config["inbounds"][0]["streamSettings"]["finalmask"] =
                    json!({"udp":[{"type":"salamander","settings":{"password":SALAMANDER}}]});
            }
            config
        }
        Core::SingBox => {
            let mut config = json!({"inbounds":[{
                "type":"hysteria2","listen":"127.0.0.1","listen_port":port,
                "users":{"$yuzuki_users":{"name":"$yuzuki_access_id","password":"$yuzuki_access_id"}},
                "tls":{"enabled":true,"certificate_path":cert,"key_path":key,"alpn":["h3"]}
            }],"outbounds":[{"type":"direct"}]});
            if salamander {
                config["inbounds"][0]["obfs"] = json!({"type":"salamander","password":SALAMANDER});
            }
            config
        }
        Core::Mihomo => {
            let mut config = json!({"listeners":[{
                "type":"hysteria2","name":"managed","listen":"127.0.0.1","port":port,
                "users":{"$yuzuki_user_map":"$yuzuki_access_id"},
                "certificate":fs::read_to_string(cert).unwrap(),"private-key":fs::read_to_string(key).unwrap(),
                "alpn":["h3"]
            }]});
            if salamander {
                config["listeners"][0]["obfs"] = json!("salamander");
                config["listeners"][0]["obfs-password"] = json!(SALAMANDER);
            }
            config
        }
    };
    templates::server(&listener, &[USER.into()]).unwrap()
}

fn hysteria_document(
    core: Core,
    port: u16,
    socks: u16,
    cert: &TestCertificate,
    salamander: bool,
) -> Value {
    let mut description =
        json!({"protocol":"hysteria2","host":"127.0.0.1","port":port,"server_name":"localhost"});
    if salamander {
        description["options"] = json!({"kind":"hysteria2","obfs_password":SALAMANDER});
    }
    let endpoint: Endpoint = serde_json::from_value(json!({"portable":description})).unwrap();
    endpoint.validate().unwrap();
    let outbound = endpoint.resolve(core, "tunnel", USER).unwrap().unwrap();
    let mut document = Registry::builtins()
        .render(core, &[outbound], &Policy::default())
        .unwrap();
    match core {
        Core::Xray => {
            document["inbounds"][0]["port"] = json!(socks);
            document["outbounds"][2]["streamSettings"]["tlsSettings"]["certificates"] =
                json!([{"certificateFile":cert.certificate,"usage":"verify"}]);
        }
        Core::SingBox => {
            document["inbounds"][0]["listen_port"] = json!(socks);
            document["outbounds"][1]["tls"]["certificate_path"] = json!(cert.certificate);
        }
        Core::Mihomo => {
            document["mixed-port"] = json!(socks);
            document["proxies"][0]["fingerprint"] = json!(cert.fingerprint);
        }
    }
    document
}

#[test]
fn hysteria2_real_process_matrix() {
    let binaries = Core::ALL
        .into_iter()
        .zip(["YUZUKI_XRAY", "YUZUKI_SING_BOX", "YUZUKI_MIHOMO"])
        .filter_map(|(core, variable)| Some((core, std::env::var(variable).ok()?)))
        .collect::<Vec<_>>();
    if binaries.len() != Core::ALL.len() {
        return;
    }
    let root = TempDir(std::env::temp_dir().join(format!("yuzuki-hysteria-{}", Uuid::new_v4())));
    fs::create_dir(&root.0).unwrap();
    let cert = test_certificate(&root.0);
    let probe = ProbeServer::start();
    for salamander in [false, true] {
        for (server_core, server_bin) in &binaries {
            let port = UdpSocket::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let server_file = root.0.join("server.json");
            let server_directory = root.0.join("server");
            fs::create_dir_all(&server_directory).unwrap();
            write_config(
                &server_file,
                hysteria_listener(*server_core, port, &cert, probe.port, salamander),
            );
            let mut server = Process::start(
                server_bin,
                *server_core,
                &server_directory,
                &server_file,
                root.0.join("server.log"),
            );
            for (client_core, client_bin) in &binaries {
                let socks = TcpListener::bind("127.0.0.1:0")
                    .unwrap()
                    .local_addr()
                    .unwrap()
                    .port();
                let client_file = root.0.join("client.json");
                let client_directory = root.0.join(format!("client-{client_core}"));
                fs::create_dir_all(&client_directory).unwrap();
                write_config(
                    &client_file,
                    hysteria_document(*client_core, port, socks, &cert, salamander),
                );
                let mut client = Process::start(
                    client_bin,
                    *client_core,
                    &client_directory,
                    &client_file,
                    root.0.join("client.log"),
                );
                let mut success = false;
                let mut last_error = String::new();
                for _ in 0..8 {
                    if server.status().is_some() || client.status().is_some() {
                        break;
                    }
                    let result = Command::new("curl")
                        .args([
                            "--silent",
                            "--show-error",
                            "--fail",
                            "--noproxy",
                            "",
                            "--max-time",
                            "1",
                            "--socks5",
                            &format!("127.0.0.1:{socks}"),
                            &format!("http://127.0.0.1:{}", probe.port),
                        ])
                        .output()
                        .unwrap();
                    if result.status.success() && result.stdout == TEST_BODY.as_bytes() {
                        success = true;
                        break;
                    }
                    last_error = String::from_utf8_lossy(&result.stderr).into_owned();
                    thread::sleep(Duration::from_millis(80));
                }
                assert!(
                    success,
                    "{client_core} → {server_core} (Salamander={salamander})\nServer\n{}\nClient\n{}\n{last_error}",
                    server.output(),
                    client.output()
                );
                eprintln!("{client_core} → {server_core} (Salamander={salamander})");
            }
        }
    }
}
