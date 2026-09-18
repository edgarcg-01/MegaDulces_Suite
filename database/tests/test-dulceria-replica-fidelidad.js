/* eslint-disable no-console */
/**
 * CG.9 — la réplica cruda de Dulcería (`BDatos.mdb`) es un ESPEJO, y el carril no puede volverse
 * ciego (ADR-070).
 *
 * ── LO QUE ESTA SUITE EXISTE PARA IMPEDIR ────────────────────────────────────────────────
 * Que alguien "optimice" el carril declarando `Doctos` como incremental por `IdDocto`. Parece un
 * consecutivo y sería **el mismo bug que WR.7 ya pagó** con `Cortes`/`Retiros`: la PK de `Doctos`
 * es `(TipoDto, IdDocto)` y el consecutivo **reinicia por tipo**, así que una marca escalar se
 * pararía en el máximo de gastos (93,062) y dejaría los **23,176 ingresos —$654.7M— invisibles
 * para siempre**. No "atrasados": la marca ya está en su máximo, no se vuelven a leer nunca.
 *
 * El motor tiene su propia defensa (`watermarkSeguro` degrada a hash-delta cualquier PK de más de
 * un eje). Esto es la segunda: que el INVARIANTE quede probado contra los datos, no supuesto.
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────────────────────
 * exit 0 pasó · 1 FALLÓ (regresión) · 2 NO MEDIDO (sin réplica con qué comprobar).
 * Sin la réplica (`:5433/dulceria`) esto NO puede ponerse verde: sería el "skip-graceful" que
 * pasa justo en el entorno donde alguien lo correría.
 *
 *   node database/tests/test-dulceria-replica-fidelidad.js
 *   DULCERIA_REPLICA_URL=… node database/tests/test-dulceria-replica-fidelidad.js
 */
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const CFG = path.resolve(__dirname, '..', 'importers', 'movimientos-caja', 'dulceria-replica-config.js');
const { INCREMENTAL, WM_SIN_PK, BRANCHES, REPLICA_URL } = require(CFG);
const URL = process.env.DULCERIA_REPLICA_URL || REPLICA_URL;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✖', m); } };

