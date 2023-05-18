import dgram from 'dgram';
import * as utils from './src/utils';
import { buildQuicheConfig } from './src/config';
import { Header, quiche } from './src/native';
import * as testsUtils from './tests/utils';
import { promise } from './src/utils';
import { SendInfo } from './src/native/types';
import { clearTimeout } from 'timers';
import QUICConnectionId from './src/QUICConnectionId';
import { Connection } from './src/native/types';
import path from 'path';


async function main () {
  const MAX_DATAGRAM_SIZE = 1350;
  const out = Buffer.alloc(quiche.MAX_DATAGRAM_SIZE, 0);
  const emptyBuffer = Buffer.alloc(0, 0);
  type ConnectionData = {
    conn: Connection;
    timeout: NodeJS.Timeout | null;
    deadline: number;
    streams: Set<number>;
  }
  const connectionMap: Map<string, ConnectionData> = new Map();

  const socket = dgram.createSocket({
    type: 'udp4',
    reuseAddr: false,
  })

  const host = "127.0.0.1";
  const localPort = 4433;

  const socketBind = utils.promisify(socket.bind).bind(socket);
  const socketClose = utils.promisify(socket.close).bind(socket);
  const socketSend = utils.promisify(socket.send).bind(socket);

  const { p: errorP, rejectP: rejectErrorP } = utils.promise();
  socket.once('error', rejectErrorP);
  await Promise.race([
    errorP,
    socketBind(localPort)
  ])
  console.log('bound', localPort);

  const config = buildQuicheConfig({
    verifyPeer: false,
    applicationProtos: [
      "hq-interop",
      "hq-29",
      "hq-28",
      "hq-27",
      "http/0.9",
    ],
    maxIdleTimeout: 5000,
    maxRecvUdpPayloadSize: MAX_DATAGRAM_SIZE,
    maxSendUdpPayloadSize: MAX_DATAGRAM_SIZE,
    initialMaxData: 10_000_000,
    initialMaxStreamDataBidiLocal: 1_000_000_000,
    initialMaxStreamDataBidiRemote: 1_000_000_000,
    initialMaxStreamsBidi: 100000,
    initialMaxStreamsUni: 100000,
    disableActiveMigration: true,
    tlsConfig: {
      privKeyFromPemFile: "tests/fixtures/certs/rsa1.key",
      certChainFromPemFile: "tests/fixtures/certs/rsa1.crt",
    },

    enableEarlyData: false,
    grease: false,
    logKeys: path.resolve(path.join(__dirname, "./tmp/key1.log")),
    supportedPrivateKeyAlgos: undefined,
    verifyFromPemFile: undefined,
    verifyPem: undefined
  })

  const crypto = {
    key: await testsUtils.generateKey(),
    ops: {
      sign: testsUtils.sign,
      verify: testsUtils.verify,
      randomBytes: testsUtils.randomBytes,
    },
  };

  const scidBuffer = new ArrayBuffer(quiche.MAX_CONN_ID_LEN);
  await crypto.ops.randomBytes(scidBuffer);

  let receivedEvent = promise();
  let timeoutEvent = promise();
  let writableEvent = promise();

  const clearTimer = (client: ConnectionData) => {
    if (client.timeout != null){
      // console.log('cleared timeout!');
      clearTimeout(client.timeout);
      client.timeout = null;
      client.deadline = Infinity;
    }
  }

  const checkTimeout = (client: ConnectionData) => {
    const time = client.conn.timeout();
    // console.log('time: ', time)
    if (time == null ) {
      // console.log('timer cleared');
      //clear timeout
      clearTimer(client);
    } else if(time == 0) {
      // instant timeout
      // console.log('instant timeout');
      clearTimer(client);
      setImmediate(() => handleTimeout(client));
    } else {
      // Update the timer
      const newDeadline = Date.now() + time;
      if (newDeadline < client.deadline) {
        // console.log('updating timer', time);
        clearTimer(client);
        client.deadline = newDeadline;
        // @ts-ignore: idk
        client.timeout = setTimeout(() => handleTimeout(client), time);
      }
    }
  }
  const handleTimeout = (client: ConnectionData) => {
    // console.log('timed out!');
    client.conn.onTimeout();
    client.deadline = Infinity;
    checkTimeout(client);
    timeoutEvent.resolveP();
    timeoutEvent = promise();
  }

  const handleRead = async (
    data: Buffer,
    remoteInfo: dgram.RemoteInfo,
  ) => {
    // console.log('received data!', data.byteLength);
    const recvInfo = {
      to: {
        host,
        port: localPort,
      },
      from: {
        host: remoteInfo.address,
        port: remoteInfo.port,
      },
    };

    let header: Header;
    try {
      header = quiche.Header.fromSlice(data, quiche.MAX_CONN_ID_LEN);
    } catch (e) {
      // `InvalidPacket` means that this is not a QUIC packet.
      // If so, then we just ignore the packet.
      return;
    }

    const dcid: Uint8Array = header.dcid;
    let scid: Uint8Array = new QUICConnectionId(
      await crypto.ops.sign(
        crypto.key,
        dcid, // <- use DCID (which is a copy), otherwise it will cause memory problems later in the NAPI
      ),
      0,
      quiche.MAX_CONN_ID_LEN,
    );

    let client: ConnectionData;
    if (!connectionMap.has(Buffer.from(dcid).toString())) {
      if (header.ty !== quiche.Type.Initial) {
        console.log(`QUIC packet must be Initial for new connections`);
        return;
      }
      // Version Negotiation
      if (!quiche.versionIsSupported(header.version)) {
        console.log(
          `QUIC packet version is not supported, performing version negotiation`,
        );
        const versionDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const versionDatagramLength = quiche.negotiateVersion(
          header.scid,
          header.dcid,
          versionDatagram,
        );
        try {
          await socketSend(
            versionDatagram,
            0,
            versionDatagramLength,
            remoteInfo.port,
            remoteInfo.address,
          );
        } catch {
          return;
        }
        return;
      }
      // At this point we are processing an `Initial` packet.
      // It is expected that token exists, because if it didn't, there would have
      // been a `BufferTooShort` error during parsing.
      const token = header.token!;
      // Stateless Retry
      if (token.byteLength === 0) {
        const token = await mintToken(dcid, remoteInfo.address, crypto);
        const retryDatagram = Buffer.allocUnsafe(quiche.MAX_DATAGRAM_SIZE);
        const retryDatagramLength = quiche.retry(
          header.scid, // Client initial packet source ID
          header.dcid, // Client initial packet destination ID
          scid, // Server's new source ID that is derived
          token,
          header.version,
          retryDatagram,
        );
        try {
          await socketSend(
            retryDatagram,
            0,
            retryDatagramLength,
            remoteInfo.port,
            remoteInfo.address,
          );
        } catch (e) {
          return;
        }
        return;
      }
      // At this point in time, the packet's DCID is the originally-derived DCID.
      // While the DCID embedded in the token is the original DCID that the client first created.
      const dcidOriginal = await validateToken(
        Buffer.from(token),
        remoteInfo.address,
        crypto,
      );
      if (dcidOriginal == null) {
        return;
      }
      // Check that the newly-derived DCID (passed in as the SCID) is the same
      // length as the packet DCID.
      // This ensures that the derivation process hasn't changed.
      if (scid.byteLength !== header.dcid.byteLength) {
        return;
      }
      // Here we shall re-use the originally-derived DCID as the SCID
      scid = new QUICConnectionId(header.dcid);

      console.log('creating new connection')
      const conn = quiche.Connection.accept(
        scid,
        dcidOriginal,
        {
          host: host,
          port: localPort,
        },
        {
          host: remoteInfo.address,
          port: remoteInfo.port,
        },
        config,
      )
      client = {
        deadline: Infinity,
        timeout: null,
        streams: new Set(),
        conn
      }
      connectionMap.set(Buffer.from(scid).toString(), client);
    } else {
      client = connectionMap.get(Buffer.from(dcid).toString())!;
    }

    client.conn.recv(data, recvInfo);

    if (client.conn.isInEarlyData() || client.conn.isEstablished()) {
      // Process writable
      for (const streamId of client.conn.writable()) {
        try {
          // close writables, we only care about readable state for test
          client.conn.streamSend(streamId, emptyBuffer, true);
        } catch (e) {
          if (e.message === 'Done') continue;
          throw e;
        }
      }

      // Process readable
      for (const streamId of client.conn.readable()) {
        // drop data and track finish frame
        client.streams.add(streamId);
        while (true) {
          try {
            const [, fin] = client.conn.streamRecv(streamId, data);
            if (fin) {
              client.streams.delete(streamId)
              console.log("Stream finished! ", streamId, "left", client.streams.size);
            }
          } catch (e) {
            if (e.message === 'Done') break;
            throw e;
          }
        }
      }
    }

    receivedEvent.resolveP();
    receivedEvent = promise();
    checkTimeout(client);
  }

  socket.on('message', handleRead);

  writableEvent.resolveP();
  while(true) {
    // Waiting for events to happen.
    // Writable events will be happening most of the time.
    await Promise.race([
      receivedEvent.p,
      timeoutEvent.p,
    ]);

    // generate outgoing packets
    for (const [cid, client] of connectionMap) {
      while(true) {
        let write: number;
        let sendInfo: SendInfo;
        try {
          [write, sendInfo] = client.conn.send(out);
          console.log(sendInfo);
        } catch (e) {
          if (e.message == 'Done') break;
          throw e;
        }
        await socketSend(out, 0, write, sendInfo.to.port, sendInfo.to.host);
        checkTimeout(client);
      }
      if (client.conn.isClosed()) {
        if(client.conn.isTimedOut()) console.log('connection timed out');
        console.log('errors? ', client.conn.peerError(), client.conn.localError());
        connectionMap.delete(cid)
      }
    }
  }

  await socketClose();
}

