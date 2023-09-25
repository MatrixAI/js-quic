use napi_derive::napi;
use napi::bindgen_prelude::*;

#[napi]
pub struct Config(pub (crate) quiche::Config);

/// Equivalent to quiche::CongestionControlAlgorithm
#[napi]
pub enum CongestionControlAlgorithm {
  Reno = 0,
  CUBIC = 1,
  BBR = 2,
}

impl From<CongestionControlAlgorithm> for quiche::CongestionControlAlgorithm {
  fn from(algo: CongestionControlAlgorithm) -> Self {
    match algo {
      CongestionControlAlgorithm::Reno => quiche::CongestionControlAlgorithm::Reno,
      CongestionControlAlgorithm::CUBIC => quiche::CongestionControlAlgorithm::CUBIC,
      CongestionControlAlgorithm::BBR => quiche::CongestionControlAlgorithm::BBR,
    }
  }
}

impl From<quiche::CongestionControlAlgorithm> for CongestionControlAlgorithm {
  fn from(item: quiche::CongestionControlAlgorithm) -> Self {
    match item {
      quiche::CongestionControlAlgorithm::Reno => CongestionControlAlgorithm::Reno,
      quiche::CongestionControlAlgorithm::CUBIC => CongestionControlAlgorithm::CUBIC,
      quiche::CongestionControlAlgorithm::BBR => CongestionControlAlgorithm::BBR,
    }
  }
}

#[napi]
impl Config {

  #[napi(constructor)]
  pub fn new() -> Result<Self> {
    let config = quiche::Config::new(
      quiche::PROTOCOL_VERSION
    ).or_else(
      |err| Err(napi::Error::from_reason(err.to_string()))
    )?;
    return Ok(Config(config));
  }

  /// Creates configuration with custom TLS context
  /// Servers must be setup with a key and cert
  #[napi(factory)]
  pub fn with_boring_ssl_ctx(
    verify_peer: bool,
    verify_allow_fail: bool,
    ca: Option<Uint8Array>,
    key: Option<Vec<Uint8Array>>,
    cert: Option<Vec<Uint8Array>>,
    sigalgs: Option<String>,
  ) -> Result<Self> {
    let mut ssl_ctx_builder = boring::ssl::SslContextBuilder::new(
      boring::ssl::SslMethod::tls(),
    ).or_else(
      |e| Err(napi::Error::from_reason(e.to_string()))
    )?;
    let verify_value = if verify_peer {
      boring::ssl::SslVerifyMode::PEER | boring::ssl::SslVerifyMode::FAIL_IF_NO_PEER_CERT
    } else {
      boring::ssl::SslVerifyMode::NONE
    };
    ssl_ctx_builder.set_verify_callback(verify_value, move |pre_verify, _| {
      // Override any validation errors, this is needed so we can request certs but validate them
      //  manually. It's essentially allowing insecure certificates
      if verify_allow_fail {
        true
      } else {
        pre_verify
      }
    });
    // Setup all CA certificates
    if let Some(ca) = ca {
      let mut x509_store_builder = boring::x509::store::X509StoreBuilder::new()
        .or_else(
          |e| Err(napi::Error::from_reason(e.to_string()))
        )?;
      let x509_certs = boring::x509::X509::stack_from_pem(
        &ca.to_vec()
      ).or_else(
        |e| Err(napi::Error::from_reason(e.to_string()))
      )?;
      for x509 in x509_certs.into_iter() {
        x509_store_builder.add_cert(x509)
          .or_else(
            |e| Err(napi::Error::from_reason(e.to_string()))
          )?;
      }
      let x509_store = x509_store_builder.build();
      ssl_ctx_builder.set_verify_cert_store(x509_store)
        .or_else(
          |e| Err(napi::Error::from_reason(e.to_string()))
        )?;
    }
    // Setup all certificates and keys
    if let (Some(key), Some(cert)) = (key, cert) {
      // Right now the boring crate does not provide a straight forward way of
      // setting multiple independent certificate chains. So we are just picking
      // the first key and cert pair.
      let (k, c) = (key[0].to_vec(), cert[0].to_vec());
      let private_key = boring::pkey::PKey::private_key_from_pem(&k)
        .or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?;
      ssl_ctx_builder.set_private_key(&private_key).or_else(
        |e| Err(napi::Error::from_reason(e.to_string()))
      )?;
      let x509_cert_chain = boring::x509::X509::stack_from_pem(
        &c
      ).or_else(
        |err| Err(napi::Error::from_reason(err.to_string()))
      )?;
      for (i, cert) in x509_cert_chain.iter().enumerate() {
        if i == 0 {
          ssl_ctx_builder.set_certificate(cert,).or_else(
            |err| Err(Error::from_reason(err.to_string()))
          )?;
        } else {
          ssl_ctx_builder.add_extra_chain_cert(
            cert.clone(),
          ).or_else(
            |err| Err(Error::from_reason(err.to_string()))
          )?;
        }
      }
    }
    // Setup supported signature algorithms
    if let Some(sigalgs) = sigalgs {
      ssl_ctx_builder.set_sigalgs_list(&sigalgs).or_else(
        |e| Err(napi::Error::from_reason(e.to_string()))
      )?;
    }
    let config = quiche::Config::with_boring_ssl_ctx_builder(
      quiche::PROTOCOL_VERSION,
      ssl_ctx_builder,
    ).or_else(
      |e| Err(Error::from_reason(e.to_string()))
    )?;
    return Ok(Config(config));
  }

