import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaStatus, reserveQuota, releaseQuota, finishQuota } from '../worker/metrics.js';
import worker from '../worker/index.js';

const request=new Request('https://readandfound.com/api/quota',{
  headers:{'x-vercel-forwarded-for':'203.0.113.17'}
});
const environment={
  RATE_LIMIT_ENABLED:'true',OPENAI_API_KEY:'test-signing-secret',
  UPSTASH_REDIS_REST_URL:'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN:'test-redis-token'
};

test('when enforcement is off, quota lookup is safe and does not call storage',async()=>{
  const result=await quotaStatus(request,{RATE_LIMIT_ENABLED:'false'});
  assert.equal(result.enabled,false);
  assert.equal(result.remaining,null);
  const response=await worker.fetch(request,{RATE_LIMIT_ENABLED:'false'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('a missing database fails closed before any paid questions',async()=>{
  const status=await quotaStatus(request,{RATE_LIMIT_ENABLED:'true'});
  assert.equal(status.enabled,true);
  assert.equal(status.unavailable,true);
  const reply=await worker.fetch(new Request('https://readandfound.com/api/read',{
    method:'POST',headers:{'content-type':'application/json','x-vercel-forwarded-for':'203.0.113.17'},
    body:JSON.stringify({step:0,favourites:'I love fiction',history:[],sessionId:'validsessionid12345'})
  }),{RATE_LIMIT_ENABLED:'true'});
  assert.equal(reply.status,503);
  assert.match((await reply.json()).error,/allowance/i);
});

test('remaining lists, swaps, and UTC reset come from durable counters',async()=>{
  const original=globalThis.fetch;
  let commands;
  try{
    globalThis.fetch=async(_url,options)=>{
      commands=JSON.parse(options.body);
      return new Response(JSON.stringify([{result:1},{result:0},{result:3},{result:1}]),{status:200});
    };
    const result=await quotaStatus(request,environment);
    assert.equal(result.remaining,1);
    assert.equal(result.used,1);
    assert.equal(result.swapsRemaining,6);
    assert.equal(result.limit,2);
    assert.match(result.resetAt,/T00:00:00\.000Z$/);
    assert.deepEqual(commands.map(item=>item[0]),['SCARD','ZCOUNT','SCARD','ZCOUNT']);
    assert.ok(commands.every(item=>!item.join(' ').includes('203.0.113.17')),'never store a raw IP address');
  }finally{globalThis.fetch=original;}
});

test('Vercel Marketplace KV aliases work for Redis storage',async()=>{
  const original=globalThis.fetch;
  let url,token;
  try{
    globalThis.fetch=async(endpoint,options)=>{
      url=endpoint;token=options.headers.Authorization;
      return new Response(JSON.stringify([{result:0},{result:0},{result:0},{result:0}]),{status:200});
    };
    const status=await quotaStatus(request,{
      RATE_LIMIT_ENABLED:'true',OPENAI_API_KEY:'test-signing-secret',
      KV_REST_API_URL:'https://redis-vercel.example.test/',
      KV_REST_API_TOKEN:'test-vercel-kv-token'
    });
    assert.equal(status.unavailable,undefined);
    assert.equal(status.remaining,2);
    assert.equal(url,'https://redis-vercel.example.test/pipeline');
    assert.equal(token,'Bearer test-vercel-kv-token');
  }finally{globalThis.fetch=original;}
});

test('a final request reserves a pending slot, then completes or releases it',async()=>{
  const original=globalThis.fetch;
  const calls=[];
  try{
    globalThis.fetch=async(_url,options)=>{
      const command=JSON.parse(options.body);calls.push(command);
      return new Response(JSON.stringify({result:command[0]==='EVAL'?[1,1]:1}),{status:200});
    };
    const quota=await reserveQuota(request,environment,'test-session-id-123456');
    assert.equal(quota.allowed,true);
    assert.equal(quota.enforced,true);
    assert.equal(calls[0][0],'EVAL');
    assert.ok(calls[0][1].includes('ZREMRANGEBYSCORE'),'stale reservations are removed');
    await finishQuota(environment,quota);
    assert.ok(calls[1][1].includes("SADD"),'a completed result consumes the slot');
    await releaseQuota(environment,quota);
    assert.equal(calls[2][0],'ZREM');
  }finally{globalThis.fetch=original;}
});
