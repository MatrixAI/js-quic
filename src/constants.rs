#![allow(dead_code)]
use napi_derive::napi;

#[napi]
pub const MAX_CONN_ID_LEN: i64 = quiche::MAX_CONN_ID_LEN as i64;

#[napi]
pub const MIN_CLIENT_INITIAL_LEN: i64 = quiche::MIN_CLIENT_INITIAL_LEN as i64;

#[napi]
pub const PROTOCOL_VERSION: i64 = quiche::PROTOCOL_VERSION as i64;

/// This maximum datagram size to SEND to the UDP socket
/// It must be used with `config.set_max_recv_udp_payload_size` and such
/// But on the receiving side, we actually use the maximum which is 65535
#[napi]
pub const MAX_DATAGRAM_SIZE: i64 = 1350;

/// This is the maximum size of the packet to be received from the socket
/// This is what you use to receive packets on the UDP socket
/// And you send it to the connection as well
#[napi]
pub const MAX_UDP_PACKET_SIZE: i64 = 65535;

// We don't need this anymore...
// pub const HTTP_3: [&[u8]; 4] = [b"h3", b"h3-29", b"h3-28", b"h3-27"];
// let alpns: Vec<&'static [u8]> = HTTP_3.to_vec();
// config.set_application_protos(&alpns).or_else(
//   |err| Err(Error::from_reason(err.to_string()))
// )?;
