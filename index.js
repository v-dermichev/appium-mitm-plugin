// appium-mitm-plugin: runs mitmproxy alongside the Appium server and exposes
// captured HTTP(S) flows (with decoded bodies) to the test client via
// `execute('mitm: ...')` commands.
//
// Requirements covered:
//   1. starts the proxy along with Appium  -> static updateServer()
//   2. exposes a command                   -> executeMethodMap (mitm: getFlows/clearFlows/status)
//   3. alerts if mitm is not accessible    -> proxyManager health check; status.error
//                                             and getFlows throws a clear error.
import {BasePlugin} from '@appium/base-plugin';

import {FlowStore} from './lib/flow-store.js';
import {proxyManager} from './lib/proxy-manager.js';

class MitmPlugin extends BasePlugin {
  // Boot the proxy once, when the Appium server starts. A failure here does not
  // crash Appium — it is recorded and surfaced via `mitm: status` / getFlows.
  static async updateServer(expressApp, httpServer, cliArgs) {
    await proxyManager.start(cliArgs);
  }

  static executeMethodMap = {
    'mitm: getFlows': {
      command: 'mitmGetFlows',
      params: {optional: ['since', 'client', 'host']},
    },
    'mitm: clearFlows': {
      command: 'mitmClearFlows',
      params: {},
    },
    'mitm: status': {
      command: 'mitmStatus',
      params: {},
    },
  };

  async execute(next, driver, script, args) {
    return await this.executeMethod(next, driver, script, args);
  }

  // Health/alert surface — { available, running, reachable, host, port, error, ... }.
  async mitmStatus() {
    return await proxyManager.status();
  }

  // Returns { flows: [...], cursor }. Pass the previous cursor back as `since`
  // for incremental polling; filter to your device with `client` (IP) / `host`.
  async mitmGetFlows(next, driver, since = 0, client = null, host = null) {
    const st = await proxyManager.status();
    if (!st.reachable) {
      throw new Error(
        `mitmproxy is not accessible on host (${st.host}:${st.port}). ${st.error || ''}`.trim(),
      );
    }
    return await new FlowStore(st.flowsFile).read({
      since: Number(since) || 0,
      client: client || null,
      host: host || null,
    });
  }

  async mitmClearFlows() {
    const st = await proxyManager.status();
    await new FlowStore(st.flowsFile).clear();
    return {cleared: true, flowsFile: st.flowsFile};
  }
}

export {MitmPlugin};
export default MitmPlugin;