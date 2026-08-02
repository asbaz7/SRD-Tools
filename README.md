# Toolroom — Workshop Tool Tracker

A web app to track every tool across all your workshops, move tools between
sites, and keep a permanent record of every transfer — with role-based
logins so people only see and do what they're allowed to.

**Stack:** Supabase (Postgres database + authentication + security rules) +
a plain HTML/CSS/JS front end. No build step, works on phone, tablet, or
desktop, and costs $0/month at your scale (Supabase's free tier covers
up to 50,000 monthly active users and 500MB database).

---

## 1. Create your database (10 minutes)

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Click **New project**. Pick a name and a strong database password (save it somewhere safe — you likely won't need it again).
3. Once the project is ready, open **SQL Editor** in the left sidebar.
4. Open `schema.sql` from this folder, copy all of it, paste it into the SQL Editor, and click **Run**.
   This creates all the tables, the security rules that enforce who can see/do what, and the automatic
   audit trail for transfers.
5. Go to **Project Settings → API**. You'll need two values in step 3 below:
   - **Project URL**
   - **anon public** key (this is safe to put in the front-end — it only grants what your security
     rules in `schema.sql` allow, nothing more)

## 2. Create your first login (2 minutes)

1. In Supabase, go to **Authentication → Users → Add user**.
2. Enter your own email and a password. Leave "Auto Confirm User" checked.
3. Go to **SQL Editor** again and run this once, replacing the email:

   ```sql
   update public.profiles
   set role = 'admin', active = true
   where id = (select id from auth.users where email = 'you@example.com');
   ```

   This makes you the first admin. Every account after this one you can manage from inside the app itself.

## 3. Run the app

Open `index.html` in a browser (double-click it, or drag it into a browser tab). The first time,
it'll ask for your **Project URL** and **anon public key** from step 1 — paste them in. That's stored
only in that browser, not sent anywhere else.

Sign in with the login you created in step 2. As an admin, use **Workshops** to add your workshop
locations, then **Tools** to start adding tools.

## 4. Put it on a real web address (so anyone can reach it from any device)

Any static-hosting service works since there's no build step. The easiest free option:

**Netlify (drag-and-drop, ~2 minutes):**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag this whole folder (`index.html`, `style.css`, `app.js`) onto the page
3. Netlify gives you a URL like `yourname.netlify.app` — share that with your team

Other equally good options: **Vercel**, **Cloudflare Pages**, or your own web host — just upload
the three files. You can add a custom domain later from any of these.

> Note: each teammate's browser will ask for the Project URL/key once, the same way yours did.
> You can just send them the two values from step 1 to paste in.

## 5. Add your team

People sign in with **email + password that you set**, not self-signup — this keeps the tool list
and transfer history restricted to people you've actually authorized.

For each teammate: **Supabase → Authentication → Users → Add user**. They'll show up in the app's
**People** page as an inactive Viewer. Open their entry there to:
- Set their **role** — `admin` (full control), `manager` (can add tools and record transfers),
  or `viewer` (read-only)
- Set their **home workshop**
- Switch them to **Active**

Until you activate someone, they can't sign in — so adding a login doesn't grant access by itself.

---

## How the security works

- Every table has Postgres **Row Level Security** turned on — the database itself enforces the
  rules, not just the front-end, so there's no way around it even if someone inspects the app's code.
- **Viewers** can see everything (tools, locations, full transfer history) but can't change anything.
- **Managers** can add/edit tools and record transfers.
- **Admins** can also manage workshops and people, and delete tools.
- The **transfer log is append-only** — nobody, including admins, can edit or delete a past transfer
  from the app. Moving a tool always happens by adding a new transfer record, so the history can
  never be rewritten, only added to.
- Inactive accounts are blocked from signing in entirely, even with a correct password.

## What's in this folder

| File | Purpose |
|---|---|
| `schema.sql` | Database tables, triggers, and security rules — run once in Supabase |
| `index.html` | Page structure |
| `style.css` | Visual design |
| `app.js` | All app behavior (login, loading data, tool/transfer actions) |

## Extending it later

Some natural next steps if you want them, all doable on this same foundation:
- QR code per tool (print a tag, scan to jump straight to that tool's page)
- Email alerts when a tool sits in "in maintenance" too long
- CSV export of the transfer log
- Photos attached to each tool

Just let me know which of these would help and I can build it into the app.
