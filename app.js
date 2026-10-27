/* Read & Found v22: deliberately small and framework-free.
   Every question and recommendation comes from the server-side model.
   No API key, book catalogue or simulated answers are shipped to browsers. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const state = { favourites: '', questions: [], answers: [], researchNotes: '', initialSources: [], researchSources: [], books: [], readerType: '', portrait: '', shareProof: '', sharedListUrl: '', favouriteBooks: [], favouriteAuthors: [], feedback: [], readTrail: [], sessionId: '', stage: 'intro', busy: false };
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
  // Serialise recommendation and portrait cover batches so their Open Library
  // requests do not compete with one another or trip its rate limits.
  let coverRequestQueue = Promise.resolve();

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
    $('loadingIcon').hidden = false;
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
    $('loadingIcon').hidden = true;
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

  function detailsForBook(book) {
    return [book.year ? 'first published ' + book.year : '',
      book.pages ? 'about ' + book.pages + ' pages' : '',
      book.series || ''].filter(Boolean).join(' · ');
  }

  function makeBorrowPanel(book) {
    const panel = document.createElement('details'); panel.className = 'borrow-panel';
    const summary = document.createElement('summary'); summary.textContent = 'borrow or listen';
    const content = document.createElement('div'); content.className = 'borrow-panel-content';
    const text = document.createElement('p');
    text.textContent = 'Search for ' + book.title + ' by ' + book.author + ' with your library card.';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'borrow-copy';
    copy.textContent = 'copy title & author';
    copy.addEventListener('click', () => {
      if (!navigator.clipboard?.writeText) return toast('Copying is unavailable in this browser.');
      navigator.clipboard.writeText(book.title + ' — ' + book.author)
        .then(() => toast('Book details copied.'), () => toast('Copying is unavailable.'));
    });
    const links = document.createElement('div'); links.className = 'borrow-service-links';
    const services = [
      ['find a local library', 'https://www.gov.uk/local-library-services'],
      ['Libby (ebooks and audiobooks)', 'https://libbyapp.com/'],
      ['BorrowBox (ebooks and audiobooks)', 'https://www.borrowbox.com/'],
      ['WorldCat catalogue', 'https://search.worldcat.org/search?' +
        new URLSearchParams({q: book.isbn13 ? 'bn:' + book.isbn13 : book.title + ' ' + book.author})]
    ];
    services.forEach(([label,url],i) => {
      const a = document.createElement('a'); a.href = url; a.textContent = label;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (i === 3) a.dataset.worldcat = 'true';
      links.append(a);
    });
    const caveat = document.createElement('p'); caveat.className = 'borrow-caveat';
    caveat.textContent = 'Availability depends on your library. GOV.UK covers England and Wales.';
    content.append(text,copy,links,caveat); panel.append(summary,content);
    return panel;
  }

  function createBookRow(book,index) {
    const row = document.createElement('article');
    row.className = 'book-row';
    row.dataset.bookIndex = String(index);
    row.style.animationDelay = `0ms`;
    const number = document.createElement('div'); number.className = 'book-number'; number.textContent = String(index+1).padStart(2,'0');
    const info = document.createElement('div'); info.className = 'book-info';
    const kicker = document.createElement('div'); kicker.className = 'book-kicker'; kicker.textContent = book.thread || (index===0 ? 'Start here' : 'The connection');
    const roleLabels = {
      closest_match:{label:'made for you',icon:'heart'},
      tone_match:{label:'right mood',icon:'cloud-sun'},
      wildcard:{label:'wild card',icon:'dice-5'},
      fresh_pick:{label:'fresh find',icon:'sparkles'}
    };
    const role = roleLabels[book.role];
    const roleBadge = role ? document.createElement('span') : null;
    if (roleBadge) {
      roleBadge.className = 'book-match-badge sticker-' + book.role;
      const badgeIcon = document.createElement('i'); badgeIcon.dataset.lucide = role.icon; badgeIcon.setAttribute('aria-hidden','true');
      roleBadge.append(badgeIcon,document.createTextNode(role.label));
    }
    const title = document.createElement('h3'); title.className = 'book-title'; title.textContent = book.title;
    const author = document.createElement('p'); author.className = 'book-author'; author.textContent = `by ${book.author}`;
    const detail = document.createElement('p'); detail.className = 'book-detail';
    detail.textContent = detailsForBook(book); detail.hidden = !detail.textContent;
    const media = document.createElement('div'); media.className = 'book-media';
    media.append(coverFor(book,index),detail);
    const reason = document.createElement('p'); reason.className = 'book-reason'; reason.textContent = book.reason;
    const note = document.createElement('details'); note.className = 'book-content-note'; note.hidden = !book.contentNote;
    const noteTitle = document.createElement('summary'); noteTitle.textContent = 'content note';
    const noteBody = document.createElement('p'); noteBody.textContent = book.contentNote || '';
    note.append(noteTitle,noteBody);
    const source = book.source?.url ? sourceLink(book.source) : sourceLink({title:'Open Library',url:'https://openlibrary.org/search?q='+encodeURIComponent(book.title+' '+book.author)});
    if (source) {
      source.className = 'book-meta-source';
      source.replaceChildren(document.createTextNode('about this book'));
      media.append(source);
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
      document.querySelectorAll('.book-feedback').forEach(item => item.classList.remove('is-open'));
      choices.hidden = !opening;
      feedback.classList.toggle('is-open',opening);
      readButton.setAttribute('aria-expanded',String(opening));
    });
    feedback.append(readButton,choices);
    info.append(kicker);
    if (roleBadge) info.append(roleBadge);
    info.append(title,author,reason);
    const actions = document.createElement('div'); actions.className = 'book-actions';
    const buy = document.createElement('a'); buy.className = 'book-buy'; buy.target = '_blank';
    buy.rel = 'noopener noreferrer sponsored'; buy.dataset.buyIndex = String(index);
    buy.href = bookshopUrl(book);
    const shopIcon = document.createElement('i'); shopIcon.dataset.lucide = 'shopping-bag'; shopIcon.setAttribute('aria-hidden','true');
    buy.append(shopIcon,document.createTextNode(' Bookshop.org'));
    actions.append(buy,makeBorrowPanel(book),feedback);
    if (book.contentNote) actions.append(note);
    info.append(actions);
    row.append(number,media,info);
    return row;
  }

  function renderReadTrail() {
    const section = $('alreadyReadTrail'), list = $('alreadyReadList');
    list.replaceChildren();
    state.readTrail.forEach(({ title, author, rating }) => {
      const item = document.createElement('li');
      const name = document.createElement('span'); name.className = 'read-trail-title'; name.textContent = title;
      const by = document.createElement('span'); by.className = 'read-trail-author'; by.textContent = ' — ' + author;
      const verdict = document.createElement('span'); verdict.className = 'read-trail-rating rating-' + rating;
      verdict.textContent = verdicts.find(v => v.id === rating)?.label.toLowerCase() || 'read';
      item.append(name,by,verdict);
      list.append(item);
    });
    section.hidden = !state.readTrail.length;
  }

  function renderResults() {
    $('readerType').textContent = state.readerType;
    $('portraitText').textContent = state.portrait;
    const list = $('booksList'); list.replaceChildren();
    renderReadTrail();
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
    $('savedListStatus').hidden = true;
    $('saveShareText').textContent = 'save & share this list';
    $('resultsFeedback').querySelectorAll('button').forEach(button=>button.disabled=false);
    stage('results'); icons(); hydrateCovers(); hydrateFavouriteCovers();
  }

  function attachCover(item,index,book,version) {
    if (!item) return;
    if (version !== coverLookupVersion || state.stage !== 'results' ||
        state.books[index]?.title !== book.title || state.books[index]?.author !== book.author) return;
    if (item.year) state.books[index].year = item.year;
    if (item.pages) state.books[index].pages = item.pages;
    if (item.series) state.books[index].series = item.series;
    if (item.isbn13) state.books[index].isbn13 = item.isbn13;
    const row = $('booksList').querySelector('[data-book-index="' + index + '"]');
    const bookDetail = row?.querySelector('.book-detail');
    if (bookDetail) { bookDetail.textContent = detailsForBook(state.books[index]); bookDetail.hidden = !bookDetail.textContent; }
    const worldcat = row?.querySelector('[data-worldcat]');
    if (worldcat && state.books[index].isbn13)
      worldcat.href = 'https://search.worldcat.org/search?' + new URLSearchParams({q:'bn:' + state.books[index].isbn13});
    if (!/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/.test(item.coverUrl || '')) return;
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
      state.books[index].coverUrl = item.coverUrl;
      $('coverCredit').hidden = false;
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    cover.appendChild(image); image.src = item.coverUrl;
  }

  function requestCoverData(books) {
    if (!books.length) return Promise.resolve([]);
    const lookup = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch('/api/covers', {
          method:'POST', signal:controller.signal,
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({books:books.map(({title,author})=>({title,author}))})
        });
        if (!response.ok) return books.map(() => null);
        const data = await response.json();
        return Array.isArray(data.covers) ? data.covers : books.map(() => null);
      } catch (_) {
        return books.map(() => null);
      } finally {
        clearTimeout(timeout);
      }
    };
    // Keep the queue alive even if a prior cover lookup fails.
    const result = coverRequestQueue.then(lookup,lookup);
    coverRequestQueue = result.then(() => undefined,() => undefined);
    return result;
  }

  async function lookupCovers(books,indexOffset,version) {
    const covers = await requestCoverData(books);
    if (version !== coverLookupVersion || state.stage !== 'results') return;
    covers.forEach((item,i) => attachCover(item,indexOffset+i,books[i],version));
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
    const authors = (state.favouriteAuthors || []).filter(author =>
      !books.some(book => book.author.toLowerCase() === author.toLowerCase()));
    const authorsBlock = $('portraitAuthors');
    authorsBlock.replaceChildren();
    if (authors.length) {
      const label = document.createElement('span');
      label.className = 'portrait-authors-heading';
      label.textContent = 'Authors you mentioned';
      authorsBlock.append(label);
      for (const author of authors) {
        const name = document.createElement('span');
        name.className = 'portrait-author-name';
        name.textContent = author;
        authorsBlock.append(name);
      }
    }
    authorsBlock.hidden = !authors.length;
    section.hidden = !books.length && !authors.length;
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
      // Same endpoint, request format and timeout as recommendation covers.
      const covers = await requestCoverData(books);
      if (version !== favouriteCoverLookupVersion || state.stage !== 'results') return;
      covers.forEach((cover,index) => {
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
      const icon = document.createElement('span'); icon.className = 'swap-page-icon'; icon.setAttribute('aria-hidden','true');
      icon.innerHTML = `<svg class="swap-page-turn" viewBox="0 0 120 64" aria-hidden="true">
      <g class="lines">
        <path d="M8 50 H52 Q60 57 68 50 H112" />
        <path d="M58 46 Q37 43 16 42" />
        <path d="M62 46 Q83 43 104 42" />
        <line class="page p1" x1="60" y1="46" x2="102" y2="46" />
        <line class="page p2" x1="60" y1="46" x2="102" y2="46" />
        <line class="page p3" x1="60" y1="46" x2="102" y2="46" />
      </g>
      <path class="ribbon" d="M60 54 Q62 59 59 63" />
    </svg>`;
      const label = document.createElement('span'); label.className = 'swap-status-copy';
      const separator = message.indexOf('. ');
      if (separator > 0) {
        const verdict = document.createElement('strong'); verdict.textContent = message.slice(0,separator+1).toLowerCase();
        const detail = document.createElement('em'); detail.textContent = message.slice(separator+2).toLowerCase();
        label.append(verdict,document.createTextNode(' '),detail);
      } else label.textContent = message;
      status.append(icon,label);
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
          book.role = 'fresh_pick';
          state.books[job.index] = book;
          state.readTrail.push({title:job.book.title,author:job.book.author,rating:job.rating});
          renderReadTrail();
          // A saved link describes the old list. After a swap, let the reader
          // deliberately save a new immutable link for the updated choices.
          state.sharedListUrl = '';
          $('savedListStatus').hidden = true;
          $('saveShareText').textContent = 'save & share this list';
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
    const pending = skip ? '(skipped)' : trim($('answerInput').value);
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
        state.answers.push(pending); state.books = result.books; state.readTrail=[]; state.feedback=[]; state.readerType = result.readerType; state.portrait = result.portrait;
        state.shareProof = result.shareProof || ''; state.sharedListUrl = '';
        state.favouriteBooks = Array.isArray(result.favouriteBooks) ? result.favouriteBooks.slice(0,6) : [];
        state.favouriteAuthors = Array.isArray(result.favouriteAuthors) ? result.favouriteAuthors.slice(0,8) : [];
        state.researchSources = Array.isArray(result.researchSources) ? result.researchSources : [];
        renderResults();
      }
    },next === 3 ? 'Putting your reading list together…' : 'Another question for you…',next === 3 ? 'Checking for books you might have missed.' : 'A minute with the bookshelves.');
  }

  function reset() {
    if (state.busy) return;
    coverLookupVersion++; favouriteCoverLookupVersion++;
    recommendationEpoch++; activeSwapController?.abort(); swapQueue=[];
    state.favourites = ''; state.questions=[]; state.answers=[]; state.researchNotes=''; state.initialSources=[]; state.researchSources=[]; state.books=[]; state.readerType=''; state.portrait=''; state.favouriteBooks=[]; state.favouriteAuthors=[]; state.shareProof=''; state.sharedListUrl=''; state.feedback=[]; state.readTrail=[]; state.sessionId='';
    $('favourites').value=''; $('characterCount').textContent='0'; $('beginButton').disabled=true;
    stages.results.classList.remove('stamp-revealed');
    stage('intro');
  }

  async function saveOrCopyList() {
    const button = $('saveShareList');
    if (state.sharedListUrl) {
      try { await navigator.clipboard.writeText(state.sharedListUrl); toast('Share link copied.'); }
      catch (_) { toast('Your share link is shown below.'); }
      return;
    }
    if (!state.shareProof) return toast('Finish a new reading list before saving it.');
    button.disabled = true; $('saveShareText').textContent = 'saving your list…';
    try {
      // Opt-in storage: the questions and raw reader answers are NOT saved.
      const payload = {
        sessionId:state.sessionId, proof:state.shareProof,
        readerType:state.readerType, portrait:state.portrait,
        favouriteBooks:state.favouriteBooks.map(({title,author,coverUrl})=>({title,author,coverUrl})),
        favouriteAuthors:state.favouriteAuthors,
        books:state.books.map(({title,author,reason,thread,role,contentNote,year,pages,series,isbn13,coverUrl})=>
          ({title,author,reason,thread,role,contentNote,year,pages,series,isbn13,coverUrl}))
      };
      const response = await fetch('/api/list',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.url) throw Error(data.error || 'Unable to save this list.');
      state.sharedListUrl = data.url;
      $('savedListLink').href = data.url;
      $('savedListLink').textContent = data.url;
      $('savedListStatus').hidden = false;
      $('saveShareText').textContent = 'copy share link';
      try { await navigator.clipboard.writeText(data.url); toast('List saved and share link copied.'); }
      catch (_) { toast('List saved. Your link is shown below.'); }
    } catch (error) {
      $('saveShareText').textContent = 'save & share this list';
      toast(error.message || 'Unable to save this list.');
    } finally { button.disabled = false; }
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
    // The screen portrait already has both sets of reader mentions. Include
    // them in the downloadable image even when no individual books were named.
    const books=(state.favouriteBooks||[]).filter(book=>book?.title);
    const authors=(state.favouriteAuthors||[]).filter(Boolean);
    // Canvas uses the same editorial typefaces as the site. Font-loading can
    // be delayed on mobile; waiting prevents a first-share fallback typeface.
    if(document.fonts?.load){
      await Promise.race([
        Promise.allSettled([
          document.fonts.load('700 92px Fraunces'),
          document.fonts.load('400 36px Fraunces'),
          document.fonts.load('600 22px "IBM Plex Sans"')
        ]),
        new Promise(resolve=>setTimeout(resolve,2200))
      ]);
    }
    const canvas=document.createElement('canvas'); canvas.width=1080; canvas.height=1440;
    const ctx=canvas.getContext('2d');
    const navy='#1c304c', coral='#c34b36', muted='#52617a', paper='#f6f4ec';
    const serif=(size,weight=400)=>`${weight} ${size}px Fraunces, Georgia, serif`;
    const sans=(size,weight=500)=>`${weight} ${size}px "IBM Plex Sans", Arial, sans-serif`;
    const draw=(text,x,y,font,color=navy)=>{
      ctx.font=font; ctx.fillStyle=color; ctx.fillText(String(text||''),x,y);
    };
    const rule=(x,y,width,color=navy,height=2)=>{
      ctx.fillStyle=color; ctx.fillRect(x,y,width,height);
    };
    const shortText=(value,width,font)=>{
      const str=String(value||'').trim(); ctx.font=font;
      if(ctx.measureText(str).width<=width)return str;
      let cut=str;
      while(cut.length && ctx.measureText(cut+'…').width>width)cut=cut.slice(0,-1);
      return cut.trimEnd()+'…';
    };
    const limitedLines=(value,width,font,maxLines)=>{
      ctx.font=font;
      const lines=wrappedLines(ctx,value,width);
      if(lines.length>maxLines){
        lines.length=maxLines;
        lines[maxLines-1]=shortText(lines[maxLines-1]+'…',width,font);
      }
      return lines;
    };
    ctx.fillStyle=paper; ctx.fillRect(0,0,1080,1440);
    rule(0,0,1080,navy,12);
    // Masthead mirrors the real site's cream header and serif wordmark.
    draw('read',80,111,serif(53,700));
    ctx.font=serif(53,700); const wordWidth=ctx.measureText('read').width;
    draw('&',80+wordWidth+3,111,serif(53,700),coral);
    ctx.font=serif(53,700); const ampWidth=ctx.measureText('&').width;
    draw('found',83+wordWidth+ampWidth,111,serif(53,700));
    draw('a little book-finding project',704,101,serif(22,400),muted);
    rule(80,148,920,'#9aa9ba',2);

    draw('A NOTE ON YOUR TASTE',82,213,sans(21,700),muted);
    let titleSize=92, titleLines=[];
    do {
      ctx.font=serif(titleSize,700);
      titleLines=wrappedLines(ctx,state.readerType||'Your reading portrait',915);
      if(titleLines.length<=2)break;
      titleSize-=4;
    } while(titleSize>60);
    titleLines=limitedLines(state.readerType||'Your reading portrait',915,serif(titleSize,700),2);
    let titleY=309;
    titleLines.forEach(line=>{draw(line,80,titleY,serif(titleSize,700)); titleY+=titleSize*1.04;});
    rule(82,titleY-28,78,coral,6);

    const paragraphY=Math.max(469,titleY+33);
    const paragraphBottom=965;
    let bodySize=35, bodyLines=[];
    while(bodySize>=24){
      bodyLines=limitedLines(state.portrait,913,serif(bodySize),100);
      if(bodyLines.length*(bodySize*1.39)<=paragraphBottom-paragraphY)break;
      bodySize-=2;
    }
    const bodyLineHeight=bodySize*1.39;
    bodyLines=limitedLines(state.portrait,913,serif(bodySize),Math.max(1,Math.floor((paragraphBottom-paragraphY)/bodyLineHeight)));
    bodyLines.forEach((line,i)=>draw(line,82,paragraphY+i*bodyLineHeight,serif(bodySize)));

    // The lower shelf always has something personal to share. Both author-only
    // and book-only answers get dedicated layouts instead of a blank area.
    const shelfY=1000, shelfBottom=1353;
    ctx.fillStyle='#e8eef3';ctx.fillRect(80,shelfY,920,shelfBottom-shelfY);
    rule(80,shelfY,920,navy,3);
    draw('WHERE OUR CONVERSATION STARTED',108,1043,sans(19,700),muted);
    const fills=['#d9b77e','#c2d1bb','#d1b1a7','#b9c9d5','#d9c79c','#b3cbbf'];
    const coverImages=await Promise.all(books.slice(0,6).map(book=>loadShareCover(book.coverUrl)));
    const bookEntry=(book,img,x,y,width,index)=>{
      const coverW=41,coverH=56;
      ctx.fillStyle=fills[index%fills.length];ctx.fillRect(x,y-38,coverW,coverH);
      rule(x+6,y-38,3,'rgba(28,48,76,.20)',coverH);
      if(img){
        const scale=Math.max(coverW/img.width,coverH/img.height),w=img.width*scale,h=img.height*scale;
        ctx.save();ctx.beginPath();ctx.rect(x,y-38,coverW,coverH);ctx.clip();
        ctx.drawImage(img,x+(coverW-w)/2,y-38+(coverH-h)/2,w,h);ctx.restore();
      }
      draw(shortText(book.title,width-coverW-19,serif(23,700)),x+coverW+15,y-9,serif(23,700));
      if(book.author)draw(shortText(book.author,width-coverW-19,sans(16)),x+coverW+15,y+15,sans(16),muted);
    };
    if(books.length&&authors.length){
      draw('BOOKS YOU MENTIONED',110,1092,sans(17,700),muted);
      draw('AUTHORS YOU MENTIONED',600,1092,sans(17,700),muted);
      rule(566,1070,2,'#c4d0db',257);
      books.slice(0,4).forEach((book,i)=>bookEntry(book,coverImages[i],110,1142+i*57,425,i));
      authors.slice(0,6).forEach((author,i)=>{
        rule(599,1124+i*36,8,coral,8);
        draw(shortText(author,353,serif(25)),624,1135+i*36,serif(25));
      });
      if(books.length>4)draw(`+ ${books.length-4} more book${books.length>5?'s':''}`,110,1340,sans(16,600),muted);
      if(authors.length>6)draw(`+ ${authors.length-6} more`,600,1340,sans(16,600),muted);
    } else if(books.length){
      draw('BOOKS YOU MENTIONED',110,1092,sans(17,700),muted);
      books.slice(0,6).forEach((book,i)=>{
        const col=i%2,row=Math.floor(i/2);
        bookEntry(book,coverImages[i],110+col*451,1145+row*75,415,i);
      });
      if(books.length>6)draw(`+ ${books.length-6} more books`,110,1339,sans(16,600),muted);
    } else if(authors.length){
      draw('AUTHORS YOU MENTIONED',110,1092,sans(17,700),muted);
      if(authors.length<=4){
        // A couple of favourite writers deserve the space of little bookplates,
        // rather than two tiny names above an otherwise empty rectangle.
        const rows=Math.ceil(authors.length/2),cardH=rows===1?112:83,gap=14;
        const top=1140+(207-(rows*cardH+(rows-1)*gap))/2;
        authors.forEach((author,i)=>{
          const col=i%2,row=Math.floor(i/2),x=110+col*446,y=top+row*(cardH+gap);
          ctx.fillStyle='#faf8f1';ctx.fillRect(x,y,423,cardH);
          rule(x,y,6,coral,cardH);
          draw(String(i+1).padStart(2,'0'),x+24,y+29,sans(17,700),muted);
          draw(shortText(author,368,serif(32,600)),x+24,y+cardH-27,serif(32,600));
        });
      } else {
        authors.slice(0,8).forEach((author,i)=>{
          const col=Math.floor(i/4),row=i%4,x=110+col*444,y=1140+row*49;
          rule(x,y-20,7,coral,25);
          draw(shortText(author,405,serif(30,600)),x+24,y,serif(30,600));
        });
      }
    } else {
      draw('YOU STARTED WITH',110,1095,sans(17,700),muted);
      const quote=state.favourites||'Some books, some questions, and a conversation.';
      limitedLines(quote,847,serif(30),5).forEach((line,i)=>draw(line,110,1155+i*41,serif(30)));
    }
    rule(80,1380,920,'#9aa9ba',2);
    draw('THREE QUESTIONS. FIVE BOOKS, PICKED FOR YOU.',80,1415,sans(17,600),muted);
    draw('readandfound.com',807,1415,serif(22,700),navy);
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
  $('saveShareList').addEventListener('click',saveOrCopyList);
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
