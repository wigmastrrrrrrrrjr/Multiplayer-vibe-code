// M1: Electron tray app — hosts the real sync engine. Joining still happens via
// the CLI (`mvc-agent join <token>`); the tray gains join/approve UI in M2+.
import { app, Tray, Menu, nativeImage } from 'electron';
import { join } from 'node:path';
import { SyncEngine } from './sync/engine.js';
import { applyUpdate, checkForUpdate, readManagedMeta } from './update/updater.js';

// 1x1 PNG so the tray icon is valid on Windows / Ubuntu / Linux.
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LOBBY_HOME =
  process.env.LOBBY_HOME || join(app.getPath('home'), 'Lobbies');

let tray = null;

app.whenReady().then(() => {
  const icon = nativeImage.createFromDataURL(ICON_DATA_URL);
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: `Lobbies: ${LOBBY_HOME}`, enabled: false },
    { type: 'separator' },
    { label: 'Join lobby… (use: mvc-agent join <token>)', enabled: false },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setToolTip('multiplayer vibe code');
  tray.setContextMenu(menu);

  const engine = new SyncEngine({
    serverUrl: process.env.MVC_SERVER_URL,
    lobbyHome: LOBBY_HOME,
    log: console,
  });

  engine.on('close', ({ code, reason }) => {
    console.warn(`[engine] ws closed (${code}${reason ? ` ${reason}` : ''})`);
  });

  app.on('before-quit', () => {
    engine.closeAll();
  });

  // Self-hosted auto-update: check once per 24h. With MVC_AUTO_UPDATE=1 the
  // new source is downloaded, verified and linked automatically; otherwise the
  // newest sha is logged so `mvc-agent update` can be run manually.
  autoUpdateCheck(process.env.MVC_SERVER_URL);
});

const UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000;

async function autoUpdateCheck(serverUrl) {
  if (!serverUrl) return;
  const meta = await readManagedMeta();
  const last = meta?.installedAt ? new Date(meta.installedAt).getTime() : 0;
  if (Date.now() - last < UPDATE_THROTTLE_MS) return;
  try {
    const res = await checkForUpdate({ serverUrl });
    if (!res.available) return;
    if (process.env.MVC_AUTO_UPDATE === '1') {
      await applyUpdate({ serverUrl, log: console.log });
      console.log(`[updater] auto-updated to ${res.latest.slice(0, 12)}`);
    } else {
      console.log(`[updater] update available (${res.latest.slice(0, 12)}…) — run: mvc-agent update`);
    }
  } catch (err) {
    console.warn(`[updater] check failed: ${err.message}`);
  }
}