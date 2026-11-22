use std::path::Path;

use node::{infra::sqlite::Outbox, services::metering::Reading};
use uuid::Uuid;

#[test]
fn retries_keep_event_ids_and_reset_counters_start_at_zero() {
    let mut outbox = Outbox::open(Path::new(":memory:")).unwrap();
    let (instance, epoch, access_id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    outbox
        .sample(
            instance,
            epoch,
            &[Reading {
                access_id,
                uploaded: 30,
                downloaded: 10,
            }],
        )
        .unwrap();
    let events = outbox.pending().unwrap();
    assert_eq!(events, outbox.pending().unwrap());
    outbox.acknowledge(&[events[0].event_id]).unwrap();
    outbox
        .sample(
            instance,
            epoch,
            &[Reading {
                access_id,
                uploaded: 34,
                downloaded: 12,
            }],
        )
        .unwrap();
    outbox
        .sample(
            instance,
            Uuid::new_v4(),
            &[Reading {
                access_id,
                uploaded: 3,
                downloaded: 2,
            }],
        )
        .unwrap();
    let events = outbox.pending().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.uploaded)
            .collect::<Vec<_>>(),
        [4, 3]
    );
}
