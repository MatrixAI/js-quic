use serde::{Serialize, Deserialize};
use std::io;
use std::net::{
  SocketAddr,
  ToSocketAddrs,
};
// use std::net::ToSocketAddrs;
use napi_derive::napi;
// use napi::bindgen_prelude::{
//   Env,
//   Array,
//   BigInt,
//   Uint8Array,
//   External,
//   ToNapiValue,
//   FromNapiValue,
//   sys
// };
use napi::bindgen_prelude::*;
use crate::config;
use crate::stream;
use crate::path;

#[napi(object)]
pub struct ConnectionError {
  pub is_app: bool,
  pub error_code: i64,
  pub reason: Vec<u8>,
}

impl From<quiche::ConnectionError> for ConnectionError {
  fn from(err: quiche::ConnectionError) -> Self {
    return ConnectionError {
      is_app: err.is_app,
      error_code: err.error_code as i64,
      reason: err.reason.to_vec(),
    };
  }
}

#[napi(object)]
pub struct Stats {
  pub recv: i64,
  pub sent: i64,
  pub lost: i64,
  pub retrans: i64,
  pub sent_bytes: i64,
  pub recv_bytes: i64,
  pub lost_bytes: i64,
  pub stream_retrans_bytes: i64,
  pub paths_count: i64,
  pub peer_max_idle_timeout: i64,
  pub peer_max_udp_payload_size: i64,
  pub peer_initial_max_data: i64,
  pub peer_initial_max_stream_data_bidi_local: i64,
  pub peer_initial_max_stream_data_bidi_remote: i64,
  pub peer_initial_max_stream_data_uni: i64,
  pub peer_initial_max_streams_bidi: i64,
  pub peer_initial_max_streams_uni: i64,
  pub peer_ack_delay_exponent: i64,
  pub peer_max_ack_delay: i64,
  pub peer_disable_active_migration: bool,
  pub peer_active_conn_id_limit: i64,
  pub peer_max_datagram_frame_size: Option<i64>,
}

impl From<quiche::Stats> for Stats {
  fn from(stats: quiche::Stats) -> Self {
    return Stats {
      recv: stats.recv as i64,
      sent: stats.sent as i64,
      lost: stats.lost as i64,
      retrans: stats.retrans as i64,
      sent_bytes: stats.sent_bytes as i64,
      recv_bytes: stats.recv_bytes as i64,
      lost_bytes: stats.lost_bytes as i64,
      stream_retrans_bytes: stats.stream_retrans_bytes as i64,
      paths_count: stats.paths_count as i64,
      peer_max_idle_timeout: stats.peer_max_idle_timeout as i64,
      peer_max_udp_payload_size: stats.peer_max_udp_payload_size as i64,
      peer_initial_max_data: stats.peer_initial_max_data as i64,
      peer_initial_max_stream_data_bidi_local: stats.peer_initial_max_stream_data_bidi_local as i64,
      peer_initial_max_stream_data_bidi_remote: stats.peer_initial_max_stream_data_bidi_remote as i64,
      peer_initial_max_stream_data_uni: stats.peer_initial_max_stream_data_uni as i64,
      peer_initial_max_streams_bidi: stats.peer_initial_max_streams_bidi as i64,
      peer_initial_max_streams_uni: stats.peer_initial_max_streams_uni as i64,
      peer_ack_delay_exponent: stats.peer_ack_delay_exponent as i64,
      peer_max_ack_delay: stats.peer_max_ack_delay as i64,
      peer_disable_active_migration: stats.peer_disable_active_migration,
      peer_active_conn_id_limit: stats.peer_active_conn_id_limit as i64,
      peer_max_datagram_frame_size: stats.peer_max_datagram_frame_size.map(|v| v as i64),
    };
  }
}

/// Equivalent to quiche::Shutdown enum
#[napi]
pub enum Shutdown {
  Read = 0,
  Write = 1
}

impl From<Shutdown> for quiche::Shutdown {
  fn from(shutdown: Shutdown) -> Self {
    match shutdown {
      Shutdown::Read => quiche::Shutdown::Read,
      Shutdown::Write => quiche::Shutdown::Write,
    }
  }
}

