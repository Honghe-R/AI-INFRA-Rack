import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { ApiError } from '@ai-infra/core';

const blocked4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
blocked6.addSubnet('2001::', 23, 'ipv6');
blocked6.addSubnet('2001:db8::', 32, 'ipv6');
blocked6.addSubnet('2002::', 16, 'ipv6');
blocked6.addSubnet('3fff::', 20, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}

export function normalizeAssistantEndpoint(value, allowedOrigins = []) {
  if (typeof value !== 'string' || value.length > 2048) throw invalidAddress();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalidAddress(); }
  const explicitlyAllowed = allowedOrigins.includes(url.origin);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && explicitlyAllowed)) ||
      url.username || url.password || url.search || url.hash) throw invalidAddress();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!explicitlyAllowed && (hostname === 'localhost' || hostname.endsWith('.localhost') ||
      (isIP(hostname) && !publicAddress(hostname)))) throw invalidAddress();
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path || '/v1'}/chat/completions`;
  return url.href;
}

function invalidAddress() {
  return new ApiError('ASSISTANT_ENDPOINT_INVALID', 'Enter a public HTTPS endpoint without credentials, query parameters or fragments. Internal gateways require administrator approval.', { status: 400 });
}

/** Check DNS then pin that exact result to the socket; never follow redirects. */
export function createAssistantFetch({ allowedOrigins = [], lookupImpl = lookup, maxBytes = 2 * 1024 * 1024 } = {}) {
  return async (endpoint, { method = 'POST', headers = {}, body, signal } = {}) => {
    const url = new URL(normalizeAssistantEndpoint(endpoint, allowedOrigins));
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
    combined.throwIfAborted();
    const resolution = lookupImpl(hostname, { all: true, verbatim: true });
    const records = await abortable(resolution, combined);
    if (!records.length || (!allowedOrigins.includes(url.origin) && records.some((record) => !publicAddress(record.address)))) {
      throw invalidAddress();
    }
    combined.throwIfAborted();
    const pinned = records[0];
    return new Promise((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, {
        method, headers, signal: combined, agent: false,
        lookup: (_host, options, callback) => options?.all
          ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy();
          reject(new ApiError('ASSISTANT_REDIRECT_BLOCKED', 'The model endpoint returned a redirect. Configure the final URL instead.', { status: 502 }));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) res.destroy(new Error('Model response exceeds size limit.'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
            text: async () => text, json: async () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}
