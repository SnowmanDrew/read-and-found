import { strict as assert } from 'node:assert';
import { issueShareProof, verifyShareProof } from '../lib/share-proof.js';
const secret='test-only-example-secret';
const list={readerType:'A little ahead',portrait:'A concise personal reading note.',books:[
  {title:'One',author:'A'},{title:'Two',author:'B'},{title:'Three',author:'C'},
  {title:'Four',author:'D'},{title:'Five',author:'E'}
]};
const session='a-test-session';
const proof=issueShareProof(list,session,secret);
assert.match(proof,/^[a-z0-9]{8,12}\.[a-f0-9]{64}$/);
assert(verifyShareProof(proof,list,session,secret));
assert(!verifyShareProof(proof,list,'wrong-session',secret));
assert(!verifyShareProof(proof,list,session,'wrong-secret'));
assert(!verifyShareProof('garbage',list,session,secret));
assert(!issueShareProof({...list,books:[]},session,secret));
// Swapping a book in an authorised reading session must remain shareable.
assert(verifyShareProof(proof,{...list,books:[...list.books.slice(0,4),{title:'Replacement',author:'F'}]},session,secret));
console.log('Saved-list proof tests passed');
