{
  inputs = {
    nixpkgs-matrix = {
      type = "indirect";
      id = "nixpkgs-matrix";
      inputs.nixpkgs.url =
        "github:NixOS/nixpkgs?rev=e69e710edfed397959507bcee120ec8a9c7ff03e";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs-matrix, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs-matrix.legacyPackages.${system};
        shell = { ci ? false }:
          with pkgs;
          mkShell {
            nativeBuildInputs = [
              nodejs_20
              shellcheck
              gitAndTools.gh
              rustc
              cargo
              cmake
              rustPlatform.bindgenHook
              valgrind
              heaptrack
              massif-visualizer
            ];
            NIX_DONT_SET_RPATH = true;
            NIX_NO_SELF_RPATH = true;
            RUST_SRC_PATH = "${rustPlatform.rustLibSrc}";
            shellHook = ''
              echo "Entering $(npm pkg get name)"
              set -o allexport
              . <(polykey secrets env js-quic)
              set +o allexport
              set -v
              ${lib.optionalString ci ''
                set -o errexit
                set -o nounset
                set -o pipefail
                shopt -s inherit_errexit
              ''}
              mkdir --parents "$(pwd)/tmp"
              export PATH="$(pwd)/dist/bin:$(npm root)/.bin:$PATH"
              npm install --ignore-scripts
              set +v
            '';
          };
      in {
        devShells = {
          default = shell { ci = false; };
          ci = shell { ci = true; };
        };
      });
}
