import worker from '../worker/index.js';

const MAX_BODY_BYTES = 65000;

async function readRequestBody(req) {
  if (req.body !== undefined) {
    const bytes = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (bytes.length > MAX_BODY_BYTES) throw new Error('too_large');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handle(req, res, route) {
  const isGet = ['out', 'stats'].includes(route);
  if (req.method !== (isGet ? 'GET' : 'POST')) {
    res.statusCode = 405;
    res.setHeader('Allow', isGet ? 'GET' : 'POST');
    res.end('Method not allowed');
    return;
  }
  let body;
  try { body = isGet ? null : await readRequestBody(req); }
  catch {
    res.statusCode = 413;
    res.end('Request too long');
    return;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = `${protocol}://${host}/api/${route}${query}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value != null && key !== 'host' && key !== 'content-length') headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(url, isGet ? { method: 'GET', headers } : { method: 'POST', headers, body });
  try {
    const response = await worker.fetch(request, process.env);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Read & Found API error:', error?.message || 'unknown');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({error:'The book service is temporarily unavailable.'}));
  }
}
