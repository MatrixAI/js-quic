use napi_derive::napi;
use napi::bindgen_prelude::{
  Env,
  Array,
  Uint8Array,
  External,
  ToNapiValue,
  Generator
};

#[napi(iterator)]
pub struct StreamIter(pub (crate) quiche::StreamIter);

#[napi]
impl Generator for StreamIter {
  type Yield = i64;
  type Next = ();
  type Return = ();

  fn next(&mut self, _value: Option<Self::Next>) -> Option<Self::Yield> {
    return self.0.next().map(
      |stream_id| stream_id as i64
    );
  }
}
