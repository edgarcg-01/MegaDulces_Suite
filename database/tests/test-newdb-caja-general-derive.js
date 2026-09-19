/* eslint-disable no-console */
/**
 * CG.9c / CG.9d — la caja general es **derive-no-copy**, y no puede volver a ser un importer ni
 * volver a perder filas en silencio (ADR-070).
 *
 * ── QUÉ EXISTE PARA IMPEDIR ESTA SUITE ────────────────────────────────────────────────────────
 *
 * 1) **Que alguien vuelva a convertir las vistas en tablas.** Eran tablas que llenaba
 *    `import-caja-general.js`, y ese importer quedó SIN AGENDAR el 2026-09-15 (se lo retiró de
 *    `intraday`/`nightly` porque corren en Linux y él exige PowerShell + ACE.OLEDB + `Z:`). Las
 *    tablas se congelaron el **2026-09-11** y el tablero no dijo nada. Una tabla acá es esa historia
 *    otra vez.
 *
 * 2) **Que vuelva la llave que colapsa.** La tabla tenía PK `(tenant_id, source_caja, tipo_dto,
 *    mov_id)`, y `(TipoDto, IdDocto)` NO es única en el origen: `IdDocto = 0` es un centinela con
 *    120 filas y el `DMax+1` del Access dejó pares repetidos de verdad. Medido: **7 movimientos /
 *    $49,699.00** se pisaban en el alcance 2026; 149 en todo el corpus.
 *
 * 3) **Que el trim se relaje.** `btrim(x)` de Postgres quita SÓLO espacios; `String(x).trim()` de
 *    JS quita todo el espacio en blanco. Hay **7 valores del origen con `\r\n` adelante**. Si
 *    alguien "simplifica" el `btrim` de dos argumentos, esos valores salen con salto de línea.
 *
 * ── CONTRATO ──────────────────────────────────────────────────────────────────────────────────
 * exit 0 pasó · 1 FALLÓ (regresión) · 2 NO MEDIDO (sin landing con qué comprobarse).
 * Sin `caja_general_ods` esto NO se pone verde: sería el skip que pasa justo donde importa.
 *
 *   node database/tests/test-newdb-caja-general-derive.js
 */
require('dotenv').config();
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✖', m); } };

