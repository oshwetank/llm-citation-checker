# CitoSkeleton server

These are the accounts, update emails and shared campaigns for the extension, added in 0.82.0. The server runs on Vercel functions, with Node 20 and no npm dependencies, in front of Supabase (Postgres, Auth and Storage).

The extension works without it. Until `src/lib/cloudConfig.js` is filled in:
- campaigns are shared as `.cito` files;
- update emails stay on the computer that collected them;
- Settings says "Accounts aren't switched on yet".

## What it does

| Endpoint | Who | What |
|---|---|---|
| `POST /api/subscribe` | anyone | Takes an email for update news. Checks the address shape, refuses burner inboxes, and checks the domain has an MX record. Returns an unsubscribe token. |
| `POST /api/unsubscribe` | holder of the token | Stops update news. |
| `GET/POST /api/profile` | signed in | Reads or sets the display name shown on shared campaigns. |
| `POST /api/share` | signed in | Starts a share and returns a 10-character code plus a one-time upload address. The extension uploads the file straight to storage, then confirms with `?done=1`. |
| `GET /api/share?code=` | signed in | Returns a short-lived download address for that campaign. |
| `GET /api/share` | signed in | Lists what I've shared. |
| `DELETE /api/share?code=` | the owner | Stops sharing and deletes the file. |

Sign-in is Supabase Auth with an emailed code, and it has no password. The extension calls Supabase's `/auth/v1/otp` and `/auth/v1/verify` directly with the public anon key. Everything else goes through these functions, which hold the service key.

Files go straight to Storage because a Vercel function accepts at most 4.5 MB per request, and a campaign can be up to 25 MB.

The limits:
- 25 MB per campaign;
- 50 live shares per person;
- shares expire after 90 days.

## Set it up (the owner's steps)

1. **Supabase.** Create a project at supabase.com.
   - In **SQL editor**, run `supabase/schema.sql`.
   - In **Authentication → Providers → Email**, keep Email on and turn on "Confirm email".
   - In **Authentication → Email templates → Magic link**, put the code in the message: `Your CitoSkeleton code is {{ .Token }}`. The extension asks for the 6-digit code, not a link.
   - For real volume, set up a custom SMTP sender under **Authentication → SMTP**. Supabase's built-in sender is rate-limited.
2. **Vercel.** Create a project from this repository with **Root directory** `server`. The framework preset is "Other", with no build command.
3. **Environment variables** (Vercel → Settings → Environment Variables):
   - `SUPABASE_URL`: `https://<project>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: from Supabase → Settings → API. Keep it secret: it never goes into the extension.
   - `EXTENSION_IDS` (optional, recommended): the Chrome Web Store id, so only the published extension is answered. Unpacked copies have other ids; leave it empty while testing.
   - `ALLOWED_ORIGINS` (optional): web origins allowed too, comma-separated.
4. **Deploy**, then fill in `src/lib/cloudConfig.js`:
   - `apiBase`: the Vercel address;
   - `supabaseUrl`;
   - `supabaseAnonKey`: Settings → API → anon public.

   Reload the extension.

## Privacy

- Nothing is sent until someone signs in, shares a campaign, opens a code, or leaves an email for updates.
- Captures are never sent, only a campaign someone chose to share.
- Subscriber emails are readable only with the service key, so only by the developer. They are never sold or shared with third parties.

## Tests

`node test/server-api.test.mjs` from the repository root calls each handler with Supabase, DNS and the clock stubbed (`lib/deps.js`). It needs no network.
