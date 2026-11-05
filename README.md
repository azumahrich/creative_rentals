# Creative Rentals — Online Version

Photography & media equipment rental management for Creative Rentals, Adum-Kumasi.
All data is stored in a PostgreSQL database on a server, so every phone, tablet and
computer with the link sees the same live data.

**Built with:** Node.js + Express (server), PostgreSQL (database), plain HTML/JS (app screens).

---

## First login

| Username | Password |
|----------|----------|
| `admin`  | `admin123` |

This **Super Admin** account is created automatically the first time the server starts.
**Change this password straight away** (Users → ✏️ on Admin → new password).

---

## Option A — Render.com (easiest, has a free tier)

1. Create a free account at **github.com**, make a new repository, and upload everything
   in this folder (except `node_modules` if present).
2. Create an account at **render.com** and sign in with GitHub.
3. **New → PostgreSQL** → give it a name → Create. When it's ready, copy the
   **Internal Database URL**.
4. **New → Web Service** → pick your repository, then set:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables:
     - `DATABASE_URL` = the URL you copied in step 3
     - `JWT_SECRET` = any long random text (e.g. 40+ mixed characters)
     - `NODE_ENV` = `production`
5. Click **Create Web Service**. After a few minutes you get a link like
   `https://creative-rentals.onrender.com`. Open it on any device and log in.

> Render's free web service sleeps after 15 minutes of no use, so the first load
> after a quiet period takes ~30–50 seconds. The free database also expires after
> a limited period. For daily business use, choose the paid **Starter** plans.

## Option B — Railway.app

1. Sign in at **railway.app** with GitHub → **New Project → Deploy from GitHub repo**.
2. In the project, click **+ New → Database → PostgreSQL**.
3. Open your web service → **Variables** → add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = a long random string
   - `NODE_ENV` = `production`
4. **Settings → Networking → Generate Domain** to get your public link.

## Option C — Your own VPS (DigitalOcean, Hetzner, etc.)

```bash
# On Ubuntu
sudo apt update && sudo apt install -y nodejs npm postgresql
sudo -u postgres createuser -P crapp          # choose a password
sudo -u postgres createdb -O crapp creative_rentals

cd creative-rentals-server
cp .env.example .env     # then edit .env:
# DATABASE_URL=postgresql://crapp:YOURPASSWORD@localhost:5432/creative_rentals
# NODE_ENV=development   (use this for a local database without SSL)
npm install
npm install -g pm2 && pm2 start server.js --name creative-rentals && pm2 save
```
Then put Nginx + a free Let's Encrypt certificate in front of port 3000.

## Running on your own computer (to try it out)

Install Node.js 18+ and PostgreSQL, create a database called `creative_rentals`, then:

```bash
cp .env.example .env    # set DATABASE_URL, and NODE_ENV=development
npm install
npm start               # open http://localhost:3000
```

---

## What happens automatically

- Database tables are created on first start, and your 30 equipment items are loaded
  (only if the equipment table is empty — your edits are never overwritten).
- Renting an item reduces its available count; marking the rental Returned (or
  deleting it) puts the stock back.
- Active rentals past their end date are marked **Overdue**.
- Recording a payment updates the rental's paid amount and balance.

## Roles

- **Super Admin** — everything. The only role that can add, edit, disable or remove
  **admin** accounts (and other super admins), and the only role that can use **Settings →
  Danger zone** to clear equipment, clients, rentals and payments.
  There must always be at least one active Super Admin.
- **Admin** — equipment, clients, rentals, payments, reports, and managing **staff** accounts.
- **Staff** — create rentals, record payments, and view/print/WhatsApp invoices. They can view clients and
  equipment but not add, edit or delete them, and can't see Payments history, Reports or revenue totals.

Nobody can change their own role, or disable/delete their own account.
Role changes and disabled accounts take effect immediately, even for someone already logged in.

## Rental times

Pickup is always **8:00 AM** on the rental date and return is by **5:00 PM** on the return
date (same day by default). Equipment rates are per 8am–5pm day, so a rental from Monday to
Wednesday is charged 3 days. A rental not returned by 5:00 PM on its return date becomes Overdue.

## Advance bookings

A rental whose date is in the future is saved as a **Booking**. It reserves the equipment for
those dates but doesn't take it out of stock. The app checks every booking and rental date by date,
so two clients can't be given the same unit on the same day. When the client collects, staff tap
**🤝 Picked up** (from the booking date onwards) and the rental becomes Active. Admins can
**Cancel booking** for no-shows. The dashboard lists pickups for the next 7 days.

## Backups

Your host's PostgreSQL has backup options (Render and Railway paid plans include daily
backups). On a VPS, schedule:
```bash
pg_dump creative_rentals > backup_$(date +%F).sql
```

## Folder layout

```
server.js            Starts the server and sets up the database
db/schema.sql        Database tables + starting equipment list
db/index.js          Database connection
middleware/auth.js   Login tokens and admin check
routes/              API: auth, users, clients, equipment, rentals, payments, reports
public/index.html    The app screens
public/logo.png      Creative Rentals logo
```

## Expenses & net profit
Admins record business costs on the **Expenses** page (date, category, amount, paid with/to, receipt ref, and
optionally the equipment item a repair was for). Reports deduct expenses from rental revenue to show **Net Profit**,
with a breakdown by category and an Expenses/Net column per equipment item. Staff can't see expenses.

## Loyalty discount
Applied automatically to every new rental's charge (never the deposit): under GH₵ 1,000 → no discount,
GH₵ 1,000 – 1,500 → 5% off, above GH₵ 1,500 → 8% off. The Super Admin can change or switch it off in Settings. Rentals made before
this update keep their original prices. Invoices and WhatsApp messages show the discount line.
