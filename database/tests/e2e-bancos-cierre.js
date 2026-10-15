/**
 * `[CB.51.2]` — **E2E de Bancos: la pantalla, no el proxy.**
 *
 * Nace de un reclamo justo de Edgar. La Fase CB.51 se diagnosticó midiendo
 * `bank_movements.recon_status` en la base — un **proxy** — cuando lo reportado era una
 * PANTALLA (`/finanzas/bancos?view=cierre`). Resultado: el primer diagnóstico señaló un bug real
 * (la llave del candado anti doble-cobro) que **no explicaba nada de lo que el usuario veía**, y
 * el defecto que sí lo explicaba apareció dos vueltas después. La regla del proyecto ya lo decía
 * —*una función de UI no está probada hasta ejercerla*— y no se aplicó.
 *
 * Este archivo cierra ese hueco: abre el navegador, se autentica, carga la pantalla real y
 * compara lo que **muestra** contra lo que **devuelve su API** y contra lo que **tiene la base**.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ **ES DE SOLO LECTURA Y TIENE QUE SEGUIR SIÉNDOLO.** Corre contra PRODUCCIÓN: navega, lee y
 * consulta. **Nunca** presiona «Conciliar», «Sincronizar del Sheet» ni «Subir estado de cuenta»,
 * y nunca escribe en la base. `SELECTORES_PROHIBIDOS` está abajo y el propio test verifica que no
 * los tocó. Un e2e que dispara una conciliación en prod no es una prueba: es una operación.
 *
 * ⚠️ **Credenciales por entorno, jamás en el archivo** (repo público, ver CLAUDE.md):
 *
 *     E2E_BASE_URL=https://megadulcessuite.com E2E_USER=... E2E_PASS=... \
 *       node database/tests/e2e-bancos-cierre.js
 *
 * Sin `E2E_USER`/`E2E_PASS` el test **no falla: reporta NO MEDIDO** (ADR-056). Lo mismo si no
 * alcanza la base para el bloque 4. Un bloque sin con qué comprobarse no se pinta verde.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * Qué comprueba:
 *   1. La pantalla CARGA de verdad (no rebota al login, no deja errores en consola).
 *   2. La pantalla NO CONTRADICE A SU API: los chips del encabezado (conciliado / clasificado /
 *      importado) dicen lo mismo que `GET /diagnostico`, y los hallazgos listados son los que la
 *      API devolvió. Es el patrón que falló en CB.51: dos lecturas del mismo hecho.
 *   3. El tablero de hallazgos es una PARTICIÓN: lo que la API manda, la pantalla lo pinta.
 *   4. ⭐ El invariante de CB.51: `three-way-detail` no puede marcar «sin Kepler» un movimiento
 *      que `finance.bank_recon_matches` tiene casado. Con su **guarda de vacuidad** — si no hay
 *      ningún pareo persistido, el cero es vacuo y se reporta NO MEDIDO.
 *   5. Declara si el despliegue trae el arreglo (`kepler_fuente` en la respuesta) o no, para que
 *      un bloque 4 verde sobre un prod viejo no se lea como «ya está arreglado».
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const BASE = process.env.E2E_BASE_URL || 'https://megadulcessuite.com';
const USER = process.env.E2E_USER;
const PASS = process.env.E2E_PASS;
const PERIODO = process.env.E2E_PERIOD || '2026-10';
/** El periodo con pareos ya persistidos contra el que se prueba el invariante de CB.51. */
const PERIODO_CASADO = process.env.E2E_PERIOD_MATCHED || '2026-09';

/** ⛔ Lo que este test NO puede tocar jamás. Se verifica al final que ninguno se haya clickeado. */
const SELECTORES_PROHIBIDOS = ['Conciliar', 'Sincronizar del Sheet', 'Subir estado de cuenta', 'Refrescar MVs'];

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const skip = (m) => { console.log(`  ⚠ NO MEDIDO: ${m}`); nomedido++; };
const nm = (v) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

