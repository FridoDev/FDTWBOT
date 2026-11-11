#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

fail() {
    printf 'FRIDO DEV BOT: %s\n' "$*" >&2
    exit 1
}

[[ "${PREFIX:-}" == /*/com.termux/files/usr && -d "$PREFIX" ]] || fail 'Run this launcher inside Android Termux.'
[[ "${HOME:-}" == /* && -d "$HOME" ]] || fail 'Termux HOME must be an existing absolute directory.'
for dependency in node curl nohup; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing $dependency. In Termux run: pkg install nodejs-lts curl coreutils"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22 or newer is required. Run: pkg install nodejs-lts'

cd -- "$HOME/still-bot" || fail 'Installation is missing at $HOME/still-bot. Run the installer in Termux first.'
[[ -f src/dashboard.js ]] || fail 'src/dashboard.js is missing. Repair the installation without deleting auth or .local files.'
runtime_dir="$HOME/still-bot/.local"
log_file="$runtime_dir/runtime.log"
token_file="$runtime_dir/dashboard-token"
base_url='http://127.0.0.1:8787'

healthy() {
    curl --fail --silent --noproxy '*' --connect-timeout 1 --max-time 1 \
        -- "$base_url/api/health" 2>/dev/null |
        node -e '
            let data = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", chunk => {
                data += chunk;
                if (data.length > 4096) process.exit(1);
            });
            process.stdin.on("error", () => process.exit(1));
            process.stdin.on("end", () => {
                try {
                    const health = JSON.parse(data);
                    process.exit(health !== null && health.app === "still-local" && health.version === 1 ? 0 : 1);
                } catch {
                    process.exit(1);
                }
            });
        ' 2>/dev/null
}

open_dashboard() {
    local token url
    [[ -f "$token_file" && ! -L "$token_file" && -r "$token_file" ]] || fail "The service is healthy, but its dashboard token is unavailable at $token_file. Check $log_file; do not delete auth or token files."
    token=$(< "$token_file")
    [[ "$token" =~ ^[0-9A-Fa-f]{64}$ ]] || fail "The dashboard token is invalid. Inspect the runtime error in $log_file; authentication files were left unchanged."
    url="$base_url/#token=$token"
    if command -v termux-open-url >/dev/null 2>&1 && termux-open-url "$url" >/dev/null 2>&1; then
        printf 'Local service ready. Check the dashboard for the WhatsApp connection status.\n'
    else
        printf 'Local service ready. Open this private link on this phone only (do not share it):\n%s\n' "$url"
    fi
    printf 'Do not force-stop Termux. Keep its battery usage Unrestricted for background operation.\n'
}

if healthy; then
    open_dashboard
    exit 0
fi

[[ ! -L "$runtime_dir" && ( ! -e "$runtime_dir" || -d "$runtime_dir" ) ]] || fail "Runtime directory is not a regular directory: $runtime_dir"
mkdir -p -- "$runtime_dir"
chmod 700 -- "$runtime_dir"
[[ ! -L "$log_file" && ( ! -e "$log_file" || -f "$log_file" ) ]] || fail "Runtime log is not a regular file: $log_file"
# Append rather than truncate: concurrent launches and earlier errors survive.
: >> "$log_file"
chmod 600 -- "$log_file"

if command -v termux-wake-lock >/dev/null 2>&1; then
    if ! termux-wake-lock >/dev/null 2>&1; then
        printf 'Could not acquire the Termux wake lock. Check battery restrictions if Android suspends the bot.\n' >&2
    fi
fi

# Binding port 8787 prevents duplicate bots without leaving a stale filesystem lock.
PORT=8787 nohup node src/dashboard.js </dev/null >> "$log_file" 2>&1 &
printf 'Waiting for the local dashboard (up to 20 seconds)...\n'
deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
    if healthy; then
        # A successful health check confirms the current token has been written.
        if [[ -f "$token_file" && ! -L "$token_file" ]]; then
            open_dashboard
            exit 0
        fi
    fi
    if (( SECONDS < deadline )); then
        sleep 0.2
    fi
done

fail "The dashboard did not become ready within 20 seconds. Check $log_file for missing dependencies, runtime verification errors, or another app using port 8787. No process was killed and authentication was preserved. You can retry this launcher after fixing the error."
