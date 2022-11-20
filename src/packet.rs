#![allow(dead_code)]
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

impl From<Type> for quiche::Type {
  fn from(ty: Type) -> Self {
    match ty {
      Type::Initial => quiche::Type::Initial,
      Type::Retry => quiche::Type::Retry,
      Type::Handshake => quiche::Type::Handshake,
      Type::ZeroRTT => quiche::Type::ZeroRTT,
      Type::VersionNegotiation => quiche::Type::VersionNegotiation,
      Type::Short => quiche::Type::Short,
    }
  }
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

#[napi]
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

#[napi]
pub fn negotiate_version(
  scid: Uint8Array,
  dcid: Uint8Array,
  mut data: Uint8Array,
) -> napi::Result<i64> {
  let scid = quiche::ConnectionId::from_ref(&scid);
  let dcid = quiche::ConnectionId::from_ref(&dcid);
  return quiche::negotiate_version(&scid, &dcid, &mut data).or_else(
    |e| Err(Error::from_reason(e.to_string()))
  ).map(|v| v as i64);
}

#[napi]
pub fn retry(
  scid: Uint8Array,
  dcid: Uint8Array,
  new_scid: Uint8Array,
  token: Uint8Array,
  version: u32,
  mut out: Uint8Array
) -> napi::Result<i64> {
  let scid = quiche::ConnectionId::from_ref(&scid);
  let dcid = quiche::ConnectionId::from_ref(&dcid);
  let new_scid = quiche::ConnectionId::from_ref(&new_scid);
  return quiche::retry(
    &scid,
    &dcid,
    &new_scid,
    &token,
    version,
    &mut out
  ).or_else(
    |e| Err(Error::from_reason(e.to_string()))
  ).map(|v| v as i64);
}
