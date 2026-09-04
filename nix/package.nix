{ lib, stdenvNoCC, nodejs_24, pnpm_10, pnpmConfigHook, fetchPnpmDeps, makeWrapper, python3 }:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "personal-feed";
  version = "0.1.0";
  src = lib.cleanSourceWith {
    src = ../.;
    filter = path: _type:
      let name = baseNameOf path;
      in !(builtins.elem name [ ".git" ".direnv" "node_modules" "lib" "result" ]);
  };

  nativeBuildInputs = [ nodejs_24 pnpmConfigHook pnpm_10 makeWrapper ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-xYwZRm5joOUDTilMVpnUcADhlE6TfdgDWqjd7G/nX10=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/lib/personal-feed"
    cp -R package.json lib node_modules python skills systemd "$out/lib/personal-feed/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/personal-feed" \
      --add-flags "$out/lib/personal-feed/lib/cli.js" \
      --prefix PATH : ${lib.makeBinPath [ (python3.withPackages (ps: [ ps.websocket-client ])) ]}
    runHook postInstall
  '';

  meta = {
    description = "Standalone Personal Feed MCP service";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "personal-feed";
  };
})
