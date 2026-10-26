import { cleanList, saveList } from '../lib/saved-list.js';
import { verifyShareProof } from '../lib/share-proof.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed.'});
  const host=req.headers['x-forwarded-host']||req.headers.host;
  const origin=req.headers.origin;
  if(origin && !['https://readandfound.com','https://www.readandfound.com',
    'https://afterword-coral.vercel.app'].includes(origin) &&
    origin !== 'https://'+host) return res.status(403).json({error:'Invalid origin.'});
  if(Number(req.headers['content-length']||0)>28000)return res.status(413).json({error:'List is too large.'});
  try {
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
    if(JSON.stringify(body||{}).length>28000)throw new Error('invalid_list');
    const list=cleanList(body);
    if(!verifyShareProof(body.proof,list,body.sessionId,process.env.OPENAI_API_KEY))
      return res.status(403).json({error:'The save link expired. Generate a new list to save it.'});
    if(!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL_OIDC_TOKEN)
      return res.status(503).json({error:'List storage is temporarily unavailable.'});
    const id=await saveList(list);
    return res.status(201).json({url:'https://readandfound.com/list/'+id});
  }catch(error) {
    if(error.message==='invalid_list')return res.status(400).json({error:'The reading list was incomplete.'});
    console.error('Saving a list failed:',error.name||'error');
    return res.status(503).json({error:'Unable to save this list just now. Please try again.'});
  }
}
