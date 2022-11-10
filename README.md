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
