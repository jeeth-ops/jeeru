# Jeeru

A private chat app just for two people, iOS-styled, with photos, videos, and Instagram Reel previews.

## Run locally
```
npm install
npm start
```
Then open http://localhost:3000

## Deploy
See deployment steps provided separately. In short:
1. Push this folder to a GitHub repo.
2. Create a new Web Service on Render, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. **Set the `JEERU_KEY` environment variable** on Render (Dashboard -> your
   service -> Environment -> Add Environment Variable). Pick a long, random
   passphrase — this is the shared PIN that gates every API request.
   **Never commit it to git or write it into any file in this repo.**
   Share it with your partner out-of-band (say it out loud, or send it over
   an already-trusted channel) — not through the app itself, and not by
   pasting it into GitHub, a doc, or an unencrypted note.

## About the login gate
Every request to `/api/*` now requires this passphrase (sent as the
`X-Jeeru-Key` header, or via `POST /api/login` on first entry). Without the
correct key:
- The server returns `401 Unauthorized` for messages, reactions, etc.
- Repeated wrong guesses from the same IP get rate-limited (429) after 8
  attempts in 15 minutes.

This stops anyone who merely finds the URL from reading the chat. It does
**not** replace real end-to-end encryption — messages are still stored as
plain text in `data.json` on the server, so someone with direct access to
the Render server/disk (or a legal order compelling Render) could still read
them. If you want that layer closed too, that's the encryption step we
talked about — happy to add it whenever you're ready.

## Note on storage
Messages are stored in `data.json` on the server. On Render's free tier this file
resets whenever the service redeploys or restarts after long inactivity — for
a couple's private chat this is usually fine, but it isn't a database-grade
guarantee. Upgrade to a persistent disk or a real database later if needed.
