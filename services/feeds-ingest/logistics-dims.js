/* eslint-disable no-console */
/**
 * `[CANON.6.18]` Dimensiones de logística de Kepler → `logistics.vehicles` / `drivers` / `routes`, AL LLEGAR el cambio.
 *
 * Antes lo hacía `database/importers/kepler/import-logistics-dims.js` cada noche (KV.8 / EMB.2). La regla es la MISMA
 * —se movió aquí sin cambiarla— y la usan los dos: el hop-2 (`apply-handlers` → `ODS_NORMALIZERS`, acotado a las
 * claves que llegaron de `kdm_transporte` / `kdm_chofer` / `kdm_rutas`) y la herramienta manual (todo el catálogo).
 * Medido antes de retirarlo (13-nov): falló 21 noches seguidas (12-oct → 5-nov, H1 del anexo CANON.5) y, desde que se
 * arregló, 8 noches sin nada que hacer. En toda su vida dio de alta 17 rutas (17-sep → 9-oct) y ninguna unidad ni
 * chofer: esas sólo las ADOPTA (les pone la clave de Kepler a la fila que el GPS o la app ya dieron de alta).
 *
 * Nunca borra: una unidad dada de baja en Kepler puede seguir teniendo viajes, costos y fotos colgando en la Suite.
 * Lo que una persona borró en la app se queda borrado (D3 del anexo CANON.5): las rutas y las unidades por su nombre
 * o placa (el índice único los cuenta aunque estén borrados); desde `[CANON.6.18]` también unidades y choferes por su
 * CLAVE de Kepler — antes, un chofer dado de alta desde Kepler y borrado en la app volvía a nacer cada noche (hoy no
 * hay ninguno: medido el 13-nov, 0 choferes y 8 unidades borradas con clave, ninguna pendiente).
 *
 * ⛔ Las RUTAS no llevan clave y es a propósito (mig 20260917130000): 3 de las 88 claves nombran cosas distintas según
 * la sucursal (`R0001` = HUANIMARO en 7 ramas y ZIROSTO en la 06). La identidad de una ruta es su NOMBRE; la clave que
 * llega sólo sirve para saber qué nombres mirar.
 *
 * `logistics.*` tiene RLS forzado: las funciones `sincronizar*` corren dentro de la transacción de quien llama, con
 * `app.tenant_id` ya puesto. Los `normalize*` (los del hop-2) abren la suya.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertTenant = (t) => { if (!UUID_RE.test(String(t || ''))) throw new Error(`tenant_id inválido: ${t}`); };
const limpias = (ks) => (ks == null ? null : Array.from(new Set((Array.isArray(ks) ? ks : []).map((k) => String(k == null ? '' : k).trim()).filter(Boolean))));
// La clave de cruce de los resolvedores (`analytics.v_kepler_transporte` / `v_kepler_chofer`): sin ceros a la izquierda.
const CLAVE_CRUCE = `(SELECT NULLIF(ltrim(btrim(x), '0'), '') FROM unnest($1::text[]) x)`;

/**
 * Sincroniza un catálogo contra `logistics.<tabla>`, fila por fila y en orden de clave: (1) si ya hay fila viva con esa
 * clave, nada; (2) si hay una viva SIN clave con el mismo atributo, la ADOPTA; (3) si el atributo ya está en cualquier
 * fila (`unico`) o una fila con esa clave fue borrada en la app, no la da de alta y lo declara; (4) la da de alta.
 */
