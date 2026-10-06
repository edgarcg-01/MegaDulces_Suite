/* eslint-disable no-console */
/**
 * `[CG.40]` — Los tres defectos de la capa de datos de Caja General, con candado.
 *
 * Salen de la auditoría por capas del 2026-10-06, medida contra prod. Los tres comparten forma:
 * **el sistema se ve bien y afirma de más**. Ninguno levanta un error.
 *
 * ── QUÉ EXISTE PARA IMPEDIR ESTA SUITE ────────────────────────────────────────────────────────
 *
 * 1) **Que vuelva el anclaje `sucursal = '00'`.** `finance.v_caja_ingresos_pendientes` lo traía.
 *    Era correcto mientras el `00` concentraba —del 1-ene al 30-sep-2026 las otras plazas tenían
 *    CERO cobros, medido— y es falso desde el corte del 1-oct (Fase PO): esconde 12 cobros por
 *    $107,588.05 **sin un solo error**. El mismo patrón vive en más vistas del repo; acá sólo se
 *    vigila la de caja.
 *
 * 2) ⛔⛔ **Que alguien le ponga `security_invoker` a las vistas `analytics.caja_general_*`.**
 *    Parece higiene (sus hermanas de `finance` sí lo tienen) y es un apagón: `app_runtime` tiene
 *    `SELECT` sobre `caja_general_ods.*` pero **NO** `USAGE` sobre ese schema —el único de la base
 *    sin USAGE—, así que sólo puede leer el landing a través de una vista que corra como su dueño.
 *    *Tener SELECT no es poder leer.*
 *
 * 3) **Que una fuente muerta se siga leyendo como «depósito sin origen».** `analytics.caja_depositos`
 *    es la 3ª explicación de `ingresosControl` y **no recibe un depósito desde ene-2026**: 228
 *    candidatos en ene contra 0 en los nueve meses siguientes. Todo lo que ella habría casado cae
 *    en `sin_explicar`, y la bandeja manda a investigar depósito por depósito algo que se arregla
 *    recuperando la fuente.
 *
 * ── CONTRATO ──────────────────────────────────────────────────────────────────────────────────
 * exit 0 pasó · 1 FALLÓ (regresión) · 2 NO MEDIDO (sin con qué comprobarse).
 * Lo que no se puede medir reporta NO MEDIDO, nunca ✔ (ADR-056).
 *
 *   node database/tests/test-newdb-caja-fuentes-y-definer.js
 */
require('dotenv').config();
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

let pass = 0; let fail = 0; let sinMedir = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✖', m); } };
const skip = (m) => { sinMedir++; console.log('  ◌ NO MEDIDO:', m); };

