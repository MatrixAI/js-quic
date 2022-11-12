// #[cfg(test)]
// mod tests {
//     #[test]
//     fn it_works() {
//         let result = 2 + 2;
//         assert_eq!(result, 4);
//     }
// }

// extern crate libc;
// extern crate url;

// use std::ffi::{CStr,CString};
// use url::{Url};

// #[no_mangle]
// pub extern "C" fn get_query (arg1: *const libc::c_char) -> *const libc::c_char {

//   let s1 = unsafe { CStr::from_ptr(arg1) };

//   let str1 = s1.to_str().unwrap();

//   let parsed_url = Url::parse(
//     str1
//   ).unwrap();

//   return CString::new(parsed_url.query().unwrap().as_bytes()).unwrap().into_raw();

// }

// use neon::prelude::*;

// Ok it's just like JS, arrow functions
// I get it
// No semicolon

// fn hello(mut cx: FunctionContext) -> JsResult<JsString> {
//   return Ok(cx.string("hello node"));
// }

// register_module!(mut cx, {
//   return cx.export_function("hello", hello);
// });

use neon::prelude::*;

fn hello(mut cx: FunctionContext) -> JsResult<JsString> {
  Ok(cx.string("hello node"))
}

// The JsResult output type is a Reuslt type that indicates Ok or thoriwng a JS exception
// it also tracks the lifetime of the returned handle... very interesting
// this is really sophisticated node-addon-api (for C/C++)
// I didn't get around to using such a thing with js-db, I was doing much more lower level NAPI macros
// cx.number() maintains the alive lifetime until is returned to the caller of get num cpus
fn get_num_cpus(mut cx: FunctionContext) -> JsResult<JsNumber> {
  return Ok(cx.number(num_cpus::get() as f64));
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
  cx.export_function("hello", hello)?;
  cx.export_function("getNumCpus", get_num_cpus)?;
  return Ok(());
}
