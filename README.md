# js-quic

staging: [![pipeline status](https://gitlab.com/MatrixAI/open-source/js-quic/badges/staging/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-quic/commits/staging)
master: [![pipeline status](https://gitlab.com/MatrixAI/open-source/js-quic/badges/master/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-quic/commits/master)

## Installation

```sh
npm install --save @matrixai/quic
```

## Usage

```ts
```

## Development

Run `nix-shell`, and once you're inside, you can use:

```sh
# install (or reinstall packages from package.json)
npm install
# build the dist
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


We are going to try a few different libraries.

The first is going to be the same one that nodejs is apparently trying to use.

* https://github.com/ngtcp2/ngtcp2
* https://github.com/microsoft/msquic - windows style, can use openssl, lack of MacOS builds though?
* https://github.com/litespeedtech/lsquic - uses boringssl
* https://github.com/facebookincubator/mvfst - weird dependencies

Same structure as js-db.

So the first issue is to be able to compile the underlying library.

You may need a couple of things:

1. build_version.cc? in case we need to change these versions?
2. and a gyp file of the library itself so it can be built on this system

The process is this:

1. `npm run build` thisruns 2 scripts: prebuild and build.
2. The `prebuild` ends up calling `node ./scripts/prebuild.js`.
3. Then it builds the TSC code.

The prebuild ends up calling node-gyp, which is like its own make file.

This will end up calling GCC and other things to build the actual library itself.

It is `node-gyp configure` then it is `node-gyp build`.

```
node-gyp configure --nodedir=/nix/store/dvzrdz86i15bmjyy869mi7h2bcgl05az-nodejs-16.15.0 --target=16.15.0 --verbose

node-gyp build --nodedir=/nix/store/dvzrdz86i15bmjyy869mi7h2bcgl05az-nodejs-16.15.0 --arch=x64 --target=16.15.0 --jobs=max --release --verbose
```

Ok I've added it to `deps/ngtcp2/ngtcp2`.

Next thing is a binding.gyp file that can actually build it.

---

Trying out the rust ecosystem.

1. Need some extensions for rust.
2. Then we need to realise that the `rust-analyzer` only works 1 level deep. So the `native` directory must be what the code is.
3. It only works if we start the project directly. Otherwise there is a problem.
4. Neon only works on `native`, maybe there's a configuration.
5. You have to start vscode at the project directory, otherwise it doesn't have access to all the tools. It's a bit annoying.

It seems like neon has changed quite a bit. The latest one has iterated a bit.

```
{
  "name": "cpu-coun",
  "version": "0.1.0",
  "description": "",
  "main": "index.node",
  "scripts": {
    "build": "cargo-cp-artifact -nc index.node -- cargo build --message-format=json-render-diagnostics",
    "build-debug": "npm run build --",
    "build-release": "npm run build -- --release",
    "install": "npm run build-release",
    "test": "cargo test"
  },
  "author": "",
  "license": "ISC",
  "devDependencies": {
    "cargo-cp-artifact": "^0.1"
  }
}
```

So now instead of `neon build`. It does things like:

```
npm run build

cargo-cp-artifact -nc index.node -- cargo build --message-format=json-render-diagnostics
```

Weird, it's like a command will run something and then do the copy.

It's ecosystem is different from the C/C++ stuff.


We would put all of that into our `prebuild.js` script.

Ok so that command is only necessary to "copy" something specifically the `target/debug/libquic.so` to the current directory.

Then it is copied as `index.node`.

It's important for the `cargo.toml` to also be have the package name equal to the name of the JS package.

So as it is `@matrixai/quic`. Then it must also be called `quic` and thus called `libquic`.

I really don't think I need this, I can do all of this with `prebuild.js`.

Interestingly enough, there is NO usage of `binding.gyp` AT ALL.

The so called `gyp` file is only necessary for if we use node-gyp directly, and as a build tool for NodeJS binaries.

The neon seems to fully use cargo.

If the `main` of the `package.json` indicates it is a `index.node` to be loaded.

That becomes the literal module that is loaded when you do a `require('.')`.

That's so cool!

---

Ok now let's try to actually build quiche. We have to take the submodule just as well.

It does need to be `src/lib.rs` as this is the default for "libraries" in Rust.

So that is the standard for writing any kind of Rust library.

Otherwise there's also `src/main.rs` but only used for binaries.

It is possible to configure it separately in the `Config.toml` file.

The license will need to match.

Wait ok, so I've basically vendored the quiche library.

But cargo is a dependency manager.

This means technically we do need to vendor it here.

We can just use cargo directly to bring it in.

If I bring in `quiche` at `0.16.0`.

The `cargo build` has a custom build script.

It ends up asking for `cmake` for when building that dependency.

I put in `cmake` into the `shell.nix` and the build appears to work.

This technically means the library is already installed.

And I didn't need to clone the repo. Or maintain a submodule.

If I do maintain a submodule, I have to maintain it recursively too probably.

```
git submodule add https://github.com/cloudflare/quiche.git deps/quiche/quiche
git submodule update --init --recursive --depth 1 deps/quiche/quiche
```

That is necessary to also bring in boringssl which is used for the TLS.

But following the guide. You can build the examples from the cloned/submodule.

```
cargo build --examples
```

It can build boring ssl, or a custom build of boring ssl. Windows appears to need something other than CMAKE, but NASM.

It appears that there is applications too as `quiche-client.

And that exists in the `apps` directory.

```
cargo run --bin quiche-client -- https://cloudflare-quic.com

```

The quiche project is a multi-workspace project.

It has apps and quiche.

The quiche is the actual library itself.

It has the `src/lib.rs` and this is standardised.

It can alos have a `src/main.rs` but this is not in fact used.

Then there is `src/bin/` which is in the `apps` directory. This contains all the binaries.

Then there are `examples` which is in separate directory entirely. I think this shows how to call it from C.

Right so `src/main.rs` is always for "default" executable. While other executables can be done in `src/bin`.

Cargo parlance an example is just Rust code with a standaonly executable. Typically a single `.rs` file. It should be in the `examples` directory.

So:

```
cargo run --example hello
```

It then builds the example and executes it.

So `src/bin` are entrypoints to the program.

The examples are just ways of showing how the library can be used.

So I guess it built all the examples in every workspace.

---

Ok so the `examples` directory contains both RUST and C code that can be compiled as minimal examples of how to use the library.

The rust code actually gets built when doing `cargo build --examples`.

However the C doesn't get built.

The reason is to compile the C code, you actually ned ot run the make file inside the examples directory.

This ends up calling the compiling `.c` files, and you can see the C files end up including the `quiche.h` header, and linking to the `libquiche.a` archive file which is a statically linked library.

We don't actually need to do this. In our case, in the case of `neon`. We are directly compiling Rust to JS. Therefore we don't need to go through compiling quiche to `libquiche.a` and then writing C bindings to bridge it into Nodejs.

We can just directly use neon, and call into quiche functions. And this means we should be able to just use `quiche` as a dependency in cargo and not require to vendor the submodule of quiche.

The cool thing though is that the C examples show how the libquiche would be called in C.

The examples are competing with the app binaries. So the app binaries are considered "fuller examples" compared to the examples in examples.

But at the end of the day, both are just examples.

```
cargo run --example client '127.0.0.1:55555'
```

o upon running `cargo build`. You can see that what you get is now:

```
target/libquiche.a
target/libquiche.so
```

The `libquiche.a` is statically compiled and 85MiB.

The `libquiche.so` is only 27 MiB, and as a dynamic library, you can see that it links to `libgcc_s.so.1`, and `libm` and `libc`.

This is far less dependencies than the equivalent C++ code which depends also on `libm` and `libgcc_s.so` and `libc`, but also primarily on `libstdc++`.

It seems the rust code is much leaner. Or at least statically compiles a bunch of code into the rust binary that GCC normally leaves out.

Notice that many dependencies are still statically linked. I think only system dependencies are considered dynamic linking.

* libm is the math library
* libgcc_s is the GCC runtime library
* libc is the C standard library
* linux-vdso is the Linux kernel virtual dynamic shared object library

I think even if we were to statically link the library... the resulting library may still need these things.

It seems the only thing you cannot statically link is `linux-vdso`. However it is not recommended to link `libc`. Doing so would be statically linking glibc, and this is not a good idea. If you don't statically link libc, you might as well not statically link libm.

https://stackoverflow.com/questions/57476533/why-is-statically-linking-glibc-discouraged

https://news.ycombinator.com/item?id=21907870

Also I can see that the control for all of this in cargo. You can see `libc`, `libm`

---

```sh
# Build the the native binary
npm run napi-build

# Put certificates in `./tmp`
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

cargo run --bin quiche-client -- 'http://127.0.0.1:55555'

# Run without verifying TLS cause the certs are self-signed
cargo run --bin quiche-client -- --no-verify 'http://127.0.0.1:55555'

cd ./apps
```

To run quiche apps:

```
cd apps
cargo run --bin quiche-server -- --listen 127.0.0.1:55555
cargo run --bin quiche-client -- --no-verify 'https://127.0.0.1:55555'
```

---


```
const s = new QUICServer({ socket: QUICSocket });
const c1 = new QUICClient({ socket: QUICSocket });
const c2 = new QUICClient({ socket: QUICSocket });
```

```
    // The DCID is the ID that the remote peer picked for us.
    // Unlike the SCID it is guaranteed to exist for all QUIC packets.
    // const dcid = header.dcid;

    // If this packet is a short header
    // the DCID is decoded based on the dcid length
    // However the SCID is actually:
    // header.scid: ConnectionId::default()
    // What is this?
    // The default connection id is a `from_vec(Vec::new())`
    // I think it's just an empty Uint8Array
    // With length of 0
    // Ok that makes sense now

    // DCID is the only thing that will always exist
    // We must use this as a way to route the connections
    // How do we decide how to do this?
    // We must maintain a "connection" map here
    // That is QUIC connections... etc.
    // Furthermore the DCID may also not exist in the map
    // In that case it can be a NEW connection
    // But if it doesn't follow the new connections
    // it must be discarded too

    // Ok so the problem is that there could be multiple packets in the datagram
    // In the initial packet we have the random DCID that the client creates
    // But it also randomly chooses its SCID

    // On the server side, we are converting the `dcid` to `connId`
    // Which is a deterministic hash of it, well a "signed" version of it

    // So we have DCID, SCID and CONNID

    // At any time, endpoints can change the DCID they transmit to a value that has not been used on
    // **another** path.
```


---

Slow build: `npm run prebuild`.

If you want a fast build use: `npm run napi build --js false`.


---

Ok so there's a `napi build --target`  option.

This option is passed to `cargo build --target`.

This is meatn to be a triple.

Like:

```
<arch><sub>-<vendor>-<sys>-<abi>
```

The available target list is in `rustc --print target-list`.

For example:

```
x86_64-unknown-linux-gnu
x86_64-pc-windows-msvc
aarch64-apple-darwin
x86_64-apple-darwin
universal-apple-darwin
```

Note that these targets don't need to be specified if we are running on the host platform.

https://github.com/napi-rs/napi-rs/pull/1397

Seems like this should work then.
