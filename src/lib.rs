use std::net::ToSocketAddrs;

use mio::net::SocketAddr;
use neon::prelude::*;
use ring::rand::*;

// This is is like unqualified imports
// use quiche::*;

// The ring library seems to be a crypto library.
// To generate random data...
// Maybe we should be using libsodium to standardise
// But it is hard to do...
// Since the rust library is its own thing
// Instead of using whatever else

pub struct ClientArgs {
  // pub version: u32,
  // pub dump_response_path: Option<String>,
  // pub dump_json: Option<usize>,
  pub urls: Vec<url::Url>,
  // pub reqs_cardinal: u64,
  // pub req_headers: Vec<String>,
  // pub no_verify: bool,
  // pub body: Option<Vec<u8>>,
  // pub method: String,
  pub connect_to: Option<String>,
  // pub session_file: Option<String>,
  pub source_port: u16,
  // pub perform_migration: bool,
  // pub send_priority_update: bool,
}


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

  let book: Book = Book {
    title: "The Great Gatsby".to_string(),
    author: "Pricilla".to_string(),
    year: 2009,
  };

  let obj = book.to_object(&mut cx)?;
  cx.export_value("book", obj)?;

  // Interesting you don't actually need to import anything
  // you just use fully qualified names like this

  // Ok so we have multiple urls we are going to contact
  // But we walso have a particular `connect_to`
  // Is that supposed to be the DNS?
  // So you need to resolve the DNS first?
  let args = ClientArgs {
    urls: vec![url::Url::parse("https://127.0.0.1:55555").unwrap()],
    connect_to: Some("127.0.0.1:55555"),
    source_port: 0,
  };

  let connect_url = &args.urls[0];

  // Pattern matching, it extracts out of `addr`
  // So `addr` is the actual tring itself in the `connect_to`
  // This whole thing becomes a `SocketAddr`
  // Previously it was just a Some of a string
  // Just like Haskell, Some is `Just "abc"`
  // And None is `Nothing`

  // let peer_addr = if let Some(addr) = &args.connect_to {
  //   addr.parse().expect("--connect-to must be a valid IP address")
  // } else {
  //   connect_url.to_socket_addrs().unwrap().next().unwrap()
  // };

  // This seems like some sort of magic

  let x = &args.connect_to;
  let y = x.unwrap();
  let peer_addr: SocketAddr = y.parse().expect("ohno");

  // Bind to INADDR_ANY or IN6ADDR_ANY depending on the IP family of the
  // server address. This is needed on macOS and BSD variants that don't
  // support binding to IN6ADDR_ANY for both v4 and v6.
  let bind_addr = match peer_addr {
    std::net::SocketAddr::V4(_) => format!("0.0.0.0:{}", args.source_port),
    std::net::SocketAddr::V6(_) => format!("[::]:{}", args.source_port),
  };

  // So the bind address is anything with the same source port
  // I see now, the client requires a source port now

  // This binds to a socket using the bind address
  // It's using return type polymorphism on the `parse()`
  // To turn it into a `SocketAddr`
  // And then it unwraps forcilby just like `as X` in our case in TS
  // But also, we are doing it like fromJust
  // The `mio` library is a socket library
  // Does this make sense in the context of nodejs?
  // It seems that it has its own event loop
  // So in the context of nodejs does this end up having its own runtime
  // Remember in the libc, we did something a bit different
  let mut socket = mio::net::UdpSocket::bind(
    bind_addr.parse().unwrap()
  ).unwrap();

  let config = quiche::Config::new(quiche::PROTOCOL_VERSION)?;

  let server_name = "localhost";

  // Generate a random source connection ID for the connection.
  let mut scid = [0; quiche::MAX_CONN_ID_LEN];
  let rng = SystemRandom::new();
  rng.fill(&mut scid[..]).unwrap();
  let scid = quiche::ConnectionId::from_ref(&scid);

  // This unwraps to the local address
  let local_addr = socket.local_addr().unwrap();

  // You can use `?` to unwrap the result into error
  // You can use `unwrap` to result in a panic
  // Use unwrap for things that should never fail
  // Use ? for 'functional total functions'

  let mut conn = quiche::connect(
    connect_url.domain(),
    &scid,
    local_addr,
    peer_addr,
    &mut config
  ).unwrap();

  // It seems the idea is that you mostly pass addresses
  // You don't actually pass any of the sockets..
  // It just so happnes the local address is the...
  // is the LOCAL socket, that mio was bound to
  // Whereas the `peer_addr` isn't acquired anywhere
  // So the reason we have to bind and listen on the local address first
  // is that where the receiving data comes from?
  // And you have to therefore bind to it
  // And here we are using `mio` to do this
  // Perhaps neon plus NAPI should be the one opening this socket
  // at least within the libuv system?
  // It is possible to do this with `uv.h`
  // But to "bind" to this, we have to use C/C++
  // If we are writing in rust? How do we use the `uv.h`.

  return Ok(());
}
