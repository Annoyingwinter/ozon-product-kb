/**
 * 代理设置（单例）— Ozon API 需要走代理穿越 GFW
 * 所有需要访问外网的模块统一 import 此文件
 */
let _dispatcher = null;
let _initialized = false;

export function getProxyDispatcher() {
  if (_initialized) return _dispatcher;
  _initialized = true;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
  if (!proxyUrl) return null;

  try {
    // 动态 import undici (可能未安装)
    const { ProxyAgent } = require("undici");
    _dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
    return _dispatcher;
  } catch {
    return null;
  }
}

// 异步版本（ESM 环境用）
export async function getProxyDispatcherAsync() {
  if (_initialized) return _dispatcher;
  _initialized = true;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
  if (!proxyUrl) return null;

  try {
    const undici = await import("undici");
    _dispatcher = new undici.ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
    console.log(`  代理: ${proxyUrl}`);
    return _dispatcher;
  } catch {
    console.log(`  代理: ${proxyUrl} (undici不可用，需 npm i undici)`);
    return null;
  }
}

/**
 * 带代理的 fetch 封装
 */
export async function proxyFetch(url, opts = {}) {
  const dispatcher = _initialized ? _dispatcher : await getProxyDispatcherAsync();
  return fetch(url, { ...opts, ...(dispatcher ? { dispatcher } : {}) });
}
