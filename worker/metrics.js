// Read & Found operational telemetry. Never persist reader answers, source text,
// OpenAI prompts, raw IP addresses or API credentials.
// Optional durable backend: Upstash Redis REST (UPSTASH_REDIS_REST_URL/TOKEN).
// Without Redis, all counters are emitted as structured Vercel Function logs.

const PRICES = {
  // Standard API pricing in USD per million tokens, Oct 2026.
  'gpt-6-luna': [0.10, 0.01, 0.50],
  'gpt-6.1-sol': [2.00, 0.10, 10.00],
  'gpt-6-sol': [2.00, 0.20, 10.00],
  'gpt-6-astra': [10.00, 1.00, 50.00]
};
const day = () => new Date().toISOString().slice(0, 10);
// Vercel's Redis Marketplace may provision either the UPSTASH_* names or the
// legacy KV_REST_API_* aliases. Both point to the same Upstash REST service.
const redisUrl = env => env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
const redisToken = env => env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
const redisConfigured = env => Boolean(redisUrl(env) && redisToken(env));

async function redis(env, commands) {
  if (!redisConfigured(env)) throw new Error('metrics_store_missing');
  const base = redisUrl(env).replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('invalid_metrics_store');
  const pipeline = Array.isArray(commands[0]);
  const response = await fetch(base + (pipeline ? '/pipeline' : ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('metrics_store_unavailable');
  const result = await response.json();
  if (result?.error || (Array.isArray(result) && result.some(item => item?.error))) throw new Error('metrics_store_unavailable');
  return result;
}

export async function track(env, type, extra = {}) {
  const date = day();
  const { model, inputTokens = 0, cachedTokens = 0, outputTokens = 0, searchCalls = 0, estimatedUSD = 0, unpriced = 0 } = extra;
  const event = {
    event: 'readandfound_usage', date, type,
    ...(model ? { model } : {}),
    ...(type === 'openai_call' ? { inputTokens, cachedTokens, outputTokens, searchCalls, estimatedUSD, unpriced } : {})
  };
  console.info(JSON.stringify(event));
  if (!redisConfigured(env)) return;
  // Logging is independent of persistence: metrics failures never interrupt books.
  const fields = { [type]: 1 };
  if (type === 'openai_call') {
    fields.inputTokens = inputTokens;
    fields.cachedTokens = cachedTokens;
    fields.outputTokens = outputTokens;
    fields.searchCalls = searchCalls;
    fields.estimatedUSD = estimatedUSD;
    fields.unpricedCalls = unpriced;
    if (model) fields[`model:${model}:calls`] = 1;
  }
  const commands = [];
  for (const key of ['rnf:metrics:all', `rnf:metrics:${date}`]) {
    for (const [field, value] of Object.entries(fields)) {
      if (!value) continue;
      commands.push([Number.isInteger(value) ? 'HINCRBY' : 'HINCRBYFLOAT', key, field, value]);
    }
  }
  if (!commands.length) return;
  try { await redis(env, commands); }
  catch (err) { console.warn('Read & Found metrics storage failed:', err.message); }
}

export async function openAIUsage(env, model, usage, searchCalls = 0) {
  const inputTokens = Math.max(0, Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0));
  const outputTokens = Math.max(0, Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0));
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0)));
  const price = PRICES[model];
  // gpt-5-search-api tokens and other unknown model rates aren't estimated;
  // $0.01 per web search is a *tool fee subtotal*, not a full invoice.
  const estimatedUSD = (price ? ((inputTokens - cachedTokens) * price[0] + cachedTokens * price[1] + outputTokens * price[2]) / 1e6 : 0) + searchCalls * 0.01;
  await track(env, 'openai_call', {
    model, inputTokens, outputTokens, cachedTokens, searchCalls,
    estimatedUSD: Number(estimatedUSD.toFixed(8)), unpriced: price ? 0 : 1
  });
}

async function anonymousId(request, env) {
  // Vercel supplies x-vercel-forwarded-for; the reader's raw IP is never stored.
  const ip = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) throw new Error('quota_identity_missing');
  const secret = env.RATE_LIMIT_SECRET || env.OPENAI_API_KEY;
  if (!secret) throw new Error('quota_secret_missing');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(ip)));
  return Array.from(sig.slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
}

