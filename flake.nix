{
  description = "scrypted-bambu dev shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};
      # shared with ci through pnpm/setup
      nodeMajor = pkgs.lib.fileContents ./.node-version;
    in {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          pkgs."nodejs_${nodeMajor}"
          pnpm
          ffmpeg
        ];
        NODE_OPTIONS = "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON";
      };
    });
}
