/* eslint-disable no-console */
/**
 * EMB.2 (antes KV.8) — Dimensiones de logística de Kepler → `logistics.*`, IDEMPOTENTE y sin wipe.
 *
 * ── QUÉ CAMBIÓ Y POR QUÉ (2026-09-17) ────────────────────────────────────────────────────
 * 1. **Single-DB sobre `kepler_ods`.** Antes abría una segunda conexión a una réplica de
 *    sucursal (`LOGISTICS_DIMS_SRC`, por defecto md_03) y leía `md.kdm_*`. Ahora lee el ODS,
 *    que vive en la MISMA base destino: desaparece la conexión per-branch y —lo importante—
 *    el importer y las vistas de EMB.0 pasan a leer exactamente la misma fuente, así que no
 *    pueden discrepar. Es el patrón de [[feedback_per_branch_to_ods_single_db]].
 * 2. **Escribe `kepler_code` y upsertea POR ESA CLAVE.** Antes dedupeaba por nombre/placa y
 *    tiraba la clave (quedaba como texto suelto en `notes`: "Kepler unidad 00017"). Sin
 *    columna de cruce, resolver un embarque a su unidad obligaba a parsear una cadena. La
 *    clave es ahora la llave de identidad; el nombre/placa sólo se usa para ADOPTAR filas
 *    viejas que todavía no la tienen.
 * 3. **Lee los catálogos por los resolvedores** `analytics.v_kepler_transporte` /
 *    `v_kepler_chofer`, que ya colapsan las altas duplicadas de Kepler (la misma unidad dada
 *    de alta como `00018` y `018`). Leer `kdm_transporte` crudo re-introduciría esos dobles.
 *
 * ⛔ **Las RUTAS no llevan clave y es a propósito** (medido, ver mig 20260917130000): 3 de las
 * 88 claves nombran cosas distintas según la sucursal (`R0001` = HUANIMARO en 7 ramas y
 * ZIROSTO en la 06; `R7` = MORELIA vs IRAPUATO). Sólo se vincula la biyección comprobada.
 *
 * `logistics.*` tiene RLS forzado → `SET LOCAL app.tenant_id` dentro de la transacción.
 *
 *   node database/importers/kepler/import-logistics-dims.js          # dry-run (ROLLBACK)
 *   node database/importers/kepler/import-logistics-dims.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

/**
 * Sincroniza un catálogo contra `logistics.<tabla>`: adopta por atributo físico lo que ya
 * existe sin clave, actualiza lo que ya la tiene, e inserta lo nuevo. Nunca borra: una unidad
 * dada de baja en Kepler puede seguir teniendo viajes, costos y fotos colgando en la Suite.
 */
