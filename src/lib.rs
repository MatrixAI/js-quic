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


/// This maximum datagram size to SEND to the UDP socket
/// It must be used with `config.set_max_recv_udp_payload_size` and such
/// But on the receiving side, we actually use the maximum which is 65535
#[napi]
pub const MAX_DATAGRAM_SIZE: u32 = 1350;

/// This is the maximum size of the packet to be received from the socket
/// This is what you use to receive packets on the UDP socket
/// And you send it to the connection as well
#[napi]
pub const MAX_UDP_PACKET_SIZE: u32 = 65535;

#[napi]
pub const MAX_CONN_ID_LEN: u32 = quiche::MAX_CONN_ID_LEN as u32;

#[napi]
pub struct Config(quiche::Config);

pub const HTTP_3: [&[u8]; 4] = [b"h3", b"h3-29", b"h3-28", b"h3-27"];

// Here's an example
// We have a ENUM called quiche::Shutdown
// This has to be passed in from JS
// We can represent this by wrapping it with our own type here
// As a new type
#[napi]
pub struct Shutdown(quiche::Shutdown);

// Then here, we have to create the implementation for this type
// In that the 0 and 1 are ultimately coming from JS
// At the value level they are numerics
impl FromNapiValue for Shutdown {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let value = i64::from_napi_value(env, value)?;
    match value {
      0 => Ok(Shutdown(quiche::Shutdown::Read)),
      1 => Ok(Shutdown(quiche::Shutdown::Write)),
      _ => Err(Error::new(
        Status::InvalidArg,
        "Invalid shutdown value".to_string(),
      )),
    }
  }
}

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
  pub fn verify_peer(&mut self, verify: bool) -> () {
    self.0.verify_peer(verify);
  }

  #[napi]
  pub fn set_max_idle_timeout(&mut self, timeout: f64) -> () {
    self.0.set_max_idle_timeout(timeout as u64);
  }

  // The max datagram size is set for both of these
  // But you are supposed to control this outside of the library

  #[napi]
  pub fn set_max_recv_udp_payload_size(&mut self, size: i64) -> () {
    self.0.set_max_recv_udp_payload_size(size as usize);
  }

  #[napi]
  pub fn set_max_send_udp_payload_size(&mut self, size: i64) -> () {
    self.0.set_max_send_udp_payload_size(size as usize);
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
    write_and_send_info.set(0, write as i64)?;
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

  // This data buffer must be the size of the entire largest packet...
  // It is not the max datagram size, you have to potentially take
  // A VERY large packet
  // On the other hand, it's all dynamic in JS
  // So it may not be a problem
  #[napi]
  pub fn recv(
    &mut self,
    mut data: Uint8Array,
    recv_info: RecvInfo,
  ) -> Result<i64> {

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
    return Ok(read as i64);
  }

  /// Maximum dgram size
  ///
  /// Use this to determine the size of the dgrams being send and received
  /// I'm not sure if this is also necessary for send and recv?
  #[napi]
  pub fn dgram_max_writable_len(&mut self) -> Option<i64> {
    return self.0.dgram_max_writable_len().map(|v| v as i64);
  }

  #[napi]
  pub fn dgram_send(
    &mut self,
    data: Uint8Array,
  ) -> Result<()> {
    match self.0.dgram_send(
      &data,
    ) {
      Ok(v) => return Ok(v),
      // If no data is sent, also return Ok
      Err(quiche::Error::Done) => return Ok(()),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn dgram_recv(
    &mut self,
    mut data: Uint8Array
  ) -> Result<i64> {
    match self.0.dgram_recv(
      &mut data,
    ) {
      Ok(v) => return Ok(v as i64),
      Err(quiche::Error::Done) => return Ok(0),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
  }

  // Ok let's work out how to deal with streams
  // this returns a tuple

  #[napi]
  pub fn stream_recv(
    &mut self,
    env: Env,
    stream_id: i64,
    mut data: Uint8Array,
  ) -> Result<Array> {
    let (read, fin) = match self.0.stream_recv(
      stream_id as u64,
      &mut data,
    ) {
      Ok((read, fin)) => (read, fin),
      // Done means there's no more data to receive
      Err(quiche::Error::Done) => (0, true),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
    let mut read_and_fin = env.create_array(2)?;
    read_and_fin.set(0, read as i64)?;
    read_and_fin.set(1, fin)?;
    return Ok(read_and_fin);
  }

  #[napi]
  pub fn stream_priority(
    &mut self,
    stream_id: i64,
    urgency: u8,
    incremental: bool
  ) -> Result<()> {
    return self.0.stream_priority(
      stream_id as u64,
      urgency,
      incremental
    ).map_err(|e| Error::from_reason(e.to_string()));
  }

  #[napi]
  pub fn stream_send(
    &mut self,
    stream_id: i64,
    data: Uint8Array,
    fin: bool
  ) -> Result<i64> {
    // 0-length buffer can be written with a fin being true
    // this indicates that it has finished the stream

    // number of written bytes may be lower than the length
    // of hte input buffer when the stream doesn't have enough capacity
    // the app should retry the operation once the stream reports it is writable again
    match self.0.stream_send(
      stream_id as u64,
      &data,
      fin
    ) {
      Ok(v) => return Ok(v as i64),
      Err(quiche::Error::Done) => return Ok(0),
      Err(e) => return Err(Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn stream_shutdown(
    &mut self,
    stream_id: i64,
    direction: Shutdown,
    err: i64
  ) -> Result<()> {
    // The err is an application-supplied error code
    // It's an application protocol error code
    // https://datatracker.ietf.org/doc/html/rfc9000#section-20.2
    // I think HTTP3 uses this a bit
    // RESET_STREAM means we stop sending
    // It can indicate to the peer WHY we have stopped sending
    // STOP_SENDING means we stop receiving
    // It can indicate to the peer WHY we have stopped receiving
    // But this is at the transport layer remember
    return self.0.stream_shutdown(
      stream_id as u64,
      direction.0,
      err as u64
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn stream_capacity(
    &self,
    stream_id: i64,
  ) -> Result<i64> {
    return self.0.stream_capacity(
      stream_id as u64
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    ).map(|v| v as i64);
  }

  #[napi]
  pub fn stream_readable(
    &self,
    stream_id: i64,
  ) -> bool {
    return self.0.stream_readable(
      stream_id as u64
    );
  }

  #[napi]
  pub fn stream_writable(
    &mut self,
    stream_id: i64,
    len: i64
  ) -> Result<bool> {
    return self.0.stream_writable(stream_id as u64, len as usize).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn stream_finished(
    &self,
    stream_id: i64
  ) -> bool {
    return self.0.stream_finished(stream_id as u64);
  }

  #[napi]
  pub fn peer_streams_left_bidi(&self) -> i64 {
    return self.0.peer_streams_left_bidi() as i64;
  }

  #[napi]
  pub fn peer_streams_left_uni(&self) -> i64 {
    return self.0.peer_streams_left_uni() as i64;
  }









}
