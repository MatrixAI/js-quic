# js-quic

staging: [![pipeline status](https://gitlab.com/MatrixAI/open-source/js-quic/badges/staging/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-quic/commits/staging)
master: [![pipeline status](https://gitlab.com/MatrixAI/open-source/js-quic/badges/master/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-quic/commits/master)

QUIC library for TypeScript/JavaScript applications.

This is built on top of Cloudflare's [quiche](https://github.com/cloudflare/quiche) library. It is intended to support Linux, Windows MacOS, Android and iOS. Mobile support is still pending.

Since Cloudflare's quiche is written in Rust. This uses the [napi-rs](https://github.com/napi-rs/napi-rs) binding system compile the native objects for Node.js.

This library focuses only on the QUIC protocol. It does not support HTTP3. You can build HTTP3 on top of this.

## Installation

```sh
npm install --save @matrixai/quic
```

## Usage

See the example executables in `/src/bin`.

## Development

Run `nix-shell`, and once you're inside, you can use:

```sh
# install (or reinstall packages from package.json)
npm install
# build the native objects
npm run prebuild
# build the dist and native objects
npm run build
# run the repl (this allows you to import from ./src)
npm run ts-node
# run the tests
npm run test
# lint the source code
npm run lint
# automatically fix the source
npm run lintfix
```

### Quiche

To understand how to develop this, it is important to understand how quiche works.

Clone the https://github.com/cloudflare/quiche project. It's multi-workspace Cargo project.

You can build and run their examples located in `/quiche/examples/`:

```sh
cargo build --examples
cargo run --example client '127.0.0.1:55555'
```

You can run their apps located in `/apps/src/bin`:

```sh
cd /apps

# The source code for these is in the `/apps/src/bin` directory
cargo run --bin quiche-client -- https://cloudflare-quic.com

# Run with
cargo run --bin quiche-server -- --listen 127.0.0.1:55555

# Run without verifying TLS if certificates is
cargo run --bin quiche-client -- --no-verify 'http://127.0.0.1:55555'
```

### TLS

If you need to test with a local certificates, try using `step`;

```sh
step certificate create \
  localhost localhost.crt localhost.key \
  --profile self-signed \
  --subtle \
  --no-password \
  --insecure \
  --force \
  --san 127.0.0.1 \
  --san ::1 \
  --not-after 31536000s

# Afterwards put certificates in `./tmp` and refer to them
```

### Cargo/Rust targets

Cargo is a cross-compiler. The target structure looks like this:

```
<arch><sub>-<vendor>-<sys>-<abi>
```

For example:

```
x86_64-unknown-linux-gnu
x86_64-pc-windows-msvc
aarch64-apple-darwin
x86_64-apple-darwin
```

The available target list is in `rustc --print target-list`.

### Structure

It is possible to structure the QUIC system in the encapsulated way or the injected way.

When using the encapsulated way, the `QUICSocket` is separated between client and server.

When using the injected way, the `QUICSocket` is shared between client and server.

![](/images/quic_structure_encapsulated.svg)

If you are building a peer to peer network, you must use the injected way. This is the only way to ensure that hole-punching works because both the client and server for any given peer must share the same UDP socket and thus share the `QUICSocket`. When done in this way, the `QUICSocket` lifecycle is managed outside of both the `QUICClient` and `QUICServer`.

![](/images/quic_structure_injected.svg)

This also means both `QUICClient` and `QUICServer` must share the same connection map.  In order to allow the `QUICSocket` to dispatch data into the correct connection, the connection map is constructed in the `QUICSocket`, however setting and unsetting connections is managed by `QUICClient` and `QUICServer`.

## Dataflow

The data flow of the QUIC system is a bidirectional graph.

Data received from the outside world is received on the UDP socket. It is parsed and then dispatched to each `QUICConnection`. Each connection further parses the data and then dispatches to the `QUICStream`. Each `QUICStream` presents the data on the `ReadableStream` interface, which can be read by a caller.

Data sent to the outside world is written to a `WritableStream` interface of a `QUICStream`. This data is buffered up in the underlying Quiche stream. A send procedure is triggered on the associated `QUICConnection` which takes all the buffered data to be sent for that connection, and sends it to the `QUICSocket`, which then sends it to the underlying UDP socket.

![](/images/quic_dataflow.svg)

Buffering occurs at the connection level and at the stream level. Each connection has a global buffer for all streams, and each stream has its own buffer. Note that connection buffering and stream buffering all occur within the Quiche library. The web streams `ReadableStream` and `WritableStream` do not do any buffering at all.

### Connection Negotiation

The connection negotiation process involves several exchanges of QUIC packets before the `QUICConnection` is constructed.

The primary reason to do this is for both sides to determine their respective connection IDs.

![](/images/quic_connection_negotiation.svg)

### Push & Pull

The `QUICSocket`, `QUICClient`, `QUICServer`, `QUICConnection` and `QUICStream` are independent state machines that exposes methods that can be called as well as events that may be emitted between them.

This creates a concurrent decentralised state machine system where there are multiple entrypoints of change.

Users may call methods which causes state transitions internally that trigger event emissions. However some methods are considered internal to the library, this means these methods are not intended to be called by the end user. They are however public relative to the other components in the system. These methods should be marked with `@internal` documentation annotation.

External events may also trigger event handlers that will call methods which perform state transitions and event emission.

Keeping track of how the system works is therefore quite complex and must follow a set of rules.

* Pull methods - these are either synchronous or asynchronous methods that may throw exceptions.
* Push handlers - these are event handlers that can initiate pull methods, if these pull handlers throw exceptions, these exceptions must be caught, and expected runtime exceptions are to be converted to error events, all other exceptions will be considered to be software bugs and will be bubbled up to the program boundary as unhandled exceptions or unhandled promise rejections. Generally the only exceptions that are expected runtime exceptions are those that arise from perform IO with the operating system.

## Benchmarks

```sh
npm run bench
```

View benchmarks here: https://github.com/MatrixAI/js-quic/blob/master/benches/results with https://raw.githack.com/

### Docs Generation

```sh
npm run docs
```

See the docs at: https://matrixai.github.io/js-quic/

### Publishing

Publishing is handled automatically by the staging pipeline.

Prerelease:

```sh
# npm login
npm version prepatch --preid alpha # premajor/preminor/prepatch
git push --follow-tags
```

Release:

```sh
# npm login
npm version patch # major/minor/patch
git push --follow-tags
```

Manually:

```sh
# npm login
npm version patch # major/minor/patch
npm run build
npm publish --access public
git push
git push --tags
```
