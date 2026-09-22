# Pick Check bridge

Connects the Pick Check gun app to Cultivera Pro. The picker types (or scans) an order number on the
Zebra; the bridge looks the order up in Cultivera and returns every line with its allocated lot
barcodes and units. Nothing is copied or pasted.

> Moving the bridge to another PC? Follow **MOVE-TO-NEW-PC.md** in this folder.

## One-time setup (on the PC that will stay on)

1. Install **Node.js LTS** from https://nodejs.org (accept the defaults).
2. Copy `config.example.json` to `config.json` and fill in:
   - `cultiveraUsername` / `cultiveraPassword`: a Cultivera Pro login for the bridge. A dedicated
     user with read access to Fulfillment is best, so nobody's personal password sits in a file.
   - `port`: leave at 8080 unless something else uses it.
   - `accessKey`: optional. If set, the gun asks for it once and remembers it.
3. Double-click `start.cmd`. It prints the address to open on the gun, e.g. `http://192.168.1.25:8080/`.
4. Optional: double-click `install-autostart.cmd` so the bridge starts by itself at Windows login.

Give the PC a fixed IP (or a DHCP reservation on the router) so the gun's bookmark never changes.
Windows may ask to allow Node through the firewall the first time: allow it on **Private** networks.

## On the gun

Open Chrome, go to the bridge address, and add it to the home screen. That is the whole install.

DataWedge (pre-installed on Zebra Android devices) types each scan into the page as keystrokes.
The app accepts a scan with or without a trailing Enter, so the default profile works as shipped.
If the gun beeps but nothing happens on screen, check DataWedge > Profile0 > **Keystroke output**
is enabled, and that under **Decoders** the QR Code decoder is on.

## What the bridge calls in Cultivera

| Purpose | Endpoint |
|---|---|
| Sign in | `POST /api/v1/auth/sign-in` (JWT, valid about a day; re-login is automatic) |
| Order number to id | `GET /api/v1/orders/get-order-by-number/{orderNo}` |
| Pick list | `GET /api/v1/fulfillment/order-pick-list/{id}` |
| Search (optional) | `POST /api/v1/orders/find-order-numbers` |

These are the same calls Cultivera's own web app makes. They are not a published API, so a Cultivera
update could change them; if the bridge starts logging errors, that is the first place to look.

## Publishing it as https://oleumorders.com

The bridge stays on the warehouse PC. A free Cloudflare Tunnel makes it reachable from anywhere
with HTTPS, and the app is protected by a shared password. The site uses its own domain,
**oleumorders.com**, registered at Cloudflare (about $10/year). **oleumlabs.com is not involved**:
its DNS stays at GoDaddy and no record on it is touched.

1. In `config.json`, set `"appPassword"` to the team password everyone will use to sign in.
   (While it is empty the app is open to anyone on the LAN, which is fine for local testing only.)
2. Cloudflare dashboard > **Domain Registration** > Register domains > `oleumorders.com`.
   A domain registered at Cloudflare is automatically a zone in the account, which is all the
   tunnel needs.
3. Right-click `setup-tunnel.cmd` > **Run as administrator**. It installs `cloudflared`, opens a
   browser for you to sign in to Cloudflare (choose the **oleumorders.com** zone), creates a tunnel
   named `pickcheck`, adds DNS records for `oleumorders.com` and `www.oleumorders.com`, and installs
   the tunnel as a Windows service so it starts with the PC.
4. Keep `start.cmd` running (or run `install-autostart.cmd` once). About a minute later,
   https://oleumorders.com works on any phone or PC. Sign-ins last 30 days per device.
5. Optional: at GoDaddy, forward `orders.oleumlabs.com` to `https://oleumorders.com` (Domain >
   Forwarding > Subdomain). That is a redirect only; it changes nothing else on oleumlabs.com.

To change the address later, edit `HOSTNAME` at the top of `setup-tunnel.cmd` and rerun it.
To revoke every signed-in device at once, delete `bridge\data\sessions.json` and restart the bridge.

