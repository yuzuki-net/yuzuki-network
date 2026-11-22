pub mod cores;
pub mod protocols;
pub mod routing;
pub mod server;
pub mod templates;

pub use yuzuki_protocol::Core;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Xray,
    SingBox,
    Mihomo,
    Universal,
}

impl Format {
    pub const ALL: [Self; 4] = [Self::Xray, Self::SingBox, Self::Mihomo, Self::Universal];

    pub const fn from_code(code: &str) -> Option<Self> {
        match code.as_bytes() {
            b"0" => Some(Self::Xray),
            b"1" => Some(Self::SingBox),
            b"2" => Some(Self::Mihomo),
            b"3" => Some(Self::Universal),
            _ => None,
        }
    }

    pub const fn code(self) -> u8 {
        match self {
            Self::Xray => 0,
            Self::SingBox => 1,
            Self::Mihomo => 2,
            Self::Universal => 3,
        }
    }

    pub const fn core(self) -> Option<Core> {
        match self {
            Self::Xray => Some(Core::Xray),
            Self::SingBox => Some(Core::SingBox),
            Self::Mihomo => Some(Core::Mihomo),
            Self::Universal => None,
        }
    }
}
