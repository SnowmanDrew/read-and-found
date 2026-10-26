import { loadList, escapeHTML as esc } from '../lib/saved-list.js';
const website='https://readandfound.com';
const urlBook=b=>'/api/out?'+new URLSearchParams({title:b.title,author:b.author,...(b.isbn13?{isbn:b.isbn13}:{})}).toString();
const worldcat=b=>'https://search.worldcat.org/search?'+new URLSearchParams({q:b.isbn13?'bn:'+b.isbn13:b.title+' '+b.author});
const cover=b=>b.coverUrl ? '<img src="'+esc(b.coverUrl)+'" alt="Cover of '+esc(b.title)+'" loading="lazy">' : '<div class="missing-cover">'+esc(b.title)+'</div>';
const borrow=b=>{
 const search=b.title+' — '+b.author;
 return '<details class="borrow"><summary>borrow or listen</summary><div class="borrow-content"><p>Search for <strong>'+esc(search)+'</strong> at your local library.</p>'+
 '<button type="button" data-copy="'+esc(search)+'">copy title &amp; author</button>'+
 '<div class="borrow-links"><a href="https://www.gov.uk/local-library-services" target="_blank" rel="noopener noreferrer">find a local library (England &amp; Wales)</a>'+
 '<a href="https://libbyapp.com/" target="_blank" rel="noopener noreferrer">Libby (ebook / audiobook)</a>'+
 '<a href="https://www.borrowbox.com/" target="_blank" rel="noopener noreferrer">BorrowBox (ebook / audiobook)</a>'+
 '<a href="'+esc(worldcat(b))+'" target="_blank" rel="noopener noreferrer">WorldCat catalogue</a></div>'+
 '<p class="fine">Availability depends on your library membership and catalogue.</p></div></details>';
};
const detail=b=>[b.year ? 'first published '+b.year:'',b.pages ? 'about '+b.pages+' pages (edition varies)':'',b.series||''].filter(Boolean).join(' · ');
export function renderSharedList(list,id) {
 const link=website+'/list/'+id;
 const title=list.readerType || 'a reading list';
 const cards=list.books.map((b,i)=>{
   const tag={closest_match:'closest match',tone_match:'your kind of mood',wildcard:'wildcard'}[b.role];
   return '<article class="book"><div class="cover">'+cover(b)+'</div><div class="book-text"><div class="number">'+String(i+1).padStart(2,'0')+'</div>'+
    (tag?'<span class="tag">'+esc(tag)+'</span>':'')+
    '<h3>'+esc(b.title)+'</h3><p class="author">by '+esc(b.author)+'</p>'+
    (detail(b)?'<p class="detail">'+esc(detail(b))+'</p>':'')+
    '<p class="reason">'+esc(b.reason)+'</p>'+
    (b.contentNote?'<details class="content"><summary>content note</summary><p>'+esc(b.contentNote)+'</p></details>':'')+
    '<div class="actions"><a href="'+esc(urlBook(b))+'" target="_blank" rel="noopener noreferrer sponsored">find a copy at Bookshop.org</a></div>'+
    borrow(b)+'</div></article>';
 }).join('');
 const favourites=(list.favouriteBooks||[]).map(b=>'<span>'+esc(b.title)+' <small>by '+esc(b.author)+'</small></span>').join('');
 const authors=(list.favouriteAuthors||[]).map(n=>'<span>'+esc(n)+'</span>').join('');
 const description='Five books picked for a reader with '+title.toLowerCase()+'. See their personalised reading notes and get your own.';
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<title>'+esc(title)+' — a reading list | Read &amp; Found</title>'+
 '<meta name="description" content="'+esc(description)+'">'+
 '<meta name="robots" content="noindex,nofollow">'+
 '<link rel="canonical" href="'+link+'">'+
 '<meta property="og:type" content="article"><meta property="og:site_name" content="Read &amp; Found">'+
 '<meta property="og:title" content="'+esc(title)+' — a reading list">'+
 '<meta property="og:description" content="'+esc(description)+'">'+
 '<meta property="og:url" content="'+link+'">'+
 '<meta property="og:image" content="'+website+'/api/list-og?id='+id+'">'+
 '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'+
 '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="'+esc(title)+' — a reading list">'+
 '<meta name="twitter:image" content="'+website+'/api/list-og?id='+id+'">'+
 '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg?v=3" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">'+
 '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'+
 '<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600;700&family=Source+Serif+4:wght@400;500;600&display=swap" rel="stylesheet">'+
 '<style>'+styles+'</style></head><body><div class="shell"><header><a class="logo" href="/">read<span>&amp;</span>found</a><a class="make" href="/">make your own list</a></header>'+
 '<main><div class="intro"><p class="eyebrow">a reading list from read&amp;found</p><h1>'+esc(title)+'</h1><p class="portrait">'+esc(list.portrait)+'</p></div>'+
 ((favourites||authors)?'<div class="starting"><p>the books and writers behind this list</p><div class="named">'+favourites+authors+'</div></div>':'')+
 '<div class="list-head"><h2>five books to try</h2><button type="button" class="copy-link" data-copy="'+esc(link)+'">copy this link</button></div>'+
 '<section>'+cards+'</section><footer><p>someone shared their reading list with you.</p><a href="/">get five books picked for you</a>'+
 '<p class="fine">Read &amp; Found is a free project made by Drew and Hannah. Library availability varies. Some Bookshop.org links may earn a small commission.</p></footer></main></div>'+
 '<script>document.addEventListener("click",async e=>{const b=e.target.closest("[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="copied!";setTimeout(()=>{b.textContent=b.dataset.copy.startsWith("https://")?"copy this link":"copy title & author"},2200)}catch(_){b.textContent="select and copy the text"}})</script>'+
 '</body></html>';
}
const styles=`
:root{--ink:#1c304c;--paper:#f5f6f4;--accent:#c34b36;--line:#bcc8d5}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);margin:0;font:18px/1.53 "Source Serif 4",Georgia,serif}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
button{font:inherit;cursor:pointer;background:transparent;color:inherit}
.shell{max-width:1120px;margin:0 auto;padding:0 26px}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 0 19px;border-bottom:2px solid var(--ink)}
.logo{font:650 33px/1 "Fraunces",Georgia,serif;letter-spacing:-.07em;text-decoration:none}
.logo span{color:var(--accent)}
.make{font:500 16px "Source Serif 4",Georgia,serif}
.intro{background:var(--ink);color:var(--paper);padding:48px clamp(22px,6vw,70px) 58px;margin:20px -12px 34px;border-bottom:9px solid #e4b857}
.eyebrow{font:italic 18px "Source Serif 4",Georgia,serif;color:#f1d799}
h1{font:600 clamp(50px,8vw,108px)/1.03 "Fraunces",Georgia,serif;letter-spacing:-.055em;margin:12px 0 25px;text-transform:lowercase}
.portrait{font-size:clamp(18px,2.5vw,25px);max-width:780px;line-height:1.46;margin:0}
.starting{padding:12px 0 22px;border-bottom:1px solid var(--line)}
.starting>p{font-style:italic;margin:0 0 12px}
.named{display:flex;gap:10px;flex-wrap:wrap}.named span{background:#e6ecf3;padding:5px 10px;font-size:15px}
.named small{font-size:12px}
.list-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:43px 0 12px}
h2{font:550 clamp(28px,4vw,44px)/1.1 "Fraunces",Georgia,serif;margin:0}
.copy-link{padding:9px 15px;border:1px solid var(--ink)}
.book{display:grid;grid-template-columns:130px minmax(0,1fr);gap:30px;border-top:1px solid var(--line);padding:32px 0}
.cover img{width:130px;max-height:220px;object-fit:contain;display:block;background:#dde2e9}
.missing-cover{width:130px;aspect-ratio:2/3;background:var(--ink);color:white;padding:15px;font:600 19px/1.15 "Fraunces",Georgia,serif;overflow-wrap:anywhere}
.number{font-size:14px;color:#52647e}
.tag{font:italic 14px "Source Serif 4",Georgia,serif;display:inline-block;padding:2px 8px;background:#e6ecf3;border:1px solid var(--line);margin:8px 0}
h3{font:600 clamp(29px,4vw,44px)/1.07 "Fraunces",Georgia,serif;letter-spacing:-.03em;margin:9px 0}
.author{font-style:italic;margin:4px 0 8px}
.detail{font-size:14px;opacity:.75;margin:6px 0}
.reason{margin:16px 0;max-width:760px}
.actions{display:inline-flex;margin:5px 0 9px;font-size:16px}
.borrow{margin:7px 0}
.borrow summary,.content summary{cursor:pointer;width:max-content;text-decoration:underline;text-underline-offset:3px;font-size:16px}
.borrow-content{border-left:2px solid var(--accent);padding:7px 0 7px 17px;margin-top:13px;background:#e9eef4}
.borrow-content p{font-size:15px;margin:8px 0 12px}
.borrow-content button{padding:6px 12px;border:1px solid var(--ink);font-size:15px}
.borrow-links{display:flex;flex-wrap:wrap;gap:12px;margin:13px 0;font-size:14px}
.content p{font-size:15px;margin:8px 0 14px}
.fine{font-size:13px!important;line-height:1.4;opacity:.7}
footer{border-top:3px solid var(--ink);margin-top:42px;padding:28px 0 50px}
footer>p:first-child{font-style:italic}
footer>a{display:inline-block;padding:13px 21px;background:var(--accent);color:white;font-weight:600}
@media(max-width:560px){.shell{padding:0 15px}header{padding:15px 0}.logo{font-size:27px}.make{font-size:14px}
.intro{margin:13px -5px 23px;padding:27px 19px 35px}.book{grid-template-columns:81px minmax(0,1fr);gap:14px;padding:24px 0}
.cover img,.missing-cover{width:81px;max-height:135px}.missing-cover{font-size:15px;padding:10px}h3{font-size:27px}
body{font-size:16px}.reason{font-size:16px}.list-head{margin-top:26px;flex-wrap:wrap}.borrow-links{flex-direction:column}
}
`;
export default async function handler(req,res) {
 if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).end('Method not allowed');}
 const id=(req.query||{}).id;
 if(typeof id!=='string')return res.status(404).end('List not found');
 try{
  const list=await loadList(id);
  if(!list)return res.status(404).setHeader('Content-Type','text/plain').end('List not found');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','public, max-age=120, s-maxage=120');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; img-src https://covers.openlibrary.org data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none';");
  return res.status(200).end(renderSharedList(list,id));
 }catch(e){
  console.error('Read list unavailable',e.name||'error');
  return res.status(503).end('Reading list temporarily unavailable');
 }
}
