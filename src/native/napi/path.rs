use napi_derive::napi;
use napi::bindgen_prelude::*;
// use napi::bindgen_prelude::{
//   Generator
// };
use serde::{Serialize, Deserialize};
use crate::connection;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PathEvent {
  New { local: connection::HostPort, peer: connection::HostPort },
  Validated { local: connection::HostPort, peer: connection::HostPort },
  FailedValidation { local: connection::HostPort, peer: connection::HostPort },
  Closed { local: connection::HostPort, peer: connection::HostPort },
  ReusedSourceConnectionId {
    seq: u64,
    old: (connection::HostPort, connection::HostPort),
    new: (connection::HostPort, connection::HostPort),
  },
  PeerMigrated {
    old: connection::HostPort,
    new: connection::HostPort,
  }
}

impl From<quiche::PathEvent> for PathEvent {
  fn from(path_event: quiche::PathEvent) -> Self {
    match path_event {
      quiche::PathEvent::New(local, peer) => PathEvent::New {
        local: connection::HostPort::from(local),
        peer: connection::HostPort::from(peer),
      },
      quiche::PathEvent::Validated(local, peer) => PathEvent::Validated {
        local: connection::HostPort::from(local),
        peer: connection::HostPort::from(peer),
      },
      quiche::PathEvent::FailedValidation(local, peer) => PathEvent::FailedValidation {
        local: connection::HostPort::from(local),
        peer: connection::HostPort::from(peer),
      },
      quiche::PathEvent::Closed(local, peer) => PathEvent::Closed {
        local: connection::HostPort::from(local),
        peer: connection::HostPort::from(peer),
      },
      quiche::PathEvent::ReusedSourceConnectionId(seq, old, new) => PathEvent::ReusedSourceConnectionId {
        seq,
        old: (connection::HostPort::from(old.0), connection::HostPort::from(old.1)),
        new: (connection::HostPort::from(new.0), connection::HostPort::from(new.1)),
      },
      quiche::PathEvent::PeerMigrated(old, new) => PathEvent::PeerMigrated {
        old: connection::HostPort::from(old),
        new: connection::HostPort::from(new),
      },
    }
  }
}

// This is an iterator of the host
#[napi(iterator)]
pub struct HostIter(pub (crate) quiche::SocketAddrIter);

#[napi]
impl Generator for HostIter {
  type Yield = connection::HostPort;
  type Next = ();
  type Return = ();

  fn next(&mut self, _value: Option<Self::Next>) -> Option<Self::Yield> {
    return self.0.next().map(
      |socket_addr| socket_addr.into()
    );
  }
}

/// Equivalent to quiche::PathStats
///
/// This is missing the validation_state because it is in a private module
/// that I cannot access
#[napi(object)]
pub struct PathStats {
  pub local_host: connection::HostPort,
  pub peer_host: connection::HostPort,
  pub active: bool,
  pub recv: i64,
  pub sent: i64,
  pub lost: i64,
  pub retrans: i64,
  pub rtt: i64,
  pub cwnd: i64,
  pub sent_bytes: i64,
  pub recv_bytes: i64,
  pub lost_bytes: i64,
  pub stream_retrans_bytes: i64,
  pub pmtu: i64,
  pub delivery_rate: i64,
}

impl From<quiche::PathStats> for PathStats {
  fn from(path_stats: quiche::PathStats) -> Self {
    PathStats {
      local_host: connection::HostPort::from(path_stats.local_addr),
      peer_host: connection::HostPort::from(path_stats.peer_addr),
      active: path_stats.active,
      recv: path_stats.recv as i64,
      sent: path_stats.sent as i64,
      lost: path_stats.lost as i64,
      retrans: path_stats.retrans as i64,
      rtt: path_stats.rtt.as_millis() as i64,
      cwnd: path_stats.cwnd as i64,
      sent_bytes: path_stats.sent_bytes as i64,
      recv_bytes: path_stats.recv_bytes as i64,
      lost_bytes: path_stats.lost_bytes as i64,
      stream_retrans_bytes: path_stats.stream_retrans_bytes as i64,
      pmtu: path_stats.pmtu as i64,
      delivery_rate: path_stats.delivery_rate as i64,
    }
  }
}

#[napi(iterator)]
pub struct PathStatsIter(pub (crate) Box<dyn Iterator<Item = quiche::PathStats>>);

#[napi]
impl Generator for PathStatsIter {
  type Yield = PathStats;
  type Next = ();
  type Return = ();

  fn next(&mut self, _value: Option<Self::Next>) -> Option<Self::Yield> {
    return self.0.next().map(
      |path_stats| path_stats.into()
    );
  }
}
