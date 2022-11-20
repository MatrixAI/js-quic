#[macro_use]
extern crate log;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use ring::rand::*;

#[napi]
pub fn plus_100(input: u32) -> u32 {
  input + 100
}

// #[napi(constructor)]

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

    warn!("New connection");

    return Ok(Connection(connection));
  }

}
