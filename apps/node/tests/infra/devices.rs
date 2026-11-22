use std::{
    net::{SocketAddr, TcpListener as Port},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

use node::{infra::metering::NativeCollector, services::metering::ports::UsageCollector};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use uuid::Uuid;
use yuzuki_protocol::{
    Core,
    v1::{Instance, Meter, OnlineSource},
};

const ACCOUNT: &str = "6b105741-68cb-4c9f-8054-2f194d836d02";
const SECRET: &str = "fixture-controller-secret";
const KEY: [u8; 32] = [194; 32];

struct FixturePath(PathBuf);
impl FixturePath {
    fn create() -> Self {
        let path = std::env::temp_dir().join(format!("yuzuki-sources-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for FixturePath {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Process(Child);
impl Process {
    fn launch(binary: &str, core: Core, folder: &Path, name: &str, config: &Value) -> Self {
        let file = folder.join(name);
        std::fs::write(&file, serde_json::to_vec(config).unwrap()).unwrap();
        let mut command = Command::new(binary);
        match core {
            Core::Xray => command.arg("run").arg("-config").arg(file),
            Core::Mihomo => command.arg("-d").arg(folder).arg("-f").arg(file),
            Core::SingBox => unreachable!(),
        };
        Self(
            command
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn address() -> SocketAddr {
    Port::bind("127.0.0.1:0").unwrap().local_addr().unwrap()
}

async fn when_listening(addr: SocketAddr, label: &str) -> TcpStream {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(stream) = TcpStream::connect(addr).await {
                return stream;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{label} did not start on {addr}"))
}

async fn measured_source(xray: &str, binary: &str, core: Core) -> OnlineSource {
    let fixture = FixturePath::create();
    let public = address();
    let controller = address();
    let local = address();
    let account: Uuid = ACCOUNT.parse().unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend = target.local_addr().unwrap();
    let (meter, config) = match core {
        Core::Xray => (
            Meter::UserStats { addr: controller },
            json!({
                "inbounds":[{"protocol":"vless","listen":"127.0.0.1","port":public.port(),
                    "settings":{"decryption":"none","clients":[{"email":ACCOUNT,"id":ACCOUNT}]}}],
                "outbounds":[{"protocol":"freedom","settings":{"finalRules":[
                    {"action":"allow","network":"tcp","ip":["127.0.0.1/32"],"port":backend.port()}]}}],
                "api":{"tag":"api","listen":controller.to_string(),"services":["StatsService"]},
                "stats":{},"policy":{"levels":{"0":{"statsUserOnline":true}}}
            }),
        ),
        Core::Mihomo => (
            Meter::DedicatedTraffic {
                addr: controller,
                access_id: account,
                secret: SECRET.into(),
            },
            json!({
                "external-controller":controller.to_string(),"secret":SECRET,
                "listeners":[{"type":"vless","name":"fixture","listen":"127.0.0.1","port":public.port(),
                    "allow-insecure":true,"users":[{"username":ACCOUNT,"uuid":ACCOUNT}]}],
            }),
        ),
        Core::SingBox => unreachable!(),
    };

    let server = Process::launch(binary, core, &fixture.0, "server.json", &config);
    drop(when_listening(public, &format!("{core} listener")).await);
    drop(when_listening(controller, &format!("{core} statistics controller")).await);
    // Xray's online map excludes the exact address 127.0.0.1.
    let outbound = json!({"inbounds":[{"protocol":"http","port":local.port(),"listen":"127.0.0.1"}],
    "outbounds":[{"protocol":"vless","sendThrough":"127.0.0.2","settings":{"vnext":[
        {"address":"127.0.0.1","port":public.port(),"users":[{"id":ACCOUNT,"encryption":"none"}]}
    ]}}]});
    let client = Process::launch(xray, Core::Xray, &fixture.0, "client.json", &outbound);
    let mut stream = when_listening(local, "test client").await;
    stream
        .write_all(format!("CONNECT {backend} HTTP/1.1\r\nHost: {backend}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut handshake = [0u8; 128];
    let received = stream.read(&mut handshake).await.unwrap();
    assert!(String::from_utf8_lossy(&handshake[..received]).contains("200"));
    stream.write_all(b"online fixture").await.unwrap();
    let (mut destination, _) = tokio::time::timeout(Duration::from_secs(3), target.accept())
        .await
        .unwrap_or_else(|_| panic!("{core} did not reach the probe destination"))
        .unwrap();
    let mut bytes = [0u8; 14];
    destination.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"online fixture");

    let instance = Instance {
        id: Uuid::new_v4(),
        core,
        config,
        meter: Some(meter),
    };
    let collector = NativeCollector::new().unwrap();
    let active = collector.online(&instance, &KEY).await.unwrap().unwrap();
    assert_eq!(active.len(), 1, "{core} online source coverage");
    assert_eq!(active[0].access_id, account);
    let rotated = collector
        .online(&instance, &[7; 32])
        .await
        .unwrap()
        .unwrap();
    assert_ne!(active[0].source, rotated[0].source);

    drop(destination);
    drop(stream);
    for _ in 0..50 {
        if collector
            .online(&instance, &KEY)
            .await
            .unwrap()
            .unwrap()
            .is_empty()
        {
            return active.into_iter().next().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop((client, server));
    panic!("{core} did not remove its closed connection");
}

#[tokio::test]
async fn pinned_native_stats_observe_the_same_authenticated_source() {
    let (Ok(xray), Ok(mihomo)) = (std::env::var("YUZUKI_XRAY"), std::env::var("YUZUKI_MIHOMO"))
    else {
        return;
    };
    let observed = tokio::time::timeout(Duration::from_secs(14), async {
        let from_xray = measured_source(&xray, &xray, Core::Xray).await;
        let from_mihomo = measured_source(&xray, &mihomo, Core::Mihomo).await;
        assert_eq!(from_xray, from_mihomo);
    })
    .await;
    assert!(observed.is_ok(), "native source test timed out");
}

#[tokio::test]
async fn disabled_or_unattributable_collectors_do_not_report_measured_zero() {
    let collector = NativeCollector::new().unwrap();
    let mut instance = Instance {
        id: Uuid::new_v4(),
        core: Core::Xray,
        meter: Some(Meter::UserStats { addr: address() }),
        config: json!({}),
    };
    assert!(collector.online(&instance, &KEY).await.unwrap().is_none());
    instance.core = Core::SingBox;
    instance.config = json!({"experimental":{"v2ray_api":{"listen":"127.0.0.1:1234"}}});
    assert!(collector.online(&instance, &KEY).await.unwrap().is_none());
}
