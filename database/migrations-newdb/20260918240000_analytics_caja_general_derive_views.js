/**
 * CG.9d — **`analytics.caja_general_*` y `caja_arqueos` pasan a VISTAS derive-no-copy** (ADR-070).
 *
 * Cierra el círculo que abrio CG.9c: el `.mdb` aterriza crudo en `caja_general_ods.*` y la capa que
 * consume la app deja de ser una tabla que alguien tiene que acordarse de llenar.
 *
 * ── Qué se arregla, medido ─────────────────────────────────────────────────────────────────────
 *
 * 1) **El congelamiento.** `import-caja-general.js` se retiró de `intraday` y `nightly` el
 *    2026-09-15 (esos carriles corren en `md`/Linux y él exige PowerShell + ACE.OLEDB + `Z:`).
 *    Quedó sólo en el modo `finance`, que **no está en ninguna agenda** → las tres tablas llevan
 *    congeladas desde el **2026-09-11**. Una vista no se congela: si el landing está fresco, la
 *    pantalla está fresca.
 *
 * 2) **Filas que se perdían en silencio.** La tabla tenía
 *    `PRIMARY KEY (tenant_id, source_caja, tipo_dto, mov_id)` = `(TipoDto, IdDocto)`, y esa llave
 *    NO es única en el origen: `IdDocto = 0` es un centinela con 120 filas y el `DMax+1` del Access
 *    dejó pares repetidos de verdad. Medido sobre las filas reales:
 *      · en el alcance que el importer carga (2026): **7 movimientos / $49,699.00** se pisaban
 *      · en todo el corpus serían 149
 *    La vista no tiene llave que colapse: salen las 116,503.
 *
 * ── Qué NO se cambia, a propósito ──────────────────────────────────────────────────────────────
 *
 * ⚠️ **El alcance de negocio se conserva.** `import-caja-general.js` carga `Fecha >= 2026-01-01`
 * (decisión de Edgar, 2026-08-14) y la vista **mantiene esa ventana**. El landing SÍ tiene el
 * histórico completo (2008-07-10 → hoy, 116,503 filas), así que abrirla es cambiar una línea — pero
 * es una decisión de negocio, no un efecto colateral de un refactor. Cambiar un `WHERE` de negocio
 * dentro de un cambio de arquitectura es exactamente lo que el proyecto prohíbe.
 *
 * ── Fidelidad: las transformaciones son las del importer, no unas parecidas ─────────────────────
 *
 * `cleanDate` (año ∈ [2009,2027] o NULL), `hhmm` (hora del datetime Access 1899), `txt` (trim →
 * NULL si vacío) y las dos tablas de etiquetas (`TIPO_DTO`, `TIPO_ARQUEO`) están calcadas de
 * `import-caja-general.js`. Se verificó A/B contra la tabla que dejó el importer real.
 *
 * ⚠️ Una diferencia deliberada: en los arqueos los cortes de denominación vienen **text** en el
 * origen y el importer los pasaba por `num()`, que convierte cualquier basura en **0**. Acá un
 * valor no numérico sale **NULL**, no 0 — lo que no se puede leer se declara. Hoy no cambia nada:
 * medido, los 18 campos son 100% numéricos en las 30,004 filas.
 *
 * ── El swap ────────────────────────────────────────────────────────────────────────────────────
 *
 * La tabla se **RENOMBRA** a `*_snapshot_bak`, no se borra (mismo patrón que
 * `20260903120000_kepler_bank_movements_live_view.js`): respeta "no borrar tablas en prod" y deja
 * el rollback a un `ALTER ... RENAME` de distancia.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

/** `cleanDate` del importer: 'YYYY-MM-DD' sólo si el año ∈ [2009,2027]; si no, NULL. */
const fechaLimpia = (col) => `
    CASE WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          AND substring(${col} from 1 for 4)::int BETWEEN 2009 AND 2027
         THEN substring(${col} from 1 for 10)::date END`;

/** `hhmm` del importer: '1899-12-30T13:58:20' → '13:58:20'. */
const horaDe = (col) => `substring(${col} from 'T([0-9]{2}:[0-9]{2}:[0-9]{2})')`;

/**
 * `txt` del importer: trim, y vacío → NULL.
 *
 * ⛔ **El segundo argumento NO es decorativo.** `btrim(x)` de Postgres quita SÓLO espacios;
 * `String(x).trim()` de JavaScript —que es lo que hace el importer— quita todo el espacio en
 * blanco, saltos de línea incluidos. El A/B contra la tabla que dejó el importer real encontró
 * **7 valores con `\r\n` adelante** (6 en `nombre_cliente`, 1 en `concepto`), del estilo
 * "\r\nVentas RD 22  21/07". Sin este juego de caracteres la pantalla publicaría el salto de línea
 * y nadie lo ataría a esta migración.
 */
const WS = String.raw`E' \t\n\r\f\v'`;
const texto = (col) => `NULLIF(btrim(${col}::text, ${WS}), '')`;

