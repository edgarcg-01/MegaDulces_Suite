'use strict';
/**
 * `[ZN.2.0]` — **Alcance que apunta a una sucursal que ya no existe.**
 *
 * ── Cómo apareció ───────────────────────────────────────────────────────────
 * Antes de hacer que los selectores respeten el alcance (`[ZN.2]`), se simuló
 * qué vería cada una de las 122 personas activas. Salieron **4 ciegas**, y no
 * por la regla sino por el DATO:
 *
 *     humberto_placencia · rdmad322 · rvmad01 · rvmad02   (ruta_directa, Madero)
 *     identity.user_scopes: dimension=warehouse, mode=listed, values={'32'}
 *
 * `'32'` es la llave **Wincaja** de Morelia Madero. Cuando Madero migró su POS a
 * Kepler pasó a ser la sucursal `'07'`, y su almacén `MD-32` quedó
 * soft-deleted — o sea que **desapareció del universo** de la dimensión
 * (`UNIVERSO_SQL.warehouse` filtra `deleted_at IS NULL`). Resultado:
 * `optionsFor()` devuelve `[]` para esas cuatro personas.
 *
 * Hoy no se nota porque el frontend **ignora el alcance** y ofrece las 9
 * sucursales del array que lleva en el bundle. O sea: el fail-open estaba
 * tapando un dato roto, y encender el filtro sin esto las dejaba sin su
 * sucursal.
 *
 * ── Por qué se AGREGA `'07'` y no se reemplaza `'32'` ───────────────────────
 * Las dos llaves son la misma sucursal en dos eras, y **las dos siguen
 * apareciendo en los datos**: los feeds anteriores al cutover emiten `'32'` y
 * nadie los reescribe. Cambiar `'32'` por `'07'` le quitaría a esas personas su
 * propia historia. `values` (lo que filtra) y `options` (lo que se ofrece en
 * pantalla) son cosas distintas a propósito: `'32'` se queda filtrando el
 * pasado aunque no se ofrezca como opción.
 *
 * `store-branches.ts` ya había declarado este caso — *«hay 4 usuarios con
 * alcance '32' que sólo ven la era Wincaja… queda declarado, no disfrazado»*.
 * Esto lo cierra por el lado del dato.
 *
 * ── Derivado, no una lista de nombres ───────────────────────────────────────
 * No se nombran los 4 usuarios: se busca **cualquier** regla de alcance cuyos
 * valores no resuelvan contra el universo vigente. Una lista escrita hoy estaría
 * vieja mañana, y el mismo defecto va a volver con el próximo cutover de POS.
 *
 * Aditiva e idempotente. No le quita alcance a nadie: sólo agrega la llave nueva
 * de la misma sucursal.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * ⚠️ **Corrección de esta misma migración (2026-09-24).** La primera versión llevaba el mapa
 * `'32'→'07'` / `'30'→'08'` **escrito a mano acá**. Está mal, y el repo ya lo había pagado:
 * `[SB.1]` (migración `20260923120000`, del mismo día y con timestamp anterior) creó
 * `analytics.v_branch_erp_cutover` justamente porque ese corte vivía **copiado en tres lugares
 * y divergió**, dejando **$1,636,170.10** de venta de Morelia Abastos invisibles en el blend.
 *
 * Escribirlo por cuarta vez habría sido reproducir el defecto exacto que ese resolvedor existe
 * para cerrar (ADR-056: un primitivo copiado a mano diverge). Se DERIVA de la vista.
 */
async function cutoversVigentes(knex) {
  const { rows } = await knex.raw(`
    SELECT DISTINCT
           btrim(wincaja_source_branch) AS viejo,
           btrim(coalesce(warehouse_code, kepler_code)) AS nuevo
      FROM analytics.v_branch_erp_cutover
     WHERE wincaja_source_branch IS NOT NULL
       AND coalesce(warehouse_code, kepler_code) IS NOT NULL
       AND btrim(wincaja_source_branch) <> btrim(coalesce(warehouse_code, kepler_code))
  `);
  return rows.map((r) => ({
    viejo: r.viejo,
    nuevo: r.nuevo,
    motivo: `cutover declarado en analytics.v_branch_erp_cutover ([SB.1])`,
  }));
}

/*
 * ⭐ Y derivarlo trajo más de lo que el mapa a mano tenía. Medido en `wincaja.branches`
 * (2026-09-24): **las 8 sucursales cambiaron de código al migrar de POS**, no sólo Morelia —
 *
 *     10 → 01 PH   ·   30 → 08 Abastos   ·   32 → 07 Madero   ·   40 → 03 8ESQ
 *     42 → 02 LPA  ·   44 → 04 Yurécuaro ·   50 → 06 Canindo  ·   54 → 05 Zamora
 *
 * El mapa escrito a mano cubría 2 de 8. Hoy sólo hay gente atorada en `'32'`, así que las otras
 * seis no reparan nada — pero el día que alguien quede con alcance `'50'`, esto lo agarra solo,
 * que es exactamente lo que un literal no hace.
 */

