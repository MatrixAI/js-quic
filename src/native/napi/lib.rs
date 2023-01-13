use napi_derive::napi;

mod constants;
mod config;
mod connection;
mod stream;
mod path;
mod packet;

#[napi]
pub fn version_is_supported(version: u32) -> bool {
  return quiche::version_is_supported(version);
}
