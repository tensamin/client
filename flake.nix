{
  description = "Tensamin client development and verification";

  inputs = {
    mtp-type-maps = {
      url = "github:TensaminDev/MTP-Type-Maps/main";
      flake = false;
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      mtp-type-maps,
      ...
    }:
    let
      forSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
      project =
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          rust = pkgs.rust-bin.stable.latest.default.override { targets = [ "wasm32-unknown-unknown" ]; };
          rustPlatform = pkgs.makeRustPlatform {
            cargo = rust;
            rustc = rust;
          };
          mtp = pkgs.fetchurl {
            url = builtins.head (
              builtins.match ''.*mtp: "([^"]+)".*'' (builtins.readFile ./pnpm-workspace.yaml)
            );
            hash = "sha256-+tCWg4kwKt5bUQNmHy4NFhRNUx8i/90holg6anhzQOw=";
          };
          mtpRust =
            pkgs.runCommand "mtp-rust-source"
              {
                nativeBuildInputs = [
                  pkgs.gnutar
                  pkgs.gzip
                ];
              }
              ''
                mkdir -p "$out"
                tar -xzf ${mtp} --strip-components=2 -C "$out" package/.rust
              '';
          cargoDeps = rustPlatform.fetchCargoVendor {
            pname = "mtp-wasm";
            version = "0.4.0";
            src = mtpRust;
            hash = "sha256-1n8d8qoPnTxMp6nADkSHwvl54WBbbIckuK5uRJOhTVA=";
          };
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "tensamin";
            version = "0.0.11";
            src = self;
            pnpm = pkgs.pnpm;
            fetcherVersion = 4;
            hash = {
              x86_64-linux = "sha256-oG9MgTGB2HGFHIX4GDa9bUAGVzpu+d2i1Uxo/5AJlxk=";
              aarch64-linux = "sha256-oG9MgTGB2HGFHIX4GDa9bUAGVzpu+d2i1Uxo/5AJlxk=";
            }.${system};
          };
          source = pkgs.runCommand "tensamin-source" { } ''
            cp -r ${self} "$out"
            chmod -R u+w "$out"
            rm -rf "$out/mtp-type-maps"
            cp -r ${mtp-type-maps} "$out/mtp-type-maps"
          '';
          common = {
            version = "0.0.11";
            src = source;
            inherit pnpmDeps;
            nativeBuildInputs = with pkgs; [
              nodejs
              pnpm
              pnpmConfigHook
              makeWrapper
              rust
              wasm-pack
              wasm-bindgen-cli_0_2_127
              binaryen
              lld
              pkg-config
              openssl
            ];
            CARGO_NET_OFFLINE = "true";
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            postConfigure = ''
              export CARGO_HOME="$TMPDIR/cargo"
              mkdir -p "$CARGO_HOME"
              cp ${cargoDeps}/.cargo/config.toml "$CARGO_HOME/config.toml"
              substituteInPlace "$CARGO_HOME/config.toml" --replace-fail '@vendor@' '${cargoDeps}'
            '';
            passthru = {
              inherit source;
              inherit cargoDeps;
            };
            meta.platforms = [
              "x86_64-linux"
              "aarch64-linux"
            ];
          };
        in
        {
          packages = {
            web = pkgs.stdenv.mkDerivation (
              common
              // {
                pname = "tensamin-web";
                buildPhase = ''
                  runHook preBuild
                  pnpm run build:web
                  runHook postBuild
                '';
                installPhase = ''mkdir -p "$out"; cp -r apps/web/dist/. "$out/"'';
              }
            );
            default = pkgs.stdenv.mkDerivation (
              common
              // {
                pname = "tensamin";
                buildPhase = ''
                  runHook preBuild
                  TENSAMIN_WEB_BASE=./ pnpm run build:web
                  pnpm --dir apps/electron run build
                  runHook postBuild
                '';
                installPhase = ''
                  mkdir -p "$out/lib/tensamin" "$out/bin" "$out/lib/web/dist"
                  cp -r apps/electron/dist apps/electron/package.json "$out/lib/tensamin/"
                  cp -r apps/web/dist/. "$out/lib/web/dist/"
                  makeWrapper ${pkgs.electron}/bin/electron "$out/bin/tensamin" \
                    --add-flags "$out/lib/tensamin" \
                    --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.pulseaudio ]} \
                    --set ELECTRON_OZONE_PLATFORM_HINT auto
                  if [ -d apps/electron/build/icons ]; then
                    mkdir -p "$out/lib/tensamin/build"
                    cp -r apps/electron/build/icons "$out/lib/tensamin/build/icons"
                    install -Dm644 apps/electron/build/icons/icon.png "$out/share/icons/hicolor/512x512/apps/tensamin.png"
                  fi
                  mkdir -p "$out/share/applications"
                  cp ${
                    pkgs.makeDesktopItem {
                      name = "tensamin";
                      desktopName = "Tensamin";
                      exec = "tensamin %U";
                      icon = "tensamin";
                      categories = [ "Network" ];
                      mimeTypes = [ "x-scheme-handler/tensamin" ];
                    }
                  }/share/applications/* "$out/share/applications/"
                '';
                meta = common.meta // {
                  mainProgram = "tensamin";
                };
              }
            );
            release-desktop = pkgs.writeShellScript "release-client-desktop" ''
              set -euo pipefail
              cd "''${RELEASE_WORK:?}"
              pnpm install --frozen-lockfile
              pnpm run ci
              electron_arch=x64
              [[ $RELEASE_ARCH != aarch64 ]] || electron_arch=arm64
              package_name=tensamin
              [[ $TENSAMIN_CHANNEL == stable ]] || package_name="tensamin-$TENSAMIN_CHANNEL"
              pnpm --dir apps/electron exec electron-builder --config electron-builder.config.cjs \
                --config.extraMetadata.version="0.0.$TENSAMIN_ANDROID_VERSION_CODE" \
                --config.deb.packageName="$package_name" --config.rpm.packageName="$package_name" \
                --linux --"$electron_arch" --publish never
              pnpm run copy-releases
              for asset in releases/*; do
                [[ $(basename "$asset") == SHA256SUMS ]] && continue
                name=$(basename "$asset")
                [[ $name != electron-release-metadata.json ]] || name="electron-release-metadata-$RELEASE_ARCH.json"
                cp "$asset" "$RELEASE_OUT/$name"
              done
            '';
            release-android = pkgs.writeShellScript "release-client-android" ''
              set -euo pipefail
              cd "''${RELEASE_WORK:?}"
              pnpm install --frozen-lockfile
              : "''${ANDROID_KEYSTORE_BASE64:?}" "''${ANDROID_KEY_ALIAS:?}" "''${ANDROID_KEY_PASSWORD:?}" "''${ANDROID_STORE_PASSWORD:?}"
              umask 077
              printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > release.keystore
              printf 'storeFile=release.keystore\nkeyAlias=%s\nkeyPassword=%s\nstorePassword=%s\n' \
                "$ANDROID_KEY_ALIAS" "$ANDROID_KEY_PASSWORD" "$ANDROID_STORE_PASSWORD" > keystore.properties
              trap 'rm -f release.keystore keystore.properties' EXIT
              pnpm run gen-icons
              cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml
              pnpm run build:mobile
              apk=apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
              cp "$apk" "$RELEASE_OUT/Tensamin-$TENSAMIN_RELEASE_TAG.apk"
            '';
          };
        };
    in
    {
      lib.mkPackages = system: (project system).packages;
      packages = forSystems (system: {
        inherit ((project system).packages)
          default
          web
          release-desktop
          release-android
          ;
      });
      checks = forSystems (system: {
        inherit ((project system).packages) default web;
      });
      devShells = forSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
          electronArch = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
          electronRuntimeLibs = with pkgs; [
            alsa-lib
            at-spi2-atk
            at-spi2-core
            atk
            cairo
            cups
            dbus
            expat
            fontconfig
            freetype
            gdk-pixbuf
            glib
            gtk3
            libdrm
            libgbm
            libglvnd
            libnotify
            libpulseaudio
            libsecret
            libuuid
            libxkbcommon
            mesa
            nspr
            nss
            pango
            pipewire
            systemd
            wayland
            libX11
            libXScrnSaver
            libXcomposite
            libXcursor
            libXdamage
            libXext
            libXfixes
            libXi
            libXrandr
            libXtst
            libxcb
          ];
          buildToolsVersion = "35.0.0";
          ndkVersion = "29.0.14206865";
          android = pkgs.androidenv.composeAndroidPackages {
            cmdLineToolsVersion = "8.0";
            platformToolsVersion = "37.0.1";
            toolsVersion = "26.1.1";
            buildToolsVersions = [ buildToolsVersion ];
            platformVersions = [
              "35"
              "36"
            ];
            includeSources = false;
            includeSystemImages = false;
            includeNDK = true;
            ndkVersions = [ ndkVersion ];
            useGoogleAPIs = false;
          };
          rustToolchain = pkgs.rust-bin.stable.latest.default.override {
            extensions = [
              "rust-src"
              "rust-analyzer"
              "rustfmt"
              "clippy"
            ];
            targets = [
              "aarch64-linux-android"
              "armv7-linux-androideabi"
              "i686-linux-android"
              "x86_64-linux-android"
              "wasm32-unknown-unknown"
            ];
          };
          commonDeps = [
            rustToolchain
            pkgs.wasm-pack
            pkgs.lld
          ];
          appImageToolsArchive = pkgs.fetchurl {
            url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz";
            hash = "sha256-hAIaeO4hSub9M6LWKpK6JVQt0QvIa/EXqbLQu6ROdmU=";
          };
          appImageTools =
            pkgs.runCommand "electron-builder-appimage-tools-nix"
              {
                nativeBuildInputs = [
                  pkgs.gnutar
                  pkgs.gzip
                ];
              }
              ''
                mkdir -p "$out"
                tar -xzf ${appImageToolsArchive} --strip-components=1 -C "$out"
                rm -f "$out/mksquashfs" "$out/desktop-file-validate"
                ln -s ${pkgs.squashfsTools}/bin/mksquashfs "$out/mksquashfs"
                ln -s ${pkgs.desktop-file-utils}/bin/desktop-file-validate "$out/desktop-file-validate"
              '';
        in
        rec {
          default = electron;
          electron = pkgs.mkShell {
            packages =
              (with pkgs; [
                nodejs
                coreutils
                pnpm
                pkgs.electron
                pkg-config
                python3
                gcc
                gnumake
                git
                jq
                patchelf
                dpkg
                rpm
                fpm
                curl
                fakeroot
                rsync
                xz
                p7zip
              ])
              ++ electronRuntimeLibs
              ++ commonDeps;
            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronRuntimeLibs}:$LD_LIBRARY_PATH"
              export ELECTRON_ENABLE_LOGGING=1
              export ELECTRON_OZONE_PLATFORM_HINT="''${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
              export NPM_CONFIG_TARGET_ARCH="''${NPM_CONFIG_TARGET_ARCH:-${electronArch}}"
              export npm_config_build_from_source=true
              export USE_SYSTEM_FPM=true
              export ELECTRON_BUILDER_7ZIP_PATH="${pkgs.p7zip}/bin/7za"
              export APPIMAGE_TOOLS_PATH="${appImageTools}"
              alias electron-install='pnpm install'
              alias electron-build-web='pnpm run build:web'
              alias electron-dev='pnpm run dev'
              alias electron-package='pnpm run package:linux'
              alias electron-validate='pnpm run validate'
            '';
          };
          tauri = pkgs.mkShell {
            buildInputs =
              (with pkgs; [
                jdk17
                gradle
                pnpm
                bun
                nodejs
                coreutils
                pkg-config
                git
                jq
                curl
                wget
                file
                webkitgtk_4_1
                libsoup_3
                gtk3
                glib
                openssl
                librsvg
                libayatana-appindicator
                android-studio-tools
              ])
              ++ [ android.androidsdk ]
              ++ commonDeps;
            shellHook = ''
              sdkSource="${android.androidsdk}/libexec/android-sdk"
              projectRoot="$PWD/apps/tauri"
              androidHome="$projectRoot/.android"
              sdkRoot="$androidHome/sdk"
              mkdir -p "$sdkRoot/cmdline-tools"
              for component in build-tools cmake licenses ndk ndk-bundle platforms platform-tools tools; do
                if [ ! -e "$sdkRoot/$component" ] && [ ! -L "$sdkRoot/$component" ]; then
                  ln -s "$sdkSource/$component" "$sdkRoot/$component"
                fi
              done
              if [ ! -e "$sdkRoot/cmdline-tools/8.0" ]; then
                ln -s "$sdkSource/cmdline-tools/8.0" "$sdkRoot/cmdline-tools/8.0"
              fi
              if [ ! -e "$sdkRoot/cmdline-tools/latest" ]; then
                ln -s "8.0" "$sdkRoot/cmdline-tools/latest"
              fi
              sdkRootAbs="$(realpath "$sdkRoot")"
              ndkRootAbs="''${sdkRootAbs}/ndk/${ndkVersion}"
              export PATH="''${sdkRootAbs}/cmdline-tools/latest/bin:''${sdkRootAbs}/platform-tools:''${ndkRootAbs}:${pkgs.android-studio-tools}/bin:$PATH"
              export ANDROID_HOME="$sdkRootAbs"
              export ANDROID_SDK_ROOT="$sdkRootAbs"
              export ANDROID_NDK_ROOT="$ndkRootAbs"
              export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
              export NDK_HOME="$ANDROID_NDK_ROOT"
              export NDK_PATH="$ANDROID_NDK_ROOT"
              export JAVA_HOME="${pkgs.jdk17}"
              # Keep Gradle configuration inside the staged workspace.
              export GRADLE_USER_HOME="$androidHome/gradle"
              mkdir -p "$GRADLE_USER_HOME"
              printf 'android.aapt2FromMavenOverride=%s\n' \
                "$sdkRootAbs/build-tools/${buildToolsVersion}/aapt2" > "$GRADLE_USER_HOME/gradle.properties"
              adb devices
            '';
          };
        }
      );
    };
}
