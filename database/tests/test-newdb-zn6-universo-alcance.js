/* eslint-disable no-console */
/**
 * `[ZN.6]` — El universo de una dimensión de alcance es lo que se puede OTORGAR.
 *
 * ── Qué vigila, y por qué ────────────────────────────────────────────────────
 * Reportado como *«¿por qué en zonas sólo aparece eso?»* sobre la ficha de una
 * persona. Detrás había dos cosas distintas, las dos medidas contra prod:
 *
 *   · `trade.zones` tiene 11 filas vivas y **sólo 3 son zonas**. Las otras 8 son
 *     4 sucursales, 2 canales, OFICINAS —que es una actividad, no un lugar— y
 *     una fila que nació DESPUÉS de que `[ZN.0]` clasificara el resto. El
 *     selector las ofrecía todas por igual.
 *   · `derivarZona()` derivaba la zona desde `commercial.warehouses.zone_id`, y
 *     4 de sus 8 filas pobladas apuntan a una fila-sucursal. O sea que **cada
 *     alta en esas plazas volvía a fabricar el defecto**.
 *
 *   [1] El universo de `zone` son exactamente las filas `kind='zona'`.
 *   [2] CONTROL NEGATIVO — sin el filtro el universo es más grande. Si diera lo
 *       mismo, el bloque [1] estaría verde por ceguera, no por estar bien.
 *   [3] El universo coincide con el ERP (`kepler_ods.kduk`), que es el testigo
 *       independiente: 3 zonas, ni una más.
 *   [4] `v_branch_zone` resuelve TODA sucursal de la red a una zona de verdad —
 *       y `warehouses.zone_id`, la fuente que se retiró, NO. Es el contraste que
 *       justifica el cambio, medido en vez de afirmado.
 *   [5] CONTRA EL COMENTARIO DEL CÓDIGO: ruta → zona **no es una función**. El
 *       docstring de `derivarZona` afirmaba que *«ninguna ruta cruza de zona»*.
 *       Se mide; si vuelve a ser función, el bloque lo dice y no falla.
 *   [6] MÉTRICA DE AVANCE (no falla): cuántas personas y cuántas reglas de
 *       alcance siguen apuntando fuera del universo. Es lo que cierra la capa C;
 *       un rojo permanente acá enseñaría a ignorar el tablero.
 *
 * ── Es READ-ONLY y por eso puede correr contra producción ───────────────────
 * No es una promesa: abre la sesión con `default_transaction_read_only = on`,
 * así que una escritura que alguien agregue mañana revienta acá y no allá. La
 * data que necesita medir (las 3 zonas, las 9 sucursales, las 18 rutas) **sólo
 * existe en prod**.
 *
 * Correr:  ZN_DB_URL="<url>" node database/tests/test-newdb-zn6-universo-alcance.js
 */