(Moving oleumlabs.com itself to Cloudflare was ruled out: several other sites and the email
records live on that domain and Cloudflare's import missed some of them. ngrok was ruled out on
price: its bring-your-own-domain plan is $20/month.)

## Opening an order without typing

Cultivera's printed pick list has no barcode, so the app offers these ways to open an order
without typing:

- **Photo of pick list** (home screen button). The camera opens with a wide box; fit the top of
  the printed sheet ("PICK LIST # 15685") in it and tap **Read order number**. The number is read
  off the paper on the phone itself (no cloud service), the app confirms it against Cultivera and
  shows the customer name, and **Open order** loads it. If the pick list was printed from the
  bridge (below) its QR code is read automatically, no tap needed. First use downloads the text
  reader (about 7 MB) from the bridge; after that it is cached.
- **Scan any package on the order.** On the home screen, scanning a lot barcode (a package label
  or a lot tag) looks the lot up across all open orders and opens the matching order. If the same
  lot is allocated to several open orders, the app lists them to choose from.
- **Print the bridge's pick list.** Open `https://oleumorders.com/picklist/15685` (or tap
  **Print pick list** on the order screen) for a printable pick list that matches Cultivera's but
  adds a **QR code of the order number** and the **slot location** for every line.

The order-number box stays on the home screen for typing. (`/api/open-orders` still lists the
orders waiting to be picked, for any future office page.)

## Scanning with a phone camera (backup for the Zebra)

On any phone, the pick screen has a **Camera** button and the home screen has **Scan order
barcode with camera**. The phone's camera reads Code 128, QR, EAN/UPC, Code 39, Data Matrix and
ITF labels and feeds them into the same checks as the Zebra's scanner. It uses the browser's
built-in barcode detector when available and otherwise a decoder bundled at
`bridge\static\zxing.min.js`, so nothing is fetched from third-party sites.

- Camera access only works on a secure address: https://oleumorders.com (or http://localhost).
  On the plain LAN address browsers refuse to open the camera, and the buttons are hidden.
- The first time, the phone asks to allow the camera; if it was refused, iPhone: Settings > Safari
  > Camera > Allow, then reload.
- The scanner keeps running between units; the same label held in view is counted once. Tap
  **Done** to close it. A **Light** button appears on phones whose torch can be controlled.
- The labels are small QR codes, so the scanner is tuned for them: it asks for the highest camera
  resolution, starts at 2x zoom on phones that allow zoom control (a **Zoom** slider appears), and
  decodes an enlarged crop of the square target box. Hold the phone 4-6 inches away and fill the box
  with the code; the phone cannot focus closer than that, so zoom in rather than moving closer.

## Item locations from the Inventory Key spreadsheet

The bridge reads `Inventory Key.xlsx` and shows a slot (e.g. `HC 01`) on every pick-list line it
can match. Matching uses the tab's **Item Name** (the strain) plus **Product Type** against the
Cultivera product name, so "GSC" on the Honey Crystal tab and "GSC" on the Live Resin tab each go to
the right product. The `locations` block in `config.json` controls it:

- `file`: the workbook's path on the bridge PC, if OneDrive is synced there with the work account
  (e.g. `C:/Users/<user>/OneDrive - OLEUMLABS/Inventory Key.xlsx`; forward slashes are fine). The
  bridge re-reads the file whenever it changes.
- `url` (instead of `file`): a OneDrive **"Anyone with the link"** share link to the workbook. The
  bridge downloads it itself every `refreshMinutes` (default 5), so no OneDrive sign-in is needed on
  the bridge PC. This is the setup used on the warehouse PC, whose OneDrive is a personal account
  that cannot sync a business file. The bridge adds `download=1` and follows SharePoint's redirects
  with cookies; a 403 means the link is not set to "Anyone with the link".
