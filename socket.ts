import dgram from 'dgram';

async function main () {

  const socket = dgram.createSocket({
    type: 'udp6',
    reuseAddr: false,
    ipv6Only: false,
  });

  // This uses `getaddrinfo` under the hood
  // What happens if the HOST resolves to a IPv4 address?
  socket.bind(0, 'localhost', () => {
    console.log(socket.address());
  });

  socket.on('error', (e) => {
    console.log('ERROR', e);
  });

  console.log('DONE');

}

void main();
