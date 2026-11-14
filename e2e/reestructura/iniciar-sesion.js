#!/usr/bin/env node
/**
 * `[GP.RF.0]` La PERSONA inicia sesión; el script sólo guarda el resultado.
 *
 *   node e2e/reestructura/iniciar-sesion.js <archivo-de-salida>
 *
 * Abre un Chromium VISIBLE en el login de prod. Quien audita escribe su usuario y contraseña ahí
 * (el script nunca los ve ni los pide). Cuando la app guarda `auth_token` y sale de /login, el
 * script escribe ese token en <archivo-de-salida> —que va FUERA del repo— y cierra. El token no
 * se imprime. Ese archivo es el `MD_TOKEN_FILE` de `paso0.e2e.ts`.
 *
 * Espera hasta 10 minutos; si nadie entra, sale sin escribir nada.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const salida = process.argv[2];
if (!salida) { console.error('uso: node iniciar-sesion.js <archivo-de-salida fuera del repo>'); process.exit(2); }
const raiz = path.resolve(__dirname, '..', '..');
if (path.resolve(salida).toLowerCase().startsWith(raiz.toLowerCase())) {
  console.error('⛔ El archivo de la sesión no puede quedar dentro del repo.'); process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto((process.env.E2E_BASE_URL || 'https://megadulcessuite.com') + '/login');
  await page.bringToFront();
  console.log('Navegador abierto en el login: inicia sesión ahí. Espero hasta 10 minutos…');
  const limite = Date.now() + 10 * 60_000;
  let aviso = Date.now();
  let token = '';
  while (Date.now() < limite) {
    token = await page.evaluate(() => {
      try { return location.pathname.startsWith('/login') ? '' : localStorage.getItem('auth_token') || ''; } catch { return ''; }
    }).catch(() => '');
    if (token) break;
    // Cada 30 s dice dónde está la página (nunca el token), para saber si se entró y no se detectó.
    if (Date.now() - aviso > 30_000) { aviso = Date.now(); console.log('esperando… la página está en ' + new URL(page.url()).pathname); }
    await page.waitForTimeout(1000);
  }
  if (!token) { console.error('Nadie inició sesión en 10 minutos: no se guardó nada.'); await browser.close(); process.exit(1); }
  fs.writeFileSync(salida, token, { mode: 0o600 });
  const carga = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  console.log(`Sesión guardada (rol: ${carga.rol ?? carga.role_name ?? 'sin rol en el token'}; vence: ${carga.exp ? new Date(carga.exp * 1000).toISOString() : 'sin dato'}).`);
  await browser.close();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
