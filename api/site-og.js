import React from 'react';
import { ImageResponse } from '@vercel/og';
import { readFile } from 'node:fs/promises';

const h = React.createElement;

// These two small subsets are from Fraunces, licensed under SIL OFL 1.1.
// Bundling them avoids an external font request for every social-card render.
let fontPromise;
function loadFonts() {
  if (!fontPromise) fontPromise = Promise.all([
    readFile(new URL('../assets/fonts/fraunces-700-social.ttf', import.meta.url)),
    readFile(new URL('../assets/fonts/fraunces-400-social.ttf', import.meta.url))
  ]).then(files => files.map(bytes =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  )).catch(error => {
    console.warn('OG font unavailable:', error?.message || 'unknown');
    fontPromise = null;
    return null;
  });
  return fontPromise;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');
  try {
    const fontData = await loadFonts();
    const headlineFont = fontData ? 'Fraunces' : 'Georgia';
    const card = h('div', { style: {
      width: 1200, height: 630, display: 'flex', flexDirection: 'column',
      position: 'relative', backgroundColor: '#f5f6f4', color: '#1c304c'
    } },
      h('div', { style: {
        height: 105, width: 1200, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 70px',
        borderBottom: '2px solid #1c304c'
      } },
        h('span', { style: {
          fontFamily: headlineFont, fontSize: 47, fontWeight: 700,
          letterSpacing: -3.5
        } }, 'read&found'),
        h('span', { style: {
          fontFamily: headlineFont, fontSize: 23, fontStyle: 'italic',
          color: '#42546d'
        } }, 'a little book-finding project')
      ),
      h('div', { style: {
        height: 475, display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', margin: '17px 32px 0',
        padding: '45px 64px 145px', backgroundColor: '#1c304c',
        color: '#f7f9f5', borderBottom: '12px solid #e4b857'
      } },
        h('div', { style: {
          display: 'flex', flexDirection: 'column', fontFamily: headlineFont,
          fontSize: 111, lineHeight: 0.98, fontWeight: 700,
          letterSpacing: -6.3
        } },
          h('span', {}, 'we should talk'),
          h('span', {}, 'about books.')
        ),
        h('div', { style: {
          display: 'flex', flexDirection: 'column', gap: 7,
          fontFamily: headlineFont, fontSize: 28, lineHeight: 1.16,
          color: '#e5ecf3'
        } },
          h('span', {}, 'tell us what you loved reading.')
        )
      ),
      h('div', { style: {
        position: 'absolute', left: 168, top: 502, width: 985, height: 118,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: '#eff3f7', borderTop: '2px solid #1c304c',
        padding: '20px 31px', boxShadow: '12px 10px 0 #cdd8e3'
      } },
        h('div', { style: {
          display: 'flex', flexDirection: 'column', gap: 13, width: 710
        } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 14 } },
            h('span', { style: {
              fontFamily: headlineFont, fontSize: 36, fontWeight: 700,
              color: '#c34b36'
            } }, '1.'),
            h('span', { style: {
              fontFamily: headlineFont, fontSize: 25,
              fontWeight: 700, letterSpacing: -0.6
            } }, 'start with the books you love')
          ),
          h('div', { style: { height: 1, width: 630, backgroundColor: '#889cb4' } })
        ),
        h('div', { style: {
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
          fontFamily: headlineFont, fontSize: 17, lineHeight: 1.35,
          color: '#42546d'
        } },
          h('span', {}, 'three questions.'),
          h('span', {}, 'five books.')
        )
      )
    );
    const image = new ImageResponse(card, {
      width: 1200, height: 630,
      ...(fontData ? { fonts: [{ name: 'Fraunces', data: fontData[0], weight: 700, style: 'normal' },
        { name: 'Fraunces', data: fontData[1], weight: 400, style: 'normal' }] } : {})
    });
    res.setHeader('X-RNF-OG-Font', fontData ? 'embedded' : 'fallback');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).end(Buffer.from(await image.arrayBuffer()));
  } catch (error) {
    console.error('Homepage OG image failed:', error?.message || error?.name || 'error');
    return res.status(503).end('Image unavailable');
  }
}
