use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! permissions {
    ($($variant:ident => ($key:literal, $group:literal, $label:literal)),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
        pub enum Permission {
            $(#[serde(rename = $key)] $variant,)+
        }

        impl Permission {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];
            pub const fn key(self) -> &'static str {
                match self { $(Self::$variant => $key,)+ }
            }

            pub fn parse(key: &str) -> Option<Self> {
                match key { $($key => Some(Self::$variant),)+ _ => None }
            }

            pub const fn group(self) -> &'static str {
                match self { $(Self::$variant => $group,)+ }
            }

            pub const fn label(self) -> &'static str {
                match self { $(Self::$variant => $label,)+ }
            }
        }
    }
}

permissions! {
    SubscriptionsRead => ("subscriptions.read", "Personal", "View and use subscriptions"),
    SubscriptionsManage => ("subscriptions.manage", "Personal", "Create or remove subscription links"),
    UsersRead => ("users.read", "Users", "Read the user directory"),
    UsersCreate => ("users.create", "Users", "Create users"),
    UsersUpdate => ("users.update", "Users", "Edit profiles and account status"),
    UsersCredentials => ("users.credentials", "Users", "Reset passwords and revoke sessions"),
    RolesRead => ("roles.read", "Access", "Read roles and permission points"),
    RolesManage => ("roles.manage", "Access", "Create, update or delete roles"),
    RolesAssign => ("roles.assign", "Access", "Assign roles and permission overrides"),
    AuditRead => ("audit.read", "Access", "Read the access audit log"),
    QuotasRead => ("quotas.read", "Quotas", "Read account usage and limits"),
    QuotasManage => ("quotas.manage", "Quotas", "Change quota limits"),
    NodesRead => ("nodes.read", "Nodes", "Read servers, nodes and usage"),
    NodesManage => ("nodes.manage", "Nodes", "Configure servers and proxy nodes"),
    NodesEnroll => ("nodes.enroll", "Nodes", "Issue or revoke server identities"),
    RoutingRead => ("routing.read", "Routing", "View policies and revisions"),
    RoutingEdit => ("routing.edit", "Routing", "Save routing drafts"),
    RoutingPublish => ("routing.publish", "Routing", "Publish or restore routing revisions"),
    AnnouncementsRead => ("announcements.read", "Announcements", "View announcement drafts and delivery"),
    AnnouncementsManage => ("announcements.manage", "Announcements", "Create and publish announcements"),
    SettingsRead => ("settings.read", "Settings", "Read system and portal settings"),
    SettingsManage => ("settings.manage", "Settings", "Change system and portal settings"),
}

#[derive(Clone, Debug, Serialize)]
pub struct RoleSummary {
    pub id: Uuid,
    pub name: String,
    pub built_in: bool,
    pub locked: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Role {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub built_in: bool,
    pub locked: bool,
    pub member_count: i64,
    pub permissions: BTreeSet<Permission>,
    pub default_quota_plan_id: Option<Uuid>,
    pub default_quota_plan_name: Option<String>,
    pub link_limits: crate::services::quotas::policy::LinkLimits,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Access {
    pub owner: bool,
    pub roles: Vec<Role>,
    pub permissions: BTreeSet<Permission>,
    pub overrides: BTreeMap<Permission, bool>,
}

impl Access {
    pub fn allows(&self, point: Permission) -> bool {
        self.permissions.contains(&point)
    }

    pub fn can_open_admin(&self) -> bool {
        self.permissions
            .iter()
            .any(|point| point.group() != "Personal")
    }

    pub fn can_manage(&self, target: &Self) -> bool {
        self.owner
            || (!target.owner
                && target
                    .roles
                    .iter()
                    .flat_map(|role| &role.permissions)
                    .chain(target.overrides.keys())
                    .all(|&point| self.allows(point)))
    }
}

#[derive(Clone, Copy)]
pub enum Rules {
    Admin,
    Require(&'static [Permission]),
}

impl Rules {
    pub fn allows(self, access: &Access) -> bool {
        match self {
            Self::Admin => access.can_open_admin(),
            Self::Require(points) => points.iter().all(|&point| access.allows(point)),
        }
    }
}