  #[napi]
  pub fn load_cert_chain_from_pem_file(&mut self, file: String) -> Result<()> {
    return self.0.load_cert_chain_from_pem_file(&file).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn load_priv_key_from_pem_file(&mut self, file: String) -> Result<()> {
    return self.0.load_priv_key_from_pem_file(&file).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn load_verify_locations_from_file(&mut self, file: String) -> Result<()> {
    return self.0.load_verify_locations_from_file(&file).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn load_verify_locations_from_directory(&mut self, dir: String) -> Result<()> {
    return self.0.load_verify_locations_from_directory(&dir).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn verify_peer(&mut self, verify: bool) -> () {
    return self.0.verify_peer(verify);
  }

  #[napi]
  pub fn grease(&mut self, grease: bool) -> () {
    return self.0.grease(grease);
  }

  #[napi]
  pub fn log_keys(&mut self) -> () {
    return self.0.log_keys();
  }

  #[napi]
  pub fn set_ticket_key(&mut self, key: Uint8Array) -> Result<()> {
    return self.0.set_ticket_key(&key).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn enable_early_data(&mut self) -> () {
    return self.0.enable_early_data();
  }

  #[napi]
  pub fn set_application_protos(
    &mut self,
    protos_list: Vec<String>,
  ) -> Result<()> {
    let protos_list = protos_list.iter().map(
      |proto| proto.as_bytes()
    ).collect::<Vec<&[u8]>>();
    return self.0.set_application_protos(&protos_list).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn set_application_protos_wire_format(
    &mut self,
    protos: Uint8Array
  ) -> Result<()> {
    return self.0.set_application_protos_wire_format(&protos).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn set_max_idle_timeout(&mut self, timeout: i64) -> () {
    self.0.set_max_idle_timeout(timeout as u64);
  }

  #[napi]
  pub fn set_max_recv_udp_payload_size(&mut self, size: i64) -> () {
    return self.0.set_max_recv_udp_payload_size(
      size as usize
    );
  }

  #[napi]
  pub fn set_max_send_udp_payload_size(&mut self, size: i64) -> () {
    return self.0.set_max_send_udp_payload_size(
      size as usize
    );
  }

  #[napi]
  pub fn set_initial_max_data(&mut self, v: i64) -> () {
    return self.0.set_initial_max_data(v as u64);
  }

  #[napi]
  pub fn set_initial_max_stream_data_bidi_local(&mut self, v: i64) -> () {
    return self.0.set_initial_max_stream_data_bidi_local(v as u64);
  }

  #[napi]
  pub fn set_initial_max_stream_data_bidi_remote(&mut self, v: i64) -> () {
    return self.0.set_initial_max_stream_data_bidi_remote(v as u64);
  }

  #[napi]
  pub fn set_initial_max_stream_data_uni(&mut self, v: i64) -> () {
    return self.0.set_initial_max_stream_data_uni(v as u64);
  }

  #[napi]
  pub fn set_initial_max_streams_bidi(&mut self, v: i64) -> () {
    return self.0.set_initial_max_streams_bidi(v as u64);
  }

  #[napi]
  pub fn set_initial_max_streams_uni(
    &mut self,
    v: i64
  ) -> () {
    return self.0.set_initial_max_streams_uni(
      v as u64
    );
  }

  #[napi]
  pub fn set_ack_delay_exponent(&mut self, v: i64) -> () {
    return self.0.set_ack_delay_exponent(
      v as u64
    );
  }

  #[napi]
  pub fn set_max_ack_delay(&mut self, v: i64) -> () {
    return self.0.set_max_ack_delay(
      v as u64
    );
  }

  #[napi]
  pub fn set_active_connection_id_limit(
    &mut self,
    v: i64
  ) -> () {
    return self.0.set_active_connection_id_limit(v as u64);
  }

  #[napi]
  pub fn set_disable_active_migration(&mut self, v: bool) -> () {
    return self.0.set_disable_active_migration(v);
  }

  #[napi]
  pub fn set_cc_algorithm_name(&mut self, name: String) -> Result<()> {
    return self.0.set_cc_algorithm_name(&name).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    );
  }

  #[napi]
  pub fn set_cc_algorithm(&mut self, algo: CongestionControlAlgorithm) -> () {
    return self.0.set_cc_algorithm(algo.into());
  }

  #[napi]
  pub fn enable_hystart(&mut self, v: bool) {
    return self.0.enable_hystart(v);
  }

  #[napi]
  pub fn enable_pacing(&mut self, v: bool) {
    return self.0.enable_pacing(v);
  }

  #[napi]
  pub fn enable_dgram(
    &mut self,
    enabled: bool,
    recv_queue_len: i64,
    send_queue_len: i64,
  ) -> () {
    return self.0.enable_dgram(
      enabled,
      recv_queue_len as usize,
      send_queue_len as usize
    );
  }

  #[napi]
  pub fn set_max_stream_window(&mut self, v: i64) {
    return self.0.set_max_stream_window(v as u64);
  }

  #[napi]
  pub fn set_max_connection_window(&mut self, v: i64) -> () {
    return self.0.set_max_connection_window(v as u64);
  }

  #[napi]
  pub fn set_stateless_reset_token(&mut self, v: Option<BigInt>) -> () {
    return self.0.set_stateless_reset_token(
      v.map(|v| v.get_u128().1)
    );
  }

  #[napi]
  pub fn set_disable_dcid_reuse(&mut self, v: bool) -> () {
    return self.0.set_disable_dcid_reuse(v);
  }
}