async function mintToken(
  dcid: Uint8Array,
  peerHost: string,
  crypto: any
): Promise<Buffer> {
  const msgData = { dcid: Buffer.from(dcid).toString(), host: peerHost };
  const msgJSON = JSON.stringify(msgData);
  const msgBuffer = Buffer.from(msgJSON);
  const msgSig = Buffer.from(
    await crypto.ops.sign(crypto.key, msgBuffer),
  );
  const tokenData = {
    msg: msgBuffer.toString('base64url'),
    sig: msgSig.toString('base64url'),
  };
  const tokenJSON = JSON.stringify(tokenData);
  return Buffer.from(tokenJSON);
}

async function validateToken(
  tokenBuffer: Buffer,
  peerHost: string,
  crypto: any
): Promise<QUICConnectionId | undefined> {
  let tokenData;
  try {
    tokenData = JSON.parse(tokenBuffer.toString());
  } catch {
    return;
  }
  if (typeof tokenData !== 'object' || tokenData == null) {
    return;
  }
  if (
    typeof tokenData.msg !== 'string' ||
    typeof tokenData.sig !== 'string'
  ) {
    return;
  }
  const msgBuffer = Buffer.from(tokenData.msg, 'base64url');
  const msgSig = Buffer.from(tokenData.sig, 'base64url');
  if (!(await crypto.ops.verify(crypto.key, msgBuffer, msgSig))) {
    return;
  }
  let msgData;
  try {
    msgData = JSON.parse(msgBuffer.toString());
  } catch {
    return;
  }
  if (typeof msgData !== 'object' || msgData == null) {
    return;
  }
  if (typeof msgData.dcid !== 'string' || typeof msgData.host !== 'string') {
    return;
  }
  if (msgData.host !== peerHost) {
    return;
  }
  return QUICConnectionId.fromString(msgData.dcid);
}

main().then(() => {});
