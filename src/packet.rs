use napi_derive::napi;
use napi::bindgen_prelude::*;

#[napi]
pub enum Type {
  Initial,
  Retry,
  Handshake,
  ZeroRTT,
  VersionNegotiation,
  Short
}

impl From<quiche::Type> for Type {
  fn from(item: quiche::Type) -> Self {
    match item {
      quiche::Type::Initial => Type::Initial,
      quiche::Type::Retry => Type::Retry,
      quiche::Type::Handshake => Type::Handshake,
      quiche::Type::ZeroRTT => Type::ZeroRTT,
      quiche::Type::VersionNegotiation => Type::VersionNegotiation,
      quiche::Type::Short => Type::Short,
    }
  }
}

#[napi(constructor)]
pub struct Header {
  pub ty: Type,
  pub version: u32,
  pub dcid: Uint8Array,
  pub scid: Uint8Array,
  pub token: Option<Uint8Array>,
  pub versions: Option<Vec<u32>>,
}

impl From<quiche::Header<'_>> for Header {
  fn from(header: quiche::Header) -> Self {
    Header {
      ty: header.ty.into(),
      version: header.version,
      dcid: header.dcid.as_ref().into(),
      scid: header.scid.as_ref().into(),
      token: header.token.map(|token| token.into()),
      versions: header.versions.map(|versions| versions.to_vec()),
    }
  }
}

#[napi]
impl Header {
  #[napi(factory)]
  pub fn from_slice(mut data: Uint8Array, dcid_len: i64) -> napi::Result<Self> {
    return quiche::Header::from_slice(
      &mut data,
      dcid_len as usize
    ).or_else(
      |e| Err(Error::from_reason(e.to_string()))
    ).map(|header| header.into());
  }
}
