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
# from npm (once published)
appium plugin install --source=npm appium-mitm-plugin
# or from this repo
appium plugin install --source=git https://github.com/v-dermichev/appium-mitm-plugin
# or local checkout
appium plugin install --source=local /path/to/appium-mitm-plugin

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
| `MITM_CONFDIR` | – | mitmproxy confdir (`--set confdir=`) |
| `MITM_EXTRA_ARGS` | – | extra space-separated mitmdump args |
| `MITM_READY_TIMEOUT_MS` | `12000` | how long to wait for the port to come up |

## Device setup (one-time)

The device must send its traffic through the proxy and trust the mitm CA:

- **Proxy:** point the device's Wi-Fi HTTP proxy at `MITM_HOST:MITM_PORT`.
- **CA trust:** install the mitm CA (`http://mit.it` via the device browser, or
  push a configuration profile) and enable full trust. On a **supervised**
  device a profile can set the proxy and trust the CA hands-off — recommended
  for CI.

Apple/Google system services pin their certs and will fail through the proxy;
that's expected and does not affect your app's own API traffic.

## Commands

```js
// status / health — use to assert the proxy is up before relying on capture
await driver.execute('mitm: status');
// -> { available, running, reachable, host, port, binary, flowsFile, error }

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