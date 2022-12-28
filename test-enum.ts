enum Type {
  Initial = 0,
  Retry = 1,
  Handshake = 2,
  ZeroRTT = 3,
  VersionNegotiation = 4,
  Short = 5
}

console.log(Type[0]);
console.log(Type['Initial']);
