# appium-mitm-plugin

An [Appium](https://appium.io) plugin that runs [mitmproxy](https://mitmproxy.org)
alongside the Appium server and exposes captured HTTP(S) traffic — full network
log: **endpoint, headers, cookies, and request + response bodies** (decoded) — to
the test client via `execute('mitm: …')` commands.

It exists because there is no built-in way to get a native iOS app's decoded
HTTP bodies through the Appium/grid endpoint: `mobile: startNetworkMonitor` is
flow-level only (IP:port + byte/RTT stats, no URL/bodies), `startPcap` is
encrypted packets, and the official Interceptor plugin is Android-only and
mock-only. This plugin fills that gap for any platform whose device traffic can
be routed through an HTTP proxy.

## What it does

1. **Starts the proxy with Appium** — boots `mitmdump` once when the server
   starts (`updateServer` hook), serving every session on the node.
2. **Exposes commands** — `mitm: getFlows`, `mitm: clearFlows`, `mitm: status`.
3. **Alerts if mitm is not accessible on the host** — verifies the `mitmdump`
   binary and that the proxy port becomes reachable; logs `ALERT: …`, and
   `mitm: status.error` / `mitm: getFlows` surface the problem to the client.

## Requirements

- Appium 2 or 3 on the host.
- `mitmproxy` installed on the **Appium host** so `mitmdump` is on `PATH`
  (`pipx install mitmproxy`), or set `MITM_BIN` to its absolute path.
- The device routed through the proxy and trusting its CA (see below).

## Install & enable

```bash
# from this repo (git source REQUIRES --package with the package name)
appium plugin install --source=git \
  https://github.com/v-dermichev/appium-mitm-plugin.git \
  --package appium-mitm-plugin
# equivalently via the github source
appium plugin install --source=github \
  v-dermichev/appium-mitm-plugin --package appium-mitm-plugin
# or from a local checkout
appium plugin install --source=local /path/to/appium-mitm-plugin
# or from npm (once published)
appium plugin install --source=npm appium-mitm-plugin

# enable it (alongside any other plugins)
appium --use-plugins=mitm
```

## Configuration

Via environment variables on the Appium host (or `--plugin-mitm-<arg>` CLI args):

| env | default | meaning |
|-----|---------|---------|
| `MITM_HOST` | `0.0.0.0` | proxy bind host |
| `MITM_PORT` | `8080` | proxy port |
| `MITM_BIN` | `mitmdump` | path to the mitmdump binary |
| `MITM_OUT` | `~/.appium-mitm/flows.jsonl` | captured-flows file (JSONL) |
| `MITM_MAX_BODY` | `131072` | per-body byte cap before truncation |
| `MITM_CERTS` | – | developer-supplied CA cert(+key) PEM for **CA-pinned** apps (`mitmdump --certs`); does **not** help SPKI/leaf pinning |
| `MITM_ALLOW_HOSTS` | – | intercept **only** these hosts/IPs, tunnel everything else (mitmdump `--allow-hosts`) |
| `MITM_IGNORE_HOSTS` | – | intercept everything **except** these hosts/IPs (mitmdump `--ignore-hosts`) |
| `MITM_CONFDIR` | – | mitmproxy confdir (`--set confdir=`) |
| `MITM_EXTRA_ARGS` | – | extra space-separated mitmdump args |
| `MITM_READY_TIMEOUT_MS` | `12000` | how long to wait for the port to come up |

### Scoping capture to specific hosts

`MITM_ALLOW_HOSTS` and `MITM_IGNORE_HOSTS` are passed straight to mitmproxy
(`--allow-hosts` / `--ignore-hosts`) — same flags, same regex matching against
host or IP — so anyone who knows mitmproxy gets the obvious lever:

- **`MITM_ALLOW_HOSTS`** — an allowlist: intercept (decrypt + record) **only**
  matching hosts; everything else is raw-tunneled (not captured). Use it to
  capture just your app's API and skip the noise.
- **`MITM_IGNORE_HOSTS`** — a denylist: intercept everything **except** matching
  hosts. Handy to bypass pinned system services or high-volume CDNs.

Each accepts a single pattern or a comma-separated list (each pattern is repeated
as its own flag), e.g. `MITM_ALLOW_HOSTS='api\.example\.com,10\.0\.0\.5'`. The
two are **mutually exclusive** (mitmproxy rejects both at once); setting both
makes the plugin refuse to start and report the conflict via `mitm: status.error`.

## Device setup (one-time)

The plugin runs the proxy on the **Appium host**; each device just needs to
(1) route its traffic through `http://<appium-host-ip>:<MITM_PORT>` and
(2) trust the mitmproxy CA. The CA lives on the host at
`~/.mitmproxy/mitmproxy-ca-cert.pem` (`.cer` for iOS, `.pem`/`.crt` for Android),
or fetch it from the device browser at `http://mitm.it` while the proxy is set.

The device must be able to reach the host's IP — bind the proxy on all
interfaces (`MITM_HOST=0.0.0.0`, the default) and put both on the same network.

> System/OS services (Apple, Google, Play Services) pin their certs and will
> fail through the proxy — that's expected and does not affect your app's own
> API traffic.

### iOS

- **Proxy:** Settings ▸ Wi-Fi ▸ ⓘ on the network ▸ Configure Proxy ▸ Manual →
  Server `<appium-host-ip>`, Port `<MITM_PORT>`.
- **CA trust:** open `http://mitm.it` in Safari → install the **iOS** profile
  (Settings ▸ General ▸ VPN & Device Management), then **enable full trust**:
  Settings ▸ General ▸ About ▸ Certificate Trust Settings → toggle mitmproxy on.
  *(The trust toggle is mandatory — without it nothing decrypts.)*
- **Hands-off / CI:** on a **supervised** device, push one configuration profile
  (via MDM or Apple Configurator) that sets the proxy **and** trusts the CA with
  no taps. This is the scalable path for CI.

### Android

- **Proxy:** Settings ▸ Wi-Fi ▸ (long-press network) ▸ Modify ▸ Advanced ▸
  Proxy ▸ Manual → host `<appium-host-ip>`, port `<MITM_PORT>`. Or over adb:
  ```bash
  adb shell settings put global http_proxy <appium-host-ip>:<MITM_PORT>
  adb shell settings put global http_proxy :0        # clear it again
  ```
- **CA trust — mind the Android version:**
  - **Android ≤ 6:** install the mitm CA as a user cert (via `mitm.it` or
    Settings ▸ Security ▸ Install a certificate ▸ CA) — apps trust it.
  - **Android 7+ (API 24+):** apps trust **user** CAs **only if** their build
    opts in with a `network_security_config` (e.g. a debug build that trusts
    `user` certs). Otherwise the CA must go into the **system** store, which
    needs root or an emulator with a writable system partition:
    ```bash
    # emulator started with -writable-system; cert named by subject hash
    HASH=$(openssl x509 -inform PEM -subject_hash_old -in ~/.mitmproxy/mitmproxy-ca-cert.pem | head -1)
    cp ~/.mitmproxy/mitmproxy-ca-cert.pem $HASH.0
    adb root && adb remount
    adb push $HASH.0 /system/etc/security/cacerts/
    adb shell chmod 644 /system/etc/security/cacerts/$HASH.0
    adb reboot
    ```
  - **Hands-off / CI:** use a debug build whose `network_security_config` trusts
    user certs (then a simple user-cert install works), or a rooted/emulator
    image with the CA pre-baked into the system store.

### Both platforms — pinning

If the app **cert-pins**, no CA trust will decrypt it (you'll see TLS-error
records). Supply the app's trusted CA via `MITM_CERTS` for **CA pinning**; for
**SPKI/leaf pinning** you need a debug build with pinning disabled. See
[Pinning](#pinning) below.

## Commands

```js
// status / health — use to assert the proxy is up before relying on capture
await driver.execute('mitm: status');
// -> { available, running, reachable, host, port, binary, flowsFile,
//      allowHosts, ignoreHosts, error }

// fetch captured flows; poll incrementally with the returned cursor,
// and scope to your device with client (IP) / host filters
const { flows, cursor } = await driver.execute('mitm: getFlows', [
  { since: 0, client: '10.113.11.78', host: 'api.example.com' },
]);

// reset the capture buffer (e.g. between tests)
await driver.execute('mitm: clearFlows');
```

`mitm: getFlows` throws a clear error if the proxy isn't reachable on the host.

## Flow record shape

Each entry in `flows` (one per completed flow):

```jsonc
{
  "id": "…", "client_ip": "10.113.11.78",
  "method": "PUT", "scheme": "https",
  "host": "api.example.com", "port": 443,
  "url": "https://api.example.com/v5/push/token/",
  "http_version": "HTTP/2.0",
  "request":  { "headers": [["k","v"]], "cookies": [["k","v"]], "query": [["k","v"]],
                "body": { "text": "…", "encoding": "utf-8", "truncated": false } },
  "response": { "status": 202, "reason": "",
                "headers": [["k","v"]],
                "cookies": [{ "name": "sid", "value": "…", "attributes": [["Path","/"]] }],
                "body": { "encoding": "base64", "data": "…", "truncated": false } },
  "timestamps": { "start": 1718…, "end": 1718… }
}
```

Bodies are `utf-8` text when decodable, otherwise base64 (`encoding: "base64"`),
capped at `MITM_MAX_BODY`. Connection/TLS failures (e.g. a cert-pinned host) are
emitted as `{ host, url, error }` records so you can distinguish "pinned" from
"not captured".

## Pinning

- **No pinning** → trust the mitm CA; full capture.
- **CA pinning** → supply the app's trusted CA via `MITM_CERTS`.
- **SPKI / leaf pinning** → cannot be MITM'd; needs a debug build with pinning
  disabled. The plugin still records the TLS-error flows so you can detect it.

## License

MIT