async function sincronizar(db, { tabla, filas, campo, insertar, normaliza }) {
  // ⚠️ `normaliza` existe por un defecto REAL (EMB.5): comparar la placa literal creó 8 filas
  // duplicadas — Kepler la escribe `GA-2027-C` y MagniTracking `GA2027C`, así que el importer
  // no reconocía la unidad que el GPS ya había dado de alta y creaba un cascarón al lado. El
  // rastreo quedaba colgando de una fila y la clave de Kepler de la otra: de 25 unidades que
  // embarcan, sólo 3 tenían GPS alcanzable. Misma familia que los ceros a la izquierda de
  // EMB.0.1 — la misma llave escrita de dos maneras.
  const cmp = normaliza
    ? (c) => `regexp_replace(upper(btrim(${c})),'[^A-Z0-9]','','g')`
    : (c) => `upper(btrim(${c}))`;
  let adoptados = 0, actualizados = 0, insertados = 0;
  for (const f of filas) {
    // 1) ¿ya la tenemos por clave?
    const porClave = await db.query(
      `SELECT id FROM logistics.${tabla} WHERE tenant_id=$1 AND kepler_code=$2 AND deleted_at IS NULL`,
      [M, f.clave]);
    if (porClave.rowCount) {
      // ⛔ NO se pisa el atributo: tras la fusión EMB.5 la fila viva es la del GPS y su placa
      // (`GA2027C`) es la buena para el rastreo. Reescribirla con la forma de Kepler
      // (`GA-2027-C`) desharía la fusión en la siguiente corrida.
      actualizados++;
      continue;
    }
    // 2) ¿existe sin clave, de antes de EMB.1 o dada de alta por el GPS? Se ADOPTA.
    const porAtributo = await db.query(
      `SELECT id FROM logistics.${tabla}
        WHERE tenant_id=$1 AND kepler_code IS NULL AND deleted_at IS NULL
          AND ${cmp(campo)}=${cmp('$2')}`,
      [M, f.valor]);
    if (porAtributo.rowCount) {
      await db.query(
        `UPDATE logistics.${tabla} SET kepler_code=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [M, porAtributo.rows[0].id, f.clave]);
      adoptados++;
      continue;
    }
    // 3) nueva.
    await insertar(db, f);
    insertados++;
  }
  console.log(`  ${tabla}: +${insertados} nuevas · ${adoptados} adoptadas · ${actualizados} al día (${filas.length} en Kepler)`);
  return { insertados, adoptados, actualizados };
}

async function main() {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    const [{ db: dbname }] = (await db.query('SELECT current_database() AS db')).rows;
    console.log(`\n=== Dims logística Kepler → logistics.* · ${dbname} · ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

    // El resolvedor es requisito: sin él se leería kdm_transporte crudo y volverían los dobles.
    const reg = await db.query(`SELECT to_regclass('analytics.v_kepler_transporte') AS t`);
    if (!reg.rows[0].t) throw new Error('falta analytics.v_kepler_transporte (migración 20260917120000 sin aplicar)');

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // ── Unidades ────────────────────────────────────────────────────────────────────────
    // DISTINCT ON: la clave es la misma en las 8 ramas (verificado: 0 claves con dos placas).
    const veh = (await db.query(`
      SELECT DISTINCT ON (clave_kepler) clave_kepler AS clave, placas AS valor, descripcion, chofer_asignado
        FROM analytics.v_kepler_transporte
       WHERE placas IS NOT NULL
       ORDER BY clave_kepler, sucursal`)).rows;
    await sincronizar(db, {
      tabla: 'vehicles', filas: veh, campo: 'plate', normaliza: true,
      insertar: (d, f) => d.query(
        `INSERT INTO logistics.vehicles (tenant_id, plate, brand, model, status, active, kepler_code, notes)
         VALUES ($1,$2,'',$3,'disponible',true,$4,$5)`,
        [M, f.valor, f.descripcion || '', f.clave, `Alta desde Kepler (unidad ${f.clave})`]),
    });

    // ── Choferes ────────────────────────────────────────────────────────────────────────
    const chof = (await db.query(`
      SELECT DISTINCT ON (clave_kepler) clave_kepler AS clave, nombre AS valor, ambiguo
        FROM analytics.v_kepler_chofer
       WHERE nombre IS NOT NULL
       ORDER BY clave_kepler, sucursal`)).rows;
    const ambiguos = chof.filter((c) => c.ambiguo).length;
    await sincronizar(db, {
      tabla: 'drivers', filas: chof, campo: 'full_name',
      insertar: (d, f) => d.query(
        `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active, kepler_code, notes)
         VALUES ($1,$2,ARRAY['chofer'],'interno','activo',true,$3,$4)`,
        [M, f.valor, f.clave, `Alta desde Kepler (chofer ${f.clave})`]),
    });
    if (ambiguos) console.log(`  ⚠ ${ambiguos} claves de chofer son ambiguas en el catálogo de Kepler (el nombre difiere entre ramas) — se tomó la forma canónica; ver analytics.v_kepler_chofer.ambiguo`);

    // ── Lo que NO se pudo dar de alta, DECLARADO (ADR-056) ──────────────────────────────
    // Kepler tiene la misma persona dada de alta dos veces con nombres distintos ("ENRIQUE
    // FUENTES" vs "ENRIQUE FUENTES MONTES"), bajo una clave corta local a la sucursal. Este
    // importer dedupea por clave canónica, así que se queda con el nombre completo — correcto,
    // porque lo contrario crearía 5 personas duplicadas. El costo es que una persona real que
    // SÓLO existe bajo una clave corta no entra (medido: 1, BENJAMIN ALONZO ZARAGOZA, suc 05
    // clave 09, cuya clave normalizada choca con el 00009 de MARIA CANDELARIA). No se
    // auto-crea: son datos maestros de personal y el alta la decide un humano. Pero se
    // imprime en cada corrida, que es la diferencia entre un hueco conocido y uno invisible.
    const huerfanos = (await db.query(`
      SELECT DISTINCT upper(btrim(k.c2)) AS nombre,
             string_agg(DISTINCT btrim(k.sucursal)||':'||btrim(k.c1), ' ') AS claves
        FROM kepler_ods.kdm_chofer k
       WHERE btrim(coalesce(k.c2,'')) <> ''
         AND NOT EXISTS (SELECT 1 FROM logistics.drivers d
                          WHERE d.tenant_id=$1 AND d.deleted_at IS NULL
                            AND upper(btrim(d.full_name)) = upper(btrim(k.c2)))
       GROUP BY 1 ORDER BY 1`, [M])).rows;
    if (huerfanos.length) {
      console.log(`  ⓘ ${huerfanos.length} nombres de chofer del ODS sin fila propia en logistics.drivers (casi todos son la MISMA persona con el nombre abreviado):`);
      for (const h of huerfanos) console.log(`      · ${h.nombre}  [${h.claves}]`);
    }

    // ── Rutas ───────────────────────────────────────────────────────────────────────────
    // Sin clave (ver ⛔ arriba): la identidad sigue siendo el NOMBRE, y lo único que hace
    // falta es que no falte ninguna. El vínculo con `kepler_code` lo puso la mig 20260917130000
    // sólo donde la biyección está comprobada.
    const rutas = (await db.query(`
      SELECT DISTINCT upper(btrim(c2)) AS valor
        FROM kepler_ods.kdm_rutas
       WHERE btrim(coalesce(c2,'')) <> ''
       ORDER BY 1`)).rows;
    const existRt = new Set((await db.query(
      `SELECT upper(btrim(name)) n FROM logistics.routes WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]
    )).rows.map((r) => r.n));
    let rIns = 0;
    for (const rt of rutas) {
      if (existRt.has(rt.valor)) continue;
      await db.query(
        `INSERT INTO logistics.routes (tenant_id, name, active, notes) VALUES ($1,$2,true,$3)`,
        [M, rt.valor, 'Alta desde Kepler (catálogo de rutas)']);
      existRt.add(rt.valor); rIns++;
    }
    console.log(`  routes: +${rIns} nuevas (${rutas.length} nombres distintos en Kepler)`);

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (require.main === module) main();
module.exports = { main };
