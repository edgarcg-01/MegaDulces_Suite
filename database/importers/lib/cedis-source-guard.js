'use strict';
/**
 * [IC.CEDIS] Guard de la fuente del CEDIS — Wincaja Irapuato.
 *
 * POR QUÉ EXISTE
 * --------------
 * El CEDIS migra su PdV a Kepler (sucursal `00`). Los dos importers que alimentan el
 * CEDIS desde Wincaja (`import-cedis-stock-wincaja` RA-PRO.24 e `import-cedis-cadence-wincaja`
 * RA-PRO.25) corren en `run-prod-feeds.js` y **no se enteran del cutover**: seguirían
 * escribiendo la foto de un `.mdb` que ya nadie actualiza.
 *
 * ⛔ El de stock hace un MERGE con **DELETE de lo que no venga de Irapuato**: después del
 *    cutover eso **borra del CEDIS todo lo que Kepler cargue** y lo deja con la foto vieja.
 *    Es daño ACTIVO, no un feed que simplemente se queda quieto.
 *
 * Medido el 2026-09-28 (prod): el último movimiento de Wincaja `00` es del **2026-09-18**
 * y los carriles PM2 de la réplica están detenidos desde el 22-sep. O sea que la fuente ya
 * está muerta **desde antes** del cutover, y el importer seguía publicando su foto como si
 * fuera de hoy. El MERGE es sin churn (UPSERT sólo-cambios), así que `updated_at` ni se
 * movía: **el feed se veía sano justamente porque el dato ya no cambiaba**.
 *
 * LAS DOS PUERTAS
 * ---------------
 *  A) CUTOVER — si `commercial.warehouses` del CEDIS ya declara `kepler_code`, el almacén
 *     vive en Kepler y Wincaja deja de ser su fuente. Se apaga **solo**, el día que alguien
 *     haga el paso 3 del checklist (§1.11c de FASE_IC). Nadie tiene que acordarse de este
 *     archivo.
 *  B) FRESCURA — si el último movimiento de la fuente tiene más de `CEDIS_SOURCE_MAX_AGE_DAYS`
 *     días (default 3), no se publica. ADR-056: un dato viejo no se publica como si fuera de
 *     hoy; y ADR-059: lo que no se puede sostener **se declara**, no se dibuja.
 *
 * NO lanza ni sale con código ≠ 0: el runner de feeds agrega fallas por paso y un `throw`
 * acá teñiría de rojo una corrida que está haciendo lo correcto. Devuelve el veredicto y
 * **lo imprime siempre** — un skip silencioso se lee igual que un feed sano, que es
 * exactamente el modo de fallo que este guard viene a cerrar.
 */

const DEFAULT_MAX_AGE_DAYS = Number(process.env.CEDIS_SOURCE_MAX_AGE_DAYS || 3);

/**
 * @param {{raw?:Function, query?:Function}} db  knex (`.raw`) o pg Client (`.query`)
 * @param {{tenant:string, cedisCode:string, wincajaBranch:string, maxAgeDays?:number}} opts
 * @returns {Promise<{ok:boolean, reason:string|null, detail:string}>}
 */
