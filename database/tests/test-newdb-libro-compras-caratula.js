#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[LC.10]` — **La carátula de la póliza y el bloqueo anti-duplicado en los dos modos.**
 *
 * Existe por ago-2026: ese mes NO tiene póliza de compras (cero abonos a 212, folio 1 del
 * Diario libre), así que lo que falta por asociar ES el libro del mes y tiene que entrar
 * como folio 1 "REGISTRO DE COMPRAS DEL MES", no como folio 2 "COMPLEMENTO".
 *
 * Qué cubre y qué NO, dicho de frente:
 *   · **Sí**: el schema y las restricciones que hacen segura la edición del folio, los
 *     HECHOS de ContPAQi sobre los que descansa la guarda (que son justo lo que puede
 *     cambiar sin que nadie lo note), el orden de declaración de las rutas, y que el
 *     bloqueo anti-duplicado no volvió a quedar condicionado por tipo.
 *   · **No**: la llamada a `setCaratula()` en vivo. El servicio necesita DI (TenantKnex +
 *     el contexto de tenant) y no se puede cargar por ts-node como `poliza-txt.ts`. Eso se
 *     prueba por HTTP con la API arriba.
 *
 * Correr: node database/tests/test-newdb-libro-compras-caratula.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };

const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const SRC = path.resolve(__dirname, '../../libs/finance/src/lib/purchase-book');