/** El universo EXACTO de la dimensión `warehouse` (espeja `UNIVERSO_SQL` + `branchKeySql`). */
const UNIVERSO = `
  SELECT CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END AS v
    FROM commercial.warehouses w
   WHERE w.deleted_at IS NULL
     AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) ~ '^[0-9]{2}$'
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // El corte se LEE del resolvedor, no se escribe acá. Si la vista no está (entorno sin
  // `[SB.1]`), no se inventa el mapa: se declara y no se repara nada — reparar a ciegas es
  // justamente lo que produce la divergencia que esto evita.
  const { rows: hayVista } = await knex.raw(`
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'analytics' AND table_name = 'v_branch_erp_cutover' LIMIT 1`);
  if (!hayVista.length) {
    console.log(
      '  ! [ZN.2.0] NO MEDIDO: falta analytics.v_branch_erp_cutover ([SB.1], mig 20260923120000). ' +
        'No se repara ningún alcance: el mapa de cutovers se deriva de esa vista, no se escribe a mano.',
    );
    return;
  }

  const cutovers = await cutoversVigentes(knex);
  console.log(`  · [ZN.2.0] cutovers vigentes según el resolvedor: ${cutovers.map((c) => `${c.viejo}→${c.nuevo}`).join(' · ') || '(ninguno)'}`);

  let reparados = 0;
  for (const { viejo, nuevo, motivo } of cutovers) {
    // Sólo donde el código viejo YA NO resuelve. Si todavía está en el universo
    // (como '30' hoy, que vive en la fila fusionada), no hay nada que reparar.
    const { rows: vive } = await knex.raw(`SELECT 1 FROM (${UNIVERSO}) u WHERE u.v = ? LIMIT 1`, [viejo]);
    if (vive.length) {
      console.log(`  ~ [ZN.2.0] '${viejo}' sigue resolviendo: no hay nada que reparar.`);
      continue;
    }

    for (const tabla of ['identity.user_scopes', 'identity.role_scopes']) {
      const res = await knex.raw(
        `UPDATE ${tabla}
            SET values = array_append(values, ?),
                nota = coalesce(nota || ' · ', '') || ?
          WHERE dimension = 'warehouse'
            AND ? = ANY(values)
            AND NOT (? = ANY(values))`,
        [nuevo, `[ZN.2.0] ${motivo}: se agrega '${nuevo}' sin quitar '${viejo}' (la historia sigue llaveada con el viejo)`, viejo, nuevo],
      );
      if (res.rowCount) {
        reparados += res.rowCount;
        console.log(`  ✓ [ZN.2.0] ${tabla}: ${res.rowCount} regla(s) con '${viejo}' ahora también alcanzan '${nuevo}'.`);
      }
    }
  }
  if (!reparados) console.log('  ~ [ZN.2.0] no había reglas que reparar.');

  // ── Gate: nadie puede quedar con un alcance que no resuelve a NADA ─────────
  // Es la condición para encender el filtro en los selectores: si esto falla, el
  // día que el front respete el alcance esas personas se quedan sin su sucursal.
  const { rows: ciegos } = await knex.raw(`
    SELECT u.username, us.values
      FROM identity.user_scopes us
      JOIN identity.users u ON u.id = us.user_id AND u.deleted_at IS NULL AND u.activo
     WHERE us.dimension = 'warehouse' AND us.mode = 'listed'
       AND NOT EXISTS (SELECT 1 FROM (${UNIVERSO}) uni WHERE uni.v = ANY(us.values))
  `);
  if (ciegos.length) {
    throw new Error(
      `[ZN.2.0] ${ciegos.length} persona(s) con alcance que no resuelve a ninguna sucursal: ` +
        ciegos.map((c) => `${c.username} (${(c.values || []).join(',')})`).join(' · ') +
        '. Encender el filtro con esto las deja ciegas.',
    );
  }
  console.log('  ✓ [ZN.2.0] ninguna persona activa queda con alcance que no resuelva.');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const { rows: hayVista } = await knex.raw(`
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'analytics' AND table_name = 'v_branch_erp_cutover' LIMIT 1`);
  if (!hayVista.length) return; // sin el resolvedor no se sabe qué se agregó: no se toca nada
  // Quita SOLO la llave que agregó esta migración, y sólo donde convive con la
  // vieja: así no le recorta el alcance a quien lo tenga por otra razón.
  for (const { viejo, nuevo } of await cutoversVigentes(knex)) {
    for (const tabla of ['identity.user_scopes', 'identity.role_scopes']) {
      await knex.raw(
        `UPDATE ${tabla} SET values = array_remove(values, ?)
          WHERE dimension = 'warehouse' AND ? = ANY(values) AND ? = ANY(values)`,
        [nuevo, viejo, nuevo],
      );
    }
  }
};
