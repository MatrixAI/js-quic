{ pkgs ? import ./pkgs.nix {}, ci ? false }:

with pkgs;
mkShell {
  nativeBuildInputs = [
    nodejs
    nodejs.python
    clang-tools
    shellcheck
    gitAndTools.gh
    rustc
    cargo
    cmake
    # Rust bindgen hook (necessary to build boring)
    rustPlatform.bindgenHook
  ];
  # Don't set rpath for native addons
  NIX_DONT_SET_RPATH = true;
  NIX_NO_SELF_RPATH = true;
  RUST_SRC_PATH = "${rustPlatform.rustLibSrc}";
  shellHook = ''
    echo "Entering $(npm pkg get name)"
    set -o allexport
    . ./.env
    set +o allexport
    set -v
    ${
      lib.optionalString ci
      ''
      set -o errexit
      set -o nounset
      set -o pipefail
      shopt -s inherit_errexit
      ''
    }
    mkdir --parents "$(pwd)/tmp"

    # Built executables and NPM executables
    export PATH="$(pwd)/dist/bin:$(npm bin):$PATH"

    # Path to headers used by node-gyp for native addons
    export npm_config_nodedir="${nodejs}"

    # Verbose logging of the Nix compiler wrappers
    export NIX_DEBUG=1

    npm install --ignore-scripts

    set +v
  '';
}
