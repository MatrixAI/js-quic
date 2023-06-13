extern crate core;

mod constants;
mod config;
mod connection;
mod stream;
mod path;
mod packet;

use napi::*;
use napi_derive::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::thread;

#[napi]
pub fn call_threadsafe_function(callback: JsFunction) -> Result<()> {
  let tsfn: ThreadsafeFunction<(u32, String), ErrorStrategy::CalleeHandled> = callback
    .create_threadsafe_function(0, |ctx| {
      let(num, s) = ctx.value;
      println!("value: {}", num);
      println!("value: {}", s);
      ctx.env.create_string("Hello!").map(|v| vec![v])
    })?;
  println!("Making native call");
  thread::spawn(move || {
    tsfn.call(
      Ok((100, "hello!".to_string())),
      ThreadsafeFunctionCallMode::Blocking,
    );
  });
  Ok(())
}

#[napi_derive::napi]
pub fn version_is_supported(version: u32) -> bool {
  return quiche::version_is_supported(version);
}
