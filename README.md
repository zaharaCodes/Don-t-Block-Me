# Don't Block Me: live version (₹10 per play, 100% free to run)

- `server.js`: backend (payments, database, tracking, scores, admin data)
- `public/index.html`: the game · `public/admin.html`: your dashboard · `public/policies.html`: privacy/terms/refund

## Two ways to take the ₹10 (set `PAYMENT_MODE`)
**`upi` (free, no fee):** the player pays your own UPI ID and types the 12-digit UTR from their UPI app.
The money goes straight to you with no gateway fee. The server only checks the UTR format and that it was
not used before. It cannot confirm the money really arrived, so open `/admin.html`, compare the UTR list with
your UPI/bank history, and tap **Revoke** on fake ones.

**`razorpay` (automatic):** payments are verified automatically, but Razorpay charges a fee on each payment.

## Free hosting (no card needed for the first two, check current limits)
1. **Database: Turso** (turso.tech, free plan). Create a database, copy its URL (`libsql://...`) and create an auth token.
2. **Code: GitHub.** Upload this folder to a new repo.
3. **Server: Render** (render.com) → New → Web Service → pick the repo → Free plan.
   Build command `npm install`, start command `npm start`.
4. In Render → Environment, add:
   `PAYMENT_MODE=upi`, `PRICE_RS=10`, `UPI_ID=<your UPI id>`, `UPI_NAME=<your name>`,
   `ADMIN_PASSWORD=<long random>`, `DB_URL=<Turso URL>`, `DB_TOKEN=<Turso token>`.
5. Edit `public/policies.html` and put your real email in place of `YOUR-EMAIL@example.com`.
6. Open your Render link = your game. Open `/admin.html` for the dashboard.

Notes: Render's free server sleeps when nobody uses it, so the first open can take about a minute.
Your data stays safe because it lives in Turso, not on Render.

## Test locally
`npm install` then copy `.env.example` to `.env` and run `npm run dev`, open http://localhost:3000.

## What /admin.html shows
Unique visitors, new/active users, opens per day, mobile share, quizzes, plays, payments and revenue,
the funnel (open → start → pay click → paid), recent payments with UTRs, recent plays and visitors.

## Security
Answers never leave the server and scores are computed on the server. A payment pass works once.
In UPI mode a determined person can type a fake UTR, which is why you check and revoke in the dashboard.
