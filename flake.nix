{
  description = "Grove: Dia-style tab groups for Brave, named by Apple's on-device model";

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
          pname = "grove-extension";
          version = "0.1.0";
          src = ./.;
          npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmBuildScript = "build";
          installPhase = "cp -r dist $out";
        };

        # The native host: host/ copied whole, the shebang pinned to Nix's python3.
        grove-host = pkgs.stdenvNoCC.mkDerivation {
          pname = "grove-host";
          version = "0.1.0";
          src = ./host;
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/libexec/grove-host $out/bin
            cp grove-host.py prompts.py validate.py emoji.txt $out/libexec/grove-host/
            substituteInPlace $out/libexec/grove-host/grove-host.py \
              --replace-fail "#!/usr/bin/env python3" "#!${pkgs.python3}/bin/python3"
            chmod +x $out/libexec/grove-host/grove-host.py
            ln -s $out/libexec/grove-host/grove-host.py $out/bin/grove-host
          '';
          doInstallCheck = true;
          installCheckPhase = "$out/bin/grove-host --version";
        };

        default = grove-host;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ nodejs pnpm typescript esbuild python3 openssl ];
        };
      });

      homeManagerModules.default = { config, pkgs, lib, ... }:
        let
          cfg = config.programs.grove;
          host = self.packages.${pkgs.stdenv.hostPlatform.system}.grove-host;
          manifest = {
            name = "io.grove.host";
            description = "Grove: names tab groups with Apple's on-device model";
            path = "${host}/bin/grove-host";
            type = "stdio";
            allowed_origins = [ "chrome-extension://${cfg.extensionId}/" ];
          };
        in
        {
          options.programs.grove = {
            enable = lib.mkEnableOption "the Grove native messaging host for Brave";
            extensionId = lib.mkOption {
              type = lib.types.str;
              default = extensionId;
              description = "Pinned extension ID (from scripts/gen-key.sh). The host itself checks the ID baked into host/grove-host.py, so change both together by re-running gen-key.sh.";
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
                "Library/Application Support/BraveSoftware/${ch}/NativeMessagingHosts/io.grove.host.json"
                { text = builtins.toJSON manifest; })
              cfg.channels);
            # `|| true`: a Mac without Apple Intelligence still activates.
            home.activation.groveSchemas = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              ${host}/bin/grove-host --install-schemas || true
            '';
          };
        };
    };
}