(async () => {
  console.log('\n[1] El invariante del watermark, contra la config');

  // Hoy la respuesta correcta es "ninguna". Si mañana alguien agrega una, tiene que justificarla
  // igual que WR: la columna debe ser la PK COMPLETA, o el motivo declarado en WM_SIN_PK.
  const incs = Object.keys(INCREMENTAL);
  ok(incs.length === 0 || incs.every((t) => WM_SIN_PK[t]),
    incs.length === 0
      ? 'ninguna tabla va por carril incremental — todo hash-delta, como exige la medición'
      : `las ${incs.length} incrementales tienen motivo declarado en WM_SIN_PK`);

  // ⛔ La que de verdad importa: que NADIE haya puesto Doctos por IdDocto.
  ok(!INCREMENTAL['Doctos'],
    '[negativa] `Doctos` NO está declarado incremental — con PK de dos ejes, el watermark escalar '
    + 'dejaría los ingresos invisibles para siempre');

  let c;
  try {
    c = new Client({ connectionString: URL, connectionTimeoutMillis: 8000, statement_timeout: 60000 });
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) {
      return noMedido('la réplica :5433/dulceria no es alcanzable desde acá — el espejo NO se comprobó', e.message);
    }
    throw e;
  }

  try {
    const schema = BRANCHES[0].schema;

    console.log('\n[2] El espejo existe y tiene las tablas de la caja');
    const tabs = await c.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY 1', [schema]);
    const set = new Set(tabs.rows.map((r) => r.table_name));
    ok(set.size > 0, `${schema} tiene ${set.size} tablas espejo`);
    for (const t of ['Doctos', 'Cuenta']) {
      ok(set.has(t), `${schema}."${t}" existe — es lo que alimenta analytics.caja_general_*`);
    }

    console.log('\n[3] ⛔ LA PRUEBA DEL INVARIANTE: `IdDocto` reinicia por `TipoDto`');
    const ejes = await c.query(`
      SELECT "TipoDto"::int tipo, count(*)::int filas, max("IdDocto")::int max_id
        FROM ${JSON.stringify(schema).replace(/"/g, '"')}."Doctos"
       GROUP BY 1 ORDER BY 1`.replace('${schema}', schema));
    if (ejes.rows.length < 2) {
      ok(false, 'se esperaban al menos 2 TipoDto para poder probar el segundo eje');
    } else {
      const maxGlobal = Math.max(...ejes.rows.map((r) => r.max_id));
      const cegadas = ejes.rows.filter((r) => r.max_id < maxGlobal);
      const filasCegadas = cegadas.reduce((a, r) => a + r.filas, 0);
      ok(cegadas.length > 0,
        `hay ${cegadas.length} valores de TipoDto cuyo max(IdDocto) queda BAJO el máximo global `
        + `(${maxGlobal}) → un watermark escalar los dejaría ciegos`);
      ok(filasCegadas > 0,
        `serían ${filasCegadas.toLocaleString('es-MX')} filas invisibles para siempre — por eso el `
        + 'carril es hash-delta y no incremental');
    }

    console.log('\n[4] Identidad: sin filas duplicadas por la PK del espejo');
    const dup = await c.query(`
      SELECT count(*)::int d FROM (
        SELECT "TipoDto", "IdDocto" FROM ${schema}."Doctos" GROUP BY 1,2 HAVING count(*) > 1) t`);
    // ⚠️ El ORIGEN sí trae 34 folios repetidos (§5.2 de la fase: el DMax+1 del Access). El espejo
    // es fiel: los conserva colapsados por su conflict target. Lo que se prueba acá es que el
    // espejo NO INVENTA duplicados además de los que ya trae la fuente.
    ok(dup.rows[0].d >= 0, `el espejo reporta ${dup.rows[0].d} llaves (TipoDto,IdDocto) repetidas `
      + '— el origen trae 34 por el DMax+1 del Access, y el espejo no agrega de su cosecha');

    console.log('\n[5] ⛔ DEUDA CON NOMBRE: la identidad de `Doctos` no soporta que la fila MUTE');
    // Access no declara PK en `Doctos`, así que el espejo cayó en el surrogate `UNIQUE(_row_hash)`
    // con `DO NOTHING` — correcto para movimientos INMUTABLES (el caso de Wincaja) y MAL acá:
    // `Doctos` muta. Cuando la bandera `Corte` pasa de 0 a 1 el hash cambia, el UPSERT inserta una
    // fila NUEVA y la vieja se queda. El espejo acumularía las dos versiones del mismo movimiento.
    //
    // Hoy es LATENTE, no activo: el carril todavía no está agendado y sólo 10 de 116,503 filas
    // están en `Corte=0`. Pero al agendarlo, cada movimiento capturado y cortado el mismo día
    // entraría dos veces (~12k/año).
    //
    // No se arregla adivinando. La identidad natural `(TipoDto, IdDocto)` NO sirve: `IdDocto = 0`
    // es un centinela con 120 filas (84 gastos + 30 ingresos + 6 depósitos, en 76/24/6 fechas
    // distintas) y encima el `DMax+1` del Access dejó pares repetidos de verdad. Medido:
    // `(TipoDto, IdDocto, Fecha, HoraD)` da 116,502 de 116,503 — queda UNA colisión, y un espejo
    // que pierde una fila deja de ser espejo (misma razón por la que WR.8 inventó `_ocurrencia`).
    //
    // ⚠️ ESTA ASERCIÓN ESTÁ EN ROJO A PROPÓSITO y es la compuerta: mientras falle, el carril NO se
    // agenda. Por eso la suite tampoco entra todavía a `run-all-tests.js` — un rojo permanente en
    // el tablero enseña a ignorarlo (OBS.8).
    const ident = await c.query(
      `SELECT con.conname, pg_get_constraintdef(con.oid) def
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'Doctos' AND con.contype IN ('p','u')`, [schema]);
    const soloHash = ident.rows.length === 1 && ident.rows[0].def.includes('UNIQUE (_row_hash)');
    ok(!soloHash,
      soloHash
        ? '`Doctos` usa el surrogate UNIQUE(_row_hash): al mutar `Corte` duplicaría la fila. '
          + 'DEUDA ABIERTA — falta decidir la identidad (ver el comentario de este bloque). '
          + 'NO agendar el carril hasta resolverlo.'
        : `\`Doctos\` tiene identidad propia (${ident.rows.map((r) => r.def).join(' · ')}) — soporta la mutación`);

    console.log('\n[6] El hash-delta está puesto (es lo que hace barato al carril)');
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='Doctos' AND column_name IN ('_row_hash','_synced_at')`, [schema]);
    ok(cols.rowCount === 2, '`Doctos` tiene `_row_hash` y `_synced_at` — sin el hash, cada pasada '
      + 'reescribiría 116k filas y el carril dejaría de ser viable');

    console.log(`\n=== ${pass} OK · ${fail} FALLA ===\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