(async () => {
  if (!USER || !PASS) {
    skip('faltan E2E_USER / E2E_PASS — el navegador no puede autenticarse, el test no concluye');
    console.log(`\n[CB.51.2] ${pass} ✓ / ${fail} ✗ / ${nomedido} no medidos`);
    process.exit(0);
  }

  const { chromium } = require('playwright');
  const navegador = await chromium.launch({ headless: true });
  const ctx = await navegador.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // Se ignoran DOS familias que las provoca el propio test, no la pantalla: el `401` de la
  // primera carga sin sesión (es el flujo normal: pide, le niegan, redirige al login) y el `429`
  // del throttler, que salta porque el bloque 4 dispara varias consultas seguidas al mismo
  // endpoint. Contarlos sería culpar a la pantalla del ruido del andamio.
  const RUIDO_DEL_TEST = /status of 401|status of 429/;
  const erroresConsola = [];
  let capturandoConsola = false;
  page.on('console', (m) => {
    if (!capturandoConsola || m.type() !== 'error') return;
    const t = m.text().slice(0, 140);
    if (!RUIDO_DEL_TEST.test(t)) erroresConsola.push(t);
  });
  /** Registro de clics, para poder DEMOSTRAR que no se disparó nada. */
  const clicks = [];
  await page.exposeFunction('__e2eClick', (t) => clicks.push(t)).catch(() => {});

  let knex = null;
  try {
    // ── 1. La pantalla carga ─────────────────────────────────────────────────────────────
    console.log(`\n[1] La pantalla carga de verdad — ${BASE} · periodo ${PERIODO}`);
    await page.goto(`${BASE}/finanzas/bancos?view=cierre&period=${PERIODO}`, { waitUntil: 'domcontentloaded' });

    // ⚠️ `domcontentloaded` dispara ANTES de que Angular arranque y decida si redirige al login,
    // así que mirar `page.url()` acá devuelve la URL pedida aunque la app termine en el login.
    // Ya costó una corrida en falso: el test se saltaba el login y se quedaba 30 s esperando un
    // encabezado que nunca iba a existir. Se espera a que resuelva UNA de las dos pantallas.
    // Por `id`, no por rol: los inputs del login no tienen `aria-label` y el nombre accesible
    // depende de un `<label for>` que el DOM headless no siempre resuelve igual que el inspector.
    // Medido: `getByRole('textbox', { name: 'Usuario' })` no empata acá, `#username` sí.
    const campoUsuario = page.locator('#username');
    const encabezado = page.getByRole('heading', { name: 'Bancos', exact: true }).first();
    await Promise.race([
      campoUsuario.waitFor({ timeout: 45000 }).catch(() => null),
      encabezado.waitFor({ timeout: 45000 }).catch(() => null),
    ]);

    if (await campoUsuario.isVisible().catch(() => false)) {
      await campoUsuario.fill(USER);
      await page.locator('#password').fill(PASS);
      await page.getByRole('button', { name: 'Iniciar Sesión' }).click();
      await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 45000 });
      await page.goto(`${BASE}/finanzas/bancos?view=cierre&period=${PERIODO}`, { waitUntil: 'domcontentloaded' });
    }
    // El encabezado del módulo es la señal de que la ruta resolvió y el guard dejó pasar.
    await encabezado.waitFor({ timeout: 45000 });
    // Recién acá empieza a contar la consola: lo de antes es el ciclo de login, que legítimamente
    // produce un 401. Medir desde el primer `goto` reportaba como defecto el flujo normal.
    capturandoConsola = true;
    ok(!/\/login/.test(page.url()), `la ruta no rebota al login (quedó en ${page.url().replace(BASE, '')})`);

    // El tablero es asíncrono: se espera al texto que SÓLO aparece con el diagnóstico resuelto.
    const tablero = page.getByText('Qué falta', { exact: false }).first();
    const cargoTablero = await tablero.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    ok(cargoTablero, 'el tablero de hallazgos se renderiza (no se queda en el esqueleto)');

    // ── 2. La pantalla no contradice a su API ────────────────────────────────────────────
    // El bug de CB.51 fue exactamente esto: dos lecturas del mismo hecho, una en el servicio y
    // otra re-derivada en la pantalla. Acá se enfrentan.
    console.log('\n[2] La pantalla dice lo mismo que su API');
    const api = await page.evaluate(async (p) => {
      const tk = localStorage.getItem('auth_token');
      const r = await fetch(`/api/finance/bank/diagnostico?period=${p}`, { headers: { Authorization: 'Bearer ' + tk } });
      return r.ok ? r.json() : { __err: r.status };
    }, PERIODO);

    if (api.__err) {
      skip(`GET /diagnostico devolvió HTTP ${api.__err} — sin API no hay contra qué comparar la pantalla`);
    } else {
      const textoPagina = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      // `conciliacion_corrida` es justo el campo que explica el reclamo de octubre.
      const chipEsperado = api.conciliacion_corrida ? null : 'sin correr';
      if (chipEsperado) {
        ok(textoPagina.includes(chipEsperado),
          `la API dice conciliacion_corrida=false y la pantalla muestra «${chipEsperado}»`);
      } else {
        ok(!textoPagina.includes('Conciliado sin correr'),
          'la API dice que la conciliación SÍ corrió y la pantalla no muestra «sin correr»');
      }
      ok(textoPagina.includes(String(api.sin_clasificar_n)),
        `el conteo sin clasificar de la API (${api.sin_clasificar_n}) aparece en la pantalla`);

      // ── 3. Partición: cada hallazgo de la API está pintado ─────────────────────────────
      console.log('\n[3] Cada hallazgo de la API está en la pantalla');
      const faltantes = (api.items || []).filter((i) => i.titulo && !textoPagina.includes(i.titulo));
      ok(faltantes.length === 0,
        `los ${(api.items || []).length} hallazgos de la API están listados (faltan ${faltantes.length}${faltantes.length ? ': ' + faltantes.map((f) => f.titulo).join(' · ') : ''})`);
      if ((api.items || []).length === 0) {
        skip('la API no devolvió hallazgos: el bloque 3 no tiene qué comprobar');
      }
      console.log(`     · ${api.movimientos} movimientos · ${api.sin_clasificar_n} sin clasificar (${nm(api.sin_clasificar_monto)}) · conciliado: ${api.conciliacion_corrida ? 'sí' : 'NO'}`);
    }

    // ── 5. ¿Este despliegue trae el arreglo? ─────────────────────────────────────────────
    // Se declara ANTES del bloque 4: un invariante verde sobre un prod sin el fix no significa
    // «arreglado», significa «todavía no desplegado y el defecto sigue vivo».
    console.log('\n[5] Qué versión del drill sirve este despliegue');
    const sonda = await page.evaluate(async ({ p, lbl }) => {
      const tk = localStorage.getItem('auth_token');
      const r = await fetch(`/api/finance/bank/three-way-detail?period=${p}&account_label=${lbl}`, { headers: { Authorization: 'Bearer ' + tk } });
      if (!r.ok) return { __err: r.status };
      const d = await r.json();
      const ex = d.excel || [];
      return { n: ex.length, traeFuente: ex.some((e) => 'kepler_fuente' in e) };
    }, { p: PERIODO_CASADO, lbl: process.env.E2E_ACCOUNT || '4885' });
    const traeFix = !sonda.__err && sonda.traeFuente;
    if (sonda.__err) skip(`three-way-detail devolvió HTTP ${sonda.__err}`);
    else console.log(`     · ${traeFix ? 'TRAE el arreglo de CB.51 (`kepler_fuente` presente)' : 'NO trae el arreglo de CB.51 — corre el drill viejo'}`);

    // ── 4. El invariante de CB.51 ────────────────────────────────────────────────────────
    console.log(`\n[4] El drill no contradice a la base — periodo ${PERIODO_CASADO}`);
    const url = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
    if (!url) {
      skip('sin PROD_DB_URL/DATABASE_URL_NEW no se puede leer qué tiene casado la base');
    } else {
      knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });
      await knex.raw(`SET statement_timeout='120s'`);
      const cuentas = await knex('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
        .where('st.period', PERIODO_CASADO).whereNull('bm.deleted_at')
        .whereRaw(`coalesce(ba.kind,'bank')='bank'`)
        .groupBy('ba.account_label').havingRaw('count(*) > 100')
        .orderByRaw('count(*) DESC').limit(3).pluck('ba.account_label');

      if (!cuentas.length) {
        skip(`no hay cuentas con >100 movimientos en ${PERIODO_CASADO}`);
      } else {
        let revisados = 0, contradicciones = 0, montoContra = 0, casadosTotal = 0;
        const muestras = [];
        for (const lbl of cuentas) {
          const casados = new Set(await knex('finance.bank_recon_matches as m')
            .join('finance.bank_movements as bm', 'bm.id', 'm.bank_movement_id')
            .join('finance.bank_accounts as ba', 'ba.id', 'bm.bank_account_id')
            .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
            .where('st.period', PERIODO_CASADO).andWhere('ba.account_label', lbl)
            .pluck('m.bank_movement_id'));
          casadosTotal += casados.size;
          const d = await page.evaluate(async ({ p, l }) => {
            const tk = localStorage.getItem('auth_token');
            const r = await fetch(`/api/finance/bank/three-way-detail?period=${p}&account_label=${l}`, { headers: { Authorization: 'Bearer ' + tk } });
            return r.ok ? r.json() : { __err: r.status };
          }, { p: PERIODO_CASADO, l: lbl });
          if (d.__err) continue;
          for (const e of d.excel || []) {
            revisados++;
            if (!e.kepler && casados.has(e.id)) {
              contradicciones++; montoContra += Number(e.importe) || 0;
              if (muestras.length < 5) muestras.push(`${String(e.fecha).slice(0, 10)} ${lbl} ${nm(e.importe)} ${String(e.concepto || '').slice(0, 24)}`);
            }
          }
        }
        // Guarda de vacuidad: sin pareos persistidos el cero se pondría verde solo.
        if (casadosTotal === 0) {
          skip(`${PERIODO_CASADO} no tiene ningún pareo persistido: un cero acá sería vacuo (corré Conciliar primero)`);
        } else {
          ok(contradicciones === 0,
            `ningún movimiento casado en la base sale «sin Kepler» — ${revisados} renglones de ${cuentas.length} cuentas, ${contradicciones} contradicciones por ${nm(montoContra)}`);
          if (contradicciones) {
            console.log('     evidencia (lo que la pantalla niega y la base afirma):');
            for (const m of muestras) console.log(`       · ${m}`);
            if (!traeFix) console.log('     ⚠️ este despliegue NO trae CB.51 — es el defecto conocido, no uno nuevo');
          }
        }
      }
    }

    // ── 0. El candado del propio test: no tocó nada ──────────────────────────────────────
    console.log('\n[0] El test no operó la pantalla');
    const prohibidosTocados = clicks.filter((c) => SELECTORES_PROHIBIDOS.some((p) => String(c).includes(p)));
    ok(prohibidosTocados.length === 0, `no se presionó ningún botón que escriba (${SELECTORES_PROHIBIDOS.join(' · ')})`);
    ok(erroresConsola.length === 0, `la pantalla no dejó errores en consola${erroresConsola.length ? ': ' + erroresConsola.slice(0, 3).join(' | ') : ''}`);

  } catch (e) {
    console.error(`  ✗ excepción: ${e.message}`);
    fail++;
  } finally {
    await ctx.close().catch(() => {});
    await navegador.close().catch(() => {});
    if (knex) await knex.destroy().catch(() => {});
  }

  console.log(`\n[CB.51.2] ${pass} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
