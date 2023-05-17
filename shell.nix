{ pkgs ? import ./pkgs.nix {}, ci ? false }:

with pkgs;
mkShell {
  nativeBuildInputs = [
    nodejs
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
    export PATH="$(pwd)/dist/bin:$(npm root)/.bin:$PATH"

    npm install --ignore-scripts

    set +v
  '';
}
