extern crate core;

use napi_derive::napi;

mod constants;
mod config;
mod connection;
mod stream;
mod path;
mod packet;
// FIXME: remote later, just here to include rust tests
mod test;

#[napi]
pub fn version_is_supported(version: u32) -> bool {
  return quiche::version_is_supported(version);
}