/**
 * Cast honesto de los cortes de denominación que el origen guarda como texto:
 * lo que no es número sale NULL, no 0. Mismo trim ancho, por el mismo motivo.
 *
 * ⛔ **NI UN `?` EN ESTE SQL.** Va por `knex.raw()`, y para knex el `?` es un MARCADOR DE
 * PARÁMETRO, no un cuantificador de regex. La primera versión usaba `'^-?[0-9]+([.][0-9]+)?$'` y
 * knex la desplegó como **`'^-$1[0-9]+([.][0-9]+)$2$'`** — se comió los dos `?` y los reemplazó por
 * bindings. La vista compiló sin quejarse y publicó **todas las denominaciones en NULL**, donde el
 * origen traía el conteo real (72.6% de los arqueos de 2026 lo tienen).
 *
 * Por eso los cuantificadores van como `{0,1}`. Es la misma trampa que la Fase CV documentó al
 * revés (allá los `?` sueltos de un regex rompían el conteo de bindings de knex).
 *
 * ⚠️ Y el A/B contra el importer NO lo atrapó, porque `analytics.caja_arqueos` estaba **vacía** en
 * el entorno de prueba: un A/B sólo cubre lo que tiene datos de los DOS lados.
 */
const numTexto = (col) => `CASE WHEN btrim(coalesce(${col},''), ${WS}) ~ '^-{0,1}[0-9]+([.][0-9]+){0,1}$'
                               THEN btrim(${col}, ${WS})::numeric END`;

/** Denominación de `Doctos` — los 15 cortes, con los nombres que usa hoy el importer. */
const DENOM_DOCTOS = ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20', 'M20', 'M10', 'M5', 'M2', 'M1', 'M05', 'M02', 'M01', 'Mor'];
/** Denominación de los ARQUEOS — 17 cortes (otro juego: acá sí hay M100 y centavos). */
const DENOM_ARQUEO = ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20', 'M100', 'M20', 'M10', 'M5', 'M2', 'M1', 'M50C', 'M20C', 'M10C', 'M5C', 'Centavos'];

const jsonbDenom = (claves, cast) =>
  `jsonb_build_object(${claves.map((k) => `'${k}', ${cast(k.toLowerCase())}`).join(', ')})`;

const SQL_CUENTAS = `
  SELECT '${M}'::uuid                       AS tenant_id,
         c.source_caja,
         ${texto('c.idcuenta')}              AS id_cuenta,
         ${texto('c.nombrecuenta')}          AS nombre,
         ${texto('c.nombrelargocta')}        AS nombre_largo,
         c.nivelcta::int                     AS nivel,
         ${texto('c.grupocta')}              AS grupo,
         ${texto('c.acumulaacta')}           AS acumula_a,
         (btrim(coalesce(c.afectablecta,'')) IN ('S','s','True','1')) AS afectable,
         c._shipped_at                       AS computed_at
    FROM caja_general_ods.cuenta c`;

const SQL_MOVIMIENTOS = `
  SELECT '${M}'::uuid                       AS tenant_id,
         d.source_caja,
         d.tipodto::int                      AS tipo_dto,
         ${texto('d.iddocto')}               AS mov_id,
         CASE d.tipodto::int WHEN 1 THEN 'Ingreso' WHEN 2 THEN 'Gasto'
                             WHEN 3 THEN 'Deposito' WHEN 6 THEN 'Misc' END AS tipo,
         ${fechaLimpia('d.fecha')}           AS fecha,
         ${horaDe('d.horad')}                AS hora,
         ${texto('d.usuariod')}              AS usuario,
         ${texto('d.cuenta')}                AS cuenta,
         -- El nombre de cuenta lo denormalizaba el importer al cargar; acá es un JOIN vivo, así que
         -- renombrar una cuenta en el Access se ve de inmediato en vez de al siguiente import.
         ${texto('ct.nombrecuenta')}         AS cuenta_nombre,
         ${texto('d.nombrecliente')}         AS nombre_cliente,
         ${texto('d.observdocto')}           AS concepto,
         coalesce(d.ingreso, 0)              AS ingreso,
         coalesce(d.gasto, 0)                AS gasto,
         coalesce(d.deposito, 0)             AS deposito,
         coalesce(d.efectivo, 0)             AS efectivo,
         ${jsonbDenom(DENOM_DOCTOS, (c) => `coalesce(d.${c}, 0)`)} AS denom,
         coalesce(d.saldod, 0)               AS saldo,
         (coalesce(d.corte, 0) <> 0)         AS corte,
         coalesce(d.dolard, 0)               AS dolar,
         coalesce(d.tipocambd, 0)            AS tipo_cambio,
         d._shipped_at                       AS computed_at
    FROM caja_general_ods.doctos d
    LEFT JOIN caja_general_ods.cuenta ct
           ON ct.source_caja = d.source_caja AND ct.idcuenta = d.cuenta
   -- Ventana de negocio de import-caja-general.js (CAJA_DOCTOS_FROM). Ver la cabecera: el landing
   -- tiene el histórico completo; abrirla es una decisión de negocio, no de esta migración.
   WHERE ${fechaLimpia('d.fecha')} >= DATE '2026-01-01'`;

