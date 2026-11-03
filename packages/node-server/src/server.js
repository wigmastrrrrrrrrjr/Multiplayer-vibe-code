#!/usr/bin/env node
import { createApp } from './app.js';

const port = Number(process.env.MVC_PORT ?? process.env.PORT ?? 8787);
const host = process.env.MVC_HOST ?? '0.0.0.0';

const app = await createApp();
app.server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`mvc-server listening on http://${shown}:${port}`);
  console.log(`data dir: ${app.dataDir}`);
  if (app.registry.enabled) {
    console.log(`registry: ${app.registry.baseUrl} (set MVC_REGISTRY_URL=off to disable)`);
  } else {
    console.log('registry: disabled (local-only lobbies)');
  }
  console.log(`public URL: ${process.env.MVC_PUBLIC_URL ?? '(derived from request Host)'}`);
  console.log('\ncreate a lobby:  mvc-agent create my-project --server http://localhost:' + port);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: shutting down…`);
  await app.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
