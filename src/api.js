import JSONBig from 'json-bigint';

export const NODE_HTTP_TIMEOUT = 15000;
export const NODE_MAX_ATTEMPTS = 3;
export const NODE_RETRY_DELAY = 500;

const jsonBig = JSONBig({ useNativeBigInt: true, alwaysParseAsBig: false });

let rpcId = 1;

/** JSON with BigInt amounts as raw integers (matches wallet.html). */
export function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`)
    .join(',')}}`;
}

export async function doNodeRequest(method, url, body) {
  let lastErr;
  for (let attempt = 1; attempt <= NODE_MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), NODE_HTTP_TIMEOUT);

      const options = {
        method,
        headers: body != null ? { 'Content-Type': 'application/json' } : {},
        body: body != null ? (typeof body === 'string' ? body : stringify(body)) : undefined,
        signal: controller.signal,
      };

      const resp = await fetch(url, options);
      clearTimeout(timeoutId);

      if (resp.status < 500 || attempt === NODE_MAX_ATTEMPTS) {
        return resp;
      }

      lastErr = new Error(`status ${resp.status}`);
      await resp.arrayBuffer();
    } catch (err) {
      lastErr = err;
    }

    if (attempt < NODE_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * NODE_RETRY_DELAY));
    }
  }
  throw new Error(`${method} ${url} failed after ${NODE_MAX_ATTEMPTS} attempts: ${lastErr}`);
}

export async function getHealth(nodeURL) {
  const url = `${nodeURL.replace(/\/$/, '')}/api/health`;
  const resp = await doNodeRequest('GET', url);
  const text = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`GET health ${resp.status}: ${text}`);
  }
  const health = jsonBig.parse(text);
  if (health.height === undefined || health.height === null) {
    throw new Error('node health missing height');
  }
  return health;
}

export async function selectBestNodeURL(nodeURLs) {
  if (nodeURLs.length === 0) throw new Error('no node URLs configured');
  let selectedURL = '';
  let selectedHeight = -1;
  let lastErr = null;

  for (const nodeURL of nodeURLs) {
    try {
      const health = await getHealth(nodeURL);
      const height = Number(health.height);
      if (selectedURL === '' || height > selectedHeight) {
        selectedURL = nodeURL.replace(/\/$/, '');
        selectedHeight = height;
      }
    } catch (err) {
      console.error(`skip sikka node ${nodeURL}: ${err.message}`);
      lastErr = err;
    }
  }
  if (!selectedURL) {
    throw lastErr || new Error('no valid node returned health');
  }
  return selectedURL;
}

export async function rpc(nodeURL, method, params = null) {
  const url = `${nodeURL.replace(/\/$/, '')}/api/rpc`;
  const body = stringify({
    jsonrpc: '2.0',
    id: rpcId++,
    method,
    params,
  });
  const resp = await doNodeRequest('POST', url, body);
  const text = await resp.text();
  let parsed;
  try {
    parsed = jsonBig.parse(text);
  } catch {
    throw new Error(`bad RPC response (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  }
  return parsed.result;
}
