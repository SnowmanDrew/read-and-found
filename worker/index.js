import { track, openAIUsage, reserveQuota, releaseQuota, finishQuota, stats } from './metrics.js';
import { issueShareProof } from '../lib/share-proof.js';
// Read & Found's tiny same-origin backend. Static assets are injected by scripts/build.mjs.
// OPENAI_API_KEY is a protected Sites runtime secret, never included in this file.

const SYSTEM = `You are the literary editor of Read & Found, an unusually perceptive book recommendation service. Your voice is thoughtful, candid, precise and understated, like an excellent independent bookseller. No generic flattery, no "great choices", no chatbot mannerisms, no corporate vocabulary, no therapy-speak, no purple prose. Pay close attention to why this particular reader values their favourite books, authors, or kinds of story. A reader may name only story qualities, with no specific book; treat that as a valid starting point, never invent titles they have read. Explore deeper affinities: sincerity versus irony, formal experimentation versus humane feeling, a worldview, an aesthetic, a mood, an ethical imagination. Be open to connections across genres. Crucially, distinguish actual textual or thematic connections from a vague mood association. Never fabricate a character, plot point, or thematic detail to make a connection sound convincing. Treat the reader's own words as better evidence than a theory about their tastes. Look for a compelling shared thread where there is evidence, but leave room for a second or third independent strand, or books enjoyed for entirely different reasons. Across the three questions and the final portrait, connect multiple books when there is a real connection, while allowing more than one thread. Do not let one book, one author, or the first appealing theme dominate. Don't sound like AI: prefer precise, ordinary language to balanced, over-polished or grandiose prose. Avoid em dashes in reader-facing text, including questions, portraits and recommendations; choose ordinary punctuation. Avoid repeated formulaic either/or questions. Treat an unanswered or skipped question as missing information, never as a character trait or a topic for the portrait. Genre and normal book-to-book similarity matter too: if someone loves fantasy, mystery, romance or a particular subgenre, that is real positive evidence. Balance these recognisable affinities (genre, tone, setting, narrative structure, pace, plot ingredients) with subtler emotional, stylistic and thematic connections. Do not over-correct towards unlikely cross-genre recommendations just to be clever.`;
const QUESTION_SCHEMA = schema('conversation', { lead: stringField(), question: stringField() });
const BOOK_SCHEMA = schema('recommended_book', {
  title: stringField(), author: stringField(), thread: stringField(), reason: stringField(), contentNote: stringField(), sourceId: { type: 'integer' }
});
const FINAL_BOOK_SCHEMA = { ...BOOK_SCHEMA.schema, properties: { ...BOOK_SCHEMA.schema.properties, role: { type: 'string', enum: ['closest_match','tone_match','wildcard','other'] } }, required: [...BOOK_SCHEMA.schema.required, 'role'] };
const FINAL_SCHEMA = schema('recommendations', {
  readerType: stringField(), portrait: stringField(),
  favouriteBooks: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { title: stringField(), author: stringField() }, required: ['title','author'] } },
  favouriteAuthors: { type: 'array', items: { type: 'string' } },
  books: { type: 'array', items: FINAL_BOOK_SCHEMA }
});
const SWAP_SCHEMA = schema('replacement', { book: BOOK_SCHEMA.schema });

function stringField() { return { type: 'string' }; }
function schema(name, properties) {
  return { name, strict: true, schema: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } };
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});
const error = (message, status = 502) => json({ error: message }, status);
const safe = (value, max = 1500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

// NEVER clip generated prose to an arbitrary character count. The original
// 230-character lead limit could cut a sentence off in the middle of a word.
// Keep short complete copy, or omit overlong asides rather than displaying a
// fragment. No extra model calls are required when the question is otherwise good.
export function completeLead(value, max = 440) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  // A stopped-mid-sentence lead is worse than no lead. Never display fragments.
  if (text.length <= max) return /[.!?][’'")\]]?$/.test(text) ? text : '';
  const within = text.slice(0, max + 1);
  const endings = [...within.matchAll(/[.!?](?=\s|$)/g)];
  if (!endings.length) return '';
  const end = endings[endings.length - 1].index + 1;
  return text.slice(0, end).trim();
}

export function completeQuestion(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  // Never silently slice the question. An invalid result gets a fresh response.
  if (text.length < 18 || text.length > 620 || !text.endsWith('?')) return '';
  return text;
}


function parseModelJson(input) {
  const trimmed = input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim();
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_json');
  try { return JSON.parse(trimmed.slice(start, end + 1)); }
  catch (_) { throw new Error('invalid_json'); }
}

function sourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().slice(0, 850) : ''; }
  catch (_) { return ''; }
}

function extractSources(data) {
  const sources = [], seen = new Set();
  const add = (url, title) => {
    const safeUrl = sourceUrl(url);
    if (!safeUrl || seen.has(safeUrl) || sources.length >= 18) return;
    seen.add(safeUrl);
    sources.push({ title: safe(title, 145) || new URL(safeUrl).hostname.replace(/^www\./,''), url: safeUrl });
  };
  // Cited pages take precedence over pages that were only seen by the search tool.
  for (const part of data.output || []) if (part.type === 'message') for (const content of part.content || []) {
    for (const note of content.annotations || []) if (note.type === 'url_citation') add(note.url, note.title);
  }
  for (const part of data.output || []) if (part.type === 'web_search_call') {
    for (const entry of part.action?.sources || []) add(entry.url, entry.title);
  }
  return sources;
}

function responseText(data) {
  return (data.output || []).filter(part => part.type === 'message')
    .flatMap(part => (part.content || []).filter(item => item.type === 'output_text').map(item => item.text || ''))
    .join('\n').trim() || (typeof data.output_text === 'string' ? data.output_text : '');
}