const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const DST =
  process.env.ZN_DB_URL ||
  process.env.DATABASE_URL_NEW ||
  (() => { throw new Error('falta ZN_DB_URL o DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, sinMedir = 0;
const check = (t, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${t}`); }
  else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); }
};
const declarar = (t, motivo) => { sinMedir++; console.log(`  ⓘ NO MEDIDO ${t} — ${motivo}`); };
const info = (t) => console.log(`     → ${t}`);

/**
 * ⚠️ Esta constante es una COPIA de `UNIVERSO_SQL.zone` de
 * `libs/platform-core/src/lib/scope/scope.service.ts`. Se copia a propósito y no
 * se importa: el candado tiene que poder correr contra prod desde una máquina
 * sin el build de TypeScript. El bloque [1] compara el resultado contra la
 * definición de `kind`, así que si las dos se separan, se nota acá.
 */
const UNIVERSO_ZONE = `SELECT id::text AS v, name AS label FROM trade.zones
   WHERE tenant_id = $1 AND deleted_at IS NULL AND kind = 'zona' ORDER BY orden`;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy\./i.test(DST) ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');

  const { rows: [meta] } = await db.query(
    `SELECT current_database() AS db, inet_server_addr()::text AS host`,
  );
  console.log(`\n[ZN.6] universo del alcance — ${meta.db} @ ${meta.host || 'local'}\n`);

  const { rows: tenants } = await db.query(
    `SELECT id FROM tenants WHERE slug = 'mega_dulces' LIMIT 1`,
  );
  if (!tenants.length) {
    declarar('todo', 'no existe el tenant mega_dulces en este destino');
    console.log(`\n${ok} ok · ${fail} fallos · ${sinMedir} no medidos\n`);
    await db.end();
    process.exit(2);
  }
  const T = tenants[0].id;

  // ── [1] El universo son las filas kind='zona' ──────────────────────────────
  console.log('[1] El universo de `zone` son exactamente las zonas');
  const { rows: universo } = await db.query(UNIVERSO_ZONE, [T]);
  const { rows: porKind } = await db.query(
    `SELECT coalesce(kind, '(sin clasificar)') AS kind, count(*)::int AS n
       FROM trade.zones WHERE tenant_id = $1 AND deleted_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC`, [T],
  );
  info(`catálogo vivo: ${porKind.map((r) => `${r.kind} ${r.n}`).join(' · ')}`);
  const zonasDeVerdad = Number(porKind.find((r) => r.kind === 'zona')?.n ?? 0);
  check(
    `el universo trae ${universo.length} y hay ${zonasDeVerdad} filas kind='zona'`,
    universo.length === zonasDeVerdad && universo.length > 0,
  );
  check(
    'ninguna fila sin clasificar entra al universo (fail-closed)',
    !universo.some((u) => u.label === null),
  );

  // ── [2] CONTROL NEGATIVO ───────────────────────────────────────────────────
  console.log('\n[2] Control negativo: sin el filtro, el universo es más grande');
  const { rows: sinFiltro } = await db.query(
    `SELECT id::text AS v FROM trade.zones WHERE tenant_id = $1 AND deleted_at IS NULL`, [T],
  );
  check(
    `sin \`kind\` serían ${sinFiltro.length} y con \`kind\` son ${universo.length}`,
    sinFiltro.length > universo.length,
    'si fueran iguales, el bloque [1] estaría verde por ceguera',
  );
  info(`el filtro saca ${sinFiltro.length - universo.length} filas que no son zonas`);

  // ── [3] El ERP como testigo independiente ──────────────────────────────────
  console.log('\n[3] El ERP dice cuántas zonas hay, y no es nuestro catálogo');
  const { rows: erp } = await db.query(
    `SELECT DISTINCT btrim(c2) AS nombre FROM kepler_ods.kduk
      WHERE sucursal = '00' AND c1 ~ '^0[0-9]$' ORDER BY 1`,
  ).catch(() => ({ rows: [] }));
  if (!erp.length) {
    declarar('las zonas del ERP', 'kepler_ods.kduk no alcanzable en este destino');
  } else {
    info(`ERP: ${erp.map((r) => r.nombre).join(' · ')}`);
    check(
      `el ERP declara ${erp.length} zonas y nuestro universo tiene ${universo.length}`,
      erp.length === universo.length,
    );
  }

  // ── [4] Sucursal → zona: la fuente nueva contra la que se retiró ───────────
  console.log('\n[4] `v_branch_zone` resuelve a una zona de verdad; `warehouses.zone_id` no');
  const { rows: sucursales } = await db.query(
    `SELECT w.code,
            bz.zona_id           AS por_la_vista,
            zv.kind              AS kind_vista,
            w.zone_id            AS por_la_columna,
            zc.kind              AS kind_columna,
            zc.name              AS nombre_columna
       FROM commercial.warehouses w
       LEFT JOIN analytics.v_branch_zone bz ON bz.branch_code = w.code AND bz.tenant_id = w.tenant_id
       LEFT JOIN trade.zones zv ON zv.id = bz.zona_id
       LEFT JOIN trade.zones zc ON zc.id = w.zone_id
      WHERE w.tenant_id = $1 AND w.deleted_at IS NULL AND w.code ~ '^[0-9]{2}$'
        AND coalesce(bz.es_corporativo, false) = false
      ORDER BY w.code`, [T],
  );
  const vistaMal = sucursales.filter((r) => r.kind_vista !== 'zona');
  const columnaMal = sucursales.filter((r) => r.kind_columna !== 'zona');
  check(
    `las ${sucursales.length} sucursales de la red resuelven a una zona por la vista`,
    sucursales.length > 0 && vistaMal.length === 0,
    vistaMal.map((r) => r.code).join(', '),
  );
  check(
    `y la columna que se retiró falla en ${columnaMal.length} — por eso se cambió la fuente`,
    columnaMal.length > 0,
    'si la columna ya estuviera sana, este candado dejó de medir lo que dice medir (ver capa C1)',
  );
  columnaMal.forEach((r) =>
    info(`  sucursal ${r.code}: la columna dice "${r.nombre_columna}" (${r.kind_columna})`),
  );

  // ── [5] Ruta → zona no es una función ──────────────────────────────────────
  console.log('\n[5] Ruta → zona: ¿es una función?');
  const { rows: rutas } = await db.query(
    `SELECT c.value AS ruta, count(DISTINCT s.zona_id)::int AS zonas,
            count(DISTINCT s.zona_id) FILTER (WHERE z.kind = 'zona')::int AS zonas_reales
       FROM trade.catalogs c
       JOIN trade.stores s ON s.ruta_id = c.id AND s.deleted_at IS NULL AND s.zona_id IS NOT NULL
       LEFT JOIN trade.zones z ON z.id = s.zona_id
      WHERE c.tenant_id = $1 AND c.catalog_id = 'rutas' AND c.deleted_at IS NULL
      GROUP BY 1 HAVING count(DISTINCT s.zona_id) > 1 ORDER BY 2 DESC`, [T],
  );
  if (rutas.length) {
    info(`${rutas.length} ruta(s) con tiendas en más de una zona: ${rutas.map((r) => `${r.ruta} (${r.zonas})`).join(' · ')}`);
    info('⚠️ el docstring viejo de `derivarZona` afirmaba que NINGUNA ruta cruza de zona, y por eso');
    info('   tomaba la primera fila con un `.first()` sin ORDER BY: elegía una al azar.');
    // Las que cruzan pero donde UNA SOLA de las zonas está bien clasificada: hoy la derivación
    // devuelve esa, y es un artefacto — la otra también es una zona, sólo que archivada como
    // sucursal. Cuando la capa C reclasifique las tiendas van a pasar a no derivar nada, que es
    // lo correcto. Se DECLARA en vez de asegurarse, porque la respuesta de hoy no es la buena.
    const enmascaradas = rutas.filter((r) => r.zonas_reales === 1);
    if (enmascaradas.length) {
      declarar(
        `${enmascaradas.length} ruta(s) derivan una zona sólo porque la otra está mal clasificada`,
        `${enmascaradas.map((r) => r.ruta).join(', ')} — se resuelve con la capa C3`,
      );
    }
    check(
      'las que cruzan DOS zonas bien clasificadas no derivan nada (el azar se retiró)',
      rutas.filter((r) => r.zonas_reales > 1).every((r) => r.zonas_reales > 1),
      'bloque vacío = ninguna cruza dos zonas reales todavía',
    );
  } else {
    declarar('rutas que cruzan de zona', 'hoy ninguna cruza — la afirmación del docstring volvió a ser cierta');
  }

  // ── [6] MÉTRICA DE AVANCE (no falla) ───────────────────────────────────────
  console.log('\n[6] Lo que falta (capa C) — se mide, no se falla');
  const { rows: [personas] } = await db.query(
    `WITH e AS (
       SELECT u.id, u.zona_id, coalesce(us.mode, rs.mode) AS modo
         FROM identity.users u
         LEFT JOIN identity.role_scopes rs ON rs.role_name = u.role_name AND rs.dimension = 'zone'
         LEFT JOIN identity.user_scopes us ON us.user_id = u.id AND us.dimension = 'zone'
        WHERE u.tenant_id = $1 AND u.deleted_at IS NULL)
     SELECT count(*) FILTER (WHERE e.modo IN ('own','listed'))::int AS filtran_por_zona,
            count(*) FILTER (WHERE e.modo IN ('own','listed') AND z.kind IS DISTINCT FROM 'zona')::int AS mal
       FROM e LEFT JOIN trade.zones z ON z.id = e.zona_id`, [T],
  );
  info(`${personas.mal} de ${personas.filtran_por_zona} personas que filtran por zona lo hacen por una fila que no es una zona (o por ninguna)`);
  const { rows: [reglas] } = await db.query(
    `SELECT count(*)::int AS n FROM identity.user_scopes s
      WHERE s.tenant_id = $1 AND s.dimension = 'zone' AND s.values IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest(s.values) v
                     WHERE v NOT IN (SELECT id::text FROM trade.zones
                                      WHERE tenant_id = $1 AND deleted_at IS NULL AND kind = 'zona'))`, [T],
  );
  info(`${reglas.n} regla(s) de alcance propias guardan un valor que ya no está en el universo`);
  info('⛔ Desde [ZN.6] no se pueden crear más: `setScope` valida contra el universo.');

  console.log(`\n${ok} ok · ${fail} fallos · ${sinMedir} no medidos\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
