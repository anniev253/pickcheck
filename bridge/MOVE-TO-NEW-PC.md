# Installing Pick Check on the warehouse PC

This package moves the bridge (and https://oleumorders.com) from Annie's laptop to the warehouse
PC. Everything needed is inside. Allow about 20 minutes; most of it is waiting on installers.

Contents:
- `bridge\`         the server, its config (Cultivera login + team password), and pick history
- `pickcheck.html`  the app the gun and phones load
- `cloudflared\`    the tunnel's identity (3 files). Copying these moves oleumorders.com to the new
                    PC with no DNS or Cloudflare changes.

## On the warehouse PC

1. Install **Node.js LTS** from https://nodejs.org (accept the defaults).

2. Install **OneDrive** if it is not there, sign in with the work account, and make sure
   `Inventory Key.xlsx` syncs down (open it once from the OneDrive folder). The bridge finds it in
   any OneDrive folder of the account it runs under.

3. Put the files in place:
   - Create `C:\PickCheck` and copy `pickcheck.html` and the whole `bridge` folder into it, so you
     have `C:\PickCheck\pickcheck.html` and `C:\PickCheck\bridge\server.js`.
   - Create the folder `C:\Users\<warehouse user>\.cloudflared` (note the leading dot) and copy the
     3 files from `cloudflared\` into it.

4. Open `C:\PickCheck\bridge\config.json` in Notepad and set `"pickerName"` to the picker's real
   name. Leave everything else as it is (the Cultivera login and team password are already filled in).

5. Right-click `C:\PickCheck\bridge\install-service.cmd` > **Run as administrator**.
   It installs the bridge as a Windows service that starts at boot, before anyone logs in, and
   restarts itself if it ever crashes. It asks for the Windows password of the account you are
   logged in as (needed so the service can read that account's OneDrive folder).
   If Windows Firewall asks about Node.js, allow it on **Private** networks.

6. Right-click `C:\PickCheck\bridge\setup-tunnel.cmd` > **Run as administrator**.
   Because the tunnel files were copied in step 3, it does not ask you to sign in to Cloudflare; it
   installs cloudflared and registers the tunnel as a service. (If a browser window does open, sign
   in and choose the **oleumorders.com** zone.)

7. Test, in this order:
   - On the PC: http://localhost:8080/ shows the Oleum Orders sign-in page.
   - On a phone over cellular: https://oleumorders.com signs in and loads an order.
   - On the gun over Wi-Fi: same address, then a trigger pull on a package counts a unit.

8. Housekeeping worth doing while you are at the PC:
   - Give it a fixed IP or a DHCP reservation on the router.
   - Windows Update > Advanced options > **Active hours**: cover the picking day so update
     reboots happen at night.
   - Delete this package from the USB stick or shared folder: `config.json` holds passwords.

## On the laptop, once the warehouse PC is serving

Stop the laptop's copies so the two never compete for oleumorders.com:
- Close the "Pick Check bridge" window (or, if the service was installed there, `nssm remove PickCheck confirm`).
- Remove the tunnel service: `"C:\Program Files (x86)\cloudflared\cloudflared.exe" service uninstall`

## If something is off

- **502 at oleumorders.com**: the tunnel is up but the bridge is not. Run `nssm status PickCheck`
  and read `C:\PickCheck\bridge\logs\bridge.log`.
- **Error 1033 at oleumorders.com**: the tunnel service is not connected. Run
  `bridge\fix-tunnel-service.cmd` as administrator.
- **Health check says locations: spreadsheet not found**: OneDrive is not synced for the account
  the service runs as. Sign in to OneDrive as that user, or set the full path to the workbook in
  `config.json` under `locations.file`.
- **Cultivera login failed**: the Cultivera account's password changed. Update `config.json`, then
  `nssm restart PickCheck`.
- `start.cmd` still works for troubleshooting (shows the log live), but stop the service first:
  `nssm stop PickCheck`, then double-click `start.cmd`. Both cannot run at once.
