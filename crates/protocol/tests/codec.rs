use yuzuki_protocol::{codec, v1::BoardMessage};

#[test]
fn snapshot_round_trips_with_tagged_meter() {
    use serde_json::json;
    use uuid::Uuid;
    use yuzuki_protocol::{
        Core,
        v1::{Instance, Meter, Snapshot},
    };

    let snapshot = Snapshot {
        revision: "revision".into(),
        instances: vec![Instance {
            id: Uuid::new_v4(),
            core: Core::Mihomo,
            config: json!({"listeners":[]}),
            meter: Some(Meter::DedicatedTraffic {
                addr: "127.0.0.1:9090".parse().unwrap(),
                access_id: Uuid::new_v4(),
                secret: "testing".into(),
            }),
        }],
    };
    let frame = codec::encode(&BoardMessage::Snapshot(snapshot.clone())).unwrap();
    let BoardMessage::Snapshot(decoded) = codec::decode(&frame).unwrap() else {
        panic!("expected snapshot")
    };
    assert_eq!(decoded, snapshot);
}

#[test]
fn rejects_extra_messages_in_a_frame() {
    let message = BoardMessage::Lease { seconds: 60 };
    let mut frame = codec::encode(&message).unwrap();
    assert!(matches!(
        codec::decode(&frame).unwrap(),
        BoardMessage::Lease { seconds: 60 }
    ));
    frame.push(0);
    assert!(codec::decode::<BoardMessage>(&frame).is_err());
}

#[test]
fn welcome_and_online_sources_round_trip() {
    use uuid::Uuid;
    use yuzuki_protocol::v1::{InstanceDevices, NodeMessage, OnlineSource};

    let session = Uuid::new_v4();
    let frame = codec::encode(&BoardMessage::Welcome {
        session,
        lease_seconds: 30,
        online_devices: [13; 32],
    })
    .unwrap();
    let BoardMessage::Welcome {
        session: decoded_session,
        lease_seconds,
        online_devices,
    } = codec::decode(&frame).unwrap()
    else {
        panic!("expected welcome");
    };
    assert_eq!(decoded_session, session);
    assert_eq!(lease_seconds, 30);
    assert_eq!(online_devices, [13; 32]);

    let instances = vec![InstanceDevices {
        instance_id: Uuid::new_v4(),
        sources: vec![OnlineSource {
            access_id: Uuid::new_v4(),
            source: [23; 32],
        }],
    }];
    let frame = codec::encode(&NodeMessage::Devices { instances }).unwrap();
    let NodeMessage::Devices { instances } = codec::decode(&frame).unwrap() else {
        panic!("expected online sources");
    };
    assert_eq!(instances[0].sources[0].source, [23; 32]);
}

#[test]
fn core_actions_and_capabilities_round_trip() {
    use uuid::Uuid;
    use yuzuki_protocol::{
        Core,
        v1::{
            Capability, CoreAction, CoreActionRequest, CoreActionStage, CoreSource, HostInfo,
            NodeMessage,
        },
    };

    let req = CoreActionRequest {
        request_id: Uuid::new_v4(),
        core: Some(Core::Xray),
        action: CoreAction::Install {
            version: "26.11.9".into(),
            download_url: Some("https://example.net/xray.zip".into()),
            sha256: Some("abc123".into()),
        },
    };
    let frame = codec::encode(&BoardMessage::CoreAction(req.clone())).unwrap();
    let BoardMessage::CoreAction(decoded) = codec::decode(&frame).unwrap() else {
        panic!("expected core action")
    };
    assert_eq!(decoded, req);

    let host = HostInfo {
        os: "linux".into(),
        arch: "amd64".into(),
        core_management: true,
    };
    let cap = Capability {
        core: Core::SingBox,
        version: "sing-box version 1.14.4".into(),
        source: CoreSource::Managed,
        path: Some("/var/lib/yuzuki-node/cores/sing-box/sing-box".into()),
    };
    let result = NodeMessage::CoreActionResult {
        request_id: req.request_id,
        core: Some(Core::SingBox),
        ok: true,
        version: Some("1.14.4".into()),
        error: None,
        capabilities: vec![cap.clone()],
        host: host.clone(),
    };
    let frame = codec::encode(&result).unwrap();
    let NodeMessage::CoreActionResult {
        request_id,
        core,
        ok,
        version,
        error,
        capabilities,
        host: decoded_host,
    } = codec::decode(&frame).unwrap()
    else {
        panic!("expected core action result")
    };
    assert_eq!(request_id, req.request_id);
    assert_eq!(core, Some(Core::SingBox));
    assert!(ok);
    assert_eq!(version.as_deref(), Some("1.14.4"));
    assert_eq!(error, None);
    assert_eq!(capabilities, vec![cap]);
    assert_eq!(decoded_host, host);

    let progress = NodeMessage::CoreActionProgress {
        request_id: req.request_id,
        core: Some(Core::Mihomo),
        stage: CoreActionStage::Downloading,
        message: "downloading".into(),
    };
    let frame = codec::encode(&progress).unwrap();
    assert!(matches!(
        codec::decode::<NodeMessage>(&frame).unwrap(),
        NodeMessage::CoreActionProgress {
            stage: CoreActionStage::Downloading,
            ..
        }
    ));
}

#[test]
fn runtime_status_config_warnings_and_disconnect_round_trip() {
    use uuid::Uuid;
    use yuzuki_protocol::v1::{BoardMessage, InstanceState, NodeMessage, RuntimeStatus};

    let hello = NodeMessage::Hello {
        capabilities: vec![],
        applied: Some("rev-1".into()),
        host: None,
        config_warnings: vec!["Ignored unknown key `legacy`".into()],
    };
    let frame = codec::encode(&hello).unwrap();
    let NodeMessage::Hello {
        config_warnings, ..
    } = codec::decode(&frame).unwrap()
    else {
        panic!("expected hello")
    };
    assert_eq!(config_warnings, vec!["Ignored unknown key `legacy`"]);

    let status = RuntimeStatus {
        instance_id: Uuid::new_v4(),
        running: false,
        state: InstanceState::MissingCore,
        error: Some("sing-box binary is not installed".into()),
    };
    let applied = NodeMessage::Applied {
        revision: "rev-2".into(),
        instances: vec![status.clone()],
    };
    let frame = codec::encode(&applied).unwrap();
    let NodeMessage::Applied {
        revision,
        instances,
    } = codec::decode(&frame).unwrap()
    else {
        panic!("expected applied")
    };
    assert_eq!(revision, "rev-2");
    assert_eq!(instances, vec![status]);

    let disc = BoardMessage::Disconnect {
        reason: "server deleted".into(),
    };
    let frame = codec::encode(&disc).unwrap();
    let BoardMessage::Disconnect { reason } = codec::decode(&frame).unwrap() else {
        panic!("expected disconnect")
    };
    assert_eq!(reason, "server deleted");
}
