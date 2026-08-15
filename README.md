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

## Note on storage
Messages are stored in `data.json` on the server. On Render's free tier this file
resets whenever the service redeploys or restarts after long inactivity — for
a couple's private chat this is usually fine, but it isn't a database-grade
guarantee. Upgrade to a persistent disk or a real database later if needed.
