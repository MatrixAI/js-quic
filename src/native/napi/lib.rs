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

// #[napi_derive::napi(strict, ts_args_type = "cb: (num: number) => number")]
// fn validate_function(cb: napi::JsFunction) -> napi::Result<u32> {
//   let args = vec![
//     napi::JsString::new(env, "Hello from Rust")?,
//   ];
//   Ok(
//     cb.call::<napi::JsUnknown>(None, &args)?
//       .coerce_to_number()?
//       .get_uint32()?
//       + 3,
//   )
// }

// #[napi]
// fn take_one<T: Fn(String, JsNumber) -> Result<()>>(env: &Env, callback: T) {
//   let num = env.create_int32(42);
//   callback("Hello!".to_string(), num).unwrap();
// }

// #[js_function(1)]
// fn call_callback(ctx: CallContext) -> Result<()> {
//   let callback: JsFunction = ctx.get::<JsFunction>(0)?;
//   let env = ctx.env;
//
//   let number = 42; // Example number
//
//   let js_number = env.create_int32(number)?;
//   callback.call(None, &[js_number])?;
//
//   Ok(())
// }

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