async function checkCedisSource(db, opts) {
  const { tenant, cedisCode, wincajaBranch } = opts;
  const maxAgeDays = opts.maxAgeDays != null ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const run = async (sql, binds) => {
    // knex.raw usa `?`; pg Client usa `$n`. Acá sólo se pasan binds posicionales `?`.
    if (typeof db.raw === 'function') return (await db.raw(sql, binds)).rows;
    let i = 0;
    return (await db.query(sql.replace(/\?/g, () => `$${++i}`), binds)).rows;
  };

  // ── A) ¿el CEDIS ya vive en Kepler? ────────────────────────────────────────
  // ⛔ SE PREGUNTA A LAS DOS TABLAS, y no es paranoia: hoy **ya discrepan**.
  //    `commercial.warehouses` code '00' → kepler_code NULL
  //    `wincaja.branches`      branch '00' → kepler_code '00', kepler_cutover_date NULL
  //    El resolvedor canónico `analytics.v_branch_erp_cutover` sale de `wincaja.branches`
  //    (filtra kepler_code NOT NULL **y** kepler_cutover_date NOT NULL), y es ahí donde se
  //    marcaron las cuatro migraciones anteriores. Si el día del cutover alguien pone la
  //    fecha sólo en `wincaja.branches` —lo más probable, porque es el procedimiento que ya
  //    siguieron— una puerta que mirara únicamente `warehouses` NO cerraría.
  //    Gracias a la sesión de [AUD-DAT.10] por señalar esta familia de defecto.
  const [wh] = await run(
    `SELECT kepler_code, wincaja_source_branch
       FROM commercial.warehouses
      WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`,
    [tenant, cedisCode]);

  if (!wh) {
    return { ok: false, reason: 'warehouse_missing',
      detail: `No existe el almacén CEDIS code=${cedisCode}.` };
  }
  if (wh.kepler_code) {
    return { ok: false, reason: 'cutover_done',
      detail: `El CEDIS ya declara commercial.warehouses.kepler_code='${wh.kepler_code}' → su `
        + `fuente es Kepler, no Wincaja. Este feed queda retirado (ver FASE_IC §1.11c).` };
  }

  // El resolvedor canónico de la frontera Wincaja→Kepler (derivado de wincaja.branches).
  const [cut] = await run(
    `SELECT kepler_code, to_char(cutover_date, 'YYYY-MM-DD') AS cutover
       FROM analytics.v_branch_erp_cutover
      WHERE tenant_id = ? AND wincaja_source_branch = ? AND cutover_date <= current_date`,
    [tenant, wincajaBranch]);

  if (cut) {
    return { ok: false, reason: 'cutover_done',
      detail: `v_branch_erp_cutover ya declara el cutover de la rama ${wincajaBranch} a Kepler `
        + `'${cut.kepler_code}' el ${cut.cutover}. La fuente del CEDIS es Kepler. `
        + `⚠️ Falta además poner commercial.warehouses.kepler_code (hoy NULL) — las dos tablas `
        + `responden la misma pregunta y hay que dejarlas de acuerdo (FASE_IC §1.11c paso 3).` };
  }

  // ── B) ¿la fuente sigue viva? ──────────────────────────────────────────────
  // `fecha` es de negocio y Wincaja tiene filas con fecha FUTURA (medido: una de 2029 en la
  // rama `10`) que envenenarían un max() — por eso se acota a hoy.
  // ⚠️ `to_char`, no `::date`: pg devuelve `date` como objeto Date y `String()` lo renderiza en
  // hora local — el mensaje salía "Fri Sep 18 2026 00:00:00 GMT-0600" y, peor, un `date` de
  // medianoche UTC puede imprimirse con el DÍA ANTERIOR. Ver feedback_pg_date_is_date_object.
  const [src] = await run(
    `SELECT to_char(max(fecha), 'YYYY-MM-DD') AS ultimo,
            (current_date - max(fecha)::date) AS dias
       FROM wincaja.maestro_mov_almacen
      WHERE source_branch = ? AND fecha <= current_date`,
    [wincajaBranch]);

  if (!src || src.ultimo == null) {
    return { ok: false, reason: 'source_empty',
      detail: `Wincaja branch ${wincajaBranch} no tiene un solo movimiento con fecha válida.` };
  }
  const dias = Number(src.dias);
  if (dias > maxAgeDays) {
    return { ok: false, reason: 'source_stale',
      detail: `La fuente Wincaja ${wincajaBranch} está RANCIA: último movimiento ${src.ultimo} `
        + `(${dias} días, tope ${maxAgeDays}). No se publica dato viejo como si fuera de hoy.` };
  }

  return { ok: true, reason: null,
    detail: `Fuente Wincaja ${wincajaBranch} fresca (último movimiento ${src.ultimo}, ${dias} d).` };
}

/** Imprime el veredicto SIEMPRE. Un skip mudo se lee igual que un feed sano. */
function reportCedisGuard(verdict, label) {
  const tag = label ? `[${label}] ` : '';
  if (verdict.ok) console.log(`${tag}✔ guard CEDIS: ${verdict.detail}`);
  else console.log(`${tag}⛔ SKIP (${verdict.reason}): ${verdict.detail}`);
  return verdict.ok;
}

module.exports = { checkCedisSource, reportCedisGuard, DEFAULT_MAX_AGE_DAYS };
