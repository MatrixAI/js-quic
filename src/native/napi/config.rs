// use core::panicking::panic;
use napi_derive::napi;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::thread;
use napi::{
  JsUnknown,
};
use futures::executor::block_on;

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
      |err| Err(Error::from_reason(err.to_string()))
    )?;
    return Ok(Config(config));
  }

  #[napi(factory)]
  pub fn with_boring_ssl_ctx(
    env: Env,
    cert_pem: Option<Uint8Array>,
    key_pem: Option<Uint8Array>,
    supported_key_algos: Option<String>,
    ca_cert_pem: Option<Uint8Array>,
    verify_peer: bool,
    verify_callback: JsFunction,
  ) -> Result<Self> {
    let mut ssl_ctx_builder = boring::ssl::SslContextBuilder::new(
      boring::ssl::SslMethod::tls(),
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
    )?;

    let tsfn: ThreadsafeFunction<(u32, String), ErrorStrategy::CalleeHandled> =
      verify_callback
      .create_threadsafe_function(0, |ctx| {
        let(num, s) = ctx.value;
        println!("value: {}", num);
        println!("value: {}", s);
        ctx.env.create_string("Hello!").map(|v| vec![v])
      })?;

    let verify_value = if verify_peer {boring::ssl::SslVerifyMode::PEER | boring::ssl::SslVerifyMode::FAIL_IF_NO_PEER_CERT }
    else { boring::ssl::SslVerifyMode::NONE };
    ssl_ctx_builder.set_verify_callback(verify_value, move |succeeded, cert_store| {
      println!("normalSuc? {}", succeeded);

      // Converting current cert
      let cert: Option<String> = match cert_store.current_cert() {
        Some(cert) => {
          match cert.to_pem() {
            Ok(pem) => Some(String::from_utf8(pem).unwrap()),
            Err(_) => None,
          }
        },
        _ => None,
      };
      // if let Some(cert) = cert {
      //   println!("pem\n{}", cert);
      // } else {
      //   println!("No current cert?");
      //   return false;
      // }

      // converting cert chain
      let chain: Option<Vec<String>> = match cert_store.chain() {
        Some(stack) => {
          Some(stack.into_iter().filter_map(|cert| {
            match cert.to_pem() {
              Ok(pem) => Some(String::from_utf8(pem).unwrap()),
              Err(_) => None,
            }
          })
            .collect::<Vec<String>>())
        },
        _ => None,
      };

      // if let Some(chain) = chain {
      //   println!("ayyyy");
      //   for pem in chain {
      //     println!("pem:\n{}", pem);
      //   }
      // } else {
      //   println!("No chain?");
      //   return false;
      // }

      // let cert_jsval = match cert {
      //   Some(cert) => env.create_string(&cert).unwrap().into_unknown(),
      //   None => env.get_undefined().unwrap().into_unknown(),
      // };
      // let chain_jsval = match chain {
      //   Some(chain) => {
      //     for pem in chain {
      //       return env.create_string(pem)?;
      //     }
      //   },
      //   None => env.get_undefined()?,
      // };
      //
      // let args = &vec![
      //   cert_jsval,
      //   // chain_jsval,
      // ];
      // let result = verify_callback.call(None, args).unwrap();
      // let val = result
      //   .coerce_to_bool().unwrap()
      //   .get_value().unwrap();
      // println!("result was: {}", val);

      println!("Making native call");
      let result = tsfn.call_async::<napi::JsBoolean>(
        Ok((100, "hello!".to_string())),
      );
      println!("waiting....");
      let asd = block_on(result);
      let val = asd
        .unwrap()
        .get_value()
        .unwrap();
      println!("Result!: {}", val);

      succeeded
    });
    // Processing and adding the cert chain
    if let Some(cert_pem) = cert_pem {
      let x509_cert_chain = boring::x509::X509::stack_from_pem(
        &cert_pem.to_vec()
      ).or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?;
      for (i, cert) in x509_cert_chain.iter().enumerate() {
        if i == 0 {
          ssl_ctx_builder.set_certificate(
            cert,
          ).or_else(
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
    // Processing and adding the private key
    if let Some(key_pem) = key_pem {
      let private_key = boring::pkey::PKey::private_key_from_pem(&key_pem)
        .or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?;
      ssl_ctx_builder.set_private_key(&private_key)
        .or_else(
          |err| Err(Error::from_reason(err.to_string()))
        )?;
    }
    // Adding supported private key algorithms
    if let Some(supported_key_algos) = supported_key_algos {
      ssl_ctx_builder.set_sigalgs_list(&supported_key_algos)
        .or_else(
          |err| Err(Error::from_reason(err.to_string()))
        )?;
    }
    // Processing CA certificate
    if let Some(ca_cert_pem) = ca_cert_pem {
      let x509_certs = boring::x509::X509::stack_from_pem(
        &ca_cert_pem.to_vec()
      ).or_else(
        |err| Err(Error::from_reason(err.to_string()))
      )?;
      let mut x509_store_builder = boring::x509::store::X509StoreBuilder::new()
        .or_else(
          |err| Err(Error::from_reason(err.to_string()))
        )?;
      for x509 in x509_certs.into_iter() {
        x509_store_builder.add_cert(x509)
          .or_else(
            |err| Err(Error::from_reason(err.to_string()))
          )?;
      }
      let x509_store = x509_store_builder.build();
      ssl_ctx_builder.set_verify_cert_store(x509_store)
        .or_else(
          |err| Err(Error::from_reason(err.to_string()))
        )?;
    }
    let ssl_ctx= ssl_ctx_builder.build();
    let config = quiche::Config::with_boring_ssl_ctx(
      quiche::PROTOCOL_VERSION,
      ssl_ctx,
    ).or_else(
      |err| Err(Error::from_reason(err.to_string()))
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
