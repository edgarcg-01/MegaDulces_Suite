/*
 * Sonda de carga de una pantalla en PROD, desde un navegador real.
 *
 * Nació persiguiendo el "se cuelga /comercial": los logs del servidor decían que todo
 * respondía en milisegundos y la pantalla igual se sentía trabada. Esto mide del lado
 * del usuario — segundo a segundo, cuántas peticiones siguen abiertas, cuántos
 * esqueletos quedan y qué título se ve — que es lo único comparable con lo que sufre
 * quien reporta el problema.
 *
 * Uso (las credenciales NUNCA van en el archivo):
 *   npx playwright install chromium          # una sola vez
 *   MSYS_NO_PATHCONV=1 PW_USER=<u> PW_PASS=<p>  *     node scripts/probe-command-center.js "/comercial/command-center" 40
 *
 * OJO en Git Bash: sin MSYS_NO_PATHCONV=1 la ruta "/comercial/..." se convierte en un
 * path de Windows y la sonda navega a cualquier lado.
 */
const { chromium } = require('playwright');

const BASE = 'https://megadulces.up.railway.app';
const U = process.env.PW_USER;
const P = process.env.PW_PASS;
const TARGET = process.argv[2] || '/comercial/command-center';
const WATCH_S = Number(process.argv[3] || 45);

(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();

  const console_ = [];
  const inflight = new Map();
  const done = [];
  p.on('console', (m) => console_.push(`${m.type()}: ${m.text().slice(0, 200)}`));
  p.on('pageerror', (e) => console_.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
  p.on('request', (r) => inflight.set(r, { url: r.url().replace(BASE, ''), t0: Date.now() }));
  p.on('requestfinished', async (r) => {
    const e = inflight.get(r); if (!e) return; inflight.delete(r);
    let st = ''; try { st = String((await r.response())?.status() ?? ''); } catch { /* ya cerrada */ }
    done.push({ ...e, ms: Date.now() - e.t0, st });
  });
  p.on('requestfailed', (r) => {
    const e = inflight.get(r); if (!e) return; inflight.delete(r);
    done.push({ ...e, ms: Date.now() - e.t0, st: 'FAIL ' + (r.failure()?.errorText || '') });
  });

  console.log('1) login…');
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  const userSel = (await p.locator('#username').count()) ? '#username' : 'input[type="text"]';
  await p.fill(userSel, U);
  await p.fill('#password', P);
  await Promise.all([
    p.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60000 }).catch(() => {}),
    p.click('button[type="submit"]'),
  ]);
  await p.waitForTimeout(4000);
  console.log('   tras login:', p.url().replace(BASE, ''));

  // Contador de cuadros: mide si la interfaz sigue viva.
  await p.addInitScript(() => { /* no-op: se instala abajo por evaluate */ });
  await p.evaluate(() => {
    const w = window;
    w.__f = { frames: 0, maxGap: 0, last: performance.now() };
    const tick = () => {
      const n = performance.now(); const d = n - w.__f.last;
      if (d > w.__f.maxGap) w.__f.maxGap = d;
      w.__f.last = n; w.__f.frames++; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  console.log(`2) navegando a ${TARGET} y observando ${WATCH_S}s…`);
  done.length = 0;
  const tNav = Date.now();
  p.goto(BASE + TARGET, { waitUntil: 'commit', timeout: 120000 }).catch((e) => console.log('   goto:', e.message));

  for (let s = 1; s <= WATCH_S; s++) {
    await p.waitForTimeout(1000);
    let fps = -1, gap = -1, skel = -1, txt = '';
    try {
      const r = await p.evaluate(() => {
        const w = window;
        const f = w.__f ? w.__f.frames : -1;
        const g = w.__f ? Math.round(w.__f.maxGap) : -1;
        if (w.__f) { w.__f.frames = 0; w.__f.maxGap = 0; }
        const sk = document.querySelectorAll('p-skeleton,.p-skeleton,[class*=skeleton]').length;
        const t = (document.querySelector('h1')?.textContent || '').trim().slice(0, 40);
        return { f, g, sk, t };
      }, { timeout: 3000 });
      fps = r.f; gap = r.g; skel = r.sk; txt = r.t;
    } catch (e) { txt = 'EVALUATE BLOQUEADO: ' + String(e.message).slice(0, 60); }
    const pend = [...inflight.values()].filter((x) => Date.now() - x.t0 > 1500);
    console.log(
      `  t+${String(s).padStart(2)}s  fps=${String(fps).padStart(3)}  saltoMax=${String(gap).padStart(5)}ms  ` +
      `skeletons=${String(skel).padStart(3)}  pendientes=${String(pend.length).padStart(2)}  h1="${txt}"`,
    );
    if (pend.length && s % 5 === 0) pend.slice(0, 4).forEach((x) => console.log(`        ⏳ ${Date.now() - x.t0}ms  ${x.url.slice(0, 90)}`));
  }

  console.log(`3) total navegación observada: ${Date.now() - tNav}ms`);
  const api = done.filter((d) => d.url.includes('/api/')).sort((a, b) => b.ms - a.ms);
  console.log('   API (top 15 por duración):');
  api.slice(0, 15).forEach((d) => console.log(`     ${String(d.ms).padStart(6)}ms ${String(d.st).padStart(4)}  ${d.url.slice(0, 80)}`));
  console.log(`   assets: ${done.filter((d) => !d.url.includes('/api/')).length} · aún pendientes: ${inflight.size}`);
  if (inflight.size) [...inflight.values()].slice(0, 10).forEach((x) => console.log(`     ⏳ ${x.url.slice(0, 90)}`));

  console.log('   consola (últimas 25):');
  console_.slice(-25).forEach((c) => console.log('     ', c));

  await p.screenshot({ path: '.tmp-pw/shot.png', fullPage: false }).catch(() => {});
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