- `sheets`: the tabs that are mapped. Unmapped tabs are ignored until you add them here.
- `overstockOnlyTypes`: product families with no fixed slot. These get a location only when the
  Overstock tab lists them, otherwise the line shows no location. Samples are treated the same way.
- If a product is on its regular tab *and* on Overstock, both show, e.g. `HC 01 · OS 12`.
- `barcodeColumn` (the sheet's **Barcode** column): when a lot's barcode is on the sheet, that row's
  slot wins outright, per lot. Full barcodes or just their last 4+ digits both work.
- **Nothing matched?** The line shows its product line as the location, e.g. `Liquid Diamond` or
  `Live Resin Cartridge` (the product name minus strain, size and pack), so the picker still knows
  which section to go to. The gun shows these in a dimmer style than real slots.

Order of precedence: barcode on the sheet, then item name + type, then the product-line fallback.

`/api/health` reports whether the workbook loaded and how many rows each tab contributed.

## If the warehouse PC goes down

What still works: any order already loaded on the gun can be picked to the end (the gun keeps the
order and queues its log locally, and sends the log when the bridge is back). What stops: opening
new orders, locations, reports.

Failover, about two minutes on any Windows PC that has this folder with a `config.json` and the
tunnel files in `%USERPROFILE%\.cloudflared` (Annie's laptop has both):

1. Right-click `takeover.cmd` > Run as administrator. It starts the bridge, installs and starts
   the tunnel service, and prints the tunnel's connections. oleumorders.com then works again.
2. When the warehouse PC is back and its bridge answers, run `standdown.cmd` (as administrator)
   on the stand-in PC so only one machine serves.

Nothing on the warehouse PC is unique: the code is on GitHub, the workbook is a share link, and
the tunnel identity is the three `.cloudflared` files. Keep a copy of `config.json` and those three
files somewhere safe (they hold passwords; not in GitHub). The one thing that lives only on the
serving PC is the pick history in `bridge\data\`; download it now and then from the reports page
(Download CSV) if it matters.

For a setup that does not depend on any office PC at all, the bridge can run on a small cloud
server (about $5/month) with exactly the same files; the gun would not notice the difference.

## Pages

- `/` the pick app (gun, phone)
- `/reports` pick numbers, orders, shortages reported from the gun, event log
- `/admin` bridge software (version, update, roll back), shortage email settings, ERP link
- `/picklist/<orderNo>` printable pick list with QR code and locations

## Shortages: what the picker does, what the office gets

1. The picker scans what can be found, taps the line → **Mark line short (can't find the rest)** →
   confirms "found 5 of 8". The line counts as done on the gun.
2. The bridge immediately emails the office: order, customer, product, lot barcode, ordered/found,
   picker, and a link to the order in Cultivera. It appears on the reports page under **Shortages
   reported from the gun** until withdrawn.
3. The picker finishes the order as usual. **Finish** with only short lines gives "Complete with N
   short lines" (the order is done on the gun) and, if the ERP link is on, the order is marked
   Picked in the ERP with a `SHORT (gun): …` note. No second email; the finish shows in the
   event log on the reports page.
4. The office adjusts the quantity in Cultivera. If the picker still has the order open,
   **Refresh from Cultivera** pulls the new quantity and the line shows complete.

Lines that are neither picked nor marked short show as MISSING and block Finish until resolved.

Email setup: reports page → **Shortage emails → Settings**. Any SMTP mailbox works; the simplest
is a Gmail address with an app password (server `smtp.gmail.com`, port 465). Enter the recipient(s),
tick Enabled, Save, then **Send test email**. Settings are stored under `notify` in `config.json`.

## ERP link: mark orders Picked on the deliveries page

When the gun completes an order (every unit scanned, or Finish & verify, per the setting), the
bridge marks that order **Picked** on production.oleumlabs.com → Sales → Deliveries, exactly as the
page's own "Mark picked" button does: `crm_deliveries.pick_status = 'picked'`, `picked_at = now`,
`updated_by = <ERP account>`. Only orders already on that calendar are touched; others are logged as
skipped. Orders already Picked / Picked up are left alone. (The ERP stores order numbers as text
such as `ORD - 15759`; the bridge matches on the digits, so any of those spellings work.)

Set it up on the reports page → **ERP link → Settings**: enter an ERP email + password (an account
that is allowed to edit deliveries), tick Enabled, Save, then **Test connection**. The login is
stored in `config.json` under `erp` on the bridge PC; nothing is typed on that PC. The same panel
can check an order's ERP status or mark one by hand. Each attempt is recorded in the event log as
`erp_marked` / `erp_failed`.

How it authenticates: Supabase password sign-in to the ERP project, then the ERP's
`crm-read-session` function issues a CRM-project token (the deliveries table lives in the CRM
project); the update is a PostgREST PATCH with that token. Project URLs and anon keys are the public
ones embedded in the ERP site; they are defaults under `erp` in config and can be overridden.

## Updating the bridge from GitHub

The code lives in a GitHub repository. The bridge can fetch the latest version itself, so changes
made on the laptop never have to be copied to the warehouse PC by hand.

- `config.json` → `"updates": { "repo": "owner/pickcheck", "branch": "main", "token": "..." }`.
  `token` is a fine-grained GitHub token with **Contents: read** on that repository (needed only
  if the repository is private).
- **Automatic by default.** The bridge checks GitHub every 10 minutes and installs a pending
  update once the gun has been idle for 15 minutes (`"idleMinutes"` to change). Alternatives:
  `"auto": "hour", "autoHour": 3` installs only at that hour; `"auto": "manual"` only via the
  reports page. Either way the reports page still shows the version and offers Update now / Roll back.
- Reports page → **Bridge software** panel shows the running version and whether an update is
  available. **Update now** downloads the latest commit, verifies the new server files load, saves
  the current files under `bridge\backup\previous`, swaps the files in and restarts (about 10
  seconds; picking progress on the gun is kept). **Roll back** restores the saved files.
- Only app code is replaced (`pickcheck.html`, `bridge\*.js`, `*.html`, `*.cmd`, `static\`).
  `config.json`, `data\` and `logs\` are never touched. `bridge\VERSION` records what is installed.
- Workflow from the laptop: edit → `git commit` → `git push`. The warehouse installs it by itself
  at the next idle moment; Update now on the reports page only if you want it sooner.

## Pick tracking and reports

Every action on the gun (order loaded, each scan, rejected scans, counts entered, lines marked
short, order verified) is sent to the bridge with a timestamp and the picker's name, and appended to
`bridge\data\picks-YYYY-MM-DD.csv` (one file per day, opens in Excel). If the gun loses Wi-Fi the
events queue on the gun and send when it reconnects.

- **Reports page:** open `http://<bridge-pc>:8080/reports` on any PC or phone. Shows orders verified,
  units picked, scans, rejected scans and average minutes per order, by day and by order, plus the
  full event log. Today / 7 days / 30 days / custom range, and a Download CSV button.
- The picker's name comes from `pickerName` in `config.json` and can be changed on the gun's home
  screen (tap Change next to the name).

## Bridge API (used by the gun app and the reports page)

- `GET /api/health` - bridge and Cultivera session status
- `GET /api/order/15537` - normalized pick list for order 15537
- `GET /api/search?q=155` - order-number suggestions
- `POST /api/events` - `{ "events": [...] }` from the gun; appended to the daily CSV
- `GET /api/picks?from=2026-09-01&to=2026-09-08` - raw events as JSON (`/api/picks.csv` for a CSV download)
- `GET /api/stats?from=...&to=...` - totals, per-day rows and per-order rows for the reports page

## Security notes

- `config.json` holds a Cultivera password in plain text. Keep it on the bridge PC only; it is
  git-ignored. Use a dedicated Cultivera user with the minimum role that can view Fulfillment.
- The bridge serves order data to anyone on the LAN who knows the address. Set `accessKey` if the
  warehouse Wi-Fi is shared with guests.
