/* eslint-disable no-console */
/**
 * `[ZN.0]` — Zona, sucursal y ruta son tres niveles, y se pueden separar.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────
 * El defecto que motivó la fase: `trade.zones` mezclaba CUATRO niveles (zona,
 * sucursal, canal, actividad) en 9 filas, y toda persona apuntaba ahí sin
 * importar a qué se dedica. De ahí salía que 26 personas de tres sucursales
 * distintas compartieran la etiqueta `LA PIEDAD RD`, y que el tablero de
 * dirección mostrara **6 zonas donde el negocio tiene 3**.
 *
 *   [1] Las 3 zonas existen en el ERP — testigo independiente de nuestro catálogo.
 *   [2] `trade.zones` declara de qué nivel es cada fila (`kind`).
 *   [3] `v_branch_zone` resuelve las sucursales a su zona, y el CEDIS se DECLARA
 *       corporativo en vez de quedar en un NULL mudo.
 *   [4] La ruta llega a su zona por su sucursal madre: es el camino que disuelve
 *       la falsa contradicción de `501…505` (catálogo decía ZAMORA, operación
 *       CANINDO: uno daba la zona y el otro la sucursal).
 *   [5] MÉTRICA DE AVANCE (no falla): cuántas personas siguen ancladas a una
 *       fila que no es una zona. Hoy son casi todas; es lo que ZN.2+ cierra.
 *
 * ⚠️ Los bloques 2-4 dependen de la migración `20260923150000`. Donde no esté
 * aplicada se DECLARAN no medidos (exit 2), no se fallan: un rojo permanente
 * enseña a ignorar el tablero.
 *
 * ── Es READ-ONLY y por eso puede correr contra producción ───────────────────
 * No escribe nada, y no es una promesa: abre la sesión con
 * `default_transaction_read_only = on`, así que un INSERT que alguien agregue
 * mañana falla acá y no allá. Por eso tampoco usa `assertSafeTarget`: la data
 * que este candado necesita medir (las 3 zonas, las 9 sucursales, las 18 rutas)
 * **sólo existe en prod**.
 *
 * Correr:  node database/tests/test-newdb-zn-zonas.js
 *   · contra prod:  ZN_DB_URL="<url>" node database/tests/test-newdb-zn-zonas.js
 */

const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const DST =
  process.env.ZN_DB_URL ||
  process.env.DATABASE_URL_NEW ||
  'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

