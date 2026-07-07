export const NODE_HTTP_TIMEOUT = 10000;
export const NODE_MAX_ATTEMPTS = 3;
export const NODE_RETRY_DELAY = 500;

export async function doNodeRequest(method, url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= NODE_MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), NODE_HTTP_TIMEOUT);
      
      const options = {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      };

      const resp = await fetch(url, options);
      clearTimeout(timeoutId);

      if (resp.status < 500 || attempt === NODE_MAX_ATTEMPTS) {
        return resp;
      }
      
      lastErr = new Error(`status ${resp.status}`);
      await resp.arrayBuffer(); // drain body
    } catch (err) {
      lastErr = err;
    }
    
    if (attempt < NODE_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * NODE_RETRY_DELAY));
    }
  }
  throw new Error(`${method} ${url} failed after ${NODE_MAX_ATTEMPTS} attempts: ${lastErr}`);
}

export async function getAddressInfo(nodeURL, address) {
  const url = `${nodeURL.replace(/\/$/, '')}/v1/address/${address}?limit=500`;
  const resp = await doNodeRequest('GET', url);
  if (resp.status !== 200) {
    const text = await resp.text();
    throw new Error(`GET address ${resp.status}: ${text}`);
  }
  const env = await resp.json();
  const info = {
    address: env.meta.address,
    balance: env.meta.balance,
    utxo_count: env.meta.utxo_count,
    utxos: env.items || []
  };
  if (info.address && info.address !== address) {
    throw new Error(`address response mismatch`);
  }
  return info;
}

export async function getNodeStatus(nodeURL) {
  const url = `${nodeURL.replace(/\/$/, '')}/v1/status`;
  const resp = await doNodeRequest('GET', url);
  if (resp.status !== 200) {
    const text = await resp.text();
    throw new Error(`GET status ${resp.status}: ${text}`);
  }
  const status = await resp.json();
  if (!status.tips || status.tips.length < 1) {
    throw new Error("node status returned no tips");
  }
  
  let dagSize = 0;
  for (const key of ["dag_size", "dagSize", "dag_depth", "dagDepth", "height", "best_height", "bestHeight"]) {
    if (status[key] !== undefined) {
      const parsed = parseInt(status[key], 10);
      if (!isNaN(parsed)) {
        dagSize = parsed;
        break;
      }
    }
  }
  status.dagSize = dagSize;
  return status;
}

export async function selectBestNodeURL(nodeURLs) {
  if (nodeURLs.length === 0) throw new Error("no node URLs configured");
  let selectedURL = "";
  let selectedDAGSize = -1;
  let lastErr = null;
  
  for (const nodeURL of nodeURLs) {
    try {
      const status = await getNodeStatus(nodeURL);
      if (selectedURL === "" || status.dagSize > selectedDAGSize) {
        selectedURL = nodeURL;
        selectedDAGSize = status.dagSize;
      }
    } catch (err) {
      console.error(`skip sikka node ${nodeURL}: ${err.message}`);
      lastErr = err;
    }
  }
  if (!selectedURL) {
    throw lastErr || new Error("no valid node returned status");
  }
  return selectedURL;
}

export async function getTips(nodeURL) {
  const status = await getNodeStatus(nodeURL);
  if (status.tips.length === 1) {
    return [status.tips[0], status.tips[0]];
  }
  return status.tips.slice(0, 2);
}

export async function getPowQuote(nodeURL, tx) {
  const url = `${nodeURL.replace(/\/$/, '')}/v1/tx/pow-quote`;
  const reqBody = { parents: tx.parents, timestamp: tx.timestamp };
  const resp = await doNodeRequest('POST', url, reqBody);
  if (resp.status !== 200) {
    const text = await resp.text();
    throw new Error(`pow quote ${resp.status}: ${text}`);
  }
  const quote = await resp.json();
  if (quote.required_bits < 0) {
    throw new Error(`invalid pow quote: required_bits=${quote.required_bits}`);
  }
  if (!quote.parent_pow_hashes || quote.parent_pow_hashes.length !== 2) {
    throw new Error("pow quote missing or invalid parent_pow_hashes");
  }
  return quote;
}

export async function submitTx(nodeURL, tx) {
  const url = `${nodeURL.replace(/\/$/, '')}/v1/tx/submit`;
  const resp = await doNodeRequest('POST', url, tx);
  const text = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`submit tx ${resp.status}: ${text}`);
  }
  const sr = JSON.parse(text);
  return sr.txid;
}
