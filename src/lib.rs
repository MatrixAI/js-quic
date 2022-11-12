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

fn get_name(mut cx: FunctionContext) -> JsResult<JsString> {
  return Ok(cx.string("hello node"));
}

struct Book {
  pub title: String,
  pub author: String,
  pub year: u32,
}

impl Book {
  fn to_object<'a>(&self, cx: &mut impl Context<'a>) -> JsResult<'a, JsObject> {
    let obj = cx.empty_object();
    let title = cx.string(&self.title);
    obj.set(cx, "title", title)?;
    let author = cx.string(&self.author);
    obj.set(cx, "author", author)?;
    let year = cx.number(self.year);
    obj.set(cx, "year", year)?;
    return Ok(obj);
  }
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
  cx.export_function("hello", hello)?;
  cx.export_function("getNumCpus", get_num_cpus)?;
  cx.export_function("getName", get_name)?;
  let book = Book {
    title: "The Great Gatsby".to_string(),
    author: "Pricilla".to_string(),
    year: 2009,
  };
  let obj = book.to_object(&mut cx)?;
  cx.export_value("book", obj)?;
  return Ok(());
}
