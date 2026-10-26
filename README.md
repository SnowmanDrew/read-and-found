# Read & Found

An independent book-discovery experiment. Readers share books and authors they love, answer three questions, and receive five personalised recommendations and a reading portrait.

## Deploy

This is the full source tree for the production Vercel project `afterword` at https://afterword-coral.vercel.app.

- **Deploy from Git `main`**, not a ZIP or build-time patch. `index.html`, `styles.css`, `app.js`, and `worker/index.js` are authoritative.
- Framework preset: **Other**; root directory: `./`. `vercel.json` defines the serverless API functions.
- Configure `OPENAI_API_KEY` in Vercel's environment settings. Optionally configure `OPENAI_MODEL` and `OPENAI_EDITOR_MODEL` according to your account's supported models. Never commit live keys.
- The historical `scripts/patch.mjs` is deliberately a no-op to remain compatible with old Vercel project settings. It must **never** mutate tracked source at build time.

## Release checks

Run `python3 tests/test_regressions.py` and `node --check app.js && node --check worker/index.js && node --check api/_adapter.js` before pushing to `main`.

## Deployment safeguards

- Do not rewrite index.html or styles.css from old ZIP archives; update this repository.
- Test the mobile homepage, About modal and an actual /api/read request on previews before promoting.
- Production Vercel env variables remain in Vercel, not in Git.