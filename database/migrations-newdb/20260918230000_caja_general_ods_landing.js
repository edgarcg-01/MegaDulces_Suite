/**
 * CG.9c — **`caja_general_ods`: el aterrizaje CRUDO de la caja general en la plataforma** (ADR-070).
 *
 * ── Por qué existe, y por qué NO es un importer ────────────────────────────────────────────────
 *
 * Hoy `analytics.caja_general_movimientos` / `caja_general_cuentas` / `caja_arqueos` son TABLAS que
 * puebla `import-caja-general.js` — un `script → tabla` contra la regla principal del proyecto. Y no
 * es una objeción de estilo: ese importer **quedó sin agendar el 2026-09-15** (se lo retiró de
 * `intraday` y `nightly` porque esos carriles corren en `md`/Linux y él exige PowerShell +
 * ACE.OLEDB + `Z:`), así que sobrevive sólo en el modo `finance`, **que no está en ninguna agenda**.
 * Resultado medido: las tablas quedaron congeladas el **2026-09-11**.
 *
 * El reemplazo es el patrón canónico del proyecto, el mismo de `kepler_ods`:
 *
 *     .mdb  ──(Jet 32-bit, hash-delta)──>  :5433/caja_general.cg20 / .cgarq20   (espejo crudo)
 *                                                   │
 *                                                   │  ship-caja-general.js (delta por _synced_at)
 *                                                   ▼
 *                                          caja_general_ods.*      ← ESTA MIGRACIÓN
 *                                                   │
 *                                                   │  derive-no-copy
 *                                                   ▼
 *                                          analytics.caja_general_* / caja_arqueos   (VISTAS)
 *
 * ── Forma: calcada del ESPEJO, no inventada ────────────────────────────────────────────────────
 *
 * Las columnas son las del `.mdb` en minúsculas, verbatim. No se renombra ni se "arregla" nada acá:
 * el saneamiento vive en la vista, igual que en `kepler_ods`. Por eso `fecha` y `horad` son **text**
 * (Jet guarda fechas 1899 que rompen `timestamp` de pg) y los importes son `numeric` sin precisión
 * (el origen trae valores corruptos y la réplica cruda los TOLERA — FASE_WR §5 gotcha 3).
 *
 * Sin `tenant_id` y sin RLS, igual que `kepler_ods.*`: el discriminador es `source_caja` y el
 * filtro de tenant se inyecta **dentro de la vista** derivada.
 *
 * ── Identidad: medida contra las filas reales, no supuesta ─────────────────────────────────────
 *
 * Las tres llevan la MISMA identidad que ya se probó en el espejo (2026-09-18):
 *   · `doctos`  (tipodto, iddocto, fecha, horad, cuenta) — única en 116,503/116,503. Las llaves
 *     "obvias" fallan: `(tipodto, iddocto)` colapsa 149 filas porque `iddocto = 0` es un centinela
 *     con 120 filas y el `DMax+1` del Access dejó pares repetidos de verdad.
 *     ⚠️ Es EXACTAMENTE la llave que usa hoy `import-caja-general.js` → en el alcance 2026 está
 *     perdiendo **7 movimientos / $49,699.00** en silencio. La vista los recupera.
 *   · `arqueo_movimientos` (id) — única en 30,004/30,004, cero nulos. Acá el importer estaba BIEN.
 *   · `cuenta` (idcuenta) — Access sí declara esta PK.
 *
 * Van como **UNIQUE NULLS NOT DISTINCT** (PG 15+), no PRIMARY KEY: una identidad que declaramos
 * NOSOTROS no puede asumir NOT NULL. Ya se pagó — 1 fila de 116,503 trae `horad` e `iddocto` en
 * NULL y tumbó una carga a la mitad. Con UNIQUE clásico los nulos son distintos entre sí y esa fila
 * se reinsertaría en CADA pasada; `NULLS NOT DISTINCT` la hace chocar consigo misma y actualizarse.
 *
 * @param { import("knex").Knex } knex
 */

/** Columnas de `Doctos` (BDatos.mdb), en el orden del origen. */
const DOCTOS_COLS = [
  ['tipodto', 'numeric'], ['iddocto', 'numeric'], ['fecha', 'text'], ['usuariod', 'text'],
  ['nombrecliente', 'text'], ['cuenta', 'numeric'], ['ingreso', 'numeric'], ['gasto', 'numeric'],
  ['deposito', 'numeric'], ['efectivo', 'numeric'], ['numpers', 'text'], ['tipo', 'numeric'],
  ['observdocto', 'text'], ['corte', 'numeric'],
  // Denominación del movimiento. 15 cortes, tal cual los nombra el Access.
  ['b1000', 'numeric'], ['b500', 'numeric'], ['b200', 'numeric'], ['b100', 'numeric'],
  ['b50', 'numeric'], ['b20', 'numeric'], ['m20', 'numeric'], ['m10', 'numeric'],
  ['m5', 'numeric'], ['m2', 'numeric'], ['m1', 'numeric'], ['m05', 'numeric'],
  ['m02', 'numeric'], ['m01', 'numeric'], ['mor', 'numeric'], ['bm', 'numeric'],
  ['saldod', 'numeric'], ['dolard', 'numeric'], ['tipocambd', 'numeric'],
  ['depcliented', 'numeric'], ['horad', 'text'],
  // ⭐ El gancho al concepto de Kepler que el Access tiene desde 2008 y NUNCA se usó:
  // vacío en el 99.3% de las filas. Se replica igual — es el hueco que ADR-070 viene a cerrar.
  ['conceptod', 'numeric'],
];

