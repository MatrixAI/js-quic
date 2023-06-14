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
use futures::executor::block_on;

// #[napi]
// pub fn call_threadsafe_function(callback: JsFunction) -> Result<()> {
//   let tsfn: ThreadsafeFunction<(u32, String), ErrorStrategy::CalleeHandled> = callback
//     .create_threadsafe_function(0, |ctx| {
//       let(num, s) = ctx.value;
//       println!("value: {}", num);
//       println!("value: {}", s);
//       ctx.env.create_string("Hello!").map(|v| vec![v])
//     })?;
//   println!("Making native call");
//   let result = tsfn.call_async::<JsBoolean>(
//     Ok((100, "hello!".to_string())),
//   );
//   println!("waiting....");
//   let asd = block_on(result);
//   let val = asd
//     .unwrap()
//     .get_value()
//     .unwrap();
//   println!("Result!: {}", val);
//   Ok(())
// }

#[napi]
fn test_callback<T: Fn(String, String) -> Result<bool>>(callback: T) {
  let result = callback("Hello".to_string(), "olleh".to_string()).unwrap();
  println!("result: {}", result);
}

// #[napi]
// pub fn call_function(env: Env) -> napi::Result<napi::JsNull> {
//   let js_func = ctx.get::<napi::JsFunction>(0)?;
//   let js_string = ctx.env.create_string("hello".as_ref())?.into_unknown();
//   js_func.call(None, &[js_string])?;
//   Ok(ctx.env.get_null()?)
// }

#[contextless_function]
fn just_return_hello(env: Env) -> ContextlessResult<JsString> {
  env.create_string("hello").map(Some)
}

// #[napi]
// pub fn call_function(ctx: CallContext) -> Result<JsNull> {
//   let js_func = ctx.get::<JsFunction>(0)?;
//   let js_string = ctx.env.create_string("hello".as_ref())?.into_unknown()?;
//   js_func.call(None, &[js_string])?;
//   Ok(ctx.env.get_null()?)
// }

#[napi]
pub fn boi(env: Env, callback: JsFunction) -> napi::Result<()> {
  let result = callback.call(None, &vec![env.create_string("hello").unwrap()]);
  let val = result
    .unwrap()
    .coerce_to_number()
    .unwrap()
    .get_int64()
    .unwrap();
  println!("result was: {}", val);
  Ok(())
}

#[napi_derive::napi]
pub fn version_is_supported(version: u32) -> bool {
  return quiche::version_is_supported(version);
}
