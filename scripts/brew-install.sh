#!/usr/bin/env bash

set -o errexit   # abort on nonzero exitstatus
set -o nounset   # abort on unbound variable
set -o pipefail  # don't hide errors within pipes

export HOMEBREW_NO_INSTALL_UPGRADE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ANALYTICS=1

brew reinstall node@20
brew link --overwrite node@20
brew install cmake
brew link --overwrite cmake
brew install rustup-init
brew link --overwrite rustup-init

# Brew does not provide specific versions of rust
# However rustup provides specific versions
# Here we provide both toolchains
rustup-init \
  --default-toolchain 1.68.2 \
  --target x86_64-apple-darwin aarch64-apple-darwin \
  -y
