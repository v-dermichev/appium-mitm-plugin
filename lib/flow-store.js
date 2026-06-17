// Reads the JSONL flow file written by the mitmproxy addon.
//
// The cursor is simply the number of lines consumed, so a client can poll
// incrementally: pass the previous `cursor` back as `since` to get only new
// flows. Filtering by client IP / host happens here so the test client can
// scope results to its own device.
import {readFile, writeFile} from 'node:fs/promises';

class FlowStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read({since = 0, client = null, host = null} = {}) {
    let content;
    try {
      content = await readFile(this.filePath, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        return {flows: [], cursor: 0};
      }
      throw e;
    }

    const lines = content.split('\n').filter(Boolean);
    const cursor = lines.length;
    const flows = [];
    for (const line of lines.slice(Math.max(0, since))) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // skip a half-written trailing line
      }
      if (client && rec.client_ip !== client) {
        continue;
      }
      if (host && rec.host !== host) {
        continue;
      }
      flows.push(rec);
    }
    return {flows, cursor};
  }

  async clear() {
    try {
      await writeFile(this.filePath, '');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
}

export {FlowStore};