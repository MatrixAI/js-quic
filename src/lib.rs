use napi::bindgen_prelude::*;
use napi_derive::napi;
use ring::rand::*;

#[napi]
pub fn plus_100(input: u32) -> u32 {
  input + 100
}

const MAX_DATAGRAM_SIZE: usize = 1350;

#[napi]
pub struct Config(quiche::Config);

pub const HTTP_3: [&[u8]; 4] = [b"h3", b"h3-29", b"h3-28", b"h3-27"];

#[napi]
impl Config {

  #[napi(constructor)]
  pub fn new() -> Result<Self> {
    let mut config = quiche::Config::new(
      quiche::PROTOCOL_VERSION
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?;

    let alpns: Vec<&'static [u8]> = HTTP_3.to_vec();
    config.set_application_protos(&alpns).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?;

    return Ok(Config(config));
  }

  #[napi]
  pub fn verify_peer(&mut self, verify: bool) -> Undefined {
    self.0.verify_peer(verify);
  }

  #[napi]
  pub fn set_max_idle_timeout(&mut self, timeout: f64) -> Undefined {
    self.0.set_max_idle_timeout(timeout as u64);
  }

  // The set_application_protos must set a reference
  // to a reference of u8
  // Basically Array of U8 Array
  // However it cannot "own" lifetime of these things
  // So it's basically a static configuration

  // pub fn set_application_protos(&mut self) -> Result<Undefined> {
  //   let alpns: Vec<&'static [u8]> = HTTP_3.to_vec();
  //   self.0.set_application_protos(&alpns).or_else(
  //     |err| Err(Error::from_reason(err.to_string()))
  //   )?;
  //   Ok(())
  // }


}

// Now we want to create a Connection object
// To do so, we can again create a new type around it
// But this i also ASYNCHRONOUS i think

// Hostname vs Host
// Remember the String is heap allocated

#[napi(object)]
pub struct Host {
  pub hostname: String,
  pub port: u16,
}

#[napi(object)]
pub struct SendInfo {
  pub from: Host,
  pub to: Host,
  pub at: External<std::time::Instant>,
}

// SocketAddr has private fields and its an enum
// So here we have to do it a little different
// We can return a buffer... but this is strange
// pub to: std::net::SocketAddr,
// Instant is an "opaque" type
// there is nothing we can do here

#[napi(object)]
pub struct SendReturn {
  pub out: Buffer,
  pub info: SendInfo,
}

#[napi]
pub struct Connection(quiche::Connection);


#[napi]
impl Connection {
  #[napi(constructor)]
  pub fn new(config: &mut Config) -> Result<Self> {

    // RANDOM source connection ID
    let mut scid = [0; quiche::MAX_CONN_ID_LEN];
    let rng = SystemRandom::new();
    rng.fill(&mut scid[..]).unwrap();

    let scid = quiche::ConnectionId::from_ref(&scid);

    // These addresses are passed in from the outside
    // We expect that the local address has already been bound to
    // On the UDP socket, we don't do any binding here
    // Since the nodejs runtime will do the relevant binding
    // When binding, it needs to bind to both IPv6 and IPv6

    let local_addr = std::net::SocketAddr::new(
      std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
      55551
    );

    let remote_addr = std::net::SocketAddr::new(
      std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)),
      55552
    );

    // We do not care about the domain
    // The server name is necessary for SNI
    // Server name indication
    // This is meant to be the server name
    // This is an option
    let connection = quiche::connect(
      None,
      &scid,
      local_addr,
      remote_addr,
      &mut config.0
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?;

    eprintln!("STDERR New connection with scid {:?}", scid);

    return Ok(Connection(connection));
  }

  // This out is actually something else
  // But we can avoid doing this
  // By alwys creating an out buffer
  // Thati s always the case
  // Because otherwise the buffer has to be passed in
  // We could just return it

// pub struct SendInfo {
//     /// The local address the packet should be sent from.
//     pub from: SocketAddr,

//     /// The remote address the packet should be sent to.
//     pub to: SocketAddr,

//     /// The time to send the packet out.
//     ///
//     /// See [Pacing] for more details.
//     ///
//     /// [Pacing]: index.html#pacing
//     pub at: time::Instant,
// }


  #[napi]
  pub fn send(&mut self) -> Result<SendReturn> {

    // I reckon we can return the same buffer multiple times
    // really!

    let mut out = [0; MAX_DATAGRAM_SIZE];

    // The send can return Ok(v) which is the tuple
    // The send can return Err(done) which means it is DONE
    // The send can return Err(e) which means some other kind of error
    // We have to differentiate them all
    // We could also take in a buffer
    // And write to it
    // and return the result
    // so what does it mean that it is done
    // do you want to redo the exception?

    let (write, send_info) = match self.0.send(&mut out) {
      Ok(v) => v,
      Err(quiche::Error::Done) => return Err(Error::from_reason("Done".to_string())),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };

    // In a way, we could keep the to_vec
    // or out always statically initailised
    // then just keep reassigning to it
    // But the key point is that tyou have to return the `write`

    let mut out_buf = vec![0; write];
    out_buf.clone_from_slice(&out[..write]);

    eprintln!("OUT write length {:?}", write);

    let send_info_js = SendInfo {
      from: Host {
        hostname: send_info.from.ip().to_string(),
        port: send_info.from.port(),
      },
      to: Host {
        hostname: send_info.to.ip().to_string(),
        port: send_info.to.port(),
      },
      at: External::new(send_info.at),
    };

    eprintln!("STDERR Send info {:?}", send_info);

    // Now we need to return 3 things
    // The write, the send_info and the also the out
    // But we must also match on the conditions here

    return Ok(SendReturn {
      out: out_buf.into(),
      info: send_info_js
    });

  }


}
