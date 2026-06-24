// Manages a single mitmproxy (mitmdump) process for the Appium server lifetime.
//
// One proxy serves every session on the node; captured flows are tagged by
// client IP so the test client can filter per device. The manager owns the
// child process, a health/reachability check (requirement: "alert if mitm is
// not accessible on host"), and the resolved runtime config.
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {logger} from '@appium/support';

const log = logger.getLogger('MitmPlugin');
const ADDON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'addons',
  'flow_writer.py',
);

class ProxyManager {
  constructor() {
    this.proc = null;
    this.config = null;
    this.error = null;
    this.reachable = false;
  }

  // Config precedence: explicit Appium CLI args > env vars > defaults.
  resolveConfig(cliArgs = {}) {
    const env = process.env;
    const home = env.HOME || env.USERPROFILE || '/tmp';
    return {
      host: cliArgs.mitmHost || env.MITM_HOST || '0.0.0.0',
      port: parseInt(cliArgs.mitmPort || env.MITM_PORT || '8080', 10),
      bin: cliArgs.mitmBin || env.MITM_BIN || 'mitmdump',
      out: cliArgs.mitmOut || env.MITM_OUT || path.join(home, '.appium-mitm', 'flows.jsonl'),
      confdir: cliArgs.mitmConfdir || env.MITM_CONFDIR || '',
      // Developer-supplied CA cert(+key) PEM for CA-pinned apps (mitmdump --certs).
      // Does NOT help SPKI/leaf-pinned apps.
      certs: cliArgs.mitmCerts || env.MITM_CERTS || '',
      // Host filters passed straight to mitmproxy (regex matched against host/IP).
      // allowHosts -> --allow-hosts: intercept ONLY these, tunnel the rest.
      // ignoreHosts -> --ignore-hosts: intercept everything EXCEPT these.
      // They are mutually exclusive in mitmproxy. Each accepts an array or a
      // comma-separated string, and is repeated once per pattern on the CLI.
      allowHosts: ProxyManager.toList(cliArgs.mitmAllowHosts ?? env.MITM_ALLOW_HOSTS),
      ignoreHosts: ProxyManager.toList(cliArgs.mitmIgnoreHosts ?? env.MITM_IGNORE_HOSTS),
      maxBody: parseInt(cliArgs.mitmMaxBody || env.MITM_MAX_BODY || '131072', 10),
      readyTimeoutMs: parseInt(cliArgs.mitmReadyTimeoutMs || env.MITM_READY_TIMEOUT_MS || '12000', 10),
      extraArgs: (cliArgs.mitmExtraArgs || env.MITM_EXTRA_ARGS || '').split(' ').filter(Boolean),
    };
  }

  // Normalize a host-filter value (array, or comma-separated string) into a
  // trimmed, non-empty list of patterns.
  static toList(value) {
    if (value == null) {
      return [];
    }
    const parts = Array.isArray(value) ? value : String(value).split(',');
    return parts.map((p) => String(p).trim()).filter(Boolean);
  }

  get loopbackHost() {
    return this.config && this.config.host !== '0.0.0.0' ? this.config.host : '127.0.0.1';
  }

  async start(cliArgs) {
    this.config = this.resolveConfig(cliArgs);
    this.error = null;
    const c = this.config;

    // mitmproxy refuses to start with both set; fail early with a clear message.
    if (c.allowHosts.length && c.ignoreHosts.length) {
      this._fail(
        'allow-hosts and ignore-hosts are mutually exclusive — set only one ' +
          '(MITM_ALLOW_HOSTS to intercept only those, or MITM_IGNORE_HOSTS to intercept all except those).',
      );
      return;
    }

    await mkdir(path.dirname(c.out), {recursive: true});

    const args = [
      '--listen-host', c.host,
      '-p', String(c.port),
      '-s', ADDON,
      '--set', 'termlog_verbosity=warn',
      '--set', 'flow_detail=0',
    ];
    if (c.confdir) {
      args.push('--set', `confdir=${c.confdir}`);
    }
    if (c.certs) {
      args.push('--certs', c.certs);
    }
    for (const h of c.allowHosts) {
      args.push('--allow-hosts', h);
    }
    for (const h of c.ignoreHosts) {
      args.push('--ignore-hosts', h);
    }
    args.push(...c.extraArgs);

    log.info(`Starting mitmproxy: ${c.bin} ${args.join(' ')}`);
    log.info(`Flows file: ${c.out} (max body ${c.maxBody} bytes)`);

    try {
      this.proc = spawn(c.bin, args, {
        env: {...process.env, MITM_OUT: c.out, MITM_MAX_BODY: String(c.maxBody)},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._fail(`Failed to spawn '${c.bin}': ${e.message}`);
      return;
    }

    this.proc.on('error', (e) => {
      this._fail(
        e.code === 'ENOENT'
          ? `mitmproxy binary '${c.bin}' not found on host. Install it (e.g. 'pipx install mitmproxy') or set MITM_BIN.`
          : `mitmproxy process error: ${e.message}`,
      );
    });
    this.proc.on('exit', (code, signal) => {
      log.warn(`mitmproxy exited (code=${code} signal=${signal})`);
      this.reachable = false;
      this.proc = null;
    });
    this.proc.stdout.on('data', (d) => log.debug(`[mitm] ${String(d).trimEnd()}`));
    this.proc.stderr.on('data', (d) => log.debug(`[mitm] ${String(d).trimEnd()}`));

    this.reachable = await this._waitReachable(c.readyTimeoutMs);
    if (this.reachable) {
      log.info(`mitmproxy is up and reachable on ${c.host}:${c.port}`);
    } else if (!this.error) {
      this._fail(`mitmproxy did not become reachable on ${c.host}:${c.port} within ${c.readyTimeoutMs}ms`);
    }
  }

  _fail(message) {
    this.error = message;
    this.reachable = false;
    log.error(`ALERT: ${message}`);
  }

  async _waitReachable(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.error) {
        return false;
      }
      if (await this._tryConnect(this.loopbackHost, this.config.port)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  _tryConnect(host, port) {
    return new Promise((resolve) => {
      const sock = net.connect({host, port});
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(1000);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  async status() {
    let reachable = false;
    if (this.config) {
      reachable = await this._tryConnect(this.loopbackHost, this.config.port);
      this.reachable = reachable;
    }
    return {
      available: reachable && !this.error,
      running: Boolean(this.proc),
      reachable,
      host: this.config?.host ?? null,
      port: this.config?.port ?? null,
      binary: this.config?.bin ?? null,
      flowsFile: this.config?.out ?? null,
      allowHosts: this.config?.allowHosts ?? [],
      ignoreHosts: this.config?.ignoreHosts ?? [],
      error: this.error,
    };
  }

  async stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.reachable = false;
  }
}

// Single instance per Appium process — the server runs one proxy for all sessions.
export const proxyManager = new ProxyManager();