import dgram from 'dgram';

async function main () {

  const socket = dgram.createSocket({
    type: 'udp6',
    reuseAddr: false,
    ipv6Only: false,
  });

  // This uses `getaddrinfo` under the hood
  // What happens if the HOST resolves to a IPv4 address?
  // socket.bind(0, '::', () => {
  //   console.log(socket.address());
  // });

  socket.on('error', (e) => {
    console.log('Handled ERROR');
  });

  socket.send(
    Buffer.from('abc'),
    1111,
    'sodfiudsf',
    (e) => {
      console.log('got an e');
      // socket.close();
    }
  );

  // not all callbacks even have an error parameter at all
  // some like socketListen just is void
  // that's crazy

  console.log('DONE');

}

void main();
