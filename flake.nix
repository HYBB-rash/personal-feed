{
  description = "Standalone Personal Feed MCP service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [ git nodejs_24 pnpm_10 (python3.withPackages (ps: [ ps.websocket-client ps.pyyaml ])) ];
            env = {
              PIP_DISABLE_PIP_VERSION_CHECK = "1";
              PYTHONDONTWRITEBYTECODE = "1";
            };
          };
        });

      packages = forEachSystem (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          personal-feed = pkgs.callPackage ./nix/package.nix { };
          default = self.packages.${system}.personal-feed;
        });

      checks = forEachSystem (system: {
        inherit (self.packages.${system}) personal-feed;
      });
    };
}