async function sincronizar(db, tenantId, { tabla, filas, campo, insertar, normaliza, unico }) {
  // ⚠️ `normaliza` existe por un defecto REAL (EMB.5): comparar la placa literal creó 8 filas duplicadas — Kepler la
  // escribe `GA-2027-C` y MagniTracking `GA2027C`, así que no se reconocía la unidad que el GPS ya había dado de alta.
  const cmp = normaliza
    ? (c) => `regexp_replace(upper(btrim(${c})),'[^A-Z0-9]','','g')`
    : (c) => `upper(btrim(${c}))`;
  let adoptados = 0, actualizados = 0, insertados = 0;
  const respetadas = [];
  for (const f of filas) {
    const porClave = await db.query(
      `SELECT id FROM logistics.${tabla} WHERE tenant_id=$1 AND kepler_code=$2 AND deleted_at IS NULL`, [tenantId, f.clave]);
    if (porClave.rowCount) {
      // ⛔ NO se pisa el atributo: tras la fusión EMB.5 la fila viva es la del GPS y su placa (`GA2027C`) es la buena
      // para el rastreo. Reescribirla con la forma de Kepler (`GA-2027-C`) desharía la fusión.
      actualizados++;
      continue;
    }
    const porAtributo = await db.query(
      `SELECT id FROM logistics.${tabla}
        WHERE tenant_id=$1 AND kepler_code IS NULL AND deleted_at IS NULL AND ${cmp(campo)}=${cmp('$2')}
        ORDER BY id LIMIT 1`, [tenantId, f.valor]);
    if (porAtributo.rowCount) {
      await db.query(`UPDATE logistics.${tabla} SET kepler_code=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, porAtributo.rows[0].id, f.clave]);
      adoptados++;
      continue;
    }
    // `[CANON.5.6]` El índice único `(tenant_id, <campo>)` cuenta también las borradas: un choque hacía ROLLBACK de todo.
    if (unico) {
      const ocupado = await db.query(
        `SELECT deleted_at IS NOT NULL AS borrada FROM logistics.${tabla} WHERE tenant_id=$1 AND ${campo}=$2 LIMIT 1`, [tenantId, f.valor]);
      if (ocupado.rowCount) { respetadas.push(`${f.valor}${ocupado.rows[0].borrada ? ' (borrada en la app)' : ' (viva con otra clave)'}`); continue; }
    }
    // `[CANON.6.18]` D3 también por CLAVE: la que una persona borró en la app no vuelve a nacer.
    const borradaPorClave = await db.query(
      `SELECT 1 FROM logistics.${tabla} WHERE tenant_id=$1 AND kepler_code=$2 AND deleted_at IS NOT NULL LIMIT 1`, [tenantId, f.clave]);
    if (borradaPorClave.rowCount) { respetadas.push(`${f.valor} (clave ${f.clave} borrada en la app)`); continue; }
    await insertar(db, f);
    insertados++;
  }
  return { tabla, insertados, adoptados, actualizados, respetadas, enKepler: filas.length };
}

/** Unidades (`kdm_transporte` por el resolvedor, que colapsa `00018`/`018`). `claves` = las `c1` que llegaron; null = todas. */
async function sincronizarUnidades(db, tenantId, claves) {
  const ks = limpias(claves);
  if (ks && !ks.length) return { tabla: 'vehicles', insertados: 0, adoptados: 0, actualizados: 0, respetadas: [], enKepler: 0 };
  // DISTINCT ON: la clave es la misma en las ramas (verificado: 0 claves con dos placas). Acotar por la clave de cruce
  // trae TODAS las filas de cada clave elegida, así que el desempate por sucursal es el mismo que sin acotar.
  const filas = (await db.query(`
    SELECT DISTINCT ON (clave_kepler) clave_kepler AS clave, placas AS valor, descripcion
      FROM analytics.v_kepler_transporte
     WHERE placas IS NOT NULL AND ($1::text[] IS NULL OR clave IN ${CLAVE_CRUCE})
     ORDER BY clave_kepler, sucursal`, [ks])).rows;
  return sincronizar(db, tenantId, {
    tabla: 'vehicles', filas, campo: 'plate', normaliza: true, unico: true,
    insertar: (d, f) => d.query(
      `INSERT INTO logistics.vehicles (tenant_id, plate, brand, model, status, active, kepler_code, notes)
       VALUES ($1,$2,'',$3,'disponible',true,$4,$5)`,
      [tenantId, f.valor, f.descripcion || '', f.clave, `Alta desde Kepler (unidad ${f.clave})`]),
  });
}

/** Choferes (`kdm_chofer` por su resolvedor). `claves` = las `c1` que llegaron; null = todas. */
async function sincronizarChoferes(db, tenantId, claves) {
  const ks = limpias(claves);
  if (ks && !ks.length) return { tabla: 'drivers', insertados: 0, adoptados: 0, actualizados: 0, respetadas: [], enKepler: 0 };
  const filas = (await db.query(`
    SELECT DISTINCT ON (clave_kepler) clave_kepler AS clave, nombre AS valor, ambiguo
      FROM analytics.v_kepler_chofer
     WHERE nombre IS NOT NULL AND ($1::text[] IS NULL OR clave IN ${CLAVE_CRUCE})
     ORDER BY clave_kepler, sucursal`, [ks])).rows;
  const r = await sincronizar(db, tenantId, {
    tabla: 'drivers', filas, campo: 'full_name',
    insertar: (d, f) => d.query(
      `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active, kepler_code, notes)
       VALUES ($1,$2,ARRAY['chofer'],'interno','activo',true,$3,$4)`,
      [tenantId, f.valor, f.clave, `Alta desde Kepler (chofer ${f.clave})`]),
  });
  return { ...r, ambiguos: filas.filter((c) => c.ambiguo).length };
}

/**
 * Rutas: la identidad es el NOMBRE (ver ⛔ arriba). `claves` = las `c1` de `kdm_rutas` que llegaron (de cualquier
 * sucursal: es sólo para saber qué nombres mirar); null = todas.
 */
async function sincronizarRutas(db, tenantId, claves) {
  const ks = limpias(claves);
  if (ks && !ks.length) return { tabla: 'routes', insertados: 0, adoptados: 0, actualizados: 0, respetadas: [], enKepler: 0 };
  const rutas = (await db.query(`
    SELECT DISTINCT upper(btrim(c2)) AS valor
      FROM kepler_ods.kdm_rutas
     WHERE btrim(coalesce(c2,'')) <> '' AND ($1::text[] IS NULL OR btrim(c1) = ANY($1::text[]))
     ORDER BY 1`, [ks])).rows;
  if (!rutas.length) return { tabla: 'routes', insertados: 0, adoptados: 0, actualizados: 0, respetadas: [], enKepler: 0 };
  const existRt = new Set((await db.query(
    `SELECT upper(btrim(name)) n FROM logistics.routes WHERE tenant_id=$1 AND deleted_at IS NULL`, [tenantId])).rows.map((r) => r.n));
  // `[CANON.5.6]` El nombre de una ruta BORRADA en la app sigue ocupando el índice único `(tenant_id, name)`:
  // «ZAMORA CANINDO» se borró el 2026-10-12 y desde esa noche el importer no actualizó nada. Se respeta (D3).
  const borradasRt = new Set((await db.query(
    `SELECT name FROM logistics.routes WHERE tenant_id=$1 AND deleted_at IS NOT NULL`, [tenantId])).rows.map((r) => r.name));
  const respetadas = [];
  let insertados = 0;
  for (const rt of rutas) {
    if (existRt.has(rt.valor)) continue;
    if (borradasRt.has(rt.valor)) { respetadas.push(rt.valor); continue; }
    await db.query(`INSERT INTO logistics.routes (tenant_id, name, active, notes) VALUES ($1,$2,true,$3)`,
      [tenantId, rt.valor, 'Alta desde Kepler (catálogo de rutas)']);
    existRt.add(rt.valor); insertados++;
  }
  return { tabla: 'routes', insertados, adoptados: 0, actualizados: rutas.length - insertados - respetadas.length, respetadas, enKepler: rutas.length };
}

// ── Los del hop-2: transacción propia, devuelven cuántas filas de logistics.* escribieron ──────────────────────────
const enTx = async (client, tenantId, fn) => {
  assertTenant(tenantId);
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const r = await fn();
    await client.query('COMMIT');
    return r.insertados + r.adoptados;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
};
async function normalizeVehiclesFromOds(client, tenantId, claves) { return enTx(client, tenantId, () => sincronizarUnidades(client, tenantId, claves)); }
async function normalizeDriversFromOds(client, tenantId, claves) { return enTx(client, tenantId, () => sincronizarChoferes(client, tenantId, claves)); }
async function normalizeRoutesFromOds(client, tenantId, claves) { return enTx(client, tenantId, () => sincronizarRutas(client, tenantId, claves)); }

module.exports = {
  sincronizarUnidades, sincronizarChoferes, sincronizarRutas,
  normalizeVehiclesFromOds, normalizeDriversFromOds, normalizeRoutesFromOds,
};
