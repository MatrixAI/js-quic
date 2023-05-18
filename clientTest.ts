import dgram from 'dgram';
import * as utils from './src/utils';
import { buildQuicheConfig } from './src/config';
import { quiche } from './src/native';
import * as testsUtils from './tests/utils';
import { promise } from './src/utils';
import { SendInfo } from './src/native/types';
import { clearTimeout } from 'timers';
import path from 'path';


async function main () {
  const MAX_DATAGRAM_SIZE = 1350;
  const buf = Buffer.alloc(65535, 0);
  const out = Buffer.alloc(quiche.MAX_DATAGRAM_SIZE, 0);
  const message = Buffer.from('Hello!');
  const emptyBuffer = Buffer.alloc(0, 0);

  const socket = dgram.createSocket({
    type: 'udp4',
    reuseAddr: false,
  })

  const host = "127.0.0.1";
  const port = 4433;
  const localPort = 55555;
  const STREAMS = 1000;
  const MESSAGES = 200;

  type StreamData = {
    messagesLeft: number;
  }
  const streamMap: Map<number, StreamData> = new Map();

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

    enableEarlyData: false,
    grease: false,
    logKeys: path.resolve(path.join(__dirname, "./tmp/key2.log")),
    supportedPrivateKeyAlgos: undefined,
    tlsConfig: undefined,
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

  const conn = quiche.Connection.connect(
    null,
    Buffer.from(scidBuffer),
    {
      host,
      port: localPort,
    },
    {
      host,
      port,
    },
    config,
  );

  conn.setKeylog(path.resolve(path.join(__dirname, "./tmp/key2.log")));

  let timeout: NodeJS.Timeout | null = null;
  let deadline: number = Infinity;
  let req_sent = false;
  let receivedEvent = promise();
  let timeoutEvent = promise();
  let writableEvent = promise();



  const clearTimer = () => {
    if (timeout != null){
      // console.log('cleared timeout!');
      clearTimeout(timeout);
      timeout = null;
      deadline = Infinity;
    }
  }

  const checkTimeout = () => {
    const time = conn.timeout();
    // console.log('time: ', time)
    if (time == null ) {
      // console.log('timer cleared');
      //clear timeout
      clearTimer();
    } else if(time == 0) {
      // instant timeout
      // console.log('instant timeout');
      clearTimer();
      setImmediate(handleTimeout);
    } else {
      // Update the timer
      const newDeadline = Date.now() + time;
      if (newDeadline < deadline) {
        // console.log('updating timer', time);
        clearTimer();
        deadline = newDeadline;
        timeout = setTimeout(handleTimeout, time);
      }
    }
  }
  const handleTimeout = () => {
    // console.log('timed out!');
    conn.onTimeout();
    deadline = Infinity;
    checkTimeout();
    timeoutEvent.resolveP();
    timeoutEvent = promise();
  }

  const handleRead = (
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
        host,
        port: remoteInfo.port,
      },
    };
    console.log(recvInfo);
    conn.recv(data, recvInfo);
    receivedEvent.resolveP();
    receivedEvent = promise();
    checkTimeout();
  }
  socket.on('message', handleRead);

  const [write, sendInfo] = conn.send(out);

  await socketSend(out, 0, write, sendInfo.to.port, sendInfo.to.host).catch((e) => {
    console.error(e);
    throw e;
  });

  checkTimeout();

  writableEvent.resolveP();
  while(true) {
    // Waiting for events to happen.
    // Writable events will be happening most of the time.
    await Promise.race([
      receivedEvent.p,
      timeoutEvent.p,
      writableEvent.p,
    ]);
    if (conn.isClosed()) {
      console.log('Connection closed', conn.stats());
      break;
    }
    // initialize streams
    if (conn.isEstablished() && !req_sent) {
      for (let i = 0; i < STREAMS; i++) {
        const streamId = i * 4;

        // console.log('creating stream!');
        conn.streamSend(streamId, emptyBuffer, false);
        streamMap.set(streamId, {
          messagesLeft: MESSAGES,
        });
      }
      console.log('done creating streams');
      req_sent = true;
    }

    // process readable data
    for (const streamId of conn.readable()) {
      // consume messages, no processing
      while(true) {
        try  {
          const [_read, fin] = conn.streamRecv(streamId, buf);
          if (fin) console.log('stream finished: ', streamId);
        } catch (e) {
          if (e.message == 'Done') break;
          throw e;
        }
      }
    }

    // process writable
    let writables = false;
    for (const streamId of conn.writable()) {
      writables = true;
      const streamData = streamMap.get(streamId);
      if (streamData == null) throw Error('Missing stream data');
      if (streamData.messagesLeft > 0) streamData.messagesLeft--;
      const fin = streamData.messagesLeft <= 0;

      // send messages
      if (fin) {
        try {
          conn.streamSend(streamId, emptyBuffer, true);
          streamMap.delete(streamId);
          if (streamMap.size === 0) console.log('finished all streams')
        } catch (e) {
          if(e.message == 'Done') {
            // console.log('sending returned done');
            continue
          }
          throw e;
        }
      } else {
        try {
          conn.streamSend(streamId, message, false);
          // console.log('wrote message', streamId)
        } catch (e) {
          if(e.message == 'Done') {
            // console.log('sending returned done');
            continue;
          }
          throw e;
        }
      }
    }
    if (writables) writableEvent.resolveP();
    else writableEvent = promise();

    // Processing outgoing packets
    while(true) {
      let write: number;
      let sendInfo: SendInfo;
      try {
        [write, sendInfo] = conn.send(out);
      } catch (e) {
        if (e.message == 'Done') break;
        throw e;
      }
      await socketSend(out, 0, write, sendInfo.to.port, sendInfo.to.host);
      // console.log('packet sent');
      checkTimeout();
    }

    if (conn.isClosed()) {
      console.log('Connection closed', conn.stats());
      break;
    }
  }
  console.log('ended');
  if(conn.isTimedOut()) console.log('connection timed out');
  console.log('errors? ', conn.peerError(), conn.localError());

  await socketClose();
}

main().then(() => {});