(async () => {
  try {
    // ── 1. Lo que hace segura la edición del folio ─────────────────────────
    console.log('\n═══ 1. Schema ═══');
    const cols = (await knex.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'finance' AND table_name = 'purchase_book_runs'`)).rows.map((r) => r.column_name);
    for (const c of ['folio_poliza', 'concepto', 'tipo', 'estado', 'archivo_contenido', 'archivo_hash'])
      ok(cols.includes(c), `col ${c}`);
    ok(!cols.includes('folio'), 'no hay una segunda columna de folio que pueda divergir');

    const cons = (await knex.raw(
      `SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conrelid = 'finance.purchase_book_runs'::regclass`)).rows;
    const uniq = cons.find((c) => /UNIQUE/.test(c.d) && /anio_mes/.test(c.d) && /folio_poliza/.test(c.d));
    ok(!!uniq, 'UNIQUE (tenant_id, anio_mes, folio_poliza): un folio, una corrida — impide que la corrida del libro y la del complemento reclamen el mismo');
    ok(cons.some((c) => /CHECK/.test(c.d) && /tipo/.test(c.d) && /complemento/.test(c.d)), 'CHECK del tipo de corrida');
    ok(cons.some((c) => /CHECK/.test(c.d) && /estado/.test(c.d) && /aplicado/.test(c.d)), 'CHECK de los estados del trámite');

    const rls = (await knex.raw(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'finance.purchase_book_runs'::regclass`)).rows[0];
    ok(rls.relrowsecurity && rls.relforcerowsecurity, 'RLS forzado en purchase_book_runs');

    // ── 2. Los hechos de ContPAQi sobre los que descansa la guarda ─────────
    console.log('\n═══ 2. Los hechos que la guarda consulta ═══');
    const polizas = Number((await knex('analytics.gl_polizas').where('tenant_id', T).count('* as c').first()).c);
    if (!polizas) {
      console.log('  ⚠ sin pólizas de ContPAQi en esta base (corre import-contpaqi-polizas.js) — skip');
    } else {
      const folioDelMes = async (mes, folio) => (await knex.raw(
        `SELECT coalesce(num_lines, 0) AS patas, round(coalesce(cargos, 0), 2) AS cargos
           FROM analytics.gl_polizas
          WHERE tenant_id = ? AND source = 'contpaqi' AND tipo_pol = '3' AND folio = ? AND anio_mes = ?`,
        [T, String(folio), mes])).rows[0] ?? null;

      // jul-2026 SÍ tiene libro: su complemento va en folio 2, y pedir el 1 debe rebotar.
      const jul1 = await folioDelMes('2026-07', 1);
      ok(!!jul1, 'jul-2026 tiene póliza de compras en el folio 1 → cambiar la carátula a folio 1 se rechaza');
      if (jul1) {
        ok(Number(jul1.patas) === 597, `jul-2026 folio 1 tiene 597 renglones (dio ${jul1.patas}) — es la póliza que la contadora armó a mano`);
        ok(Math.abs(Number(jul1.cargos) - 33804766.23) < 0.01, `jul-2026 folio 1 suma 33,804,766.23 (dio ${jul1.cargos})`);
      }
      ok(!(await folioDelMes('2026-07', 2)), 'jul-2026 folio 2 está libre → ahí entra su complemento');

      // ago-2026 NO tiene libro: su complemento ES el mes y entra en folio 1.
      const ago1 = await folioDelMes('2026-08', 1);
      ok(!ago1, 'ago-2026 NO tiene póliza de compras en el folio 1 → la carátula puede ponerse en folio 1');
      const agoAbonos = Number((await knex.raw(
        `SELECT count(*)::int n FROM analytics.gl_poliza_lines
          WHERE tenant_id = ? AND source = 'contpaqi' AND anio_mes = '2026-08'
            AND cuenta_mayor LIKE '212%' AND cargo_abono = 'A'`, [T])).rows[0].n);
      ok(agoAbonos === 0, `ago-2026 no tiene un solo abono a proveedor 212 (dio ${agoAbonos}) — por eso "todo lo no asociado" ES el mes`);

      // La segunda puerta: sin ella, ago-2026 duplicaba. Que siga habiendo qué atrapar.
      const agoCargos = (await knex.raw(
        `SELECT count(*)::int n, round(sum(importe), 2) AS monto FROM analytics.gl_poliza_lines
          WHERE tenant_id = ? AND source = 'contpaqi' AND anio_mes = '2026-08'
            AND (cuenta LIKE '501%' OR cuenta LIKE '502%') AND cargo_abono = 'C'`, [T])).rows[0];
      ok(Number(agoCargos.n) > 0,
        `ago-2026 SÍ tiene compras cargadas a 501/502 desde otras pólizas (${agoCargos.n} patas por ${agoCargos.monto}): la puerta (b) del anti-duplicado no es teórica`);
    }

    // ── 3. El orden de las rutas ───────────────────────────────────────────
    console.log('\n═══ 3. Orden de declaración de las rutas ═══');
    // Nest resuelve por orden: `@Get(':mes')` se come cualquier ruta literal declarada
    // después. Ya mordió una vez con /no-asociados.
    const ctrl = fs.readFileSync(path.join(SRC, 'purchase-book.controller.ts'), 'utf8');
    // Se leen sólo los decoradores REALES: el comentario que explica esta misma regla
    // contiene la cadena `@Get(':mes')` y un indexOf a secas lo encuentra a él primero
    // (pasó al escribir este test: reportó las 7 rutas como mal ordenadas).
    const decoradores = ctrl.split(/\r?\n/)
      .map((l, i) => ({ i, t: l.trim() }))
      .filter((x) => /^@(Get|Post)\('/.test(x.t))
      .map((x) => ({ linea: x.i + 1, ruta: x.t.match(/^@(?:Get|Post)\('([^']*)'\)/)?.[1] ?? '' }));
    const generico = decoradores.find((d) => d.ruta === ':mes');
    ok(!!generico, "el controller tiene la ruta genérica @Get(':mes')");
    const literales = decoradores.filter((d) => d.ruta.startsWith('no-asociados'));
    ok(literales.length >= 7, `hay ${literales.length} rutas literales de /no-asociados`);
    const tarde = literales.filter((d) => generico && d.linea > generico.linea).map((d) => d.ruta);
    ok(tarde.length === 0, `ninguna ruta de /no-asociados se declara DESPUÉS de @Get(':mes')${tarde.length ? ` — se la comerían: ${tarde.join(', ')}` : ''}`);
    ok(literales.some((d) => d.ruta === 'no-asociados/:mes/caratula'), 'la ruta de la carátula existe');

    // ── 4. El bloqueo anti-duplicado no vuelve a ser exclusivo del complemento ──
    console.log('\n═══ 4. El anti-duplicado aplica a los dos modos ═══');
    const svc = fs.readFileSync(path.join(SRC, 'purchase-book.service.ts'), 'utf8');
    const gen = svc.slice(svc.indexOf('  async generar('), svc.indexOf('  async obtenerArchivo('));
    ok(gen.length > 200, 'se pudo aislar el cuerpo de generar()');
    ok(/const dobles = dentro\.filter/.test(gen), 'generar() filtra las que ya están posteadas');
    // La forma vieja: el filtro DENTRO de un if por tipo. Volver a eso deja sin freno al
    // modo que abarca el mes entero, que es el de MÁS riesgo, no el de menos.
    const dentroDeIf = /if \(tipo === 'complemento'\)\s*\{[^}]*dobles/s.test(gen);
    ok(!dentroDeIf, 'el bloqueo NO está condicionado por tipo de corrida');
    ok(/tipo === 'libro'/.test(gen) && /throw new BadRequestException/.test(gen),
      'generar() rechaza el modo libro (arrastra los CFDIs que ContPAQi ya tiene asociados)');
    ok(/gl_polizas/.test(gen), 'generar() vuelve a mirar si el folio está ocupado antes de escribir');

    const car = svc.slice(svc.indexOf('  async setCaratula('), svc.indexOf('  private async ensureRun('));
    ok(/gl_polizas/.test(car), 'setCaratula() consulta si ContPAQi ya tiene ese folio');
    ok(/estado === 'aplicado' \|\| run\.estado === 'entregado'/.test(car), 'setCaratula() no toca una corrida ya entregada o aplicada');
    ok(/this\.invalidar\(/.test(car), 'setCaratula() invalida el archivo firmado: cambió la carátula, el TXT ya no corresponde');

    const inv = svc.slice(svc.indexOf('  private async invalidar('), svc.indexOf('  async setCaratula('));
    ok(/archivo_contenido: null/.test(inv) && /archivo_hash: null/.test(inv),
      'invalidar() tira el contenido Y el hash (dejar el contenido servía el TXT viejo sin firma)');

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ok · ${fail} fallidas`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail ? 1 : 0);
})();
