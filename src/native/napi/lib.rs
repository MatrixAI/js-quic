extern crate core;

use napi_derive::napi;

mod config;
mod connection;
mod constants;
mod packet;
mod path;
mod stream;

#[napi]
pub fn version_is_supported(version: u32) -> bool {
    return quiche::version_is_supported(version);
}