const SQL_ARQUEOS = `
  SELECT '${M}'::uuid                       AS tenant_id,
         a.source_caja,
         ${texto('a.id')}                    AS mov_id,
         ${texto('a.folio')}                 AS folio,
         CASE a.movimientoprincipal::int WHEN 1 THEN 'Arqueo' WHEN 2 THEN 'Retiro'
                                        WHEN 3 THEN 'Corte'  WHEN 4 THEN 'Deposito'
                                        WHEN 5 THEN 'Fondo Caja' WHEN 6 THEN 'Mixto' END AS tipo,
         ${texto('a.almacen')}               AS almacen,
         ${texto('a.caja')}                  AS caja,
         ${fechaLimpia('a.movimientofecha')} AS arqueo_date,
         ${texto('a.capturo')}               AS capturo,
         coalesce(a.totalbilletes, 0)        AS total_billetes,
         coalesce(a.totalmonedas, 0)         AS total_monedas,
         coalesce(a.totalefectivo, 0)        AS total_efectivo,
         coalesce(a.totalcredito, 0)         AS total_credito,
         coalesce(a.totalcheques, 0)         AS total_cheques,
         coalesce(a.totaltarjeta, 0)         AS total_tarjeta,
         coalesce(a.totaldolares, 0)         AS total_dolares,
         coalesce(a.movimientototal, 0)      AS mov_total,
         ${jsonbDenom(DENOM_ARQUEO, numTexto)} AS denom,
         coalesce(a.revisado, false)         AS revisado,
         coalesce(a.cancelado, false)        AS cancelado,
         ${texto('a.observaciones')}         AS observaciones,
         a._shipped_at                       AS computed_at
    FROM caja_general_ods.arqueo_movimientos a
   -- El importer filtraba el año en la propia query de Access (DATE_LO/DATE_HI = 2009..2027);
   -- la limpieza de fecha ya aplica ese mismo rango, asi que no hace falta ventana extra.
   -- (sin acentos graves aca dentro: este SQL vive en un template literal de JS y un backtick
   --  en un comentario CIERRA el string. Es la quinta vez que pasa en el repo.)
   WHERE ${fechaLimpia('a.movimientofecha')} IS NOT NULL`;

const VISTAS = [
  ['caja_general_cuentas', SQL_CUENTAS,
    'Vista derive-no-copy: plan de cuentas de la caja general EN VIVO desde caja_general_ods.cuenta. '
    + 'Reemplaza import-caja-general.js --only doctos (parte catalogo). Respaldo: *_snapshot_bak.'],
  ['caja_general_movimientos', SQL_MOVIMIENTOS,
    'Vista derive-no-copy: libro de la caja general EN VIVO desde caja_general_ods.doctos + cuenta. '
    + 'Reemplaza import-caja-general.js. Recupera las filas que la PK (tipo_dto, mov_id) colapsaba '
    + '(7 movs / $49,699 en 2026). Ventana de negocio fecha >= 2026-01-01, igual que el importer. '
    + 'Respaldo: *_snapshot_bak.'],
  ['caja_arqueos', SQL_ARQUEOS,
    'Vista derive-no-copy: arqueos de la caja 20 EN VIVO desde caja_general_ods.arqueo_movimientos '
    + '(BMovimientosCajas.mdb). Reemplaza import-caja-general.js --only arqueos. Es la tabla que '
    + 'vigila el sensor caja_general de db-health. Respaldo: *_snapshot_bak.'],
];

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('caja_general_ods.doctos') AS t`);
  if (!ods.rows[0]?.t) return; // entorno sin el landing: nada que derivar (idempotente)

  for (const [nombre, sql, comentario] of VISTAS) {
    const rel = await knex.raw(
      `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.${nombre}')`);
    if (rel.rows[0]?.relkind === 'v') continue; // ya es vista

    if (rel.rows[0]?.relkind === 'r') {
      // RENAME, no DROP: el rollback es un ALTER y la regla del proyecto prohíbe borrar tablas.
      await knex.raw(`ALTER TABLE analytics.${nombre} RENAME TO ${nombre}_snapshot_bak`);
    }
    await knex.raw(`CREATE VIEW analytics.${nombre} AS ${sql}`);
    await knex.raw(`GRANT SELECT ON analytics.${nombre} TO app_runtime`);
    await knex.raw(`COMMENT ON VIEW analytics.${nombre} IS ${knex.raw('?', [comentario]).toString()}`);
  }
};

exports.down = async function (knex) {
  for (const [nombre] of VISTAS) {
    await knex.raw(`DROP VIEW IF EXISTS analytics.${nombre}`);
    await knex.raw(`ALTER TABLE IF EXISTS analytics.${nombre}_snapshot_bak RENAME TO ${nombre}`);
  }
};
