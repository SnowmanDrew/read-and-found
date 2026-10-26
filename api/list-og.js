import React from 'react';
import { ImageResponse } from '@vercel/og';
import { loadList } from '../lib/saved-list.js';
const h=React.createElement;

export default async function handler(req,res) {
 const id=req.query?.id;
 if(req.method!=='GET')return res.status(405).end('Method not allowed');
 try {
  const list=await loadList(id);
  if(!list)return res.status(404).end('List not found');
  const top=list.books.slice(0,3);
  // Fetch only public catalogue cover images; never the user's private answers.
  const images=await Promise.all(top.map(async b=>{
    if(!/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(b.coverUrl||''))return null;
    try {
      const response=await fetch(b.coverUrl,{signal:AbortSignal.timeout(3000)});
      if(!response.ok || !/^image\/(jpeg|png)/i.test(response.headers.get('content-type')||''))return null;
      const data=Buffer.from(await response.arrayBuffer());
      if(data.length>500000)return null;
      return 'data:'+response.headers.get('content-type')+';base64,'+data.toString('base64');
    } catch(_) {return null}
  }));
  const covers=top.map((b,i)=>h('div',{key:i,style:{height:'220px',width:'140px',background:'#f5f6f4',
    border:'3px solid #f2d99d',display:'flex',flexDirection:'column',justifyContent:'center',
    overflow:'hidden',padding:images[i]?'0':'15px'}},
    images[i]?h('img',{src:images[i],width:134,height:214,style:{objectFit:'contain'}}):
      h('span',{style:{fontSize:19,fontWeight:700,color:'#1c304c',lineHeight:1.2}},b.title)));
  const component=h('div',{style:{width:'1200px',height:'630px',display:'flex',background:'#1c304c',
     color:'#f5f6f4',padding:'54px 62px',fontFamily:'Georgia',alignItems:'center',justifyContent:'space-between'}},
   h('div',{style:{display:'flex',flexDirection:'column',width:'560px',height:'100%',justifyContent:'space-between'}},
      h('div',{style:{fontSize:34,fontWeight:700}},'read&found'),
      h('div',{style:{display:'flex',flexDirection:'column',gap:17}},
        h('span',{style:{fontSize:26,color:'#edcf8c',fontStyle:'italic'}},'a reading list, just for you'),
        h('div',{style:{fontSize:64,fontWeight:700,letterSpacing:-2,lineHeight:1.05}},list.readerType.slice(0,72)),
        h('div',{style:{fontSize:24,color:'#dce6f1'}},'five books, picked for you')),
      h('span',{style:{fontSize:20,color:'#dfc685'}},'readandfound.com')),
   h('div',{style:{display:'flex',width:470,justifyContent:'space-between',gap:14,alignItems:'center'}},...covers));
  const image=new ImageResponse(component,{width:1200,height:630});
  res.statusCode=200;res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','public,max-age=120,s-maxage=120');
  return res.end(Buffer.from(await image.arrayBuffer()));
 }catch(error){
  console.error('Share image unavailable:',error.name||'error');
  return res.status(503).end('Image unavailable');
 }
}