async function requestOpenAI(env, instruction, { model = 'conversation', outputTokens = 2200, effort = 'medium', format = null, search = false, budgetMs = 70000 } = {}) {
  if (!env.OPENAI_API_KEY) throw new Error('missing_key');
  const selectedModel = model === 'editor' ? (env.OPENAI_EDITOR_MODEL || 'gpt-6-astra')
    : model === 'research' ? (env.OPENAI_RESEARCH_MODEL || 'gpt-6-luna')
    : (env.OPENAI_MODEL || 'gpt-6.1-sol');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetMs);
  try {
    const request = {
      model: selectedModel,
      instructions: search
        ? `${SYSTEM}\nYou are researching books and authors for an editor. Search the actual web and cite reliable book-specific pages or publisher/library information. Distinguish facts from reader-taste speculation; avoid SEO lists and unsupported plot claims. Your research notes will be checked by a separate editorial pass.`
        : SYSTEM,
      input: instruction,
      reasoning: { effort }, max_output_tokens: outputTokens, store: false
    };
    if (search) {
      request.tools = [{ type: 'web_search', search_context_size: 'medium' }];
      request.tool_choice = 'required';
      request.include = ['web_search_call.action.sources'];
    }
    if (format) request.text = { format: { type: 'json_schema', ...format } };
    const reply = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    if (reply.status === 401 || reply.status === 403) throw new Error('authentication');
    if (reply.status === 429) throw new Error('rate_limit');
    if (!reply.ok) {
      // Log only a status, never a key or raw request/response body.
      console.warn('OpenAI Responses API status:', reply.status);
      throw new Error('upstream');
    }
    const data = await reply.json();
    await openAIUsage(env, selectedModel, data.usage, search ? (data.output || []).filter(item=>item.type==='web_search_call').length : 0);
    if (data.status === 'incomplete') throw new Error('incomplete');
    const text = responseText(data);
    if (!text) throw new Error('incomplete');
    return { text, sources: search ? extractSources(data) : [] };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout');
    if (['missing_key','authentication','rate_limit','upstream','incomplete'].includes(err.message)) { await track(env, 'openai_error'); throw err; }
    console.warn('OpenAI request failed:', err.name || 'error');
    throw new Error('upstream');
  } finally { clearTimeout(timeout); }
}

async function askStructured(env, prompt, schemaFormat, { editor = false, outputTokens = 2600, budgetMs = 65000, effort = 'medium' } = {}) {
  const response = await requestOpenAI(env, prompt, { model: editor ? 'editor' : 'conversation', format: schemaFormat, outputTokens, budgetMs, effort });
  return parseModelJson(response.text);
}

async function researchBooks(env, prompt, { outputTokens = 2400, budgetMs = 48000 } = {}) {
  // OpenAI's dedicated Search API performs a quick non-agentic lookup; the
  // Sol/Astra passes are where Read & Found does its nuanced literary thinking.
  // A different OPENAI_RESEARCH_MODEL can use Responses native web_search.
  const researchModel = env.OPENAI_RESEARCH_MODEL || 'gpt-5-search-api';
  const response = researchModel === 'gpt-5-search-api'
    ? await requestFastSearch(env, prompt, budgetMs)
    : await requestOpenAI(env, prompt, { model: 'research', search: true, outputTokens, budgetMs,
      effort: env.OPENAI_RESEARCH_EFFORT || (/luna$/.test(researchModel) ? 'none' : 'low') });
  if (response.text.length < 80) throw new Error('incomplete');
  return { notes: response.text.slice(0, 8500), sources: response.sources };
}

