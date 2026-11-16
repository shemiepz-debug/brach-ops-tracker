# Branch Ops Tracker: Railway server with sync (v1.16.0)

Files (all at the top level, no folders): `index.html`, `server.js`, `Dockerfile`, `package.json`, `railway.json`. No npm packages are needed.

## 1. Put it on GitHub
In your `brach-ops-tracker` repo: delete the old `Branch Ops Tracker.html`, then upload ALL of these files (no folders)
(Add file > Upload files, drag the contents of this zip, Commit). Railway rebuilds by itself.

## 2. In Railway (service settings)
1. **Variables**: add
   - `ACCESS_KEY` = a long secret you make up (20+ characters, e.g. three random words and digits). Without it the server refuses all data requests.
   - `DATA_DIR` = `/data`
2. **Volume**: right-click the canvas > Volume > attach to the service, mount path `/data`. Without a volume, data is lost on every redeploy.
3. **Networking**: Settings > Networking > Generate Domain.
4. Wait for the deploy to turn green. Open `https://YOUR-DOMAIN/api/ping` - it should show `{"app":"branch-ops-sync","configured":true}`.

## 3. Connect each device
Open the Railway address on the PC and the phone. The app asks for the access key (or: Settings > Sync between devices > Connect).
The first device uploads its data. Other devices merge theirs with it. A "Synced 14:32" chip in the header shows the state.
For the APK: Settings > Sync > Connect, then enter the same address and key.

## How sync behaves
- Works offline from the device's own storage; sends changes when the connection returns (checks every 8 seconds and after each save).
- Records are merged one by one. Edits to different records never overwrite each other. If two devices change the same record at once, the later save wins for it.
- Deleting a record, or a document, on one device deletes it on the others.
- Documents and photos sync too (60 MB max each).
- Device-only settings are not synced: theme, font size, compact mode, default branch, lock PIN and timeout, last-backup time.
- The server keeps a copy of its data once per day for 14 days in `/data/backups`.
- Wrong access keys are blocked for 10 minutes after 10 tries.

## Safety
The page itself is public, but all data is behind the access key. Treat the key like a password. To change it, change the variable in Railway and reconnect each device.
Still keep your own Full backups from the app now and then.
