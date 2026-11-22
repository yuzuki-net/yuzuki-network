use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct SubscriptionCopy {
    pub remaining_traffic: String,
    pub used_traffic_unlimited: String,
    pub next_reset: String,
    pub expires: String,
    pub no_expiry: String,
    pub unlimited_validity: String,
    pub website: String,
    pub group_name: String,
}

macro_rules! catalog {
    ($locale:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/src/i18n/locales/",
            $locale,
            "/subscription-info.json"
        ))
    };
}

static CATALOGS: LazyLock<[(&str, SubscriptionCopy); 5]> = LazyLock::new(|| {
    [
        ("en", catalog!("en")),
        ("zh-CN", catalog!("zh-CN")),
        ("ja", catalog!("ja")),
        ("ru", catalog!("ru")),
        ("fa", catalog!("fa")),
    ]
    .map(|(locale, json)| {
        let copy = serde_json::from_str(json).expect("invalid embedded subscription copy");
        (locale, copy)
    })
});

pub(super) fn for_locale(account: Option<&str>, site: Option<&str>) -> &'static SubscriptionCopy {
    [account, site, Some("en")]
        .into_iter()
        .flatten()
        .find_map(|locale| {
            CATALOGS
                .iter()
                .find_map(|(code, copy)| (*code == locale).then_some(copy))
        })
        .expect("English subscription copy is embedded")
}
