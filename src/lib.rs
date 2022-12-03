use napi_derive::napi;
use napi::bindgen_prelude::*;

mod constants;
mod config;
mod connection;
mod stream;
mod path;
mod packet;

// Creates random connection ID
//
// Relies on the JS runtime to provide the randomness system
// #[napi]
// pub fn create_connection_id<T: Fn(Buffer) -> Result<()>>(
//   get_random_values: T
// ) -> Result<External<quiche::ConnectionId<'static>>> {
//   let scid = [0; quiche::MAX_CONN_ID_LEN].to_vec();
//   let scid = Buffer::from(scid);
//   get_random_values(scid.clone()).or_else(
//     |err| Err(Error::from_reason(err.to_string()))
//   )?;
//   let scid = quiche::ConnectionId::from_vec(scid.to_vec());
//   eprintln!("New connection with scid {:?}", scid);
//   return Ok(External::new(scid));
// }

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

#[napi]
pub fn version_is_supported(version: u32) -> bool {
  return quiche::version_is_supported(version);

}
