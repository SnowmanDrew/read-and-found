import React from 'react';
import { ImageResponse } from '@vercel/og';
const h=React.createElement;
// A deliberately simple, branded preview for the homepage.
// Personalised previews come from /api/list-og for saved lists.
export default async function handler(req,res) {
  if(req.method!=='GET')return res.status(405).end('Method not allowed');
  const card = h('div',{style:{
    width:1200,height:630,display:'flex',flexDirection:'column',justifyContent:'space-between',
    backgroundColor:'#1c304c',color:'#f5f6f4',padding:'63px 75px',
    borderBottom:'19px solid #e4b857'
  }},
    h('div',{style:{fontSize:42,fontWeight:700,letterSpacing:-1}},'read&found'),
    h('div',{style:{display:'flex',flexDirection:'column',gap:24}},
      h('div',{style:{display:'flex',flexDirection:'column',fontSize:102,fontWeight:700,letterSpacing:-5,lineHeight:1.0}},
        h('span',{},'we should talk'),h('span',{},'about books.')),
      h('div',{style:{fontSize:28,fontStyle:'italic',color:'#e8d3a8'}},
        'a little book-finding project, made by Drew and Hannah')),
    h('div',{style:{display:'flex',justifyContent:'space-between',fontSize:21}},
      h('span',{},'three questions. five books.'),
      h('span',{style:{color:'#efcb94'}},'readandfound.com'))
  );
  try {
    const image=new ImageResponse(card,{width:1200,height:630});
    res.setHeader('Content-Type','image/png');
    res.setHeader('Cache-Control','public, max-age=86400, s-maxage=86400');
    return res.status(200).end(Buffer.from(await image.arrayBuffer()));
  } catch(error) {
    console.error('Homepage OG image failed:',error?.message||error?.name||'error');
    return res.status(503).end('Image unavailable');
  }
}
