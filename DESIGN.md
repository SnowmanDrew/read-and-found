# Read & Found — design notes

**Concept:** An independent bookshop's reading notes, not a tech landing page.

Keep the site personal and useful. The site should feel as if someone who genuinely enjoys talking about books has put it together.

## Visual vocabulary
- Inky blue, crisp pale paper, warm annotation red, and a yellow reading-note panel. No cream/terracotta/forest-green gradient palette.
- Fraunces for big, characterful display typography; Source Serif 4 for reading; IBM Plex Mono for occasional utility text. Avoid tracking every label in uppercase.
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