(async () => {
  if (!URL) return noMedido('sin DATABASE_URL_NEW — no hay a qué conectarse');
  let c;
  try {
    c = new Client({ connectionString: URL, connectionTimeoutMillis: 10000, statement_timeout: 120000 });
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido('la DB de la plataforma no es alcanzable desde acá', e.message);
    throw e;
  }

  try {
    const landing = await c.query(`SELECT to_regclass('caja_general_ods.doctos') r`);
    if (!landing.rows[0].r) {
      return noMedido('no existe caja_general_ods.doctos — el landing crudo no está, nada que derivar');
    }

    console.log('\n[1] El landing crudo existe con su identidad DECLARADA');
    const ident = await c.query(`
      SELECT t.relname, pg_get_constraintdef(con.oid) def
        FROM pg_constraint con
        JOIN pg_class t ON t.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'caja_general_ods' AND con.contype = 'u' ORDER BY 1`);
    const porTabla = Object.fromEntries(ident.rows.map((r) => [r.relname, r.def]));
    for (const [t, esperado] of [
      ['doctos', '(source_caja, tipodto, iddocto, fecha, horad, cuenta)'],
      ['cuenta', '(source_caja, idcuenta)'],
      ['arqueo_movimientos', '(source_caja, id)'],
    ]) {
      const def = porTabla[t] || '';
      ok(def.includes(esperado), `${t}: identidad ${esperado}`);
      // ⛔ NULLS NOT DISTINCT no es un detalle: con UNIQUE clásico una fila con NULL en la llave
      // se reinserta en CADA pasada. Ya se pagó — 1 de 116,503 filas de Doctos trae NULLs.
      ok(def.includes('NULLS NOT DISTINCT'),
        `${t}: va como UNIQUE NULLS NOT DISTINCT — con el UNIQUE clásico los nulos son distintos `
        + 'entre sí y esa fila se reinsertaría para siempre');
    }

    console.log('\n[2] ⛔ Las tres son VISTAS, no tablas');
    const rel = await c.query(`
      SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='analytics'
         AND c.relname IN ('caja_general_movimientos','caja_general_cuentas','caja_arqueos')`);
    const kind = Object.fromEntries(rel.rows.map((r) => [r.relname, r.relkind]));
    for (const t of ['caja_general_movimientos', 'caja_general_cuentas', 'caja_arqueos']) {
      ok(kind[t] === 'v',
        kind[t] === 'v'
          ? `analytics.${t} es VISTA derive-no-copy`
          : `analytics.${t} es ${kind[t] === 'r' ? 'TABLA' : 'algo que no es vista'} — volvió el importer. `
            + 'Eso es lo que estuvo congelado del 11 al 15 de septiembre sin que el tablero lo dijera.');
    }

    console.log('\n[3] ⛔ LA PRUEBA DEL COLAPSO: (tipo_dto, mov_id) NO alcanza como identidad');
    const col = await c.query(`
      SELECT count(*)::int filas,
             count(DISTINCT (tipo_dto::text || '|' || coalesce(mov_id,'')))::int llaves
        FROM analytics.caja_general_movimientos`);
    const { filas, llaves } = col.rows[0];
    ok(filas > llaves,
      `la vista trae ${filas.toLocaleString('es-MX')} filas contra ${llaves.toLocaleString('es-MX')} `
      + `llaves (tipo_dto, mov_id) → esa PK perdía ${filas - llaves} movimientos. Si esto se pone `
      + 'en 0, o el origen se limpió o alguien volvió a colapsar por esa llave.');

    console.log('\n[4] La vista no pierde NADA contra su landing (misma ventana de negocio)');
    const par = await c.query(`
      SELECT (SELECT count(*)::int FROM caja_general_ods.doctos
               WHERE fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 AND substring(fecha from 1 for 10)::date >= DATE '2026-01-01') landing,
             (SELECT count(*)::int FROM analytics.caja_general_movimientos) vista`);
    ok(par.rows[0].landing === par.rows[0].vista,
      `landing ${par.rows[0].landing.toLocaleString('es-MX')} = vista ${par.rows[0].vista.toLocaleString('es-MX')} `
      + '— la vista no filtra de más');

    const dinero = await c.query(`
      SELECT (SELECT sum(coalesce(ingreso,0))::numeric FROM caja_general_ods.doctos
               WHERE fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 AND substring(fecha from 1 for 10)::date >= DATE '2026-01-01') l_ing,
             (SELECT sum(ingreso)::numeric FROM analytics.caja_general_movimientos) v_ing,
             (SELECT sum(coalesce(gasto,0))::numeric FROM caja_general_ods.doctos
               WHERE fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 AND substring(fecha from 1 for 10)::date >= DATE '2026-01-01') l_gas,
             (SELECT sum(gasto)::numeric FROM analytics.caja_general_movimientos) v_gas`);
    const d = dinero.rows[0];
    ok(String(d.l_ing) === String(d.v_ing) && String(d.l_gas) === String(d.v_gas),
      `dinero al centavo: ingreso $${Number(d.v_ing).toLocaleString('es-MX')} · gasto $${Number(d.v_gas).toLocaleString('es-MX')}`);

    console.log('\n[5] ⛔ El trim ancho: ningún texto publicado arranca o termina en blanco');
    // btrim(x) de pg quita SOLO espacios. El origen trae 7 valores con \r\n adelante.
    const ws = await c.query(`
      SELECT count(*) FILTER (WHERE nombre_cliente ~ '^\\s|\\s$')::int nc,
             count(*) FILTER (WHERE concepto ~ '^\\s|\\s$')::int co,
             count(*) FILTER (WHERE usuario ~ '^\\s|\\s$')::int us
        FROM analytics.caja_general_movimientos`);
    const w = ws.rows[0];
    ok(w.nc === 0 && w.co === 0 && w.us === 0,
      `nombre_cliente ${w.nc} · concepto ${w.co} · usuario ${w.us} con blanco al borde `
      + '(si esto sube, alguien cambió btrim(x, E\' \\t\\n\\r\\f\\v\') por btrim(x) a secas)');

    console.log('\n[6] Los arqueos — la tabla que vigila el sensor `caja_general` de db-health');
    const aq = await c.query(`
      SELECT count(*)::int n, max(arqueo_date)::text hi,
             count(*) FILTER (WHERE cancelado)::int canc
        FROM analytics.caja_arqueos`);
    const a = aq.rows[0];
    ok(a.n > 0, `caja_arqueos trae ${a.n.toLocaleString('es-MX')} arqueos`);
    const rezagoDias = a.hi
      ? Math.floor((Date.now() - new Date(a.hi + 'T00:00:00Z').getTime()) / 86400000) : null;
    ok(rezagoDias != null && rezagoDias <= 7,
      rezagoDias == null
        ? 'caja_arqueos NO tiene fecha máxima — el sensor mide sobre la nada'
        : `el arqueo más nuevo es de hace ${rezagoDias} día(s) (${a.hi}). El sensor pide warn 30h / `
          + 'crit 50h; más de 7 días es el congelamiento otra vez.');
    ok(a.canc > 0,
      `${a.canc.toLocaleString('es-MX')} arqueos cancelados llegan a la vista — es la prueba de que `
      + 'la fila MUTA y de que el espejo la actualiza en su lugar en vez de duplicarla');

    // ⛔ EL CANDADO DEL `?`: knex.raw trata `?` como MARCADOR DE PARÁMETRO. La primera versión de
    // esta vista usaba `'^-?[0-9]+([.][0-9]+)?$'` y se desplegó como `'^-$1[0-9]+([.][0-9]+)$2$'`
    // — knex se comió los dos cuantificadores. La vista compiló sin una queja y publicó TODAS las
    // denominaciones en NULL, donde el origen trae el conteo real.
    //
    // No se comprueba "que no sea null" (eso lo pasaría cualquier cosa): se comprueba contra un
    // ÁRBITRO INDEPENDIENTE — el desglose reconstruido tiene que dar el `total_billetes` que el
    // origen ya calculó. Medido: 2,425 de 2,425 en prod.
    const den = await c.query(`
      SELECT count(*)::int n,
             count(*) FILTER (WHERE abs(
                 coalesce((denom->>'B1000')::numeric,0)*1000 + coalesce((denom->>'B500')::numeric,0)*500
               + coalesce((denom->>'B200')::numeric,0)*200  + coalesce((denom->>'B100')::numeric,0)*100
               + coalesce((denom->>'B50')::numeric,0)*50    + coalesce((denom->>'B20')::numeric,0)*20
               - total_billetes) < 0.005)::int cuadra
        FROM analytics.caja_arqueos WHERE coalesce(total_billetes,0) <> 0`);
    const dd = den.rows[0];
    if (!dd.n) {
      console.log('  ⃝ NO MEDIDO — no hay arqueos con billetes con qué comprobar el desglose');
    } else {
      // No se exige 100%: hay 5 arqueos de 2014-2022 donde el TOTAL tecleado no coincide con el
      // DESGLOSE tecleado (dif de $300 a $87,500) — error del origen, no del carril. En 2026 el
      // cuadre es 100%. El umbral está en 99.9% porque el bug que esto vigila daba **0%**: no hay
      // zona gris entre "se comió los cuantificadores" y "cinco filas viejas mal capturadas".
      const pct = dd.cuadra / dd.n;
      ok(pct >= 0.999,
        `el desglose reconstruye el total de billetes en ${dd.cuadra} de ${dd.n} arqueos `
        + `(${(pct * 100).toFixed(3)}%, ${dd.n - dd.cuadra} excepciones del origen) — si esto se `
        + 'desploma, alguien volvió a meter un `?` en un regex que pasa por knex.raw');
    }

    console.log('\n[7] La marca del shipper existe y avanzó');
    const wm = await c.query(`SELECT to_regclass('caja_general_ods._ship_watermark') r`);
    if (!wm.rows[0].r) {
      ok(false, 'no existe caja_general_ods._ship_watermark — el shipper nunca corrió');
    } else {
      const m = await c.query(`SELECT src_table, wm, rows_shipped FROM caja_general_ods._ship_watermark ORDER BY 1`);
      ok(m.rowCount >= 3, `${m.rowCount} rutas con marca (se esperaban 3)`);
      ok(m.rows.every((r) => r.wm != null), 'todas las rutas tienen marca — ninguna quedó sin shipear');
    }

    console.log(`\n=== ${pass} ✓ · ${fail} ✗ ===\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
