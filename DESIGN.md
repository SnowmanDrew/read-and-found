# Read & Found — design notes

**Concept:** An independent bookshop's reading notes, not a tech landing page.

Keep the site personal and useful. The site should feel as if someone who genuinely enjoys talking about books has put it together.

## Visual vocabulary
- Inky blue, crisp pale paper, warm annotation red, and a yellow reading-note panel. No cream/terracotta/forest-green gradient palette.
- Fraunces for big, characterful display typography; Source Serif 4 for reading, personal notes, links and calls to action. IBM Plex Sans is reserved for functional counters. No monospace for conversational text or buttons. Avoid tracking every label in uppercase.
- The opening is a single typographic statement. No CSS-drawn fake covers, concentric orbits, imagined publishers, badges, or generic landing-page illustration.
- The favourites form reads like a bookshop reading slip; results use real Open Library covers when available and a quiet text fallback.
- The reading portrait appears on a yellow reading-note surface, echoed by the downloadable image.
- Only use external-link arrows on links leaving the site. Use purposeful animation, not standard fade-up decoration.

## Voice
- Direct, curious, humble. Sound like a reader talking to another reader, not a consultant describing a recommender system.
- Let the project author be visible. No personality-test mysticism or inflated AI claims.
- Preserve the research, question, book-cover and portrait flows when restyling.

## Regression guardrails
- Check the opening form on a 375px mobile viewport, including a clearly visible submit button.
- Check the About sheet at 375×667; sign-off must not be clipped.
- Check question text and portrait lengths, real-cover fallbacks, and responsive results.
- Run `python -m unittest discover -s tests` and `node --check app.js` before merging.
- Always change GitHub source; let Vercel deploy it. Never reconstruct HTML from an old Vercel deployment.

## One signature interaction
- When the complete list appears, a bookshop-style **for your shelves** ink stamp lands once on the results header. No other generic results fade-up; honour reduced-motion preferences.
- Selectively lowercase site-owned headlines, labels, navigation and button copy via CSS only. Keep book titles, authors, questions, reader portraits and longer prose in normal case.

## Polish (v33)
- Lowercase only site-owned headings and brief interface labels. Preserve published book titles, author names, all questions and longer writing.
- Use the italic reading serif on lined answer paper; do not use novelty handwriting type.
- Reflect readers' actual authors and covers in the portrait, and show full cover images without cropping.
- The five recommendations aim for a grounded closest match, a tonal match and a careful wildcard, while respecting explicit negative preferences.
- A skipped question is missing information, never content for the portrait. Avoid repetitive either/or questions and em dashes.
