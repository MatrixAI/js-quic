mod constants;
mod config;
mod connection;
mod stream;
mod path;
mod packet;

// Creates random connection ID
//
// Relies on the JS runtime to provide the randomness system
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
