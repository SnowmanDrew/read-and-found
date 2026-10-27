import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Run the actual browser export function with a recording canvas. These
// fixtures catch regressions where author-only answers produce an empty card.
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=source.indexOf('  async function portraitCanvas() {');
const end=source.indexOf('\n  async function exportPortrait(',start);
assert.ok(start>=0&&end>start,'portraitCanvas must be present');
const functionSource=`(${source.slice(start,end).trim()})`;

async function render(state){
  const text=[];
  const ctx={
    font:'30px Georgia',fillStyle:'',
    measureText(value){
      const size=Number(this.font.match(/(\d+)px/)?.[1]||30);
      return {width:String(value).length*size*.49};
    },
    fillText(value,x,y){text.push({value:String(value),x,y});},
    fillRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},drawImage(){}
  };
  const wrappedLines=(context,value,width)=>{
    const lines=[];let line='';
    for(const word of String(value||'').split(/\s+/).filter(Boolean)){
      const next=line?line+' '+word:word;
      if(line&&context.measureText(next).width>width){lines.push(line);line=word;}
      else line=next;
    }
    if(line)lines.push(line);
    return lines;
  };
  const renderFn=vm.runInNewContext(functionSource,{
    state,wrappedLines,loadShareCover:async()=>null,
    document:{createElement:()=>({getContext:()=>ctx})},
    setTimeout,Promise
  });
  await renderFn();
  return text;
}

const baseline={
  readerType:'Lives in Company',
  portrait:'You like stories in which people change one another over time, with places that feel inhabited. '
    .repeat(4),
  favourites:'I love Isabel Allende and Elena Ferrante.',
  favouriteBooks:[],favouriteAuthors:[]
};

test('author-only readers get their actual named authors on the shared portrait',async()=>{
  const text=await render({...baseline,favouriteAuthors:['Isabel Allende','Elena Ferrante']});
  assert.ok(text.some(item=>item.value==='AUTHORS YOU MENTIONED'));
  assert.ok(text.some(item=>item.value==='Isabel Allende'));
  assert.ok(text.some(item=>item.value==='Elena Ferrante'));
  assert.ok(!text.some(item=>item.value==='BOOKS YOU MENTIONED'));
});

test('both books and authors appear together, without relying on cover downloads',async()=>{
  const text=await render({...baseline,
    favouriteBooks:[{title:'The House of the Spirits',author:'Isabel Allende'}],
    favouriteAuthors:['Elena Ferrante']
  });
  for(const expected of ['BOOKS YOU MENTIONED','AUTHORS YOU MENTIONED',
    'The House of the Spirits','Isabel Allende','Elena Ferrante']){
    assert.ok(text.some(item=>item.value===expected),`missing ${expected}`);
  }
});

test('no detected titles or authors still includes the reader’s own starting point',async()=>{
  const text=await render(baseline);
  assert.ok(text.some(item=>item.value==='YOU STARTED WITH'));
  assert.ok(text.some(item=>item.value.includes('Isabel Allende')));
});

test('long notes and titles do not run through the personal details or footer',async()=>{
  const text=await render({...baseline,
    readerType:'A Fascination With Stories Of People Who Keep Becoming Different People',
    portrait:'These are the stories you came to talk about, full of overlapping lives and histories. '.repeat(40),
    favouriteAuthors:['Elena Ferrante']
  });
  const body=text.filter(item=>item.y>=460&&item.y<1000);
  assert.ok(body.length>0);
  assert.ok(body.every(item=>item.y<1000),'portrait intrudes into mentions shelf');
  assert.ok(text.some(item=>item.value==='Elena Ferrante'));
  assert.ok(text.some(item=>item.value==='readandfound.com'));
});
