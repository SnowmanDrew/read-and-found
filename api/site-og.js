import React from 'react';
import { ImageResponse } from '@vercel/og';

const h = React.createElement;
const FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf';
let fontPromise;

// The preview borrows the site's bookshop-front hero, oversized Fraunces
// lettering and overlapping paper answer slip rather than a generic banner.
// Cache the open-licensed font across warm invocations; still render if it fails.
function loadFont() {
  if (!fontPromise) fontPromise = fetch(FONT_URL, { signal: AbortSignal.timeout(8000) })
    .then(response => {
      if (!response.ok) throw new Error('font unavailable');
      return response.arrayBuffer();
    })
    .catch(error => {
      console.warn('OG font unavailable:', error?.message || 'unknown');
      fontPromise = null;
      return null;
    });
  return fontPromise;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');
  try {
    const fontData = await loadFont();
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
        padding: '58px 64px 75px', backgroundColor: '#1c304c',
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
          h('span', {}, 'tell us what you loved reading.'),
          h('span', {}, 'we’ll find five books worth trying.')
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
      ...(fontData ? { fonts: [{ name: 'Fraunces', data: fontData, weight: 700, style: 'normal' }] } : {})
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    return res.status(200).end(Buffer.from(await image.arrayBuffer()));
  } catch (error) {
    console.error('Homepage OG image failed:', error?.message || error?.name || 'error');
    return res.status(503).end('Image unavailable');
  }
}
