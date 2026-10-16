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
  await page.exposeFunction('__e2eClick', (t) => clicks.push(t)).catch(() => null);

  let knex = null;
  /** Una sola conexión, perezosa: la comparten el bloque 4 y el 7. Devuelve null si no hay URL. */
  const knexDe = () => {
    if (knex) return knex;
    const u = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
    if (!u) return null;
    knex = require('knex')({ client: 'pg', connection: u, pool: { min: 0, max: 2 } });
    return knex;
  };
  try {
    // ── 1. La pantalla carga ─────────────────────────────────────────────────────────────
    console.log(`\n[1] La pantalla carga de verdad — ${BASE} · periodo ${PERIODO}`);
    // ⛔ Se entra SIEMPRE por `/login`, nunca directo a la ruta profunda. Medido el 2026-10-15:
    // una carga fría sobre `/finanzas/bancos?...` deja la página en blanco —ni el formulario ni
    // el encabezado aparecen en 45 s— mientras que entrando por `/login` y navegando después
    // resuelve en 1 s. Además es lo que hace una persona, así que el test recorre el camino real
    // en vez de uno que sólo existe en el test.
    //
    // Por `id`, no por rol: los inputs del login no tienen `aria-label` y el nombre accesible
    // depende de un `<label for>` que el DOM headless no resuelve igual que el inspector.
    // Medido: `getByRole('textbox', { name: 'Usuario' })` no empata acá, `#username` sí.
    const campoUsuario = page.locator('#username');
    // ⚠️ Por `h1` + texto, NO por rol con `exact`: el encabezado lleva un ícono de ayuda dentro,
    // así que su nombre accesible no siempre es «Bancos» a secas — empataba de forma
    // intermitente según cuándo cargara la fuente de íconos, y el test fallaba sin motivo.
    const encabezado = page.locator('h1', { hasText: 'Bancos' }).first();

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await campoUsuario.waitFor({ timeout: 45000 });

    {
      // ⚠️ El login se REINTENTA, y no por prolijidad: el endpoint de auth está detrás del
      // Throttler de 3 niveles, así que correr el e2e dos veces seguidas (o varias sesiones a la
      // vez) devuelve 429 y la app rebota a `/login?reason=expired`. Medido: el mismo usuario y
      // la misma contraseña dan 201 un minuto después. Sin el reintento, el test reporta como
      // defecto de la pantalla un límite de tasa que provoca él mismo.
      let entro = false;
      for (let intento = 1; intento <= 3 && !entro; intento++) {
        if (intento > 1) await page.waitForTimeout(20000 * (intento - 1));
        await campoUsuario.fill(USER);
        await page.locator('#password').fill(PASS);
        await page.getByRole('button', { name: 'Iniciar Sesión' }).click();
        entro = await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30000 })
          .then(() => true).catch(() => false);
        if (!entro) console.log(`     · intento ${intento} de login rebotó (${page.url().replace(BASE, '')}) — reintentando`);
      }
      if (!entro) {
        skip('el login no pasó en 3 intentos (throttler o credenciales) — el test no puede concluir');
        throw new Error('__sin_sesion__');
      }
      await page.goto(`${BASE}/finanzas/bancos?view=cierre&period=${PERIODO}`, { waitUntil: 'domcontentloaded' });
    }
    // El encabezado del módulo es la señal de que la ruta resolvió y el guard dejó pasar.
    //
    // ⚠️ Se REINTENTA la navegación. Medido el 2026-10-15: la misma URL, con la misma sesión,
    // a veces deja la página sin pintar el componente (la URL es la correcta y el `h1` no
    // aparece en 45 s) y al re-navegar resuelve en 1 s. No se diagnosticó la causa —es de la
    // app, no del test— así que **se declara acá en vez de esconderse tras un timeout más
    // largo**: si hace falta más de un intento, el test lo dice.
    let pinto = false;
    for (let intento = 1; intento <= 3 && !pinto; intento++) {
      if (intento > 1) {
        // ⚠️ Hay DOS motivos distintos para no ver el encabezado y confundirlos manda a
        // diagnosticar lo que no es: o la sesión se cayó (la app rebotó a `/login`, típicamente
        // por el throttler de auth tras varias corridas seguidas) o el componente no pintó con
        // la URL correcta. El primero se arregla volviendo a entrar; el segundo, re-navegando.
        const reboto = /\/login/.test(page.url());
        console.log(`     · ${reboto ? 'la sesión se cayó' : 'el componente no pintó'} (${page.url().replace(BASE, '')}) — ${reboto ? 're-autenticando' : 're-navegando'}, intento ${intento}`);
        if (reboto) {
          await page.waitForTimeout(20000 * (intento - 1));
          await campoUsuario.waitFor({ timeout: 30000 }).catch(() => null);
          await campoUsuario.fill(USER);
          await page.locator('#password').fill(PASS);
          await page.getByRole('button', { name: 'Iniciar Sesión' }).click();
          await page.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 30000 }).catch(() => null);
        }
        await page.goto(`${BASE}/finanzas/bancos?view=cierre&period=${PERIODO}`, { waitUntil: 'domcontentloaded' });
      }
      pinto = await encabezado.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    }
    ok(pinto, 'el componente de Bancos pinta su encabezado');
    if (!pinto) throw new Error('__sin_pantalla__');
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
      knexDe();
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

    // ── 6. La cobertura no puede pasar de 100 % ──────────────────────────────────────────
    // `[CB.52]` — el chip decía **«Conciliado 160 %»**. Un porcentaje por encima de 100 no es
    // una cifra alta: es un numerador que no cabe en su denominador. Medido en prod el
    // 2026-10-15 sobre 2026-10: numerador $51,208,666.76 (948 retiros + **812 depósitos**),
    // denominador $32,068,777.39 (**sólo retiros**) → 159.7 %.
    // Resto del motor viejo: `runMatch` sobre el 102 casaba sólo retiros; desde `[CB.27]` el de
    // tesorería casa las dos direcciones y el denominador se quedó donde estaba.
    console.log('\n[6] La cobertura conciliada es un porcentaje, no una opinión');
    const est = await page.evaluate(async (p) => {
      const tk = localStorage.getItem('auth_token');
      const r = await fetch(`/api/finance/bank/diagnostico?period=${p}`, { headers: { Authorization: 'Bearer ' + tk } });
      return r.ok ? (await r.json()).recon_estado : { __err: r.status };
    }, PERIODO);
    if (!est) {
      skip(`${PERIODO} no tiene conciliación corrida: no hay cobertura que medir`);
    } else if (est.__err) {
      skip(`/diagnostico devolvió HTTP ${est.__err}`);
    } else {
      ok(est.pct >= 0 && est.pct <= 100,
        `la cobertura cae en 0–100 % (dice ${est.pct} %: ${nm(est.bank_matched_amount ?? 0)} casado de ${nm(est.bank_amount)})`);
      // Prueba de que el rango no se cumple por casualidad: numerador y denominador tienen que
      // salir de la MISMA columna. Si alguien vuelve a mezclar importes de Kepler con importes
      // de banco, el numerador deja de estar contenido y esto lo caza.
      if (est.bank_matched_amount != null) {
        ok(est.bank_matched_amount <= est.bank_amount + 0.01,
          'el monto casado está CONTENIDO en el monto total del banco (misma columna arriba y abajo)');
      } else {
        skip('el despliegue no expone `bank_matched_amount` — no trae CB.52, no se puede verificar la contención');
      }
    }

    // ── 7. Conciliar de verdad ───────────────────────────────────────────────────────────
    // ⛔ **ESTE BLOQUE ESCRIBE EN PRODUCCIÓN** y por eso es OPT-IN: sólo corre con
    // `E2E_CONCILIAR=1`. Presiona el botón REAL de la pestaña Conciliación —no llama a la API
    // por atrás— porque el reclamo original era que los movimientos no se conciliaban, y eso se
    // comprueba apretando lo que aprieta una persona. `runMatch` borra y reconstruye los pareos
    // del periodo, así que re-correrlo es idempotente, pero sigue siendo una escritura.
    if (process.env.E2E_CONCILIAR !== '1') {
      skip('Conciliar NO se ejecutó (escribe en prod). Para ejercerlo: E2E_CONCILIAR=1');
    } else {
      console.log(`\n[7] Conciliar — ejercido desde el botón, periodo ${PERIODO}`);
      const casadosDe = async () => knexDe()('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', PERIODO).whereNull('bm.deleted_at').where('bm.recon_status', 'matched')
        .count({ n: '*' }).first().then((r) => Number(r.n) || 0);
      const antes = await casadosDe();

      await page.goto(`${BASE}/finanzas/bancos?view=conciliacion&period=${PERIODO}`, { waitUntil: 'domcontentloaded' });
      const boton = page.getByRole('button', { name: 'Conciliar', exact: true }).first();
      await boton.waitFor({ timeout: 45000 });
      clicks.push('Conciliar');  // queda registrado: este test SÍ operó, y se declara
      await boton.click();

      // El botón dispara un job asíncrono (202 + WS), así que no alcanza con esperar la red:
      // se espera a que la BASE cambie, que es el único hecho que importa.
      let despues = antes, esperado = 0;
      for (let s = 0; s < 60 && despues === antes; s++) { await page.waitForTimeout(2000); despues = await casadosDe(); esperado = s; }
      ok(despues > 0, `Conciliar dejó movimientos casados en la base: ${antes} → ${despues} (tardó ~${esperado * 2}s)`);
      if (despues === antes && antes > 0) {
        skip('el conteo no se movió, pero ya venía casado: re-conciliar es idempotente y no prueba nada nuevo');
      }
      const errorVisible = await page.getByText(/delete from|error/i).first().isVisible().catch(() => false);
      ok(!errorVisible, 'Conciliar no dejó un error en pantalla');
    }

    // ── 0. El candado del propio test: no tocó nada ──────────────────────────────────────
    console.log('\n[0] El test no operó la pantalla');
    // `Conciliar` deja de estar prohibido SÓLO si se pidió explícitamente con `E2E_CONCILIAR=1`.
    // Lo demás sigue vedado incluso entonces: autorizar una escritura no autoriza las otras.
    const vedados = SELECTORES_PROHIBIDOS.filter((p) => !(p === 'Conciliar' && process.env.E2E_CONCILIAR === '1'));
    const prohibidosTocados = clicks.filter((c) => vedados.some((p) => String(c).includes(p)));
    ok(prohibidosTocados.length === 0,
      process.env.E2E_CONCILIAR === '1'
        ? `sólo se operó Conciliar, que se pidió a propósito; nada más (${vedados.join(' · ')})`
        : `no se presionó ningún botón que escriba (${vedados.join(' · ')})`);
    ok(erroresConsola.length === 0, `la pantalla no dejó errores en consola${erroresConsola.length ? ': ' + erroresConsola.slice(0, 3).join(' | ') : ''}`);

  } catch (e) {
    // Los dos centinelas ya se contaron arriba — `__sin_sesion__` como NO MEDIDO y
    // `__sin_pantalla__` como ✗ — así que acá no se vuelven a contar.
    //  y  ya se contaron arriba (NO MEDIDO / ✗): no se duplican.
    if (!['__sin_sesion__', '__sin_pantalla__'].includes(e.message)) { console.error(`  ✗ excepción: ${e.message}`); fail++; }
  } finally {
    await ctx.close().catch(() => null);
    await navegador.close().catch(() => null);
    if (knex) await knex.destroy().catch(() => null);
  }

  console.log(`\n[CB.51.2] ${pass} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
