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

---

I need to be locked together.

These need to be atomic operations.

The only issue is that the "atomicity" is controlled outside of `QUICConnection` atm.

Whereas it seems to make sense to do this directly?

```
recieve
[IF IS DRAINING IS TRUE SKIP SEND]
send
[CLOSE] - we may be "closed here"
set-timeout
```

This would be triggered by:
* QUICStream
* keepAliveTimer
* after onTimeout

```
send
[CLOSE] - we may be "closed here"
set-timeout
```

Remember you may also "receive" and end up closing too. But you will always check if you need to send first before checking the close. At worst it will tell you it's done.

Now of course we enable calling recv and send.

But `send` actually ends up calling multiple things here.

But if `recv` is synchronous, you can always call it infront of `send`.

This technically means `send` should be encapsulating the logic of setting the timeout.

If you want to make sure it's re-entrant, you can just "lock" on the send call.

The setTimeout is then protected.

The `recv` call is made synchronously.



Receive Send Timer, Send Timer (all of this requires locking the conn lock)

Closing too, it should require the conn lock
Receive Send [Close] Timer, Send [Close] Timer
It's all optional
It's the send that has to do Send, Close, Timer... that's what needs to check it all
Forget about events for now
