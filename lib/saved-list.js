import { randomBytes } from 'node:crypto';
import { get, put } from '@vercel/blob';

const string = (value,max) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const regex = /^[a-zA-Z0-9_-]{12,30}$/;
export const isListId = id => typeof id === 'string' && regex.test(id);
const allowedCover = u => /^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(u || '');

export function cleanList(body) {
  if (!body || !Array.isArray(body.books) || body.books.length !== 5) throw new Error('invalid_list');
  const books = body.books.map(b => ({
    title:string(b.title,150), author:string(b.author,110),
    reason:string(b.reason,850), thread:string(b.thread,100),
    role:['closest_match','tone_match','wildcard','other'].includes(b.role)?b.role:'other',
    contentNote:string(b.contentNote,260),
    year:Number.isInteger(b.year) && b.year>=1400 && b.year<=2100 ? b.year:null,
    pages:Number.isInteger(b.pages) && b.pages>0 && b.pages<=4000 ? b.pages:null,
    series:string(b.series,100),
    isbn13:/^97[89]\d{10}$/.test(b.isbn13||'')?b.isbn13:null,
    coverUrl:allowedCover(b.coverUrl)?b.coverUrl:null
  }));
  if (books.some(b=>!b.title || !b.author || !b.reason)) throw new Error('invalid_list');
  const readerType=string(body.readerType,110), portrait=string(body.portrait,1400);
  if (!readerType || !portrait) throw new Error('invalid_list');
  return {
    version:1, readerType, portrait, books,
    favouriteBooks:(Array.isArray(body.favouriteBooks)?body.favouriteBooks:[]).slice(0,6).map(b=>({
      title:string(b.title,150),author:string(b.author,110),
      coverUrl:allowedCover(b.coverUrl)?b.coverUrl:null
    })).filter(b=>b.title&&b.author),
    favouriteAuthors:(Array.isArray(body.favouriteAuthors)?body.favouriteAuthors:[]).slice(0,8).map(n=>string(n,100)).filter(Boolean)
  };
}
export async function saveList(list) {
  const id = randomBytes(12).toString('base64url');
  await put('lists/'+id+'.json',JSON.stringify({...list,createdAt:new Date().toISOString()}),{
    access:'private',addRandomSuffix:false,contentType:'application/json',
    cacheControlMaxAge:60
  });
  return id;
}
export async function loadList(id) {
  if (!isListId(id)) return null;
  const blob = await get('lists/'+id+'.json',{access:'private'});
  if (!blob?.stream) return null;
  const raw = await new Response(blob.stream).text();
  if(raw.length>40000)return null;
  return JSON.parse(raw);
}
export const escapeHTML = value => String(value??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
