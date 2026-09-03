#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[LC.9]` — **El archivo que se le entrega a ContPAQi**: layout, parser y round-trip.
 *
 * Se carga el `.ts` REAL vía ts-node (`libs/finance/.../poliza-txt.ts`), no una
 * reimplementación: si el layout cambia de criterio, este archivo se pone rojo. Por eso el
 * layout vive en un módulo sin dependencias de Nest — para que se pueda probar sin DI.
 *
 * Cinco bloques:
 *   1. **Layout** — los largos y el round-trip sobre movimientos sintéticos.
 *   2. **El parser falla ruidoso** — las formas de renglón que NO se deben adivinar. Es el
 *      bloque que más importa: un default silencioso acá voltea el signo de una pata de
 *      millones y nadie lo ve hasta cuadrar la balanza.
 *   3. **Invariante** — ningún renglón se serializa sin cuenta, por ningún camino.
 *   4. **Datos reales** (skip-graceful) — los TXT ya generados se vuelven a parsear y se
 *      cuadran contra la póliza que quedó en ContPAQi.
 *   5. **Placeholders** — un `?` o un `¿` dentro del SQL tira 500 en producción y ni el
 *      build ni una validación DB-direct con `$1` lo atrapan. Vivido el 2026-09-02.
 *
 * ⚠️ El **separador** (`SEP`) es lo único del layout que no está verificado contra un
 * archivo real. Se cierra poniendo un TXT que ContPAQi ya haya aceptado en
 * `database/tests/fixtures/` — ver el bloque 4.
 *
 * Correr: node database/tests/test-newdb-libro-compras-txt.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const lanza = (fn, m) => { try { fn(); ok(false, `${m} (no lanzó)`); } catch { ok(true, m); } };

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const SRC = path.resolve(__dirname, '../../libs/finance/src/lib/purchase-book');
const {
  construirTxt, parsearTxt, largoLinea, impTxt, LAYOUT_P, LAYOUT_M, SEP,
} = require(path.join(SRC, 'poliza-txt.ts'));

const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

/** Un juego de movimientos que ejercita los casos que rompen un parser ingenuo. */
const MOVS = [
  { cuenta: '5010000108', referencia: '21988', abono: false, importe: 272161.75, concepto: 'A1B2C3D4-0000-4000-8000-000000000001' },
  { cuenta: '5020000108', referencia: '21988', abono: false, importe: 38519.05, concepto: 'A1B2C3D4-0000-4000-8000-000000000001' },
  { cuenta: '2120000108', referencia: '21988', abono: true, importe: 310680.80, concepto: 'A1B2C3D4-0000-4000-8000-000000000001' },
  // Referencia VACÍA y concepto vacío: es el renglón que un split(' ') corre entero.
  { cuenta: '1470040000', referencia: '', abono: false, importe: 614102.17, concepto: '' },
  // Importe entero: ContPAQi lo quiere como 6.0, no 6 ni 6.00.
  { cuenta: '1470110000', referencia: '', abono: false, importe: 6, concepto: '' },
];

