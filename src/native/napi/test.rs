#[macro_use]
extern crate log;

use std::net::ToSocketAddrs;

use ring::rand::*;

const MAX_DATAGRAM_SIZE: usize = 1350;
const HTTP_REQ_STREAM_ID: u64 = 4;

// FIXME: this is a temp test file, need to remove before merging

#[cfg(test)]
mod tests {

  #[test]
  fn test_prof() {
    let mut buf = [0; 65535];
    let mut out = [0; MAX_DATAGRAM_SIZE];

    let mut args = std::env::args();

    let cmd = &args.next().unwrap();

    if args.len() != 1 {
      println!("Usage: {cmd} URL");
      println!("\nSee tools/apps/ for more complete implementations.");
      return;
    }

    let url = url::Url::parse(&args.next().unwrap()).unwrap();

    // Resolve server address.
    let peer_addr = url.to_socket_addrs().unwrap().next().unwrap();

    // Bind to INADDR_ANY or IN6ADDR_ANY depending on the IP family of the
    // server address. This is needed on macOS and BSD variants that don't
    // support binding to IN6ADDR_ANY for both v4 and v6.
    let bind_addr = match peer_addr {
      std::net::SocketAddr::V4(_) => "0.0.0.0:0",
      std::net::SocketAddr::V6(_) => "[::]:0",
    };

    // Create the configuration for the QUIC connection.
    let mut config = quiche::Config::new(quiche::PROTOCOL_VERSION).unwrap();

    // *CAUTION*: this should not be set to `false` in production!!!
    config.verify_peer(false);

    config
      .set_application_protos(&[
        b"hq-interop",
        b"hq-29",
        b"hq-28",
        b"hq-27",
        b"http/0.9",
      ])
      .unwrap();

    config.set_max_idle_timeout(5000);
    config.set_max_recv_udp_payload_size(MAX_DATAGRAM_SIZE);
    config.set_max_send_udp_payload_size(MAX_DATAGRAM_SIZE);
    config.set_initial_max_data(10_000_000);
    config.set_initial_max_stream_data_bidi_local(1_000_000);
    config.set_initial_max_stream_data_bidi_remote(1_000_000);
    config.set_initial_max_streams_bidi(100);
    config.set_initial_max_streams_uni(100);
    config.set_disable_active_migration(true);

    // Generate a random source connection ID for the connection.
    let mut scid = [0; quiche::MAX_CONN_ID_LEN];
    SystemRandom::new().fill(&mut scid[..]).unwrap();

    let scid = quiche::ConnectionId::from_ref(&scid);

    // Get local address.
    let local_addr = socket.local_addr().unwrap();

    // Create a QUIC connection and initiate handshake.
    let mut client_conn =
      quiche::connect(url.domain(), &scid, local_addr, peer_addr, &mut config)
        .unwrap();

    let (write, send_info) = client_conn.send(&mut out);
    let pkt_buf = &mut buf[..write];

    // Parse the QUIC packet's header.
    let hdr = match quiche::Header::from_slice(
      pkt_buf,
      quiche::MAX_CONN_ID_LEN,
    ) {
      Ok(v) => v,

      Err(e) => {
        panic!("Parsing packet header failed: {:?}", e);
      },
    };

    let server_conn_id = ring::hmac::sign(&conn_id_seed, &hdr.dcid);
    let server_conn_id = &server_conn_id.as_ref()[..quiche::MAX_CONN_ID_LEN];
    let server_conn_id = server_conn_id.to_vec().into();

    let mut scid = [0; quiche::MAX_CONN_ID_LEN];
    scid.copy_from_slice(&server_conn_id);

    let scid = quiche::ConnectionId::from_ref(&scid);

    // Token is always present in Initial packets.
    let token = hdr.token.as_ref().unwrap();

    // Do stateless retry if the client didn't send a token.
    let new_token = mint_token(&hdr, &from);

    let len = quiche::retry(
      &hdr.scid,
      &hdr.dcid,
      &scid,
      &new_token,
      hdr.version,
      &mut out,
    )
      .unwrap();

    let out = &out[..len];

    let read = match client_conn.recv(&mut out, recv_info) {
      Ok(v) => v,

      Err(e) => {
        panic!("recv failed: {:?}", e);
      },
    };

    let (write, send_info) = client_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];

    let server_conn = quiche::accept(
      &scid,
      odcid.as_ref(),
      local_addr,
      from,
      &mut server_config,
    )
      .unwrap();

    let read = match server_conn.recv(out, recv_info) {
      Ok(v) => v,

      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client <-initial- server
    let (write, pkt_info) = server_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match client_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client -initial-> server
    let (write, pkt_info) = client_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match server_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client <-handshake- server
    let (write, pkt_info) = server_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match client_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client -handshake-> server
    let (write, pkt_info) = client_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match server_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client <-short- server
    let (write, pkt_info) = server_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match client_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };

    // Client -short-> server
    let (write, pkt_info) = client_conn.send(&mut out).expect("initial send failed");
    let out = &out[..write];
    let read = match server_conn.recv(out, pkt_info) {
      Ok(v) => v,
      Err(e) => {
        panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
      },
    };
    // Both are established

    // main loop
    let message = [0; 1024];

    for n in 1..5000 {
      client_conn.stream_send(0, &message, false);
      // sending forward packets
      loop {
        let (write, pkt_info) = match client_conn.send(&mut out){
          Ok(v) => v,
          Err(quiche::Error::Done) => {
            break;
          },
          Err(e) => {
            panic!("{} recv failed: {:?}", client_conn.trace_id(), e);
          },
        };
        let out = &out[..write];
        let read = match server_conn.recv(out, pkt_info) {
          Ok(v) => v,
          Err(e) => {
            panic!("{} recv failed: {:?}", server_conn.trace_id(), e);
          },
        };
      };
      // Processing streams
      for s in client.conn.readable() {
        while let Ok((read, fin)) =
          client.conn.stream_recv(s, &mut buf)
        {
          // Do nothing
        }
      }
      // Processing reverse packets
      'reverse: loop {
        let (write, from) = match server_conn.send(&mut out) {
          Ok(v) => v,
          Err(quiche::Error::Done) => {
            break 'reverse;
          },
          Err(e) => {
            panic!("{} recv failed: {:?}", server_conn.trace_id(), e);
          },
        };
        let out = &out[..write];
        let recv_info = quiche::RecvInfo {
          from,
          to: local,
        };
        let read = match client_conn.recv(out, recv_info) {
          Ok(v) => v,
          Err(e) => {
            panic!("{} recv failed: {:?}", client.conn.trace_id(), e);
          },
        };
      };
    }
  }
}