/** Las tres vistas cuyo `security definer` es LOAD-BEARING, con la tabla que cada una lee. */
const VISTAS_DEFINER = [
  ['analytics.caja_general_movimientos', 'doctos'],
  ['analytics.caja_general_cuentas', 'cuenta'],
  ['analytics.caja_arqueos', 'arqueo_movimientos'],
];

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
    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[1] La vista jubilada no vuelve a anclarse a la era vieja');
    const hv = await c.query(`SELECT to_regclass('finance.v_caja_ingresos_pendientes') r`);
    if (!hv.rows[0].r) {
      skip('finance.v_caja_ingresos_pendientes no existe en esta DB (¿se dropeó?) — nada que vigilar');
    } else {
      const def = (await c.query(
        `SELECT pg_get_viewdef('finance.v_caja_ingresos_pendientes'::regclass, true) d`)).rows[0].d;

      // El detector: la firma del anclaje, tolerante a espacios y comillas.
      const anclada = (sql) => /sucursal\s*=\s*'00'/i.test(sql);

      ok(!anclada(def), 'sin `sucursal = \'00\'` cableado');

      // ⛔ PRUEBA NEGATIVA. Un detector que nunca dispara no prueba nada: se le da el texto que
      // DEBE atrapar. Sin esto, un regex mal escrito se pondría verde sobre una vista rota.
      ok(anclada(`WHERE tenant_id = current_tenant_id() AND sucursal = '00' AND monto > 0`),
        'prueba negativa: el detector SÍ atrapa el anclaje cuando está presente');

      // El tenant se filtra DENTRO: la vista no hereda RLS de sus tablas.
      ok(/current_tenant_id\(\)/.test(def), 'filtra el tenant dentro de la vista');

      // Que esté declarada como jubilada es lo único que, desde psql, la distingue de una viva.
      const com = (await c.query(
        `SELECT obj_description('finance.v_caja_ingresos_pendientes'::regclass, 'pg_class') d`)).rows[0].d;
      ok(!!com && /jubilada/i.test(com), 'declara en su COMMENT que está jubilada y por qué');
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[2] ⛔ El security definer de las vistas de caja es LOAD-BEARING');

    const rol = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rowCount;
    const schema = (await c.query(`SELECT oid FROM pg_namespace WHERE nspname = 'caja_general_ods'`)).rows[0];

    if (!rol || !schema) {
      skip('falta el rol app_runtime o el schema caja_general_ods en esta DB → la premisa del '
        + 'security definer no se puede ejercer acá. NO es un ✓.');
    } else {
      // ⭐ Esto vigila la PREMISA, no el síntoma. Si algún día alguien concede USAGE, este test se
      // pone rojo y lo que hay que revisar es la DECISIÓN (ya se puede usar invoker), no el código.
      const usage = (await c.query(
        `SELECT has_schema_privilege('app_runtime', $1::oid, 'USAGE') u`, [schema.oid])).rows[0].u;
      ok(usage === false,
        'PREMISA: app_runtime NO tiene USAGE sobre caja_general_ods → sólo puede leer el landing '
        + 'a través de una vista que corra como su dueño');

      if (usage) {
        skip('la premisa cambió: con USAGE concedido, las vistas YA PODRÍAN llevar security_invoker. '
          + 'Revisar la decisión de [CG.40] antes de tocar nada.');
      }

      for (const [vista, tabla] of VISTAS_DEFINER) {
        const reg = (await c.query(`SELECT to_regclass($1) r`, [vista])).rows[0].r;
        if (!reg) { skip(`${vista} no existe en esta DB`); continue; }

        const row = (await c.query(`
          SELECT coalesce(c.reloptions::text ILIKE '%security_invoker=true%', false) inv,
                 has_table_privilege('app_runtime', c.oid, 'SELECT') sel,
                 obj_description(c.oid, 'pg_class') com
            FROM pg_class c WHERE c.oid = $1::regclass`, [vista])).rows[0];

        ok(row.inv === false, `${vista}: SIN security_invoker (ponérselo apaga la pantalla)`);
        ok(row.sel === true, `${vista}: app_runtime la puede leer`);
        ok(!!row.com && /NO agregar security_invoker/i.test(row.com),
          `${vista}: su COMMENT avisa por qué no lleva invoker`);

        // El SELECT sobre la tabla base existe pero es inejercible sin USAGE: justo la trampa.
        const selBase = (await c.query(
          `SELECT has_table_privilege('app_runtime', $1, 'SELECT') s`,
          [`caja_general_ods.${tabla}`])).rows[0].s;
        ok(selBase === true,
          `caja_general_ods.${tabla}: app_runtime TIENE SELECT (y aun así no puede leerla sin USAGE)`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n[3] La fuente muerta se puede DECLARAR (no leerse como hueco del ERP)');
    const cd = (await c.query(`SELECT to_regclass('analytics.caja_depositos') r`)).rows[0].r;
    if (!cd) {
      skip('analytics.caja_depositos no existe en esta DB');
    } else {
      // ⚠️ `to_char` en SQL, no `String(fecha).slice()` en JS: `pg` devuelve un `date` como objeto
      // `Date` a medianoche UTC, así que `String()` da `"Wed Jan 21"` y, renderizado en hora MX,
      // puede dar **el día anterior**. Esta suite se escribió con ese bug y lo imprimió.
      const m = (await c.query(`
        SELECT count(*)::int filas,
               to_char(max(deposito_date) FILTER (WHERE deposito_date <= current_date),
                       'YYYY-MM-DD') ultimo,
               (current_date - max(deposito_date) FILTER (WHERE deposito_date <= current_date))::int dias
          FROM analytics.caja_depositos
         WHERE source_instance = 'SI' AND eliminado = false AND total_deposito_real > 0`)).rows[0];

      if (!m.filas) {
        skip('analytics.caja_depositos está vacía → no hay con qué medir hasta cuándo llegó');
      } else {
        // No se exige que la fuente esté viva (no depende de nosotros): se exige que su último
        // dato sea MEDIBLE, que es lo que vuelve accionable el cero en pantalla.
        ok(m.ultimo != null,
          `el último depósito real es medible (${m.ultimo}) → la pantalla puede decir desde cuándo `
          + 'no hay datos en vez de publicar un cero mudo');

        // El formato se comprueba, porque el bug que tuvo esta suite era justo de formato y salía
        // «✔» igual: una fecha mal renderizada no falla, sólo queda ilegible en pantalla.
        ok(/^\d{4}-\d{2}-\d{2}$/.test(String(m.ultimo)),
          `la fecha sale como fecha ISO y no como objeto Date renderizado ("${m.ultimo}")`);

        if (m.dias > 60) {
          console.log(`  ⓘ la fuente lleva ${m.dias} días sin un depósito nuevo: `
            + 'todo lo que habría casado cae hoy en «sin explicar». Es un dato, no una falla de este test.');
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // `[CG.41]` EL GATE DE RENDIMIENTO. Edgar, 2026-10-06: «una consulta de más de 500
    // milisegundos no funciona». Bajó de 1 s.
    //
    // Se vigila la pierna Kepler de la pestaña Conciliación porque es **el 80% del tiempo** de esa
    // pestaña (663 de 825 ms; las otras tres piernas juntas no llegan a 50 ms) y porque su causa es
    // estructural: el CTE `flj` de `analytics.kepler_bank_movements` se usa dos veces, Postgres lo
    // MATERIALIZA, y entonces el filtro de fecha no baja al scan — seq scan de 666k filas para
    // devolver ~100.
    //
    // ⚠️ Esto mide desde DONDE CORRE EL TEST, así que incluye la red. Es a propósito: el número que
    // importa es el que siente quien usa la pantalla, no el `Execution Time` de Postgres.
    console.log('\n[4] El gate de 500 ms sobre la consulta más cara de la pantalla');
    const mv = (await c.query(`SELECT to_regclass('analytics.kepler_bank_movements') r`)).rows[0].r;
    if (!mv) {
      skip('analytics.kepler_bank_movements no existe en esta DB');
    } else {
      const SQL = `SELECT banco_nombre, count(*) n, sum(importe) m
                     FROM analytics.kepler_bank_movements
                    WHERE tenant_id = $1 AND signo > 0 AND es_traspaso = false
                      AND fecha_valor >= date_trunc('month', current_date)::date
                    GROUP BY 1`;
      const T_MEGA = '00000000-0000-0000-0000-00000000d01c';
      const ts = [];
      // 1 corrida de calentamiento descartada: la primera paga el caché frío y mediría el disco,
      // no la consulta.
      for (let i = 0; i < 4; i++) {
        const t0 = process.hrtime.bigint();
        const r = await c.query(SQL, [T_MEGA]);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (i === 0 && r.rowCount === 0) break; // sin datos del mes: no hay qué medir
        if (i > 0) ts.push(ms);
      }
      if (!ts.length) {
        skip('sin movimientos de banco en el mes en curso → no hay con qué medir el gate. NO es un ✓.');
      } else {
        ts.sort((a, b) => a - b);
        const med = Math.round(ts[Math.floor(ts.length / 2)]);
        ok(med <= 500,
          `la pierna Kepler de Conciliación responde en ${med} ms (gate 500 ms)`);
        if (med > 500) {
          console.log('    ⓘ si esto está rojo, lo que falta casi seguro es la mig 20261006170000: '
            + 'el índice ix_kdm1_tesoreria_fecha + el CTE flj en NOT MATERIALIZED. Los dos juntos, '
            + 'por separado ninguno alcanza (sólo la forma da 475 ms; sólo el índice, nada).');
        }
      }
    }

    console.log(`\n${fail ? '✖' : '✔'} ${pass} ✓ / ${fail} ✗ / ${sinMedir} no medido`);
    process.exit(fail ? 1 : 0);
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