/** Columnas de `Cuenta` (BDatos.mdb) — el plan de cuentas de la caja. */
const CUENTA_COLS = [
  ['idcuenta', 'numeric'], ['nombrecuenta', 'text'], ['tipo', 'text'], ['acumulaacta', 'numeric'],
  ['nombrelargocta', 'text'], ['afectablecta', 'text'], ['grupocta', 'text'], ['nivelcta', 'numeric'],
];

/**
 * Columnas de `0 T Movimientos` (BMovimientosCajas.mdb) — los ARQUEOS.
 * ⚠️ Los cortes de denominación vienen **text** en el origen (el Access los guarda así) mientras que
 * los totales son numéricos. Se respeta: la réplica cruda no convierte.
 */
const ARQUEO_COLS = [
  ['id', 'numeric'], ['id2', 'numeric'], ['folio', 'text'], ['arqueo', 'numeric'],
  ['adeposito', 'boolean'], ['deposito', 'numeric'], ['movimientoprincipal', 'numeric'],
  ['movimientosecundario', 'numeric'], ['almacen', 'text'], ['movimientofecha', 'text'],
  ['movimientohora', 'text'], ['caja', 'text'], ['capturo', 'text'],
  ['b1000', 'text'], ['b500', 'text'], ['b200', 'text'], ['b100', 'text'], ['b50', 'text'],
  ['b20', 'text'], ['totalbilletes', 'numeric'],
  ['m100', 'text'], ['m20', 'text'], ['m10', 'text'], ['m5', 'text'], ['m2', 'text'],
  ['m1', 'text'], ['m50c', 'text'], ['m20c', 'text'], ['m10c', 'text'], ['m5c', 'text'],
  ['centavos', 'text'], ['totalmonedas', 'numeric'],
  ['totalefectivo', 'numeric'], ['totalcredito', 'numeric'], ['totalcheques', 'numeric'],
  ['totaltarjeta', 'numeric'], ['dolares', 'text'], ['dolarestipocambio', 'numeric'],
  ['totaldolares', 'numeric'], ['movimientototal', 'numeric'], ['observaciones', 'text'],
  ['impreso', 'boolean'], ['finalizado', 'boolean'],
  // Banderas que se prenden DESPUÉS de capturar → la fila MUTA → el UPSERT tiene que ser
  // DO UPDATE, no DO NOTHING. Medido: `cancelado` en true en 6,541 de 30,004.
  ['revisado', 'boolean'], ['revisadox', 'text'], ['revisadofyh', 'text'],
  ['cancelado', 'boolean'], ['canceladox', 'text'], ['canceladofyh', 'text'],
];

const ddl = (table, cols, identity) => `
  CREATE TABLE caja_general_ods.${table} (
    -- Discriminador de ORIGEN, como \`sucursal\` en kepler_ods. Hoy siempre '20', pero el .mdb de
    -- cada sucursal trae su propio catálogo de cuentas, así que la llave lo lleva desde el día uno.
    source_caja  text NOT NULL,
${cols.map(([c, t]) => `    ${c.padEnd(22)} ${t},`).join('\n')}
    -- Housekeeping del carril. \`_row_hash\` es lo que hace barato el delta; \`_synced_at\` sólo se
    -- mueve cuando el hash CAMBIÓ (el UPSERT lo gatea con IS DISTINCT), y por eso sirve de marca
    -- de cambio para el shipper.
    _row_hash    text,
    _synced_at   timestamptz NOT NULL DEFAULT now(),
    _shipped_at  timestamptz NOT NULL DEFAULT now()
  )`;

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS caja_general_ods`);

  const tablas = [
    ['doctos', DOCTOS_COLS, '(source_caja, tipodto, iddocto, fecha, horad, cuenta)'],
    ['cuenta', CUENTA_COLS, '(source_caja, idcuenta)'],
    ['arqueo_movimientos', ARQUEO_COLS, '(source_caja, id)'],
  ];

  for (const [t, cols, identity] of tablas) {
    const ex = await knex.raw(`SELECT to_regclass('caja_general_ods.${t}') AS r`);
    if (ex.rows[0]?.r) continue;
    await knex.raw(ddl(t, cols, identity));
    // NULLS NOT DISTINCT: ver la cabecera. Sin esto, una fila con NULL en la llave se reinserta
    // en cada pasada y el espejo deja de ser espejo.
    await knex.raw(
      `ALTER TABLE caja_general_ods.${t}
         ADD CONSTRAINT ux_cgods_${t} UNIQUE NULLS NOT DISTINCT ${identity}`);
    await knex.raw(`GRANT SELECT ON caja_general_ods.${t} TO app_runtime`);
  }

  // El shipper lee su propio delta por aquí; las vistas filtran por fecha.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cgods_doctos_fecha
    ON caja_general_ods.doctos (source_caja, fecha)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cgods_doctos_cuenta
    ON caja_general_ods.doctos (source_caja, cuenta)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cgods_arqueo_fecha
    ON caja_general_ods.arqueo_movimientos (source_caja, movimientofecha)`);

  await knex.raw(`COMMENT ON SCHEMA caja_general_ods IS
    'CG.9c (ADR-070) — aterrizaje CRUDO de la caja general (Access BDatos.mdb + BMovimientosCajas.mdb), '
    'mismo patrón que kepler_ods: columnas verbatim del origen, sin tenant_id, sin RLS, sin saneamiento. '
    'Lo alimenta ship-caja-general.js desde el espejo :5433/caja_general. Consumir por las VISTAS de '
    'analytics, nunca directo.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS caja_general_ods.doctos`);
  await knex.raw(`DROP TABLE IF EXISTS caja_general_ods.cuenta`);
  await knex.raw(`DROP TABLE IF EXISTS caja_general_ods.arqueo_movimientos`);
  await knex.raw(`DROP SCHEMA IF EXISTS caja_general_ods`);
};