let ok = 0, fail = 0, sinMedir = 0;
const check = (t, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${t}`); }
  else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); }
};
const declarar = (t, motivo) => { sinMedir++; console.log(`  ⓘ NO MEDIDO ${t} — ${motivo}`); };
const info = (t) => console.log(`     → ${t}`);

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy\./i.test(DST) ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  // La guarda de verdad: con esto cualquier escritura revienta.
  await db.query('SET default_transaction_read_only = on');
  await db.query("SET statement_timeout = '30s'");
  const q = async (s, p) => (await db.query(s, p)).rows;

  try {
    // ── [1] El testigo independiente: el ERP ────────────────────────────────
    console.log('\n[1] Las 3 zonas del negocio, según el ERP (kepler_ods.kduk)');
    const zonasErp = await q(`
      SELECT DISTINCT upper(btrim(c2)) nombre
        FROM kepler_ods.kduk
       WHERE btrim(c2) <> ''
       ORDER BY 1`);
    const nombresErp = zonasErp.map((z) => z.nombre);
    const plazas = ['LA PIEDAD', 'MORELIA', 'ZAMORA'];
    for (const p of plazas) {
      check(
        `el ERP conoce la zona ${p}`,
        nombresErp.some((n) => n.includes(p)),
        `no aparece en kduk (${nombresErp.length} nombres)`,
      );
    }
    // NEGATIVA: que no haya una CUARTA plaza que el negocio no mencionó. Si
    // aparece, no es un fallo del código: es que el negocio creció y hay que
    // enterarse acá y no por una pantalla que agrupa mal.
    const otras = nombresErp.filter((n) => !plazas.some((p) => n.includes(p)));
    check(
      'y no hay una cuarta plaza sin declarar',
      otras.length === 0,
      `aparecieron: ${otras.join(' · ')}`,
    );

    // ── [2] El catálogo propio declara su nivel ─────────────────────────────
    console.log('\n[2] trade.zones declara de qué NIVEL es cada fila');
    const tieneKind = (await q(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='trade' AND table_name='zones' AND column_name='kind'`)).length > 0;

    if (!tieneKind) {
      declarar('la clasificación por nivel', 'falta la migración [ZN.0] (trade.zones.kind)');
    } else {
      const porKind = await q(`
        SELECT coalesce(kind,'(sin clasificar)') kind, count(*)::int n,
               string_agg(name, ' · ' ORDER BY orden) nombres
          FROM trade.zones WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1`);
      for (const r of porKind) info(`${r.kind}: ${r.n} — ${r.nombres}`);

      const zonas = porKind.find((r) => r.kind === 'zona');
      check('hay exactamente 3 zonas', (zonas?.n ?? 0) === 3, `hay ${zonas?.n ?? 0}`);
      check(
        'ninguna fila quedó sin clasificar',
        !porKind.some((r) => r.kind === '(sin clasificar)'),
        porKind.find((r) => r.kind === '(sin clasificar)')?.nombres,
      );
      const conCodigo = await q(
        `SELECT count(*)::int n FROM trade.zones WHERE kind='zona' AND code IS NOT NULL AND deleted_at IS NULL`,
      );
      check(
        'y las 3 tienen llave estable (code), no sólo nombre',
        conCodigo[0].n === 3,
        `${conCodigo[0].n} con code — el JWT viaja con el NOMBRE, así que renombrar sin code rompe`,
      );
    }

    // ── [3] Sucursal → zona ─────────────────────────────────────────────────
    console.log('\n[3] Cada sucursal de la red resuelve a su zona');
    const hayVista = (await q(`
      SELECT 1 FROM information_schema.views
       WHERE table_schema='analytics' AND table_name='v_branch_zone'`)).length > 0;

    if (!hayVista) {
      declarar('el resolvedor sucursal → zona', 'falta la vista analytics.v_branch_zone ([ZN.0])');
    } else {
      const arbol = await q(`
        SELECT coalesce(zona_code,'(sin zona)') zona_code, count(*)::int n,
               string_agg(branch_short, ' ' ORDER BY branch_code) sucursales
          FROM analytics.v_branch_zone WHERE NOT es_corporativo GROUP BY 1 ORDER BY 1`);
      for (const r of arbol) info(`${r.zona_code}: ${r.sucursales}`);
      check('las 3 zonas tienen sucursales', arbol.filter((r) => r.zona_code !== '(sin zona)').length === 3);
      check(
        'ninguna sucursal de la red quedó sin zona',
        !arbol.some((r) => r.zona_code === '(sin zona)'),
        arbol.find((r) => r.zona_code === '(sin zona)')?.sucursales,
      );
      const corp = await q(`SELECT branch_short FROM analytics.v_branch_zone WHERE es_corporativo`);
      check(
        'y el CEDIS se DECLARA corporativo en vez de colgar de una plaza',
        corp.length >= 1,
        'sin fila corporativa: ¿a qué zona quedó el CEDIS?',
      );
    }

    // ── [4] Ruta → sucursal → zona ──────────────────────────────────────────
    console.log('\n[4] La ruta llega a su zona POR SU SUCURSAL (la falsa contradicción 501-505)');
    const hayRutas = (await q(`
      SELECT 1 FROM information_schema.views
       WHERE table_schema='analytics' AND table_name='v_route_zone'`)).length > 0;

    if (!hayRutas || !hayVista) {
      declarar('el camino ruta → zona', 'falta v_route_zone o v_branch_zone');
    } else {
      /*
       * `v_route_zone` ya resuelve la SUCURSAL madre (`parent_code`, desde
       * `wincaja.branches.parent_branch`) — de ahí a la zona es un solo salto.
       * Su columna `zona_name` sigue mostrando el catálogo VIEJO (mezclado):
       * para la 501 dice `CANINDO`, que es la sucursal, no la zona.
       */
      const rutas = await q(`
        SELECT coalesce(bz.zona_code,'(sin zona)') zona_code, count(*)::int n,
               string_agg(rz.route_code, ' ' ORDER BY rz.route_code) codigos
          FROM analytics.v_route_zone rz
          JOIN analytics.v_branch_zone bz
            ON bz.tenant_id = rz.tenant_id AND bz.branch_code = rz.parent_code
         GROUP BY 1 ORDER BY 1`);
      for (const r of rutas) info(`${r.zona_code}: ${r.codigos}`);
      const total = rutas.reduce((a, r) => a + r.n, 0);
      const { rows: [{ n: totalRutas }] } = { rows: await q(`SELECT count(*)::int n FROM analytics.v_route_zone`) };
      check(
        'todas las rutas llegan a una zona por su sucursal madre',
        total === Number(totalRutas) && !rutas.some((r) => r.zona_code === '(sin zona)'),
        `${total} de ${totalRutas} resueltas`,
      );
      const zam = rutas.find((r) => r.zona_code === 'ZAM');
      check(
        '⭐ las rutas 501-505 caen en ZAMORA vía su sucursal madre CANINDO (la «contradicción» era mezcla de niveles)',
        !!zam && ['501', '502', '503', '504', '505'].every((c) => (zam.codigos || '').includes(c)),
        zam ? `ZAM trae: ${zam.codigos}` : 'ninguna ruta resolvió a ZAM',
      );
    }

    // ── [5] ¿Se puede encender el filtro? ───────────────────────────────────
    /*
     * `[ZN.2]` El selector de sucursales pasa a salir de `me/scope` en vez del
     * array del bundle. Antes de encenderlo hay que comprobar que el ALCANCE
     * GUARDADO resuelve contra el universo vigente: una regla que apunta a una
     * sucursal que ya no existe devuelve `options: []`, y esa persona se queda
     * sin su sucursal el día que la pantalla obedezca.
     *
     * No es hipotético: al medirlo aparecieron **4 personas de ruta de Morelia
     * Madero** con alcance `'32'` (la llave Wincaja), que dejó de existir cuando
     * Madero migró su POS a Kepler como `'07'`. Hoy no se nota porque el front
     * ignora el alcance — el fail-open estaba tapando un dato roto.
     *
     * Mientras queden, se DECLARAN con nombre y remedio en vez de fallar: un
     * rojo permanente enseña a ignorar el tablero, y lo que falta es aplicar
     * `20260923160000`, no arreglar código.
     */
    console.log('\n[5] ¿El alcance guardado resuelve? (condición para encender ZN.2)');
    const ciegos = await q(`
      WITH uni AS (
        SELECT CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END AS v
          FROM commercial.warehouses w
         WHERE w.deleted_at IS NULL
           AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END) ~ '^[0-9]{2}$')
      SELECT u.username, u.department_code depto, us.values
        FROM identity.user_scopes us
        JOIN identity.users u ON u.id = us.user_id AND u.deleted_at IS NULL AND u.activo
       WHERE us.dimension = 'warehouse' AND us.mode = 'listed'
         AND NOT EXISTS (SELECT 1 FROM uni WHERE uni.v = ANY(us.values))
       ORDER BY 1`);
    if (ciegos.length === 0) {
      check('ninguna persona activa tiene un alcance que no resuelva a ninguna sucursal', true);
    } else {
      declarar(
        `${ciegos.length} persona(s) con alcance que no resuelve`,
        `${ciegos.map((c) => `${c.username} [${(c.values || []).join(',')}]`).join(' · ')} — ` +
          `aplicar la migración 20260923160000 ([ZN.2.0]) antes de que el selector obedezca al alcance`,
      );
    }

    // ── [6] Métrica de avance — NO falla ────────────────────────────────────
    console.log('\n[6] Cuánto falta (métrica, no candado)');
    if (!tieneKind) {
      declarar('la métrica de personas mal ancladas', 'sin `kind` no se puede distinguir el nivel');
    } else {
      const mal = await q(`
        SELECT coalesce(z.kind,'(sin clasificar)') nivel, count(*)::int n
          FROM identity.users u
          JOIN trade.zones z ON z.id = u.zona_id
         WHERE u.deleted_at IS NULL AND u.activo
         GROUP BY 1 ORDER BY 2 DESC`);
      for (const r of mal) info(`personas ancladas a una fila de nivel "${r.nivel}": ${r.n}`);
      const noZona = mal.filter((r) => r.nivel !== 'zona').reduce((a, r) => a + r.n, 0);
      info(
        noZona === 0
          ? 'todas las personas cuelgan de una ZONA real'
          : `${noZona} personas cuelgan de algo que no es una zona (sucursal/canal/oficina) — lo cierra ZN.2+`,
      );
      // Y el dato que le toca a cada actividad, que es el pedido de fondo.
      const anclas = await q(`
        SELECT CASE
                 WHEN department_code IN ('tienda','cajas') THEN 'tienda'
                 WHEN department_code IN ('ruta_directa','ruta_vecinal') THEN 'ruta'
                 ELSE 'oficina/otro' END actividad,
               count(*)::int personas,
               count(warehouse_code)::int con_sucursal,
               count(route_id)::int con_ruta
          FROM identity.users
         WHERE deleted_at IS NULL AND activo
         GROUP BY 1 ORDER BY 1`);
      for (const r of anclas) {
        info(`${r.actividad}: ${r.personas} personas · ${r.con_sucursal} con sucursal · ${r.con_ruta} con ruta`);
      }
    }
  } catch (e) {
    fail++;
    console.log(`  ❌ excepción inesperada — ${e.message}`);
  } finally {
    await db.end().catch(() => undefined);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} [ZN.0] ${ok} ok, ${fail} fallo(s), ${sinMedir} no medido(s)`);
  process.exit(fail === 0 ? (sinMedir ? 2 : 0) : 1);
})();