// Completed sessions and in-progress reservations are separate. A crashed
// function cannot strand a reader's slot for three days: pending reservations
// expire after ten minutes. Successful lists alone consume the daily allowance.
// These Lua operations are atomic, so two tabs cannot claim the last slot.
const RESERVE = `redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(ARGV[3]) - 600000)
local finished = redis.call('SCARD', KEYS[1])
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return {0, finished} end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return {1, finished + redis.call('ZCARD', KEYS[2])} end
local n = finished + redis.call('ZCARD', KEYS[2])
if n >= tonumber(ARGV[2]) then return {0, n} end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1]); redis.call('EXPIRE', KEYS[2], 259200)
return {1, n + 1}`;
const FINISH = `if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('SADD', KEYS[1], ARGV[1]); redis.call('EXPIRE', KEYS[1], 259200)
end
return 1`;
const quotaKeys = (type, date, hash) => ({
  completed: `rnf:quota:completed:${type}:${date}:${hash}`,
  pending: `rnf:quota:pending:${type}:${date}:${hash}`
});
const quotaLimit = (env,type) => type === 'recommendations' ? 2 : Math.max(1, Math.min(100, Number(env.DAILY_REPLACEMENT_LIMIT || 10)));
const tomorrowUTC = date => new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString();

export async function quotaStatus(request, env) {
  const date = day();
  const status = { enabled: env.RATE_LIMIT_ENABLED === 'true', limit: 2,
    remaining: null, swapsRemaining: null, swapLimit: quotaLimit(env,'replacements'), resetAt: tomorrowUTC(date) };
  if (!status.enabled) return status;
  if (!redisConfigured(env)) return { ...status, unavailable: true };
  try {
    const hash = await anonymousId(request,env);
    const lists = quotaKeys('recommendations',date,hash);
    const swaps = quotaKeys('replacements',date,hash);
    const result = await redis(env, [
      ['SCARD',lists.completed], ['ZCOUNT',lists.pending,Date.now()-600000,'+inf'],
      ['SCARD',swaps.completed], ['ZCOUNT',swaps.pending,Date.now()-600000,'+inf']
    ]);
    const counts = result.map(item=>Number(item?.result || 0));
    return { ...status, used: counts[0], remaining: Math.max(0,2-counts[0]-counts[1]),
      swapsRemaining: Math.max(0,status.swapLimit-counts[2]-counts[3]) };
  } catch (err) {
    console.warn('Read & Found quota status unavailable:',err.message);
    return { ...status, unavailable: true };
  }
}

export async function reserveQuota(request, env, sessionId, type = 'recommendations') {
  if (env.RATE_LIMIT_ENABLED !== 'true') return { allowed: true, enforced: false };
  if (!redisConfigured(env)) return { allowed: false, unavailable: true };
  if (!/^[\w-]{12,100}$/.test(sessionId || '')) return { allowed: false, unavailable: true };
  let hash;
  try { hash = await anonymousId(request, env); }
  catch (_) { return { allowed: false, unavailable: true }; }
  const limit = quotaLimit(env,type);
  const date = day();
  const { completed, pending } = quotaKeys(type,date,hash);
  try {
    const result = await redis(env, ['EVAL', RESERVE, 2, completed, pending, sessionId, limit, Date.now()]);
    const [allowed, count] = result.result || [];
    return { allowed: allowed === 1, count, enforced: true, completed, pending, sessionId };
  } catch (err) {
    console.warn('Read & Found quota unavailable:', err.message);
    return { allowed: false, unavailable: true };
  }
}

export async function releaseQuota(env, quota) {
  if (!quota?.enforced || !quota.pending) return;
  try { await redis(env, ['ZREM', quota.pending, quota.sessionId]); } catch (_) {}
}
export async function finishQuota(env, quota) {
  if (!quota?.enforced || !quota.completed) return;
  try { await redis(env, ['EVAL', FINISH, 2, quota.completed, quota.pending, quota.sessionId]); }
  catch (err) { console.warn('Read & Found quota completion failed:',err.message); }
}

const asObject = value => {
  const result = {};
  if (Array.isArray(value)) for (let i = 0; i < value.length; i += 2) result[value[i]] = Number(value[i + 1]) || 0;
  return result;
};

export async function stats(request, env) {
  if (!env.ADMIN_STATS_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_STATS_TOKEN}`)
    return new Response(JSON.stringify({ error: 'Not authorised.' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!redisConfigured(env)) return new Response(JSON.stringify({ error: 'Connect Upstash Redis to enable the persistent dashboard. Structured usage is still recorded in Vercel Function logs.' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0,10));
  try {
    const response = await redis(env, [['HGETALL','rnf:metrics:all'], ...dates.map(d=>['HGETALL',`rnf:metrics:${d}`])]);
    const values = response.map(item => asObject(item.result));
    return new Response(JSON.stringify({ all: values[0], days: dates.map((date,i)=>({ date, ...values[i+1] })),
      info: 'Estimates use standard token prices plus $0.01 per web search; search-model token charges are excluded. Counters start when Redis is connected. Days are UTC.' }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Usage data is temporarily unavailable.' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}
