use napi_derive::napi;
use napi::bindgen_prelude::{
  Generator
};
use serde::{Serialize, Deserialize};
use crate::connection;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PathEvent {
  New { local: connection::Host, peer: connection::Host},
  Validated { local: connection::Host, peer: connection::Host },
  FailedValidation { local: connection::Host, peer: connection::Host },
  Closed { local: connection::Host, peer: connection::Host },
  ReusedSourceConnectionId {
    seq: u64,
    old: (connection::Host, connection::Host),
    new: (connection::Host, connection::Host),
  },
  PeerMigrated {
    old: connection::Host,
    new: connection::Host,
  }
}

impl From<quiche::PathEvent> for PathEvent {
  fn from(path_event: quiche::PathEvent) -> Self {
    match path_event {
      quiche::PathEvent::New(local, peer) => PathEvent::New {
        local: connection::Host::from(local),
        peer: connection::Host::from(peer),
      },
      quiche::PathEvent::Validated(local, peer) => PathEvent::Validated {
        local: connection::Host::from(local),
        peer: connection::Host::from(peer),
      },
      quiche::PathEvent::FailedValidation(local, peer) => PathEvent::FailedValidation {
        local: connection::Host::from(local),
        peer: connection::Host::from(peer),
      },
      quiche::PathEvent::Closed(local, peer) => PathEvent::Closed {
        local: connection::Host::from(local),
        peer: connection::Host::from(peer),
      },
      quiche::PathEvent::ReusedSourceConnectionId(seq, old, new) => PathEvent::ReusedSourceConnectionId {
        seq,
        old: (connection::Host::from(old.0), connection::Host::from(old.1)),
        new: (connection::Host::from(new.0), connection::Host::from(new.1)),
      },
      quiche::PathEvent::PeerMigrated(old, new) => PathEvent::PeerMigrated {
        old: connection::Host::from(old),
        new: connection::Host::from(new),
      },
    }
  }
}

// This is an iterator of the host
#[napi(iterator)]
pub struct HostIter(pub (crate) quiche::SocketAddrIter);

#[napi]
impl Generator for HostIter {
  type Yield = connection::Host;
  type Next = ();
  type Return = ();

  fn next(&mut self, _value: Option<Self::Next>) -> Option<Self::Yield> {
    return self.0.next().map(
      |socket_addr| socket_addr.into()
    );
  }
}
