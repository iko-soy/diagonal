{
  description = "Diagonal: Dia-style tab groups for Brave, named by Apple's on-device model";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      extensionId = nixpkgs.lib.strings.trim (builtins.readFile ./extension-id);
    in
    {
      packages = forAll (pkgs: rec {
        # The unpacked extension (dist/). Load it from brave://extensions → Load unpacked.
        extension = pkgs.buildNpmPackage {
          pname = "diagonal-extension";
          version = "0.1.0";
          src = ./.;
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build";
          installPhase = "cp -r dist $out";
        };

        # The native host: host/ copied whole, the shebang pinned to Nix's python3.
        diagonal-host = pkgs.stdenvNoCC.mkDerivation {
          pname = "diagonal-host";
          version = "0.1.0";
          src = ./host;
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/libexec/diagonal-host $out/bin
            cp diagonal-host.py prompts.py validate.py emoji.txt $out/libexec/diagonal-host/
            substituteInPlace $out/libexec/diagonal-host/diagonal-host.py \
              --replace-fail "#!/usr/bin/env python3" "#!${pkgs.python3}/bin/python3"
            chmod +x $out/libexec/diagonal-host/diagonal-host.py
            ln -s $out/libexec/diagonal-host/diagonal-host.py $out/bin/diagonal-host
          '';
          doInstallCheck = true;
          installCheckPhase = "$out/bin/diagonal-host --version";
        };

        default = diagonal-host;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ nodejs pnpm typescript esbuild python3 openssl ];
        };
      });

      homeManagerModules.default = { config, pkgs, lib, ... }:
        let
          cfg = config.programs.diagonal;
          host = self.packages.${pkgs.stdenv.hostPlatform.system}.diagonal-host;
          manifest = {
            name = "io.diagonal.host";
            description = "Diagonal: names tab groups with Apple's on-device model";
            path = "${host}/bin/diagonal-host";
            type = "stdio";
            allowed_origins = [ "chrome-extension://${cfg.extensionId}/" ];
          };
        in
        {
          options.programs.diagonal = {
            enable = lib.mkEnableOption "the Diagonal native messaging host for Brave";
            extensionId = lib.mkOption {
              type = lib.types.str;
              default = extensionId;
              description = "Pinned extension ID (from scripts/gen-key.sh). The host itself checks the ID baked into host/diagonal-host.py, so change both together by re-running gen-key.sh.";
            };
            channels = lib.mkOption {
              type = lib.types.listOf (lib.types.enum [ "Brave-Browser" "Brave-Browser-Beta" "Brave-Browser-Nightly" ]);
              default = [ "Brave-Browser" ];
              description = "Brave channels to install the host manifest for.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ host ];
            home.file = lib.listToAttrs (map
              (ch: lib.nameValuePair
                "Library/Application Support/BraveSoftware/${ch}/NativeMessagingHosts/io.diagonal.host.json"
                { text = builtins.toJSON manifest; })
              cfg.channels);
            # `|| true`: a Mac without Apple Intelligence still activates.
            home.activation.diagonalSchemas = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              ${host}/bin/diagonal-host --install-schemas || true
            '';
          };
        };
    };
}