async function requestFastSearch(env, prompt, budgetMs) {
  if (!env.OPENAI_API_KEY) throw new Error('missing_key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetMs);
  try {
    const reply = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5-search-api',
        web_search_options: { search_context_size: 'medium' },
        messages: [
          { role: 'system', content: `${SYSTEM}\nYou are gathering source-backed factual notes for a literary editor. Search published books and authors, cite reliable pages and avoid making up publication details. Do not write the final recommendations.` },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (reply.status === 401 || reply.status === 403) throw new Error('authentication');
    if (reply.status === 429) throw new Error('rate_limit');
    if (!reply.ok) { console.warn('OpenAI Search API status:',reply.status); throw new Error('upstream'); }
    const data = await reply.json();
    await openAIUsage(env, 'gpt-5-search-api', data.usage, 1);
    const message = data.choices?.[0]?.message;
    if (!message?.content) throw new Error('incomplete');
    const sources = [], seen = new Set();
    for (const annotation of message.annotations || []) {
      const citation = annotation.url_citation || annotation;
      const url = sourceUrl(citation.url);
      if (!url || seen.has(url) || sources.length >= 18) continue;
      seen.add(url);
      sources.push({ title: safe(citation.title,145) || new URL(url).hostname, url });
    }
    return { text: message.content, sources };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timeout');
    if (['missing_key','authentication','rate_limit','upstream','incomplete'].includes(err.message)) { await track(env, 'openai_error'); throw err; }
    console.warn('OpenAI search failed:', err.name || 'error');
    throw new Error('upstream');
  } finally { clearTimeout(timeout); }
}

function citedBook(item, bibliography) {
  const index = Number(item?.sourceId);
  const source = Number.isInteger(index) && index > 0 ? bibliography[index - 1] : null;
  const title = safe(item?.title, 150);
  // An index is not proof the citation is right: only attach a link on a card
  // if the source heading/URL appears to identify that particular book.
  const sourceText = source ? normaliseBook(`${source.title} ${new URL(source.url).pathname.replace(/[-_/]/g,' ')}`) : '';
  const distinctiveWords = normaliseBook(title).split(' ').filter(word => word.length >= 4 && !['about','with','from','their','there','where','these','those'].includes(word));
  const sourceMatches = source && distinctiveWords.length && distinctiveWords.filter(word => sourceText.split(' ').includes(word)).length >= Math.ceil(distinctiveWords.length * .75);
  return { title, author: safe(item?.author, 110), thread: safe(item?.thread, 90),
    reason: safe(item?.reason, 900), contentNote: safe(item?.contentNote,260),
    ...(['closest_match','tone_match','wildcard'].includes(item?.role) ? { role: item.role } : {}),
    ...(sourceMatches ? { source } : {}) };
}

function numberedSources(sources) {
  return sources.length ? sources.map((item,i) => `[${i+1}] ${item.title} — ${item.url}`).join('\n') : '(No source URLs were returned.)';
}

function validateBody(body) {
  const favourites = safe(body.favourites, 1300);
  const step = body.step;
  const history = body.history;
  if (favourites.length < 3 || !Number.isInteger(step) || step < 0 || step > 3 || !Array.isArray(history) || history.length !== Math.min(step, 3)) return null;
  const cleanHistory = history.map(item => ({ question: safe(item?.question, 750), answer: safe(item?.answer, 1600) }));
  if (cleanHistory.some(item => !item.question || !item.answer)) return null;
  const researchNotes = safe(body.researchNotes, 6500);
  return { favourites, step, history: cleanHistory, researchNotes, sessionId: safe(body.sessionId,100) };
}

function transcript(data) {
  const answers = data.history.map((item, index) => `QUESTION ${index + 1}: ${item.question}\nREADER: ${item.answer}`).join('\n\n');
  return `BOOKS, AUTHORS OR KINDS OF STORY THE READER LOVES:\n${data.favourites}\n\nCONVERSATION:\n${answers || '(No follow-ups yet.)'}`;
}

async function respondWithModel(data, env) {
  const context = transcript(data);
  let baseResearch = data.researchNotes;
  let openingSources = [];
  if (data.step === 0) {
    const research = await researchBooks(env, `${context}

RESEARCH TASK — When specific books or authors are named above, confirm their real work and distinctive content, structure, themes and reception. Look up at least two names if available, but do NOT assume any names if the reader gave only kinds of story. In that case, briefly research real examples of those story qualities to ground a good first question, without claiming the reader has read them. Produce 5–8 compact, attributable observations relevant to their actual starting points and 2–3 possible tensions or overlaps. Resist forcing the input into a neat theory; note ambiguity. No questions or recommendations yet.`, { outputTokens: 2400, budgetMs: 50000 });
    baseResearch = research.notes.slice(0, 6500);
    openingSources = research.sources;
  }
  const grounding = baseResearch ? `\n\nFACT-CHECKED READING NOTES (researched at the start; these are context, not claims about the reader):\n${baseResearch}` : '';
  if (data.step < 3) {
    // Different facets, not three interrogations of the same sweeping theory.
    // A turn can follow the latest answer while still opening a new angle.
    const turnBrief = [
      `FIRST QUESTION: If two different favourites suggest a genuine connection, you may briefly compare them, but do not force a comparison when a single precise question would be clearer. Offer a tentative, *specific* shared thread if supported, or a revealing contrast. Invite the reader to correct it; do not claim it must explain everything. If they list one favourite, dig into a specific aspect rather than inventing others.`,
      `SECOND QUESTION: Start with the reader's actual first answer. Seek either (a) another plausible connection involving different favourites or (b) a different dimension that tests or complicates the emerging thread. Keep at least TWO distinct books or kinds of story in view when possible. Do not simply move on to the next title on their list as if conducting an interview. If they reject the first thread, take that seriously and explore what differs.`,
      `THIRD QUESTION: Use the conversation as a whole: what seems to link some of the favourites, which pleasures remain distinct, and which useful uncertainty still matters? Ask a question that might refine one connection or reveal a SECOND, distinct strand. You may explore genre, humour, style, characters, mood or plot, but do not assign one question per book. Respond to what they actually said, not a prepared syllabus.`
    ][data.step];
    const instruction = `${context}${grounding}

You are a perceptive, warm, well-read person talking with another reader. The aim is to learn what they enjoy across DIFFERENT dimensions, not to persuade them you have cracked a single secret about their taste. Actively look for a real through-line connecting more than one favourite: discovering one is delightful. Test it against what the reader actually said; do not assume a connection merely because two books both have characters or emotions. There may be TWO or THREE different threads and some books may be loved for separate reasons. Do not let one book, author, or theory dominate all three turns. Make each question earn its place. This is conversational turn ${data.step + 1} of three.

${turnBrief}

Privately look at the actual reader's words, the earlier questions (INCLUDING their leads), and their answers. Identify (1) which preference dimensions the conversation has already tested, (2) which books/authors it has already over-focused on, and (3) one genuinely different, worthwhile curiosity. If their latest answer asks to stay with a thread, honour that; otherwise give the conversation some breadth. An interesting emerging commonality is a lead to explore, not a finding to keep reasserting. Prefer a question that distinguishes between plausible explanations, reveals a second thread, or compares a different pairing of their favourites. Avoid mechanically asking about each book or author in turn. Do not use the same named work as the anchor across all three questions if the reader mentioned several. Avoid rotating through favourites one by one; seek relationships between examples where justified. Different books may satisfy different needs, with no unifying explanation. Do not infer feelings merely from a title. Ordinary genre, escapism, plot and fun deserve as much attention as style or philosophy.

Write one brief, natural conversational response with an OPTIONAL lead and exactly one question. Vary structure across the three turns: sometimes a direct question, sometimes a brief concrete comparison, sometimes a question about tone or pacing. Do NOT chain together multiple alternatives or three choices in one sentence; never frame all three questions as an either/or. No em dashes, and avoid repeatedly saying 'that pleasure' or 'that tension'. Keep it lively: it is a conversation about their reading taste, not three isolated book interviews. In the lead, if used, make ONE specific, falsifiable observation grounded in their words rather than a theory about who they fundamentally are. Never spend half a paragraph proving two unrelated authors are secretly alike. Don't present a multiple-choice test, flatter their taste, make elaborate academic comparisons, or repeatedly ask whether two books 'scratch the same itch'. Permit an answer such as 'I just enjoy them for different reasons'.

The lead should normally be one complete sentence, up to 22 words (maximum 40). The question should be complete, direct and preferably 10–22 words (maximum 45). A short lead plus a short question is better than a literary essay. Do not leave any sentence unfinished or break off mid-word. No markdown emphasis (asterisks), jargon, therapy language, generic chatbot encouragement or sweeping claims. Return just the two JSON fields; keep the response human, curious and varied.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await askStructured(env, instruction, QUESTION_SCHEMA, { outputTokens: 1100, budgetMs: 49000, effort: 'medium' });
        const lead = completeLead(result.lead);
        const question = completeQuestion(result.question);
        if (!question) throw new Error('invalid_question');
        return { lead, question, ...(data.step === 0 ? { researchNotes: baseResearch, sources: openingSources.slice(0,8) } : {}) };
      } catch (err) { if (attempt || !['invalid_json','invalid_question'].includes(err.message)) throw err; }
    }
  }
  // Live web research produces an open-ended longlist; the stronger editorial
  // model weighs the actual reader's answers and composes their five selections.
  // There is no predefined catalogue, genre filter, or fabricated fallback.
  const existing = [data.favourites, ...data.history.map(item => item.answer)].join('\n').toLowerCase();
  const discussedQuestions = data.history.map(item => item.question).join('\n').toLowerCase();
  const searchPrompt = `${context}${grounding}

IMPORTANT NEGATIVE PREFERENCES: If the reader rejects a genre, tone or level of darkness (for example 'no thrillers', 'nothing too dark', 'not horror'), obey that preference even if their other favourites have dark elements. Do not interpret 'mystery' as a request for murder, horror or psychological thrillers. If they like literary fiction, include genuine literary candidates with a compatible mood, not only genre crossovers.

RESEARCH TASK — Search across literary criticism, library catalogues, publisher pages and author interviews for published books that could suit the PRECISE preferences this person expressed, using BOTH the genres, subgenres, settings, storytelling pleasures and familiar features they enjoy AND the deeper preferences expressed in their answers. Look up the titles and authors in the conversation so you understand their real work. Then research about 10–12 NEW, specific published books by different authors. Include a substantial set of recognisably close matches (genre, tone, pace, premise or form, supported by evidence) and several more adventurous cross-genre connections. A good discovery can still be in the same genre; do not prize unexpectedness for its own sake. Never include books/authors already named by the reader, or titles raised in our questions. For each new book give: exact title and author, a verified specific detail (structure, character, premise, prose, themes), and an honest sentence about a possible affinity or meaningful contrast to something this reader ACTUALLY SAID. Cite book-specific sources, ideally publishers, library catalogues or substantive reviews. Do not guess at plots or make up titles. Give a concise researched longlist in plain text, not JSON.`;
  const discovery = await researchBooks(env, searchPrompt, { outputTokens: 4000, budgetMs: 73000 });
  const bibliography = discovery.sources;
  const editorial = `${context}
${grounding}

LIVE WEB RESEARCH INTO POSSIBLE BOOKS:
${discovery.notes}

RESEARCH SOURCES (numbered; use sourceId from this list only when the source genuinely discusses your selected book):
${numberedSources(bibliography)}

This is an open-ended, freshly researched longlist, NOT a pre-curated catalogue. Scrutinise title/author pairs and factual descriptions. If a researched candidate is shaky, discard it. Select exactly FIVE real, correctly attributed published books by five different authors from the researched options. Do not include books or authors already mentioned by the reader, or titles raised earlier in our conversation. Do not force all their favourites into one grand theory. Consider BOTH why they read and what kinds of books they enjoy. Genre similarity is a legitimate reason to recommend something, especially when supported by a second, more specific affinity; it is not automatically superficial. Prioritise their own answers when they clarify or contradict the opening list. EXPLICIT AVOIDANCES ARE BOUNDARIES: if they said no thriller, do not include thrillers or books primarily sold as psychological horror; if they want something quiet, include genuinely quiet books rather than only dark mystery-adjacent works. Never treat a skipped question, '(skipped)', or an inability to choose as a preference; do not mention unanswered questions in the portrait or recommendations. As a default, aim for roughly two or three recommendations with recognisable genre/subgenre, premise, tonal or structural affinities, and two or three more lateral discoveries. Adapt this balance to the actual reader: if they mostly describe a genre they love, give them more within it; if they explicitly want to branch out, follow that. Never make the set feel random just to appear original.

FAVOURITE AUTHORS: In "favouriteAuthors" return the names of authors the reader explicitly says they enjoy, including a named author without a specific favourite title. Only include names they actually wrote; never infer an author from a researched book or earlier question. Return [] if none. The display will show these as names rather than inventing a cover.

FAVOURITE BOOK COVERS: Include in "favouriteBooks" up to SIX distinct real book titles that the reader personally named as a book they loved or liked, in the initial favourites or their answers. Before writing the portrait, carefully inventory EVERY explicitly named liked book in the reader input and include them all (up to six), not only the titles you discussed in your reasoning. This list is a faithful record of the reader, not a creative selection. Give the correct title and author. A mentioned author by itself does NOT count as a named book. Do NOT infer a book from an author name, research note, or one of your recommendations, and do NOT include a book the reader explicitly disliked. If they named no actual liked book titles, return an empty array. We will use this list to illustrate their personal portrait, not to decide what to sell.

THE READER PORTRAIT: First rule: "Don't sound like AI." Write the sort of succinct, perceptive sketch a good independent bookseller might make after actually listening to someone. Readers are unusually sensitive to machine-written, over-interpreted prose. The portrait must feel OBSERVED, not decoded. Choose the least elaborate interpretation the evidence supports: a reader might value hilarity in one book and moral seriousness in another without these being signs of the same deep need. Actively look for at least one genuinely illuminating thread linking TWO or more of their loved books, authors or stated preferences; finding a connection is part of the magic, but it has to be grounded in the reader's words. But you may discover TWO different underlying threads, or no overarching connection at all. Draw on two or three SEPARATE preferences or reading pleasures from the conversation, if evidenced; do not bend everything into a grand unified theory. Never let one title, one author, or one abstract theme occupy the whole portrait when the conversation contains multiple favourites. Refer to distinct works or stated preferences naturally, rather than mechanically name-dropping all of them. In particular, avoid the format "you liked A for X, B for Y, and C for Z" without saying something that genuinely relates or contrasts them. Make connections between multiple works when the evidence exists, and name a second different connection when it matters. It is perfectly natural for a person to love one book for jokes and another for adventure or difficulty. Include one small, concrete detail that could only have come from THIS conversation. Do not overstate certainty about their personality, values, intelligence, identity or emotional needs. Avoid psychoanalysing and excessive compliments.

Create an original 2–5 word "readerType" heading that fits the evidence but isn't a fanciful personality-test classification. It can be modest, wry or descriptive, not necessarily "The [Adjective] [Noun]"; don't promise to reveal 'who they truly are'. Write "portrait" in 50–75 words of lucid, natural second-person prose, in two or three sentences. Variety is welcome; an honest contrast between distinct reading moods is better than a forced synthesis. Allow specificity, gentle humour and an affectionate observation, but never an invented personal anecdote.

Avoid common AI-tells: 'you are the kind of reader who', 'at heart', 'what unites them all', 'whether X or Y', 'not just X but Y', 'your reading DNA', 'you gravitate towards', 'tapestry', 'resonates', 'there is something about', symmetrical abstractions, and generic claims about wanting stories that 'make you think and feel'. Don't repeatedly use the same sentence structure. Don't use vague pseudo-profound aphorisms. Never mention skipped questions, unanswered prompts, the interview process, or the algorithm in the portrait. If the reader did not answer a question, simply work with what they did tell you. No em dashes. No markdown formatting. Write as an editor would, not a personality quiz, horoscope, therapist or promotional chatbot.

THE FIVE RECOMMENDATIONS: Choose a clear mix of discovery roles. Mark ONE book as role 'closest_match' for the most grounded fit with their favourite books, ONE as 'tone_match' for a book especially close to their stated mood, and ONE as 'wildcard' for a plausible but genuinely different discovery. The other TWO use role 'other'. These roles must be honest, never an excuse to violate a stated dislike. A wildcard is NOT permission to recommend a thriller to someone who explicitly does not want one. Return this role field on each book. Do not mention these role codes in the prose. Across the set of five, draw on DIFFERENT strands of the reader's stated preferences, rather than attaching all five to the same supposed hidden motivation. Distinguish genre/subgenre and storytelling pleasures from voice, craft, mood, character, etc. Don't rely on whatever topic the last question happened to explore. For each selected book, write a "reason" of 40–60 words that feels like a bookseller telling a friend why this one is worth trying. Start with one concrete and accurate detail about the book *supported by your research*, then explain why one specific thing they said points towards it. Make five genuinely different cases rather than recycling an idea across all five. Avoid meta-analysis of the reader, such as "your preference for character tension gives this similarity weight". Be warm, accurate and concise. If a book contains disturbing themes relevant to informed choice, retain a brief considerate content note. When a recommendation is close in genre, subgenre, atmosphere or narrative mechanics, say so plainly and explain the additional specific link. A connection can be imperfect or a small leap; be honest about that. Never invent a plot event, assume the reader has experienced something personally, spoil an ending, or imply that two books are similar just because they share a genre or theme. Avoid stock phrases like "perfect for you", "you'll love", "resonates with", "masterful" and "must-read". Give each book a short "thread" of 2–5 original words, like a small editorial note. Avoid em dashes in all reader-facing text. In the separate contentNote field, give a brief clear advisory when there is significant violence, self-harm, sexual violence, animal cruelty or comparable distressing material; otherwise return an empty string. Do not repeat the advisory in the main reason, and do not invent warnings. For each book set "sourceId" to its matching number in the RESEARCH SOURCES list; use 0 when no source specifically describes that book.

Write the portrait and five book selections as structured JSON.`;
  const result = await askStructured(env, editorial, FINAL_SCHEMA, { editor: true, outputTokens: 5200, budgetMs: 85000, effort: 'medium' });
  const readerType = safe(result.readerType, 110);
  const portrait = safe(result.portrait, 1400);
  if (readerType.length < 5 || portrait.length < 120) throw new Error('invalid_books');
  const authors = new Set();
  const books = [];
  for (const item of Array.isArray(result.books) ? result.books : []) {
    const book = citedBook(item, bibliography);
    if (!book.title || !book.author || book.reason.length < 170 || authors.has(normaliseBook(book.author)) ||
        existing.includes(book.title.toLowerCase()) || discussedQuestions.includes(book.title.toLowerCase()) ||
        existing.includes(book.author.toLowerCase())) continue;
    authors.add(normaliseBook(book.author));
    books.push(book);
    if (books.length === 5) break;
  }
  if (books.length !== 5) throw new Error('invalid_books');
  const wordsSaid = normaliseBook([data.favourites, ...data.history.map(item=>item.answer)].join(' '));
  const favouriteBooks = (Array.isArray(result.favouriteBooks) ? result.favouriteBooks : [])
    .map(item=>({ title: safe(item?.title,150), author: safe(item?.author,110) }))
    .filter(item=>item.title.length>2 && item.author.length>2 && wordsSaid.includes(normaliseBook(item.title)))
    .filter((item,i,arr)=>arr.findIndex(other=>normaliseBook(other.title)===normaliseBook(item.title))===i)
    .slice(0,6);
  const favouriteAuthors = (Array.isArray(result.favouriteAuthors) ? result.favouriteAuthors : [])
    .map(name => safe(name,100))
    .filter(name => name.length > 3 && wordsSaid.includes(normaliseBook(name)))
    .filter((name,i,all)=>all.findIndex(other=>normaliseBook(other)===normaliseBook(name))===i)
    .slice(0,8);
  return { readerType, portrait, favouriteBooks, favouriteAuthors, books, researchSources: bibliography.slice(0,12), shareProof: issueShareProof({readerType,portrait,books},data.sessionId,env.OPENAI_API_KEY) };
}

async function handleApi(request, env) {
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return error('Request not allowed.', 403);
  if (Number(request.headers.get('content-length')) > 12000) return error('Your message is too long.', 413);
  let data;
  try { data = validateBody(await request.json()); } catch (_) { return error('Please check your answers and try again.', 400); }
  if (!data) return error('Please check your answers and try again.', 400);
  let quota = null;
  if (data.step === 3) {
    quota = await reserveQuota(request, env, data.sessionId);
    if (!quota.allowed) return quota.unavailable
      ? error('The reading room is temporarily at capacity. Please try again later.',503)
      : error('You have already received two sets of recommendations today. Come back tomorrow for more.',429);
  }
  await track(env, `stage_${data.step}_started`);
  try {
    const result = await respondWithModel(data, env);
    await track(env, `stage_${data.step}_completed`);
    if (data.step === 3) { await track(env,'completed_sessions'); await finishQuota(env,quota); }
    return json(result);
  }
  catch (err) {
    await releaseQuota(env,quota);
    await track(env,`stage_${data.step}_failed`);
    console.warn('Read & Found model request:', err.message || 'unknown_error');
    if (err.message === 'missing_key' || err.message === 'authentication') return error('The model connection needs attention. Please try again later.', 503);
    if (err.message === 'rate_limit') return error('Our reading room is out of AI credit or temporarily over its limit. Please come back later; your answers will stay on this page.', 503);
    if (err.message === 'timeout' || err.name === 'AbortError') return error('The model took too long to reply. Please try again.', 504);
    return error('We couldn’t get a useful response this time. Please try again.', 502);
  }
}

async function handleReplace(request, env) {
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return error('Request not allowed.', 403);
  if (Number(request.headers.get('content-length')) > 20000) return error('Request too long.', 413);
  let conversation, books, feedback, replaceIndex, rating, replacementId;
  try {
    const body = await request.json();
    conversation = validateBody({ ...body, step: 3 });
    if (!conversation || !Array.isArray(body.books) || body.books.length !== 5 ||
        !Array.isArray(body.feedback) || body.feedback.length < 1 || body.feedback.length > 30 ||
        !Number.isInteger(body.replaceIndex) || body.replaceIndex < 0 || body.replaceIndex > 4) throw new Error('invalid');
    replaceIndex = body.replaceIndex;
    books = body.books.map(book => ({ title: safe(book?.title, 150), author: safe(book?.author, 110) }));
    feedback = body.feedback.map(item => ({ title: safe(item?.title, 150), author: safe(item?.author, 110), rating: item?.rating }));
    rating = body.rating;
    replacementId = safe(body.sessionId,100);
    if (books.some(book => !book.title || !book.author) || feedback.some(item =>
      !item.title || !item.author || !['loved','liked','okay','disliked'].includes(item.rating)
    ) || !['loved','liked','okay','disliked'].includes(rating)) throw new Error('invalid');
    const target = books[replaceIndex];
    if (!feedback.some(item => normaliseBook(item.title) === normaliseBook(target.title) &&
        normaliseBook(item.author) === normaliseBook(target.author) && item.rating === rating)) throw new Error('invalid');
  } catch (_) { return error('Please try marking that book again.', 400); }

  const target = books[replaceIndex];
  const verdict = { loved: 'LOVED it', liked: 'LIKED it', okay: 'thought it was JUST OKAY', disliked: 'DID NOT LIKE it' }[rating];
  const history = feedback.map(item => `- ${item.title} — ${item.author}: ${item.rating}`).join('\n');
  const current = books.map((book, i) => `${i+1}. ${book.title} — ${book.author}${i===replaceIndex?' [REPLACE THIS]':''}`).join('\n');
  const instruction = `${transcript(conversation)}
${conversation.researchNotes ? `\nINITIAL RESEARCH ON THE READER'S FAVOURITES:\n${conversation.researchNotes}\n` : ''}

The reader has already read ${target.title} by ${target.author}, and ${verdict}. We need exactly ONE NEW book to replace it, without touching the other four recommendations.

CURRENT RECOMMENDATIONS (exclude ALL of these):
${current}

EVERY BOOK THE READER HAS MARKED AS READ, WITH THEIR REACTION (exclude ALL of these too):
${history}

Let the verdict change your reading of their taste. If they loved this book, treat that as strong positive evidence and explore an adjacent but surprising direction. If they merely liked it, take a more exploratory step. If it was okay or they disliked it, move away from the qualities that might not have worked and look for a different route into the reader's stated interests. Do NOT assume you know WHY they reacted this way: the rating is evidence, not an explanation. The conversation remains the best evidence of what matters to them.

We will RESEARCH a new book rather than guessing. The replacement must be a REAL, correctly attributed published book from the whole world of literature, any era or genre. Not a title already named in the conversation, not any title in the lists above, not by any of the five currently selected authors, and not an author the reader identified as a favourite. Prioritise both a recognisable match in genre, tone or storytelling pleasures AND at least one more specific taste connection. A same-genre discovery is welcome; being unusual is not a virtue on its own. The fact this book was already read and its verdict are new, important evidence, but not grounds to invent what the reader felt about its details.`;

  const quota = await reserveQuota(request, env, replacementId, 'replacements');
  if (!quota.allowed) return quota.unavailable ? error('The reading room is temporarily at capacity. Please try again later.',503)
    : error('That is all the book swaps available today. Please try again tomorrow.',429);
  await track(env,'replacements_started');
  try {
    const excludeNames = [conversation.favourites, ...conversation.history.flatMap(item => [item.question,item.answer])].join('\n').toLowerCase();
    const seen = new Set([...books,...feedback].map(item => `${normaliseBook(item.title)}|${normaliseBook(item.author)}`));
    const seenTitles = new Set([...books,...feedback].map(item => normaliseBook(item.title)));
    const currentAuthors = new Set(books.map(item => normaliseBook(item.author)));
    const research = await researchBooks(env, `${instruction}\n\nSearch the web for 4–6 plausible, genuinely published alternatives, verifying precise title/author pairs and substantive book-specific details through publishers, catalogues or good reviews. For each candidate, explain one specific possible connection to this reader's actual answers and the newly reported reaction. Cite the sources. No invented titles or vague genre lists.`, { outputTokens: 2400, budgetMs: 56000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const editorial = `${instruction}\n\nWEB-RESEARCHED ALTERNATIVES:\n${research.notes}\n\nSOURCES (use sourceId corresponding to a source about the actual selected book; 0 if none):\n${numberedSources(research.sources)}\n\nChoose the SINGLE strongest verified new book from this research, respecting every exclusion and the rating. Give it a distinctive "thread" of 2–5 words and a "reason" of 55–80 words. Start with a true and concrete quality of this specific book, then connect it to a real statement or preference of this reader. Make the connection candid and interesting, without generic praise, forced analogies, spoilers or assumed personal experiences. ${attempt ? 'Pick an alternate candidate not used in the prior attempt.' : ''}`;
      const raw = await askStructured(env, editorial, SWAP_SCHEMA, { editor:true, outputTokens: 1700, budgetMs: 65000, effort: 'medium' });
      const book = citedBook(raw.book, research.sources);
      if (!book.title || !book.author || book.reason.length < 125 ||
          seen.has(`${normaliseBook(book.title)}|${normaliseBook(book.author)}`) || seenTitles.has(normaliseBook(book.title)) ||
          currentAuthors.has(normaliseBook(book.author)) ||
          excludeNames.includes(book.title.toLowerCase()) || excludeNames.includes(book.author.toLowerCase())) continue;
      await track(env,'replacements_completed'); await finishQuota(env,quota);
      return json({ book });
    }
    await releaseQuota(env,quota);
    return error('That suggestion wasn’t quite right. Let’s try another.', 502);
  } catch (err) {
    await releaseQuota(env,quota); await track(env,'replacements_failed');
    console.warn('Read & Found replacement request:', err.message || 'unknown_error');
    if (err.message === 'authentication' || err.message === 'missing_key') return error('The book service needs attention. Try again later.', 503);
    if (err.message === 'rate_limit') return error('The reading room is out of AI credit or temporarily over its limit. Please try again later.', 503);
    return error('We couldn’t find the next book just now. Try again.', err.message === 'timeout' ? 504 : 502);
  }
}

function normaliseBook(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function handleCovers(request) {
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return error('Request not allowed.', 403);
  if (Number(request.headers.get('content-length')) > 10000) return error('Request too long.', 413);
  let books;
  try {
    const body = await request.json();
    if (!Array.isArray(body.books) || !body.books.length || body.books.length > 8) throw new Error('invalid');
    books = body.books.map(book => ({ title: safe(book?.title, 150), author: safe(book?.author, 110) }));
    if (books.some(book => !book.title || !book.author)) throw new Error('invalid');
  } catch (_) { return error('Invalid book list.', 400); }

  // One catalogue search PER book. The old combined OR search returned 60
  // results across every title, then required exact author/title and complete
  // edition-language metadata. Real books often fell through those conditions.
  // Send only public titles and authors to Open Library, never private answers.
  const validISBN13 = value => /^97[89]\d{10}$/.test(value) &&
    [...value].reduce((sum,char,i)=>sum + Number(char)*(i%2 ? 3 : 1),0) % 10 === 0;
  const coverId = edition => (Array.isArray(edition?.covers) ? edition.covers : [])
    .find(id => Number.isSafeInteger(id) && id > 0);
  const english = edition => edition.languages?.some(lang => lang?.key === '/languages/eng');
  const unlabelledEnglishTitle = (edition,book) =>
    (!Array.isArray(edition.languages) || edition.languages.length === 0) &&
    normaliseBook(edition.title || '') === normaliseBook(book.title);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24000);
  async function catalogue(url) {
    const response = await fetch(url,{signal:controller.signal,headers:{
      'User-Agent':'ReadAndFound/1.0 (book discovery; metadata only)',
      'Accept':'application/json'
    }});
    if (!response.ok) throw new Error('catalogue_'+response.status);
    return response.json();
  }
  async function oneCover(book) {
    const query = new URLSearchParams({
      title:book.title, author:book.author,
      fields:'key,title,author_name,edition_count,first_publish_year',limit:'16'
    });
    const search = await catalogue('https://openlibrary.org/search.json?'+query);
    const title = normaliseBook(book.title),author=normaliseBook(book.author);
    const works = (search.docs || []).filter(item =>
      /^\/works\/OL\d+W$/.test(item.key || '') &&
      (normaliseBook(item.title || '') === title ||
       normaliseBook(item.title || '').startsWith(title+' ')) &&
      (item.author_name || []).some(name => {
        const n=normaliseBook(name);
        return n === author || n.endsWith(' '+author) || author.endsWith(' '+n);
      })
    ).slice(0,2);
    let metadataFallback = null;
    for (const work of works) {
      let unlabelled = null, metadataEdition = null;
      const year = Number.isInteger(work.first_publish_year) ? work.first_publish_year : null;
      const metadata = (edition, id = null) => ({
        coverUrl: id ? 'https://covers.openlibrary.org/b/id/'+id+'-L.jpg?default=false' : null,
        isbn13: (edition?.isbn_13 || []).find(validISBN13) || null,
        year,
        pages: Number.isInteger(edition?.number_of_pages) && edition.number_of_pages > 0 ? edition.number_of_pages : null,
        series: Array.isArray(edition?.series) ? String(edition.series[0] || '').slice(0,100) : null,
        openLibraryUrl:'https://openlibrary.org'+work.key
      });
      for (let offset=0;offset<=100;offset+=100) {
        const data = await catalogue('https://openlibrary.org'+work.key+'/editions.json?'+
          new URLSearchParams({limit:'100',offset:String(offset)}));
        const entries = data.entries || [];
        // Page count and publication year are valuable even if no edition has cover art.
        const plausible = entries.filter(item => english(item) || unlabelledEnglishTitle(item,book));
        const better = plausible.find(item => Number.isInteger(item.number_of_pages) && item.number_of_pages > 0) || plausible[0];
        if (better && (!metadataEdition || (!metadataEdition.number_of_pages && better.number_of_pages)))
          metadataEdition = better;
        const editions = entries.filter(item => !!coverId(item));
        const confirmed = editions.filter(english);
        const fallback = editions.filter(item => unlabelledEnglishTitle(item,book));
        const picked = confirmed.find(item => (item.isbn_13 || []).some(validISBN13)) || confirmed[0];
        if (picked) {
          const result = metadata(picked,coverId(picked));
          if (!result.pages && metadataEdition) result.pages = metadata(metadataEdition).pages;
          return result;
        }
        if (!unlabelled && fallback.length) unlabelled =
          fallback.find(item => (item.isbn_13 || []).some(validISBN13)) || fallback[0];
        if ((data.size || 0) <= offset+100) break;
      }
      if (unlabelled) {
        const result = metadata(unlabelled,coverId(unlabelled));
        if (!result.pages && metadataEdition) result.pages = metadata(metadataEdition).pages;
        return result;
      }
      if (!metadataFallback) metadataFallback = metadata(metadataEdition);
    }
    return metadataFallback;
  }
  try {
    const covers = Array(books.length).fill(null);
    let cursor=0;
    // Keep concurrency modest to avoid Open Library's public API rate limits.
    await Promise.all(Array.from({length:Math.min(2,books.length)},async()=>{
      while(cursor < books.length) {
        const i=cursor++;
        try { covers[i]=await oneCover(books[i]); }
        catch (_) { covers[i]=null; }
      }
    }));
    return json({covers});
  } catch (err) {
    console.warn('Optional Open Library cover lookup unavailable:',err.name||'error');
    return json({covers:books.map(()=>null)});
  } finally { clearTimeout(timeout); }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/read') return handleApi(request, env);
    if (path === '/api/replace') return handleReplace(request, env);
    if (path === '/api/covers') return handleCovers(request);
    if (path === '/api/out') {
      if (request.method !== 'GET') return error('Method not allowed.',405);
      const params = new URL(request.url).searchParams;
      const title = safe(params.get('title'),150), author = safe(params.get('author'),110);
      const isbn = safe(params.get('isbn'),13);
      if (!title || !author) return error('Book not found.',400);
      const id = safe(env.BOOKSHOP_AFFILIATE_ID,30);
      const isValidISBN = /^97[89]\d{10}$/.test(isbn) && [...isbn].reduce((sum,c,i)=>sum+Number(c)*(i%2?3:1),0)%10===0;
      const isAffiliate = /^\d{1,15}$/.test(id) && isValidISBN;
      const target = isAffiliate ? `https://uk.bookshop.org/a/${id}/${isbn}`
        : `https://uk.bookshop.org/search?keywords=${encodeURIComponent(title+' '+author)}`;
      await track(env, isAffiliate ? 'affiliate_click' : 'bookshop_click');
      return new Response(null,{status:302,headers:{Location:target,'Cache-Control':'no-store'}});
    }
    if (path === '/api/stats') {
      if (request.method !== 'GET') return error('Method not allowed.',405);
      return stats(request,env);
    }
    if (path === '/api/event') {
      if (request.method !== 'POST') return error('Method not allowed.',405);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== new URL(request.url).origin) return error('Request not allowed.',403);
      try {
        const raw = await request.text();
        if (raw.length > 1000) return error('Request too long.',413);
        const { event } = JSON.parse(raw);
        if (!['affiliate_click','donation_click','list_helpful','list_not_helpful'].includes(event)) return error('Invalid event.',400);
        await track(env,event);
        return json({ok:true});
      } catch (_) { return error('Invalid event.',400); }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const asset = ASSETS[path === '/' ? '/index.html' : path];
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      // Frequent prototype deployments must not mix a fresh HTML page with
      // an hour-old script or stylesheet from the previous release.
      headers: { 'content-type': asset.type, 'cache-control': 'no-cache, must-revalidate', 'x-content-type-options': 'nosniff' }
    });
  }
};