(async () => {
  try {
    // ── 1. Layout ──────────────────────────────────────────────────────────
    console.log('\n═══ 1. Layout ═══');
    ok(largoLinea(LAYOUT_P) === 147, `encabezado P mide 147 (138 de campos + 9 separadores) — dio ${largoLinea(LAYOUT_P)}`);
    ok(largoLinea(LAYOUT_M) === 211, `movimiento M mide 211 (203 de campos + 8 separadores) — dio ${largoLinea(LAYOUT_M)}`);
    ok(LAYOUT_P.length === 10 && LAYOUT_M.length === 9, 'P tiene 10 campos y M tiene 9');

    const txt = construirTxt('20260731', 2, 'COMPLEMENTO REGISTRO DE COMPRAS 2026-07', MOVS);
    const lineas = txt.split('\r\n').filter((l) => l !== '');
    ok(txt.endsWith('\r\n'), 'el archivo cierra con CRLF');
    ok(lineas.length === MOVS.length + 1, `1 encabezado + ${MOVS.length} movimientos`);
    ok(lineas.every((l, i) => l.length === (i === 0 ? 147 : 211)), 'todas las líneas miden exactamente su largo');

    const p = parsearTxt(txt);
    ok(p.invalidos.length === 0, `el TXT propio parsea sin renglones inválidos (${p.invalidos.map((x) => x.motivo).join(', ')})`);
    ok(p.header && p.header.folio === 2 && p.header.tipo_pol === '3', 'el encabezado devuelve folio 2 y tipo de póliza 3');
    ok(p.header && p.header.fecha === '20260731', 'la fecha vuelve como yyyyMMdd');
    ok(p.header && p.header.concepto === 'COMPLEMENTO REGISTRO DE COMPRAS 2026-07', 'el concepto de la póliza sobrevive');
    ok(p.movimientos.length === MOVS.length, `vuelven los ${MOVS.length} movimientos`);

    const igual = p.movimientos.every((m, i) => m.cuenta === MOVS[i].cuenta && m.referencia === MOVS[i].referencia
      && m.abono === MOVS[i].abono && m.importe === MOVS[i].importe && m.concepto === MOVS[i].concepto);
    ok(igual, 'cada movimiento vuelve idéntico: cuenta, referencia, cargo/abono, importe y concepto');
    ok(p.movimientos[3].referencia === '', 'la referencia vacía sobrevive (el renglón que rompe un split por espacios)');
    ok(p.movimientos[0].concepto.length === 36, 'el UUID de 36 chars viaja entero en el concepto');
    ok(p.movimientos[2].abono === true && p.movimientos[0].abono === false, 'abono y cargo no se confunden');

    // Round-trip: la prueba de que escritor y lector no se separaron.
    const ida = construirTxt('20260731', 2, 'COMPLEMENTO REGISTRO DE COMPRAS 2026-07', p.movimientos);
    ok(Buffer.compare(Buffer.from(txt, 'latin1'), Buffer.from(ida, 'latin1')) === 0,
      'round-trip byte a byte: construir → parsear → construir da el mismo archivo');

    // El contrato es "entre 1 y 2 decimales, nunca cero": `6.0` y `6.53` valen, `6` no.
    // La forma exacta que emite ContPAQi la zanja el fixture del bloque 4.
    ok(impTxt(6) === '6.0', 'importe entero sale como 6.0, no como 6');
    ok(impTxt(6.53) === '6.53', 'dos decimales se respetan');
    ok(impTxt(1234567.891) === '1234567.89', 'se redondea a centavos');
    const formas = [0, 6, 6.5, 6.53, 1234567.891, 0.01, 310680.8].map(impTxt);
    ok(formas.every((s) => /^\d+\.\d{1,2}$/.test(s)), `todo importe sale con 1 o 2 decimales (${formas.join(', ')})`);

    // ── 2. El parser falla ruidoso ─────────────────────────────────────────
    console.log('\n═══ 2. El parser falla ruidoso (no adivina) ═══');
    const linM = (campos) => {
      // Arma un renglón M a mano para poder romperlo campo por campo.
      let s = '';
      LAYOUT_M.forEach((c, i) => {
        const v = String(campos[i] ?? '');
        s += (c.der ? v.padStart(c.ancho, ' ') : v.padEnd(c.ancho, ' ')) + (i < LAYOUT_M.length - 1 ? SEP : '');
      });
      return s;
    };
    const cab = txt.split('\r\n')[0];
    const conM = (m) => parsearTxt(`${cab}\r\n${m}\r\n`);

    let r = conM(linM(['M', '2120000108', '21988', '2', '100.0', '0', '0.0', '', '']));
    ok(r.movimientos.length === 0 && r.invalidos.length === 1 && /no es 0 ni 1/.test(r.invalidos[0].motivo),
      'tipo de movimiento "2" se rechaza — NO se asume cargo (invertiría el asiento en silencio)');

    r = conM(linM(['M', '', '21988', '0', '100.0', '0', '0.0', '', '']));
    ok(r.movimientos.length === 0 && /sin cuenta/.test(r.invalidos[0]?.motivo ?? ''), 'movimiento sin cuenta se rechaza');

    r = conM(linM(['M', '2120000108', '21988', '0', 'ABC', '0', '0.0', '', '']));
    ok(r.movimientos.length === 0 && /importe/.test(r.invalidos[0]?.motivo ?? ''), 'importe no numérico se rechaza');

    r = conM(linM(['M', '2120000108', '21988', '0', '100.0', '0', '0.0', '', '']) + 'XXXX');
    ok(r.movimientos.length === 0 && /mide/.test(r.invalidos[0]?.motivo ?? ''), 'un renglón más largo que el layout se rechaza');

    r = conM(linM(['M', '2120000108', '21988', '0', '100.0', '0', '0.0', '', '']).trimEnd());
    ok(r.movimientos.length === 1 && r.invalidos.length === 0,
      'un renglón con los blancos del final recortados SÍ se acepta (un editor de texto los come)');

    ok(parsearTxt('').invalidos.length === 1, 'archivo vacío se reporta, no se devuelve en silencio');
    ok(parsearTxt(`${linM(['M', '2120000108', '', '0', '1.0', '0', '0.0', '', ''])}\r\n`).invalidos.some((x) => /encabezado/.test(x.motivo)),
      'un archivo sin encabezado P se reporta');
    ok(parsearTxt(`${cab}\r\n${cab}\r\n`).invalidos.some((x) => /segundo encabezado/.test(x.motivo)),
      'dos encabezados P en el mismo archivo se reportan');
    ok(parsearTxt(`${cab}\r\nBASURA\r\n`).invalidos.some((x) => /no arranca/.test(x.motivo)),
      'un renglón que no arranca con P ni con M se reporta');

    // ── 3. Invariante: nunca un renglón sin cuenta ─────────────────────────
    console.log('\n═══ 3. Invariante del serializador ═══');
    lanza(() => construirTxt('20260731', 1, 'X', [{ cuenta: '', referencia: '', abono: false, importe: 1, concepto: '' }]),
      'construirTxt se niega a serializar un movimiento con cuenta vacía');
    lanza(() => construirTxt('20260731', 1, 'X', [{ cuenta: null, referencia: '', abono: false, importe: 1, concepto: '' }]),
      'construirTxt se niega con la cuenta en null (el caso de los 14 proveedores sin cuenta 502)');
    lanza(() => construirTxt('20260731', 1, 'X', [{ cuenta: '   ', referencia: '', abono: false, importe: 1, concepto: '' }]),
      'construirTxt se niega con la cuenta en blancos');

    // ── 4. Contra los datos reales (skip-graceful) ─────────────────────────
    console.log('\n═══ 4. Datos reales ═══');
    const dir = path.join(__dirname, 'fixtures');
    const fixtures = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^poliza-compras-real-.*\.txt$/.test(f)) : [];
    if (!fixtures.length) {
      console.log('  ⚠ sin TXT de referencia de ContPAQi — SKIP del round-trip contra un archivo real.');
      console.log('    El separador sigue SIN verificar. Poné un TXT que ContPAQi ya haya aceptado en');
      console.log('    database/tests/fixtures/poliza-compras-real-<mes>.txt y este bloque se pone verde.');
    } else {
      for (const f of fixtures) {
        const real = fs.readFileSync(path.join(dir, f), 'latin1');
        const rp = parsearTxt(real);
        ok(rp.invalidos.length === 0, `${f}: parsea sin inválidos (${rp.invalidos.slice(0, 3).map((x) => `L${x.linea} ${x.motivo}`).join(' · ')})`);
        if (rp.invalidos.length === 0 && rp.header) {
          // Se le devuelven SUS movimientos en SU orden: así el diff sólo puede fallar por
          // formato, no por el orden (el nuestro ordena por fecha y el suyo salía de Excel).
          const nuestro = construirTxt(rp.header.fecha, rp.header.folio, rp.header.concepto, rp.movimientos);
          const a = Buffer.from(real, 'latin1'), b = Buffer.from(nuestro, 'latin1');
          const iguales = Buffer.compare(a, b) === 0;
          if (!iguales) {
            let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
            console.error(`    primer byte distinto en ${i} (largos ${a.length} vs ${b.length})`);
            console.error(`    real   : ${JSON.stringify(real.slice(Math.max(0, i - 20), i + 20))}`);
            console.error(`    nuestro: ${JSON.stringify(nuestro.slice(Math.max(0, i - 20), i + 20))}`);
          }
          ok(iguales, `${f}: round-trip byte a byte contra el archivo real — EL SEPARADOR QUEDA PROBADO`);
        }
      }
    }

    const runs = await knex('finance.purchase_book_runs')
      .where('tenant_id', T).whereNull('deleted_at').whereNotNull('archivo_contenido')
      .select('anio_mes', 'tipo', 'folio_poliza', 'estado', 'archivo_contenido', 'total_cargos', 'total_abonos', 'renglones');
    if (!runs.length) {
      console.log('  ⚠ sin corridas con archivo guardado en esta base — skip de las aserciones contra corridas reales');
    } else {
      let malos = 0, descuadres = 0;
      for (const run of runs) {
        const rp = parsearTxt(run.archivo_contenido);
        if (rp.invalidos.length) { malos++; console.error(`    ${run.anio_mes}/${run.tipo}: ${rp.invalidos[0].motivo}`); continue; }
        const cargos = Math.round(rp.movimientos.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0) * 100) / 100;
        const abonos = Math.round(rp.movimientos.filter((m) => m.abono).reduce((a, m) => a + m.importe, 0) * 100) / 100;
        if (Math.abs(cargos - Number(run.total_cargos)) >= 0.01 || Math.abs(cargos - abonos) >= 0.01) {
          descuadres++;
          console.error(`    ${run.anio_mes}/${run.tipo}: archivo C ${cargos} / A ${abonos} vs corrida ${run.total_cargos}`);
        }
      }
      ok(malos === 0, `${runs.length === 1 ? 'la corrida con archivo vuelve' : `las ${runs.length} corridas con archivo vuelven`} a parsear sin inválidos`);
      ok(descuadres === 0, 'el archivo guardado reproduce los totales de su corrida y cuadra cargos = abonos');

      // LC.11: el respaldo resuelve las facturas desde los UUID que lleva el propio TXT.
      // Si esos UUID no casan con fiscal.cfdis, la hoja de facturas sale coja y el respaldo
      // deja de cuadrar contra el archivo — que es justo lo que tiene que evitar.
      for (const run of runs) {
        const rp = parsearTxt(run.archivo_contenido);
        if (rp.invalidos.length) continue;
        const uuids = [...new Set(rp.movimientos.map((m) => m.concepto).filter((c) => /^[0-9A-Fa-f-]{36}$/.test(c)))]
          .map((u) => u.toUpperCase());
        if (!uuids.length) { console.log(`  ⚠ ${run.anio_mes}/${run.tipo}: el archivo no lleva UUID — el respaldo cae a la decisión registrada`); continue; }
        const { rows: hallados } = await knex.raw(
          `SELECT count(DISTINCT upper(uuid))::int n FROM fiscal.cfdis
            WHERE tenant_id = ? AND upper(uuid) = ANY (?)`, [T, uuids]);
        ok(Number(hallados[0].n) === uuids.length,
          `${run.anio_mes}/${run.tipo}: los ${uuids.length} UUID del archivo resuelven a un CFDI (${hallados[0].n} hallados)`);
        // `upper()` no es paranoia gratuita: los 167k UUID están hoy en mayúsculas, pero el
        // join no debe depender de que un feed futuro respete esa convención.
        ok(rp.movimientos.filter((m) => m.concepto).length >= uuids.length,
          `${run.anio_mes}/${run.tipo}: cada factura aporta al menos un renglón con su UUID (el listado para el Asociador de CFDI)`);
      }

      // El cuadre contra ContPAQi, que es lo que LC.7 va a automatizar.
      for (const run of runs.filter((x) => x.estado === 'entregado' || x.estado === 'aplicado')) {
        const rp = parsearTxt(run.archivo_contenido);
        if (rp.invalidos.length || !rp.header) continue;
        const { rows } = await knex.raw(
          `SELECT cuenta, cargo_abono, round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = ? AND source = 'contpaqi' AND tipo_pol = '3'
              AND folio = ? AND anio_mes = ?`,
          [T, String(rp.header.folio), run.anio_mes],
        );
        if (!rows.length) { console.log(`  ⚠ ${run.anio_mes}/${run.tipo}: ContPAQi todavía no tiene la póliza folio ${rp.header.folio} — skip`); continue; }
        const clave = (c, ab, i) => `${c}|${ab}|${Math.round(Number(i) * 100)}`;
        const mios = new Map(), suyos = new Map();
        for (const m of rp.movimientos) { const k = clave(m.cuenta, m.abono ? 'A' : 'C', m.importe); mios.set(k, (mios.get(k) ?? 0) + 1); }
        for (const m of rows) { const k = clave(m.cuenta, m.cargo_abono, m.importe); suyos.set(k, (suyos.get(k) ?? 0) + 1); }
        let casan = 0, solo = 0;
        for (const k of new Set([...mios.keys(), ...suyos.keys()])) {
          const g = mios.get(k) ?? 0, s = suyos.get(k) ?? 0;
          casan += Math.min(g, s); solo += Math.abs(g - s);
        }
        ok(solo === 0, `${run.anio_mes}/${run.tipo}: lo entregado casa con la póliza real (${casan} patas, ${solo} sin par)`);
      }
    }

    // ── 5. Placeholders dentro del SQL ─────────────────────────────────────
    console.log('\n═══ 5. Placeholders en el SQL ═══');
    // knex cuenta los `?` con un escaneo de TEXTO PLANO: no distingue comentarios ni
    // literales. Un `¿...?` en un comentario en español agrega bindings fantasma y tira
    // "Expected N bindings, saw N+1" en runtime. Ni el build ni una prueba DB-direct con
    // `$1` lo atrapan, porque ninguno pasa por el formateador de knex.
    const fuente = fs.readFileSync(path.join(SRC, 'purchase-book.service.ts'), 'utf8');
    const sospechosos = [];
    const re = /knex\.raw\(\s*`/g;
    let m2;
    while ((m2 = re.exec(fuente)) !== null) {
      const desde = re.lastIndex;
      const hasta = fuente.indexOf('`', desde);
      if (hasta < 0) break;
      const sql = fuente.slice(desde, hasta);
      sql.split('\n').forEach((linea, i) => {
        if (linea.includes('¿')) sospechosos.push(`signo de apertura ¿ en la línea ${i + 1} del SQL`);
        const c = linea.indexOf('--');
        if (c >= 0 && linea.slice(c).includes('?')) sospechosos.push(`un ? dentro del comentario: ${linea.slice(c).trim().slice(0, 50)}`);
      });
    }
    ok(sospechosos.length === 0, `ningún ? ni ¿ suelto dentro del SQL del servicio${sospechosos.length ? ` — ${sospechosos.join(' · ')}` : ''}`);

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ok · ${fail} fallidas`);
  } catch (e) {
    console.error('ERROR:', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail ? 1 : 0);
})();
