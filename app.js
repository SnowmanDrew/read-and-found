/* Read & Found v22: deliberately small and framework-free.
   Every question and recommendation comes from the server-side model.
   No API key, book catalogue or simulated answers are shipped to browsers. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = { favourites: '', questions: [], answers: [], researchNotes: '', initialSources: [], researchSources: [], books: [], readerType: '', portrait: '', favouriteBooks: [], feedback: [], sessionId: '', stage: 'intro', busy: false };
  const stages = { intro: $('introStage'), conversation: $('conversationStage'), results: $('resultsStage') };
  let loadingTicker = null;
  let retryAction = null;
  let toastTimer = null;
  let coverLookupVersion = 0;
  let recommendationEpoch = 0;
  let swapQueue = [];
  let swapWorkerRunning = false;
  let activeSwapController = null;
  let favouriteCoverLookupVersion = 0;

  const verdicts = [
    { id: 'loved', label: 'Loved it' },
    { id: 'liked', label: 'Liked it' },
    { id: 'okay', label: 'It was fine' },
    { id: 'disliked', label: 'Not for me' }
  ];

  const trim = value => String(value || '').trim();
  const sessionId = () => (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
  const snippet = (value, max = 70) => trim(value).length > max ? trim(value).slice(0,max-1).trimEnd() + '…' : trim(value);

  function icons() { if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'stroke-width': 1.6 } }); }

  function toast(message) {
    const box = $('toast'); box.textContent = message; box.classList.add('is-visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('is-visible'), 3500);
  }

  function stage(name) {
    state.stage = name;
    for (const [key, element] of Object.entries(stages)) {
      element.hidden = key !== name;
      element.classList.toggle('is-active', key === name);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function stopLoadingTicker() {
    if (loadingTicker !== null) clearInterval(loadingTicker);
    loadingTicker = null;
  }
  function loading(title, description) {
    state.busy = true; stopLoadingTicker();
    const longWait = /reading list/i.test(title);
    const notes = longWait ? [
      ['Finding your five books…','Looking beyond the obvious choices.'],
      ['Checking the shelves…','Making sure the details are right.'],
      ['Following a few good leads…','Some books are harder to find than others.'],
      ['Writing your reading notes…','Putting the reasons into words.'],
      ['Nearly there…','Taking another look at your answers.']
    ] : [[title,description],
      ['Thinking about what you said…','Following the thread between your favourites.'],
      ['One good question at a time…','Trying not to make any easy assumptions.']];
    let index = 0;
    const advance = () => {
      const [heading,detail] = notes[index++ % notes.length];
      $('loadingTitle').textContent = heading; $('loadingDetail').textContent = detail;
      $('loadingKicker').textContent = longWait ? 'Making a reading list' : 'A note from the shelves';
    };
    advance(); loadingTicker = setInterval(advance,7200);
    $('loadingOverlay').classList.toggle('is-long-wait',longWait);
    $('loadingOverlay').classList.toggle('is-question-wait',!longWait);
    $('loadingIcon').hidden = false; $('loadingRule').hidden = false;
    $('retryButton').hidden = true; $('backFromError').hidden = true;
    $('loadingOverlay').hidden = false; document.body.style.overflow = 'hidden';
  }
  function hideLoading() {
    stopLoadingTicker(); state.busy = false; retryAction = null;
    $('loadingOverlay').hidden = true;
    // A real ink-stamp gesture, only when the new five-book list first appears.
    // Swapping a recommendation does not trigger it again.
    if (state.stage === 'results' && !stages.results.classList.contains('stamp-revealed')) {
      requestAnimationFrame(() => stages.results.classList.add('stamp-revealed'));
    }
    document.body.style.overflow = '';
  }
  function showError(message, onRetry) {
    stopLoadingTicker(); state.busy = false; retryAction = onRetry;
    $('loadingKicker').textContent = 'A note from the shelves';
    $('loadingTitle').textContent = 'A small interruption.';
    $('loadingDetail').textContent = message;
    $('loadingIcon').hidden = true; $('loadingRule').hidden = true;
    $('retryButton').hidden = /two sets of recommendations today|book swaps available today/i.test(message);
    $('backFromError').hidden = false;
  }

  async function callModel(step, history) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 170000);
    try {
      const response = await fetch('/api/read', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favourites: state.favourites, step, history, researchNotes: state.researchNotes, sessionId: state.sessionId })
      });
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(payload.error || 'We couldn’t reach the model. Please try again.');
      return payload;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The model took too long to reply. Try again.');
      if (err instanceof TypeError) throw new Error('We couldn’t connect just now. Check your connection and try again.');
      throw err;
    } finally { clearTimeout(timeout); }
  }

  function historyWith(pending = null) {
    const fullQuestion = item => [item.lead, item.question].filter(Boolean).join(' ');
    const history = state.answers.map((answer,i) => ({ question: fullQuestion(state.questions[i]), answer }));
    if (pending !== null) history.push({ question: fullQuestion(state.questions[state.answers.length]), answer: pending });
    return history;
  }

  async function run(action, title, description) {
    if (state.busy) return;
    loading(title,description);
    try { await action(); hideLoading(); }
    catch (error) { showError(error.message || 'Please try again.', () => run(action,title,description)); }
  }

  function ledger() {
    const list = $('conversationLedger'); list.replaceChildren();
    const labels = ['Your favourites','First question','Second question','Third question'];
    for (let i=0;i<4;i++) {
      const li = document.createElement('li');
      if (i === state.answers.length + 1) li.className = 'is-current';
      const label = document.createElement('span'); label.className = 'ledger-heading'; label.textContent = labels[i];
      const answer = document.createElement('span'); answer.className = 'ledger-answer';
      answer.textContent = i === 0 ? snippet(state.favourites,75) : state.answers[i-1] ? snippet(state.answers[i-1],75) : i === state.answers.length + 1 ? 'Now' : 'Up next';
      if (i > state.answers.length) answer.classList.add('ledger-pending');
      li.append(label,answer); list.append(li);
    }
    $('timelineCount').textContent = `Question ${Math.min(3,state.answers.length+1)} of 3`;
  }

  function renderQuestion() {
    const index = state.answers.length;
    $('questionIndex').textContent = `Question ${index+1} of 3`;
    $('progressFill').style.width = `${index/3*100}%`;
    $('questionLead').textContent = state.questions[index].lead || '';
    $('questionLead').hidden = !state.questions[index].lead;
    $('questionHeading').textContent = state.questions[index].question;
    $('questionHeading').classList.toggle('is-long',state.questions[index].question.length>180);
    $('conversationAsideHeading').textContent = ["Let's get specific.",'Another angle.','Nearly there.'][index];
    // Keep research citations in the final reading list, not in the question area.
    $('questionSources').replaceChildren(); $('questionSources').hidden = true;
    $('answerInput').value = '';
    $('answerInput').placeholder = /have you (read|come across)|ever read|are you familiar with/i.test(state.questions[index].question)
      ? 'If you have, what did you think? If not, what’s your instinct?'
      : 'Whatever comes to mind…';
    $('answerContinue').disabled = true;
    $('continueText').textContent = index === 2 ? 'Find my five books' : 'Continue';
    ledger(); stage('conversation');
    $('questionContent').style.animation = 'none'; void $('questionContent').offsetWidth; $('questionContent').style.animation = '';
    setTimeout(() => $('questionHeading').focus({preventScroll:true}),80);
  }

  function sourceLink(item) {
    const link = document.createElement('a');
    if (!item || !/^https?:\/\//i.test(item.url || '')) return link;
    link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = item.title || 'Source';
    link.title = `${item.title || 'Source'} — opens in a new tab`;
    return link;
  }

  function coverFor(book,index) {
    const cover = document.createElement('div'); cover.className = `book-cover cover-style-${index+1}`; cover.setAttribute('aria-hidden','true');
    cover.dataset.coverIndex = String(index);
    const top = document.createElement('span'); top.className = 'cover-top'; top.textContent = 'Read & Found';
    const ornament = document.createElement('span'); ornament.className = `cover-ornament cover-ornament-${index+1}`;
    const bottom = document.createElement('div');
    const title = document.createElement('div'); title.className = 'cover-title'; title.textContent = book.title;
    const author = document.createElement('div'); author.className = 'cover-author'; author.textContent = book.author;
    bottom.append(title,author); cover.append(top,ornament,bottom);
    return cover;
  }

  function bookshopUrl(book) {
    const params = new URLSearchParams({ title: book.title, author: book.author });
    if (/^97[89]\d{10}$/.test(book.isbn13 || '')) params.set('isbn',book.isbn13);
    return '/api/out?' + params.toString();
  }

  function createBookRow(book,index) {
    const row = document.createElement('article');
    row.className = 'book-row';
    row.dataset.bookIndex = String(index);
    row.style.animationDelay = `0ms`;
    const number = document.createElement('div'); number.className = 'book-number'; number.textContent = String(index+1).padStart(2,'0');
    const info = document.createElement('div'); info.className = 'book-info';
    const kicker = document.createElement('div'); kicker.className = 'book-kicker'; kicker.textContent = book.thread || (index===0 ? 'START HERE' : 'THE CONNECTION');
    const title = document.createElement('h3'); title.className = 'book-title'; title.textContent = book.title;
    const author = document.createElement('p'); author.className = 'book-author'; author.textContent = `by ${book.author}`;
    const reason = document.createElement('p'); reason.className = 'book-reason'; reason.textContent = book.reason;
    const source = book.source?.url ? sourceLink(book.source) : sourceLink({title:'Open Library',url:'https://openlibrary.org/search?q='+encodeURIComponent(book.title+' '+book.author)});
    if (source) {
      source.className = 'book-source';
      source.replaceChildren(document.createTextNode('About this book '));
      const arrow = document.createElement('i'); arrow.dataset.lucide = 'arrow-up-right'; arrow.setAttribute('aria-hidden','true');
      source.append(arrow);
    }

    const feedback = document.createElement('div'); feedback.className = 'book-feedback';
    const readButton = document.createElement('button'); readButton.type = 'button'; readButton.className = 'read-trigger';
    readButton.setAttribute('aria-expanded','false'); readButton.setAttribute('aria-controls',`read-choices-${index}`);
    const icon = document.createElement('i'); icon.dataset.lucide = 'book-check'; icon.setAttribute('aria-hidden','true');
    readButton.append(icon,document.createTextNode(' Read it? Swap for another'));
    const choices = document.createElement('div'); choices.className = 'read-choices'; choices.id = `read-choices-${index}`; choices.hidden = true;
    const prompt = document.createElement('span'); prompt.className = 'read-prompt'; prompt.textContent = 'How was it?';
    const options = document.createElement('div'); options.className = 'read-options';
    verdicts.forEach(verdict => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'verdict-button';
      button.textContent = verdict.label;
      button.addEventListener('click', () => markAsRead(index,book,verdict.id));
      options.appendChild(button);
    });
    choices.append(prompt,options);
    readButton.addEventListener('click', () => {
      const opening = choices.hidden;
      document.querySelectorAll('.read-choices').forEach(panel => { panel.hidden = true; });
      document.querySelectorAll('.read-trigger').forEach(button => button.setAttribute('aria-expanded','false'));
      choices.hidden = !opening;
      readButton.setAttribute('aria-expanded',String(opening));
    });
    feedback.append(readButton,choices);
    info.append(kicker,title,author,reason);
    const links = document.createElement('div'); links.className = 'book-links';
    if (source) links.append(source);
    const buy = document.createElement('a'); buy.className = 'book-buy'; buy.target = '_blank';
    buy.rel = 'noopener noreferrer sponsored'; buy.dataset.buyIndex = String(index);
    buy.href = bookshopUrl(book);
    const shopIcon = document.createElement('i'); shopIcon.dataset.lucide = 'shopping-bag'; shopIcon.setAttribute('aria-hidden','true');
    const shopArrow = document.createElement('i'); shopArrow.dataset.lucide = 'arrow-up-right'; shopArrow.setAttribute('aria-hidden','true');
    buy.append(shopIcon,document.createTextNode(' Find a copy at Bookshop.org '),shopArrow);
    links.append(buy); info.append(links);
    info.append(feedback);
    row.append(number,coverFor(book,index),info);
    return row;
  }

  function renderResults() {
    $('readerType').textContent = state.readerType;
    $('portraitText').textContent = state.portrait;
    const list = $('booksList'); list.replaceChildren();
    state.books.forEach((book,index) => list.append(createBookRow(book,index)));
    const sources = $('researchSources'); const links = $('researchLinks'); links.replaceChildren();
    const allSources = [...state.researchSources,...state.initialSources].filter((item,index,all)=>item?.url && all.findIndex(other=>other?.url===item.url)===index);
    allSources.forEach(item => {
      const li = document.createElement('li'); li.append(sourceLink(item)); links.append(li);
    });
    sources.hidden = !allSources.length;
    sources.open = false;
    const starting = $('portraitStartingPoint');
    starting.textContent = 'You started with: ' + snippet(state.favourites,250);
    starting.hidden = !state.favourites;
    $('feedbackThanks').hidden = true;
    $('resultsFeedback').querySelectorAll('button').forEach(button=>button.disabled=false);
    stage('results'); icons(); hydrateCovers(); hydrateFavouriteCovers();
  }

  function attachCover(item,index,book,version) {
    if (!item || !/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(item.coverUrl)) return;
    if (version !== coverLookupVersion || state.stage !== 'results' ||
        state.books[index]?.title !== book.title || state.books[index]?.author !== book.author) return;
    const cover = $('booksList').querySelector(`[data-cover-index="${index}"]`);
    if (!cover) return;
    cover.querySelector('.real-cover')?.remove();
    cover.classList.remove('has-real-cover');
    if (item.isbn13) {
      state.books[index].isbn13 = item.isbn13;
      const shop = $('booksList').querySelector(`[data-buy-index="${index}"]`);
      if (shop) shop.href = bookshopUrl(state.books[index]);
    }
    const image = document.createElement('img');
    image.className = 'real-cover'; image.alt = '';
    image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => {
      if (version !== coverLookupVersion || state.stage !== 'results' || state.books[index]?.title !== book.title) return;
      cover.classList.add('has-real-cover');
      $('coverCredit').hidden = false;
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    cover.appendChild(image); image.src = item.coverUrl;
  }

  async function lookupCovers(books,indexOffset,version) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch('/api/covers', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: books.map(({title,author}) => ({ title, author })) })
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.covers)) return;
      data.covers.forEach((item,i) => attachCover(item,indexOffset+i,books[i],version));
    } catch (_) { /* The typographic fallback stays in place. */ }
    finally { clearTimeout(timeout); }
  }

  function hydrateCovers() {
    const version = ++coverLookupVersion;
    $('coverCredit').hidden = true;
    void lookupCovers([...state.books],0,version);
  }

  async function hydrateFavouriteCovers() {
    const version = ++favouriteCoverLookupVersion;
    const section = $('portraitFavourites'), shelf = $('portraitFavouriteShelf');
    shelf.replaceChildren();
    const books = state.favouriteBooks.slice(0,6);
    section.hidden = !books.length;
    if (!books.length) return;
    const elements = books.map((book,index) => {
      const item = document.createElement('div'); item.className = 'portrait-favourite';
      const cover = document.createElement('div'); cover.className = 'portrait-book-cover';
      const title = document.createElement('strong'); title.textContent = book.title;
      const author = document.createElement('span'); author.textContent = book.author;
      cover.append(title,author);
      const caption = document.createElement('p'); caption.className = 'portrait-book-caption'; caption.textContent = book.title;
      item.append(cover,caption); shelf.append(item); return cover;
    });
    try {
      const response = await fetch('/api/covers', {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({books:books.map(({title,author})=>({title,author}))})
      });
      if (!response.ok || version !== favouriteCoverLookupVersion) return;
      const result = await response.json();
      if (!Array.isArray(result.covers) || version !== favouriteCoverLookupVersion) return;
      result.covers.forEach((cover,index) => {
        const url = cover?.coverUrl;
        if (!/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(url || '')) return;
        // Ordinary on-page images do not require CORS. The shared PNG uses a
        // separate CORS-enabled image load because it draws onto a canvas.
        // Preload eagerly so the image is visible even while off screen.
        const image = new Image(); image.loading='eager'; image.decoding='async'; image.alt=`Cover of ${books[index].title}`;
        image.referrerPolicy='no-referrer';
        image.addEventListener('load',()=>{
          if (version !== favouriteCoverLookupVersion || state.stage !== 'results') return;
          const container = elements[index];
          if (!container) return;
          container.append(image);
          container.classList.add('has-cover-image');
          $('coverCredit').hidden=false;
        },{once:true});
        image.addEventListener('error',()=>image.remove(),{once:true});
        image.src=url; books[index].coverUrl=url;
      });
    } catch (_) { /* The book-shaped typographic fallback is deliberate. */ }
  }

  function showSwapStatus(index,message,retryJob = null) {
    const row = $('booksList').querySelector(`[data-book-index="${index}"]`);
    if (!row) return;
    row.classList.toggle('is-replacing',!retryJob);
    const feedback = row.querySelector('.book-feedback');
    feedback.replaceChildren();
    const status = document.createElement('div'); status.className = 'swap-status'; status.setAttribute('role','status');
    if (!retryJob) {
      const spinner = document.createElement('i'); spinner.dataset.lucide = 'loader-circle'; spinner.setAttribute('aria-hidden','true');
      status.append(spinner,document.createTextNode(message));
    } else {
      const note = document.createElement('span'); note.textContent = message;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'swap-retry'; retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        if (retryJob.epoch !== recommendationEpoch || state.stage !== 'results') return;
        swapQueue.push(retryJob); showSwapStatus(index,'Finding another book…'); void processSwapQueue();
      });
      status.append(note,retry);
    }
    feedback.append(status); icons();
  }

  function markAsRead(index,book,rating) {
    if (state.stage !== 'results' || state.books[index] !== book) return;
    const entry = { title: book.title, author: book.author, rating };
    state.feedback.push(entry);
    const job = { index, book, rating, epoch: recommendationEpoch, requestId: sessionId() };
    swapQueue.push(job);
    const phrase = verdicts.find(verdict => verdict.id === rating)?.label || 'Read';
    showSwapStatus(index,`${phrase}. Finding another book…`);
    void processSwapQueue();
  }

  async function requestReplacement(job) {
    const controller = new AbortController();
    activeSwapController = controller;
    const timeout = setTimeout(() => controller.abort(), 135000);
    try {
      const response = await fetch('/api/replace', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          favourites: state.favourites, history: historyWith(), researchNotes: state.researchNotes,
          books: state.books.map(({title,author}) => ({ title, author })),
          feedback: state.feedback.slice(-30),
          replaceIndex: job.index, rating: job.rating, sessionId: job.requestId
        })
      });
      let result = {};
      try { result = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(result.error || 'We couldn’t replace this book just now.');
      if (!result.book?.title || !result.book?.author || !result.book?.reason) throw new Error('The replacement was incomplete.');
      return result.book;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The book search took too long.');
      if (err instanceof TypeError) throw new Error('Connection interrupted.');
      throw err;
    } finally {
      clearTimeout(timeout);
      if (activeSwapController === controller) activeSwapController = null;
    }
  }

  async function processSwapQueue() {
    if (swapWorkerRunning) return;
    swapWorkerRunning = true;
    try {
      while (swapQueue.length) {
        const job = swapQueue.shift();
        if (job.epoch !== recommendationEpoch || state.stage !== 'results' || state.books[job.index] !== job.book) continue;
        try {
          const book = await requestReplacement(job);
          if (job.epoch !== recommendationEpoch || state.stage !== 'results' || state.books[job.index] !== job.book) continue;
          const duplicate = state.books.some((other,i) => i !== job.index &&
            other.title.toLowerCase() === book.title.toLowerCase() && other.author.toLowerCase() === book.author.toLowerCase());
          if (duplicate) throw new Error('That book is already in your five.');
          const oldRow = $('booksList').querySelector(`[data-book-index="${job.index}"]`);
          if (!oldRow) continue;
          state.books[job.index] = book;
          const newRow = createBookRow(book,job.index);
          newRow.classList.add('is-new-pick'); newRow.style.animationDelay = '0ms';
          oldRow.replaceWith(newRow);
          $('coverCredit').hidden = !$('booksList').querySelector('.has-real-cover');
          icons();
          $('swapAnnouncement').textContent = `${job.book.title} replaced with ${book.title} by ${book.author}.`;
          void lookupCovers([book],job.index,coverLookupVersion);
        } catch (err) {
          if (job.epoch !== recommendationEpoch || state.stage !== 'results') continue;
          showSwapStatus(job.index,err.message || 'Couldn’t find a replacement.',job);
        }
      }
    } finally { swapWorkerRunning = false; }
  }

  async function begin() {
    const favourites = trim($('favourites').value);
    if (favourites.length < 3) return;
    state.favourites = favourites; state.sessionId=sessionId(); state.answers = []; state.questions = []; state.researchNotes = ''; state.initialSources = []; state.researchSources = [];
    await run(async () => {
      const result = await callModel(0,[]);
      if (!result.question) throw new Error('The model missed that question. Try again.');
      state.researchNotes = result.researchNotes || '';
      state.initialSources = Array.isArray(result.sources) ? result.sources : [];
      state.questions = [{lead:result.lead || '',question:result.question}]; renderQuestion();
    },'Making a note of that…','Looking for the thread between your favourites.');
  }

  async function answer(skip = false) {
    const pending = skip ? 'I’m not sure. Surprise me.' : trim($('answerInput').value);
    if (pending.length < 2) return;
    const next = state.answers.length + 1;
    const history = historyWith(pending);
    await run(async () => {
      const result = await callModel(next,history);
      if (next < 3) {
        if (!result.question) throw new Error('The model missed that question. Try again.');
        state.answers.push(pending); state.questions.push({lead:result.lead || '',question:result.question}); renderQuestion();
      } else {
        if (!Array.isArray(result.books) || result.books.length !== 5 || !result.readerType || !result.portrait) throw new Error('The recommendations were incomplete. Try again.');
        state.answers.push(pending); state.books = result.books; state.readerType = result.readerType; state.portrait = result.portrait;
        state.favouriteBooks = Array.isArray(result.favouriteBooks) ? result.favouriteBooks.slice(0,6) : [];
        state.researchSources = Array.isArray(result.researchSources) ? result.researchSources : [];
        renderResults();
      }
    },next === 3 ? 'Putting your reading list together…' : 'Another question for you…',next === 3 ? 'Checking for books you might have missed.' : 'A minute with the bookshelves.');
  }

  function reset() {
    if (state.busy) return;
    coverLookupVersion++; favouriteCoverLookupVersion++;
    recommendationEpoch++; activeSwapController?.abort(); swapQueue=[];
    state.favourites = ''; state.questions=[]; state.answers=[]; state.researchNotes=''; state.initialSources=[]; state.researchSources=[]; state.books=[]; state.readerType=''; state.portrait=''; state.favouriteBooks=[]; state.feedback=[]; state.sessionId='';
    $('favourites').value=''; $('characterCount').textContent='0'; $('beginButton').disabled=true;
    stages.results.classList.remove('stamp-revealed');
    stage('intro');
  }

  async function copyList() {
    const content = `READ & FOUND — YOUR READING LIST\n\n${state.readerType}\n${state.portrait}\n\n${state.books.map((book,i)=>`${i+1}. ${book.title} — ${book.author}\n${book.reason}`).join('\n\n')}`;
    try { await navigator.clipboard.writeText(content); toast('Reading list copied.'); }
    catch (_) { toast('Copying is unavailable in this browser.'); }
  }

  // A privacy-preserving, image-first sharing experience. No profile or answers
  // are uploaded to our servers; the graphic is rendered on the reader's device.
  function wrappedLines(ctx,text,maxWidth) {
    const lines = [], words = String(text || '').split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? line+' '+word : word;
      if (ctx.measureText(candidate).width > maxWidth && line) { lines.push(line); line=word; }
      else line=candidate;
    }
    if (line) lines.push(line);
    return lines;
  }

  async function loadShareCover(url) {
    if (!/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(url || '')) return null;
    return Promise.race([
      new Promise(resolve=>{
        const img=new Image(); img.crossOrigin='anonymous';
        img.onload=()=>resolve(img); img.onerror=()=>resolve(null); img.src=url;
      }),
      new Promise(resolve=>setTimeout(()=>resolve(null),4000))
    ]);
  }

  async function portraitCanvas() {
    const canvas=document.createElement('canvas'); canvas.width=1080; canvas.height=1440;
    const ctx=canvas.getContext('2d');
    const draw=(text,x,y,font,color)=>{ctx.font=font;ctx.fillStyle=color;ctx.fillText(text,x,y);};
    ctx.fillStyle='#f3e1a0'; ctx.fillRect(0,0,1080,1440);
    ctx.fillStyle='#1b304e';ctx.fillRect(88,77,8,49);
    draw('read',90,119,'500 44px Georgia','#1b304e');
    const readWidth=ctx.measureText('read').width;
    draw('&',90+readWidth+12,119,'italic 44px Georgia','#da553f');
    const andWidth=ctx.measureText('&').width;
    draw('found',90+readWidth+andWidth+29,119,'500 44px Georgia','#1b304e');
    draw('NOTES ON YOUR READING',90,191,'700 18px Arial','#455775');
    ctx.fillStyle='rgba(27,48,78,.32)';ctx.fillRect(90,221,900,2);
    draw('SOMETHING ABOUT YOUR READING',90,295,'700 17px Arial','#455775');
    ctx.font='400 94px Georgia';
    const headingLines=wrappedLines(ctx,state.readerType,890).slice(0,3);
    let y=397;
    for(const line of headingLines){draw(line,90,y,'400 94px Georgia','#1b304e');y+=97;}
    ctx.fillStyle='#da553f';ctx.fillRect(90,y+1,64,5);
    y+=80;
    ctx.font='36px Georgia';
    const portraitLines=wrappedLines(ctx,state.portrait,888);
    let fontSize=36, lineHeight=51;
    const shelfStart=state.favouriteBooks.length ? 1020 : 1200;
    while(y + portraitLines.length*lineHeight > shelfStart - 65 && fontSize>25){
      fontSize -= 2; lineHeight -= 3;
      ctx.font=`${fontSize}px Georgia`;
      portraitLines.splice(0,portraitLines.length,...wrappedLines(ctx,state.portrait,888));
    }
    for(const line of portraitLines){draw(line,90,y,`${fontSize}px Georgia`,'#1b304e');y+=lineHeight;}
    if(state.favouriteBooks.length){
      const books=state.favouriteBooks.slice(0,5);
      draw('THE BOOKS THAT STARTED IT ALL',90,1012,'700 17px Arial','#455775');
      const images=await Promise.all(books.map(b=>loadShareCover(b.coverUrl)));
      const coverWidth=156,coverHeight=224,gap=22,top=1055;
      books.forEach((book,i)=>{
        const x=90+i*(coverWidth+gap);
        const fills=['#c2a78b','#c7cdab','#d5bf97','#b6c8c0','#dfb7ab'];
        ctx.fillStyle=fills[i];ctx.fillRect(x,top,coverWidth,coverHeight);
        const img=images[i];
        if(img){
          const scale=Math.max(coverWidth/img.width,coverHeight/img.height);
          const w=img.width*scale,h=img.height*scale;
          ctx.save();ctx.beginPath();ctx.rect(x,top,coverWidth,coverHeight);ctx.clip();ctx.drawImage(img,x+(coverWidth-w)/2,top+(coverHeight-h)/2,w,h);ctx.restore();
        } else {
          ctx.fillStyle='rgba(40,68,56,.15)';ctx.fillRect(x,top,9,coverHeight);
          ctx.font='400 24px Georgia'; ctx.fillStyle='#284438';
          let ly=top+35;
          for(const line of wrappedLines(ctx,book.title,coverWidth-28).slice(0,5)) {ctx.fillText(line,x+17,ly);ly+=28;}
          ctx.font='15px Arial';
          for(const line of wrappedLines(ctx,book.author,coverWidth-25).slice(0,3)) {ctx.fillText(line,x+17,top+coverHeight-25);}
        }
        ctx.font='17px Arial';ctx.fillStyle='#1b304e';
        const short=wrappedLines(ctx,book.title,coverWidth-3).slice(0,2);
        short.forEach((line,j)=>ctx.fillText(line,x,top+coverHeight+32+j*23));
      });
    }
    ctx.fillStyle='rgba(27,48,78,.32)';ctx.fillRect(90,1364,900,2);
    draw('DRAWN FROM A CONVERSATION ABOUT BOOKS',90,1400,'700 14px Arial','#455775');
    draw('READ & FOUND',845,1400,'700 15px Arial','#1b304e');
    return canvas;
  }

  async function exportPortrait(preferShare) {
    if(state.stage!=='results') return;
    const button=$(preferShare?'sharePortrait':'downloadPortrait');
    button.disabled=true;
    try {
      const canvas=await portraitCanvas();
      const blob=await new Promise((resolve,reject)=>{
        try {canvas.toBlob(value=>value?resolve(value):reject(new Error('Export unavailable')),'image/png');}
        catch(err){reject(err);}
      });
      const file=new File([blob],'my-reading-portrait.png',{type:'image/png'});
      if(preferShare && navigator.share && navigator.canShare?.({files:[file]})) {
        try {await navigator.share({files:[file],title:'My reading portrait — Read & Found'});return;}
        catch(err){if(err.name==='AbortError') return;}
      }
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='my-reading-portrait.png';document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      toast(preferShare?'Portrait saved — ready to share.':'Your portrait has been saved.');
    } catch(err){
      console.warn('Portrait export unavailable:',err.name||'error');
      try {await navigator.clipboard.writeText(`My Read & Found reading portrait: ${state.readerType}\n\n${state.portrait}`);toast('Image unavailable, but your portrait text was copied.');}
      catch(_){toast('This browser could not export the portrait. Try another browser.');}
    } finally {button.disabled=false;}
  }

  $('favourites').addEventListener('input',e => {
    $('characterCount').textContent = e.target.value.length;
    $('beginButton').disabled = trim(e.target.value).length < 3;
  });
  $('useExample').addEventListener('click',() => {
    $('favourites').value = 'I loved The Hunger Games and Normal People. I always enjoy Agatha Christie, and I like stories with a bit of mystery and complicated characters.';
    $('favourites').dispatchEvent(new Event('input')); $('favourites').focus();
  });
  $('initialForm').addEventListener('submit',e => {e.preventDefault();begin();});
  $('favourites').addEventListener('keydown',e => {if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();$('initialForm').requestSubmit();}});
  $('answerInput').addEventListener('input',e => { $('answerContinue').disabled = trim(e.target.value).length < 2; });
  $('answerForm').addEventListener('submit',e => {e.preventDefault();answer();});
  $('answerInput').addEventListener('keydown',e => {if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();if(!$('answerContinue').disabled)$('answerForm').requestSubmit();}});
  $('skipAnswer').addEventListener('click',() => answer(true));
  $('retryButton').addEventListener('click',() => { const pending = retryAction; hideLoading(); if(pending) pending(); });
  $('backFromError').addEventListener('click',hideLoading);
  $('logoReset').addEventListener('click',reset);
  $('restartFromJourney').addEventListener('click',reset);
  $('startAgain').addEventListener('click',reset);
  $('copyList').addEventListener('click',copyList);
  $('resultsFeedback').querySelectorAll('[data-feedback]').forEach(button=>button.addEventListener('click',()=>{
    const vote=button.dataset.feedback==='yes'?'list_helpful':'list_not_helpful';
    try{navigator.sendBeacon('/api/event',new Blob([JSON.stringify({event:vote})],{type:'text/plain'}));}catch(_){}
    $('resultsFeedback').querySelectorAll('button').forEach(item=>item.disabled=true);
    $('feedbackThanks').hidden=false;
  }));
  $('downloadPortrait').addEventListener('click',()=>exportPortrait(false));
  $('sharePortrait').addEventListener('click',()=>exportPortrait(true));
  for (const id of ['kofiSupport','footerKofi']) $(id)?.addEventListener('click',()=>{
    try { navigator.sendBeacon('/api/event',new Blob([JSON.stringify({event:'donation_click'})],{type:'text/plain'})); } catch (_) {}
  });
  const dialog = $('settingsDialog');
  $('settingsOpen').addEventListener('click',()=>dialog.showModal());
  $('footerSettings').addEventListener('click',()=>dialog.showModal());
  $('settingsClose').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog) dialog.close();});
  icons();
})();
