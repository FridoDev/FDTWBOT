#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

fail() {
    printf 'FRIDO DEV BOT: %s\n' "$*" >&2
    exit 1
}

[[ $# -eq 1 ]] || fail 'Usage: bash install.sh https://your-deployment.vercel.app'
origin=$1
origin_pattern='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
[[ "$origin" =~ $origin_pattern ]] || fail 'Use an HTTPS origin only, without credentials, paths, query strings or fragments.'
authority=${origin#https://}
host=${authority%%:*}
(( ${#host} <= 253 )) || fail 'The origin hostname is too long.'
IFS='.' read -r -a labels <<< "$host"
for label in "${labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || fail 'The origin has an invalid domain label.'
done
if [[ "$authority" == *:* ]]; then
    port=${authority##*:}
    (( 10#$port >= 1 && 10#$port <= 65535 )) || fail 'The origin port must be between 1 and 65535.'
fi

[[ "${PREFIX:-}" == /*/com.termux/files/usr && -d "$PREFIX" ]] || fail 'Run this installer inside Android Termux with its normal PREFIX.'
[[ "${HOME:-}" == /* && -d "$HOME" && -w "$HOME" ]] || fail 'Termux HOME must be an existing, writable absolute directory.'
for dependency in node npm curl tar sha256sum; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing $dependency. In Termux run: pkg install nodejs-lts npm curl tar coreutils"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22 or newer is required. Run: pkg install nodejs-lts'

install_dir="$HOME/still-bot"
launcher="$install_dir/scripts/termux-launch.sh"
marker="$install_dir/.local/install-complete"
download_dir=''
stage_dir=''
retained_install=''
cleanup() {
    local status=$?
    trap - EXIT
    # Only this invocation's mktemp download directory is disposable.
    if [[ -n "$download_dir" && -d "$download_dir" ]]; then
        rm -rf -- "$download_dir" || printf 'Could not clean temporary downloads: %s\n' "$download_dir" >&2
    fi
    if (( status != 0 )); then
        if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
            printf 'Staging files retained for diagnostics: %s\n' "$stage_dir" >&2
        fi
        if [[ -n "$retained_install" ]]; then
            printf 'Installation retained for diagnostics: %s\nNo installation or authentication files were deleted. Resolve the error before retrying; automatic reinstall is disabled.\n' "$retained_install" >&2
        fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install_shortcut() {
    local shortcuts="$HOME/.shortcuts"
    local shortcut="$HOME/.shortcuts/FRIDO DEV BOT"
    local shortcut_copy
    if [[ -L "$shortcuts" || ( -e "$shortcuts" && ! -d "$shortcuts" ) ]]; then
        printf 'Shortcut directory is not a regular directory; left unchanged: %s\n' "$shortcuts" >&2
        return 0
    fi
    if ! mkdir -p -- "$shortcuts"; then
        printf 'Could not create %s. Launch manually with: bash "%s"\n' "$shortcuts" "$launcher" >&2
        return 0
    fi
    if [[ -e "$shortcut" || -L "$shortcut" ]]; then
        printf 'Existing shortcut preserved: %s\n' "$shortcut"
        return 0
    fi
    if [[ -z "$download_dir" ]]; then
        download_dir=$(mktemp -d "$HOME/.still-bot-download.XXXXXXXX")
    fi
    shortcut_copy="$download_dir/FRIDO DEV BOT"
    cp -- "$launcher" "$shortcut_copy"
    chmod 700 -- "$shortcut_copy"
    # Atomic, no-clobber publication: even a concurrent shortcut is preserved.
    if ln -T -- "$shortcut_copy" "$shortcut"; then
        printf 'Home-screen shortcut installed: %s\n' "$shortcut"
    else
        printf 'Shortcut was not replaced. Launch manually with: bash "%s"\n' "$launcher" >&2
    fi
}

phone_notes() {
    printf '%s\n' \
        'Install the free Termux:Widget companion from the same source as Termux.' \
        'Add its home-screen widget and select FRIDO DEV BOT.' \
        'For reliable background operation, set Termux battery usage to Unrestricted in Android settings.' \
        'No Android settings were changed. Do not force-stop Termux while the bot is running.'
}

if [[ -e "$install_dir" || -L "$install_dir" ]]; then
    if [[ -d "$install_dir" && ! -L "$install_dir" && -f "$launcher" && ! -L "$launcher" \
        && -f "$install_dir/package.json" && -f "$install_dir/package-lock.json" \
        && -f "$install_dir/src/dashboard.js" && -d "$install_dir/node_modules" \
        && -f "$marker" && ! -L "$marker" && "$(< "$marker")" == 'still-local:1' ]]; then
        printf 'Existing verified installation found at %s. Reusing it; dependencies and authentication are unchanged.\n' "$install_dir"
        install_shortcut
        phone_notes
        bash -- "$launcher"
        exit 0
    fi
    fail "Destination already exists but is not a verified FRIDO DEV BOT installation: $install_dir. Nothing was overwritten. Inspect or repair it manually; preserve its auth and .local files. Move it aside yourself only after backing up anything you need."
fi

download_dir=$(mktemp -d "$HOME/.still-bot-download.XXXXXXXX")
printf 'Downloading FRIDO DEV BOT from %s\n' "$origin"
for filename in still-bot.tar.gz still-bot.sha256; do
    curl --fail --silent --show-error --location \
        --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --connect-timeout 15 --max-time 180 --retry 2 --retry-max-time 240 \
        --output "$download_dir/$filename" -- "$origin/downloads/$filename"
done

checksum_line=$(< "$download_dir/still-bot.sha256")
checksum_pattern='^[0-9A-Fa-f]{64} [ *](\./)?still-bot\.tar\.gz$'
[[ "$checksum_line" =~ $checksum_pattern ]] || fail 'Checksum must contain one sha256sum line for still-bot.tar.gz only.'
(
    cd -- "$download_dir"
    sha256sum -c --strict -- still-bot.sha256
)

# Trust the chosen HTTPS origin, but reject archives with misplaced application files.
tar -tzf "$download_dir/still-bot.tar.gz" > "$download_dir/members.txt"
while IFS= read -r member; do
    [[ "$member" != /* && ! "$member" =~ (^|/)\.\.(/|$) ]] || fail 'Bundle contains an unsafe archive path.'
    while [[ "$member" == ./* ]]; do member=${member#./}; done
    case "$member" in
        ''|.|package.json|package-lock.json|src|src/*|scripts|scripts/*|web|web/*) ;;
        *) fail 'Bundle contains unexpected root files; expected package manifests, src/, scripts/ and web/.' ;;
    esac
done < "$download_dir/members.txt"

stage_dir=$(mktemp -d "$HOME/.still-bot-stage.XXXXXXXX")
tar -xzf "$download_dir/still-bot.tar.gz" --directory "$stage_dir" --no-same-owner --no-same-permissions
for required in package.json package-lock.json src/dashboard.js scripts/termux-launch.sh; do
    [[ -f "$stage_dir/$required" && ! -L "$stage_dir/$required" ]] || fail "Bundle is missing a regular $required file."
done
for required in src scripts web; do
    [[ -d "$stage_dir/$required" && ! -L "$stage_dir/$required" ]] || fail "Bundle is missing a regular $required directory."
done
[[ ! -e "$install_dir" && ! -L "$install_dir" ]] || fail 'Destination appeared during download; it was left unchanged.'
mv -T --no-clobber -- "$stage_dir" "$install_dir"
[[ ! -d "$stage_dir" ]] || fail 'Destination appeared during staging; no existing installation was replaced.'
stage_dir=''
retained_install="$install_dir"
cd -- "$install_dir"
printf 'Installing locked dependencies. Failed installs will be retained at %s\n' "$install_dir"
npm ci --omit=optional --no-audit --no-fund
npm run verify:runtime

mkdir -p -- "$install_dir/.local"
printf '%s\n' 'still-local:1' > "$marker"
chmod 600 -- "$marker"
chmod 700 -- "$launcher"
install_shortcut
phone_notes
printf 'Installation verified. Opening the local dashboard.\n'
bash -- "$launcher"
