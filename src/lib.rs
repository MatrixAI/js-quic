// use std::net::SocketAddr;
// use std::net::IpAddr;
use std::net::ToSocketAddrs;
use napi::bindgen_prelude::*;
use napi_derive::napi;
// use ring::rand::*;

// You have to pass a random bytes system?
// But I don't think we need this
// We can acquire it from the runtime that passes this in
// const RNG: SystemRandom = SystemRandom::new();

#[napi]
pub const MAX_DATAGRAM_SIZE: u32 = 1350;

#[napi]
pub const MAX_CONN_ID_LEN: u32 = quiche::MAX_CONN_ID_LEN as u32;

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
  pub ip: String,
  pub port: u16,
}

#[napi(object)]
pub struct SendInfo {
  /// The local address the packet should be sent from.
  pub from: Host,
  /// The remote address the packet should be sent to.
  pub to: Host,
  /// The time to send the packet out for pacing.
  pub at: External<std::time::Instant>,
}

#[napi(object)]
pub struct RecvInfo {
  /// The remote address the packet was received from.
  pub from: Host,
  /// The local address the packet was sent to.
  pub to: Host,
}

// Tuples don't work nicely and tuple structs
// Instead the I have to create a specialised object
// just for the return

// #[napi(object)]
// pub struct ConnectionSendReturn {
//   pub length: u32,
//   pub info: Option<SendInfo>,
// }

/// Creates random connection ID
///
/// Relies on the JS runtime to provide the randomness system
// #[napi]
// pub fn create_connection_id<T: Fn(Buffer) -> Result<()>>(
//   get_random_values: T
// ) -> Result<External<quiche::ConnectionId<'static>>> {
//   let scid = [0; quiche::MAX_CONN_ID_LEN].to_vec();
//   let scid = Buffer::from(scid);
//   get_random_values(scid.clone()).or_else(
//     |err| Err(Error::from_reason(err.to_string()))
//   )?;
//   let scid = quiche::ConnectionId::from_vec(scid.to_vec());
//   eprintln!("New connection with scid {:?}", scid);
//   return Ok(External::new(scid));
// }

#[napi]
pub struct Connection(quiche::Connection);

#[napi]
impl Connection {

  /// Creates QUIC Client Connection
  ///
  /// This can take both IP addresses and hostnames
  #[napi(factory)]
  pub fn connect(
    // scid: External<quiche::ConnectionId>,
    scid: Buffer,
    local_host: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    config: &mut Config,
  ) -> Result<Self> {
    // These addresses are passed in from the outside
    // We expect that the local address has already been bound to
    // On the UDP socket, we don't do any binding here
    // Since the nodejs runtime will do the relevant binding
    // When binding, it needs to bind to both IPv6 and IPv6

    let local_addr = (local_host, local_port).to_socket_addrs().or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?.next().unwrap();

    eprintln!("Local address: {:?}", local_addr);

    let remote_addr = (remote_host, remote_port).to_socket_addrs().or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?.next().unwrap();

    eprintln!("Remote address: {:?}", remote_addr);

    let scid = quiche::ConnectionId::from_ref(&scid);

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

  #[napi(factory)]
  pub fn accept(
    scid: Buffer,
    local_host: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    config: &mut Config,
  ) -> Result<Self> {

    let local_addr = (local_host, local_port).to_socket_addrs().or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?.next().unwrap();

    eprintln!("Local address: {:?}", local_addr);

    let remote_addr = (remote_host, remote_port).to_socket_addrs().or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?.next().unwrap();

    eprintln!("Remote address: {:?}", remote_addr);

    let scid = quiche::ConnectionId::from_ref(&scid);

    let connection = quiche::accept(
      &scid,
      None,
      local_addr,
      remote_addr,
      &mut config.0
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?;

    eprintln!("New connection with scid {:?}", scid);

    return Ok(Connection(connection));
  }

  /// Sends a QUIC packet
  ///
  /// This writes to the data buffer passed in.
  /// The buffer must be allocated to the size of MAX_DATAGRAM_SIZE.
  /// This will return a JS array of `[length, send_info]`.
  /// If the length is 0, then that there's no data to send.
  /// The `send_info` will be set to `null`.
  #[napi]
  pub fn send(&mut self, env: Env, mut data: Uint8Array) -> Result<Array> {
    // Convert the Done error into a 0-length write
    // This would mean that there's nothing to send
    let (write, send_info) = match self.0.send(&mut data) {
      Ok((write, send_info)) => (write, Some(send_info)),
      Err(quiche::Error::Done) => (0, None),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
    let send_info = send_info.map(|info| {
      let from = Host {
        ip: info.from.ip().to_string(),
        port: info.from.port(),
      };
      let to = Host {
        ip: info.to.ip().to_string(),
        port: info.to.port(),
      };
      let at = External::new(info.at);
      SendInfo { from, to, at }
    });
    let mut write_and_send_info = env.create_array(2)?;
    write_and_send_info.set(0, write as u32)?;
    write_and_send_info.set(1, send_info)?;
    return Ok(write_and_send_info);
  }

  // We need the information that the packet was sent from and to
  // And both are socket addresses
  // THE TO info
  // is the local address
  // that is something that
  // The buffer here is mutated
  // Do not re-use it
  // Pass back the `to` as the LOCAL address?
  // We provided the address all the time

  #[napi]
  pub fn recv(
    &mut self,
    mut data: Uint8Array,
    recv_info: RecvInfo,
  ) -> Result<u32> {

    // Parsing is kind of slow
    // the from address has to be passed in from JS side
    // but the local address here is already known here
    // if we can keep track of it, it would work nicely
    // In fact, for any given connection, don't we already have both the remote address and the local address already?
    // Yea, exactly this information is technically already known

    let recv_info = quiche::RecvInfo {
      from: (recv_info.from.ip, recv_info.from.port).to_socket_addrs().or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?.next().unwrap(),
      to: (recv_info.to.ip, recv_info.to.port).to_socket_addrs().or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?.next().unwrap(),
    };
    // If there is an error, the JS side should continue to read
    // But it can log out the error
    // You may call this multiple times
    // When receiving multiple packets
    // Process potentially coalesced packets.
    let read = match self.0.recv(
      &mut data,
      recv_info
    ) {
      Ok(v) => v,
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
    return Ok(read as u32);
  }

  // It's quite low level as above!
  // Remember that
  // Plus the returning of the recv info

}