impl From<quiche::Shutdown> for Shutdown {
  fn from(item: quiche::Shutdown) -> Self {
    match item {
      quiche::Shutdown::Read => Shutdown::Read,
      quiche::Shutdown::Write => Shutdown::Write,
    }
  }
}

#[napi(object)]
#[derive(Serialize, Deserialize)]
pub struct Host {
  pub addr: String,
  pub port: u16,
}

impl TryFrom<Host> for SocketAddr {
  type Error = io::Error;
  fn try_from(host: Host) -> io::Result<Self> {
    (host.addr, host.port).to_socket_addrs()?.next().ok_or(
      io::Error::new(
        io::ErrorKind::Other,
        "Could not convert host to socket address"
      )
    )
  }
}

impl From<SocketAddr> for Host {
  fn from(socket_addr: SocketAddr) -> Self {
    Host {
      addr: socket_addr.ip().to_string(),
      port: socket_addr.port(),
    }
  }
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

#[napi]
pub struct Connection(pub (crate) quiche::Connection);

#[napi]
impl Connection {

  /// Creates QUIC Client Connection
  ///
  /// This can take both IP addresses and hostnames
  #[napi(factory)]
  pub fn connect(
    scid: Uint8Array,
    local_host: Host,
    remote_host: Host,
    config: &mut config::Config,
  ) -> napi::Result<Self> {
    // These addresses are passed in from the outside
    // We expect that the local address has already been bound to
    // On the UDP socket, we don't do any binding here
    // Since the nodejs runtime will do the relevant binding
    // When binding, it needs to bind to both IPv6 and IPv6

    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // let local_addr = (local_host, local_port).to_socket_addrs().or_else(
    //   |err| Err(napi::Error::from_reason(err.to_string()))
    // )?.next().unwrap();

    // eprintln!("Local address: {:?}", local_addr);

    // let remote_addr = (remote_host, remote_port).to_socket_addrs().or_else(
    //   |err| Err(napi::Error::from_reason(err.to_string()))
    // )?.next().unwrap();

    let remote_addr: SocketAddr = remote_host.try_into().or_else(
      |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // eprintln!("Remote address: {:?}", remote_addr);

    let scid = quiche::ConnectionId::from_ref(&scid);

    let connection = quiche::connect(
      None,
      &scid,
      local_addr,
      remote_addr,
      &mut config.0
    ).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // eprintln!("STDERR New connection with scid {:?}", scid);

    return Ok(Connection(connection));
  }

  #[napi(factory)]
  pub fn accept(
    scid: Uint8Array,
    odcid: Option<Uint8Array>,
    local_host: Host,
    remote_host: Host,
    config: &mut config::Config,
  ) -> napi::Result<Self> {

    // let local_addr = (local_host, local_port).to_socket_addrs().or_else(
    //   |err| Err(napi::Error::from_reason(err.to_string()))
    // )?.next().unwrap();

    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // eprintln!("Local address: {:?}", local_addr);

    // let remote_addr = (remote_host, remote_port).to_socket_addrs().or_else(
    //   |err| Err(napi::Error::from_reason(err.to_string()))
    // )?.next().unwrap();

    let remote_addr: SocketAddr = remote_host.try_into().or_else(
      |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // eprintln!("Remote address: {:?}", remote_addr);

    let scid = quiche::ConnectionId::from_ref(&scid);

    let odcid = odcid.map(
      |dcid| quiche::ConnectionId::from_vec(dcid.to_vec())
    );

    let connection = quiche::accept(
      &scid,
      odcid.as_ref(),
      local_addr,
      remote_addr,
      &mut config.0
    ).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
    )?;

    // eprintln!("New connection with scid {:?}", scid);

    return Ok(Connection(connection));
  }

  #[napi]
  pub fn set_session(&mut self, session: Uint8Array) -> napi::Result<()> {
    return self.0.set_session(&session).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
    );
  }

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
  ) -> napi::Result<i64> {

    // Parsing is kind of slow
    // the from address has to be passed in from JS side
    // but the local address here is already known here
    // if we can keep track of it, it would work nicely
    // In fact, for any given connection, don't we already have both the remote address and the local address already?
    // Yea, exactly this information is technically already known

    // recv_info.from

    let recv_info = quiche::RecvInfo {
      from: recv_info.from.try_into().or_else(
        |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
      )?,
      // from: (recv_info.from.addr, recv_info.from.port).to_socket_addrs().or_else(
      //   |err| Err(napi::Error::from_reason(err.to_string()))
      // )?.next().unwrap(),
      to: recv_info.to.try_into().or_else(
        |err: io::Error| Err(napi::Error::from_reason(err.to_string()))
      )?,
      // to: (recv_info.to.addr, recv_info.to.port).to_socket_addrs().or_else(
      //   |err| Err(napi::Error::from_reason(err.to_string()))
      // )?.next().unwrap(),
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
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
    return Ok(read as i64);
  }


  /// Sends a QUIC packet
  ///
  /// This writes to the data buffer passed in.
  /// The buffer must be allocated to the size of MAX_DATAGRAM_SIZE.
  /// This will return a JS array of `[length, send_info]`.
  /// If the length is 0, then that there's no data to send.
  /// The `send_info` will be set to `null`.
  #[napi(ts_return_type = "[number, SendInfo | null]")]
  pub fn send(&mut self, env: Env, mut data: Uint8Array) -> napi::Result<Array> {
    // Convert the Done error into a 0-length write
    // This would mean that there's nothing to send
    let (write, send_info) = match self.0.send(&mut data) {
      Ok((write, send_info)) => (write, Some(send_info)),
      Err(quiche::Error::Done) => (0, None),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
    let send_info = send_info.map(|info| {
      let from = Host {
        addr: info.from.ip().to_string(),
        port: info.from.port(),
      };
      let to = Host {
        addr: info.to.ip().to_string(),
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

  // So you can pass the SocketAddr
  // But instead we provide a sort of conversion that is necessary

  #[napi(ts_return_type = "[number, SendInfo | null]")]
  pub fn send_on_path(
    &mut self,
    env: Env,
    mut data: Uint8Array,
    from: Option<Host>,
    to: Option<Host>
  ) -> napi::Result<Array> {
    // If we want to "preserve" the error
    // We have to then provide a Some(Result)
    // Which means Option<Result<SocketAddr>>
    // Then we have to "unwrap" it
    // But I'm not sure how to do this here...
    // Especially it seems so functional
    // On the other hand... I think if we can unwrap it here

    let from: Option<SocketAddr> = match from {
      Some(host) => Some(
        host.try_into().or_else(
          |err: io::Error| Err(
            napi::Error::new(napi::Status::InvalidArg, err.to_string())
          )
        )?
      ),
      // Some(host) => (host.addr, host.port).to_socket_addrs().or_else(
      //   |err| Err(napi::Error::from_reason(err.to_string()))
      // )?.next(),
      _ => None
    };
    let to: Option<SocketAddr> = match to {
      Some(host) => Some(
        host.try_into().or_else(
          |err: io::Error| Err(
            napi::Error::new(napi::Status::InvalidArg, err.to_string())
            // napi::Error::from_reason(err.to_string())
          )
        )?
      ),
      // Some(host) => (host.addr, host.port).to_socket_addrs().or_else(
      //   |err| Err(napi::Error::from_reason(err.to_string()))
      // )?.next(),
      _ => None
    };
    let (write, send_info) = match self.0.send_on_path(&mut data, from, to) {
      Ok((write, send_info)) => (write, Some(send_info)),
      Err(quiche::Error::Done) => (0, None),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
    let send_info = send_info.map(|info| {
      let from = Host {
        addr: info.from.ip().to_string(),
        port: info.from.port(),
      };
      let to = Host {
        addr: info.to.ip().to_string(),
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

  #[napi]
  pub fn send_quantum(&self) -> i64 {
    return self.0.send_quantum() as i64;
  }

  #[napi]
  pub fn send_quantum_on_path(&self, local_host: Host, peer_host: Host) -> napi::Result<i64> {
    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    let remote_addr: SocketAddr = peer_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    return Ok(self.0.send_quantum_on_path(local_addr, remote_addr) as i64);
  }

  #[napi(ts_return_type = "[number, boolean]")]
  pub fn stream_recv(
    &mut self,
    env: Env,
    stream_id: i64,
    mut data: Uint8Array,
  ) -> napi::Result<Array> {
    let (read, fin) = match self.0.stream_recv(
      stream_id as u64,
      &mut data,
    ) {
      Ok((read, fin)) => (read, fin),
      // Done means there's no more data to receive
      Err(quiche::Error::Done) => (0, true),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
    let mut read_and_fin = env.create_array(2)?;
    read_and_fin.set(0, read as i64)?;
    read_and_fin.set(1, fin)?;
    return Ok(read_and_fin);
  }

  #[napi]
  pub fn stream_send(
    &mut self,
    stream_id: i64,
    data: Uint8Array,
    fin: bool
  ) -> napi::Result<i64> {
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
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn stream_priority(
    &mut self,
    stream_id: i64,
    urgency: u8,
    incremental: bool
  ) -> napi::Result<()> {
    return self.0.stream_priority(
      stream_id as u64,
      urgency,
      incremental
    ).map_err(|e| napi::Error::from_reason(e.to_string()));
  }

  #[napi]
  pub fn stream_shutdown(
    &mut self,
    stream_id: i64,
    direction: Shutdown,
    err: i64
  ) -> napi::Result<()> {
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
      direction.into(),
      err as u64
    ).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn stream_capacity(
    &self,
    stream_id: i64,
  ) -> napi::Result<i64> {
    return self.0.stream_capacity(
      stream_id as u64
    ).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
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
  ) -> napi::Result<bool> {
    return self.0.stream_writable(stream_id as u64, len as usize).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
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

  #[napi]
  pub fn readable(&self) -> stream::StreamIter {
    return stream::StreamIter(self.0.readable());
  }

  #[napi]
  pub fn writable(&self) -> stream::StreamIter {
    return stream::StreamIter(self.0.writable());
  }

  #[napi]
  pub fn max_send_udp_payload_size(&self) -> i64 {
    return self.0.max_send_udp_payload_size() as i64;
  }

  #[napi]
  pub fn dgram_recv(
    &mut self,
    mut data: Uint8Array
  ) -> napi::Result<i64> {
    match self.0.dgram_recv(
      &mut data,
    ) {
      Ok(v) => return Ok(v as i64),
      Err(quiche::Error::Done) => return Ok(0),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn dgram_recv_vec(
    &mut self,
  ) -> napi::Result<Option<Uint8Array>> {
    match self.0.dgram_recv_vec() {
      Ok(v) => return Ok(Some(v.into())),
      Err(quiche::Error::Done) => return Ok(None),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn dgram_recv_peek(&self, mut data: Uint8Array, len: i64) -> napi::Result<i64> {
    match self.0.dgram_recv_peek(
      &mut data,
      len as usize,
    ) {
      Ok(v) => return Ok(v as i64),
      Err(quiche::Error::Done) => return Ok(0),
      Err(e) => return Err(napi::Error::from_reason(e.to_string()))
    };
  }

  #[napi]
  pub fn dgram_recv_front_len(&self) -> Option<i64> {
    return self.0.dgram_recv_front_len().map(|v| v as i64);
  }

  #[napi]
  pub fn dgram_recv_queue_len(&self) -> i64 {
    return self.0.dgram_recv_queue_len() as i64;
  }

  #[napi]
  pub fn dgram_recv_queue_byte_size(&self) -> i64 {
    return self.0.dgram_recv_queue_byte_size() as i64;
  }

  #[napi]
  pub fn dgram_send_queue_len(&self) -> i64 {
    return self.0.dgram_send_queue_len() as i64;
  }

  #[napi]
  pub fn dgram_send_queue_byte_size(&self) -> i64 {
    return self.0.dgram_send_queue_byte_size() as i64;
  }

  #[napi]
  pub fn is_dgram_send_queue_full(&self) -> bool {
    return self.0.is_dgram_send_queue_full();
  }

  #[napi]
  pub fn is_dgram_recv_queue_full(&self) -> bool {
    return self.0.is_dgram_recv_queue_full();
  }

  #[napi]
  pub fn dgram_send(
    &mut self,
    data: Uint8Array,
  ) -> napi::Result<()> {
    match self.0.dgram_send(
      &data,
    ) {
      Ok(v) => return Ok(v),
      // If no data is sent, also return Ok
      Err(quiche::Error::Done) => return Ok(()),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
  }

  #[napi]
  pub fn dgram_send_vec(
    &mut self,
    data: Uint8Array
  ) -> napi::Result<()> {
    match self.0.dgram_send_vec(
      data.to_vec()
    ) {
      Ok(v) => return Ok(v),
      Err(quiche::Error::Done) => return Ok(()),
      Err(e) => return Err(napi::Error::from_reason(e.to_string())),
    };
  }

  // We have Task, AsyncTask and async fn that runs things in the tokio runtime
  // It seems the async task could be used here
  // but I'm unclear about how the streams and shit should be done
  // It seems that this is all in-memory computation
  // So we should just not bother any async unless there's REAL IO

  // If an exception occurs, we have to convert to false
  #[napi]
  pub fn dgram_purge_outgoing<F: Fn(Uint8Array) -> napi::Result<bool>>(
    &mut self,
    f: F
  ) -> () {
    return self.0.dgram_purge_outgoing(
      |data: &[u8]| match f(data.into()) {
        Ok(v) => v,
        // If error occurs, this must return false
        _ => false
      }
    );
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
  pub fn timeout(&self) -> Option<i64> {
    return self.0.timeout().map(|t| t.as_millis() as i64);
  }

  #[napi]
  pub fn on_timeout(&mut self) -> () {
    return self.0.on_timeout();
  }

  #[napi]
  pub fn probe_path(
    &mut self,
    local_host: Host,
    peer_host: Host
  ) -> napi::Result<i64> {
    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    let peer_addr: SocketAddr = peer_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    return self.0.probe_path(
      local_addr,
      peer_addr
    )
    .map(|v| v as i64)
    .or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  #[napi]
  pub fn migrate_source(&mut self, local_host: Host) -> napi::Result<i64> {
    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    return self.0.migrate_source(local_addr).map(|v| v as i64).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  #[napi]
  pub fn migrate(&mut self, local_host: Host, peer_host: Host) -> napi::Result<i64> {
    let local_addr: SocketAddr = local_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    let peer_addr: SocketAddr = peer_host.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    return self.0.migrate(local_addr, peer_addr).map(|v| v as i64).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  // So the problem with ConnectionId
  // is that I could make it External
  // But at the same time it turns out that these are just buffers
  // And the connection ID can just be maintained on the JS side
  // So I can just reference those buffers
  // One way is to provide a constructor
  // That allows you pass a buffer in to construct it
  // rather than just taking it
  #[napi]
  pub fn new_source_cid(
    &mut self,
    scid: Uint8Array,
    reset_token: BigInt,
    retire_if_needed: bool
  ) -> napi::Result<i64> {
    return self.0.new_source_cid(
      &quiche::ConnectionId::from_ref(&scid),
      reset_token.get_u128().1,
      retire_if_needed
    ).map(|v| v as i64).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  #[napi]
  pub fn active_source_cids(&self) -> i64 {
    return self.0.active_source_cids() as i64;
  }

  #[napi]
  pub fn max_active_source_cids(&self) -> i64 {
    return self.0.max_active_source_cids() as i64;
  }

  #[napi]
  pub fn source_cids_left(&self) -> i64 {
    return self.0.source_cids_left() as i64;
  }

  #[napi]
  pub fn retire_destination_cid(&mut self, dcid_seq: i64) -> napi::Result<()> {
    return self.0.retire_destination_cid(dcid_seq as u64).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  // Technically this is some sort of struct
  #[napi(ts_return_type = "object")]
  pub fn path_event_next(
    &mut self,
    env: Env
  ) -> napi::Result<Option<napi::JsUnknown>> {
    let path_event: Option<path::PathEvent> = self.0.path_event_next().map(
      |v| v.into()
    );
    return path_event.map(|v| env.to_js_value(&v)).transpose();
  }

  #[napi]
  pub fn retired_scid_next(&mut self) -> Option<Uint8Array> {
    return self.0.retired_scid_next().map(|v| v.into());
    // return self.0.retired_scid_next().map(|v| ConnectionId(v));
    // let connection_id = self.0.retired_scid_next();
    // return connection_id.map(|v| ConnectionId {
    //   id: v.as_ref().into()
    // });
  }

  #[napi]
  pub fn available_dcids(&self) -> i64 {
    return self.0.available_dcids() as i64;
  }

  #[napi]
  pub fn paths_iter(&self, from: Host) -> napi::Result<path::HostIter> {
    let from_addr: SocketAddr = from.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    let socket_addr_iter = self.0.paths_iter(from_addr);
    return Ok(path::HostIter(socket_addr_iter));
  }

  #[napi]
  pub fn close(&mut self, app: bool, err: i64, reason: Uint8Array) -> napi::Result<()> {
    return self.0.close(app, err as u64, &reason).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  #[napi]
  pub fn trace_id(&self) -> String {
    return self.0.trace_id().to_string();
  }

  #[napi]
  pub fn application_proto(&self) -> Uint8Array {
    return self.0.application_proto().to_vec().into();
  }

  #[napi]
  pub fn server_name(&self) -> Option<String> {
    return self.0.server_name().map(|v| v.to_string());
  }

  #[napi]
  pub fn peer_cert_chain(&self) -> Option<Vec<Uint8Array>> {
    return self.0.peer_cert_chain().map(
      |certs| certs.iter().map(
        |cert| cert.to_vec().into()
      ).collect()
    );
  }

  #[napi]
  pub fn session(&self) -> Option<Uint8Array> {
    return self.0.session().map(|s| s.to_vec().into());
  }

  // This requires working on a Buffer/Uint8Array
  // We return the ConnectionId
  // But the problem is that on the JS side
  // ConnectionId is just an opaque object
  // It should be "containing" an inherent buffer
  // Or we just use Uint8Array as our ConnectionId
  // And just do the conversion directly
  // As on the JS side it makes more sense to just say that it is a buffer
  // without further work
  // We could do something like
  // ConnectionId(Uint8Array)
  // Thus wrapping it into something we can use outside
  // and exposing it too?

  #[napi]
  pub fn source_id(&self) -> Uint8Array {
    return self.0.source_id().as_ref().into();
    // return ConnectionId { id: self.0.source_id().as_ref().into() };
    // return ConnectionId(
    //   quiche::ConnectionId::from_vec(self.0.source_id().as_ref().to_vec())
    // );
  }

  #[napi]
  pub fn destination_id(&self) -> Uint8Array {
    return self.0.destination_id().as_ref().into();
    // return ConnectionId { id: self.0.destination_id().as_ref().into() };
    // return ConnectionId(
    //   quiche::ConnectionId::from_vec(self.0.destination_id().as_ref().to_vec())
    // );
  }

  #[napi]
  pub fn is_established(&self) -> bool {
    return self.0.is_established();
  }

  #[napi]
  pub fn is_resumed(&self) -> bool {
    return self.0.is_resumed();
  }

  #[napi]
  pub fn is_in_early_data(&self) -> bool {
    return self.0.is_in_early_data();
  }

  #[napi]
  pub fn is_readable(&self) -> bool {
    return self.0.is_readable();
  }

  #[napi]
  pub fn is_path_validated(
    &self,
    from: Host,
    to: Host
  ) -> napi::Result<bool> {
    let from_addr: SocketAddr = from.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    let to_addr: SocketAddr = to.try_into().or_else(
      |err: io::Error| Err(
        napi::Error::new(napi::Status::InvalidArg, err.to_string())
      )
    )?;
    return self.0.is_path_validated(from_addr, to_addr).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    );
  }

  #[napi]
  pub fn is_draining(&self) -> bool {
    return self.0.is_draining();
  }

  #[napi]
  pub fn is_closed(&self) -> bool {
    return self.0.is_closed();
  }

  #[napi]
  pub fn is_timed_out(&self) -> bool {
    return self.0.is_timed_out();
  }

  #[napi]
  pub fn peer_error(&self) -> Option<ConnectionError> {
    return self.0.peer_error().map(|e| e.clone().into());
  }

  #[napi]
  pub fn local_error(&self) -> Option<ConnectionError> {
    return self.0.local_error().map(|e| e.clone().into());
  }

  #[napi]
  pub fn stats(&self) -> Stats {
    return self.0.stats().into();
  }

  /// Path stats as an array
  ///
  /// Normally this would be an iterator.
  /// However the iterator can only exist in the lifetime of the connection.
  /// This collects the all the data, converts them to our PathStats
  /// Then returns it all as 1 giant array.
  ///
  /// https://stackoverflow.com/q/74609430/582917
  /// https://stackoverflow.com/q/50343130/582917
  #[napi]
  pub fn path_stats(&self) -> Vec<path::PathStats> {
    return self.0.path_stats().map(
      |s| s.into()
    ).collect();
  }
}
