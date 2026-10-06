'use strict';
/**
 * `[SN.40]` Candado de «Tus accesos» — la cascada vos → puesto → departamento que alimenta
 * `GET /telemetry/suite/mios`.
 *
 *   node database/tests/test-newdb-suite-accesos.js
 *
 * Sólo lee.
 *
 * ── QUÉ PROTEGE, Y POR QUÉ ESTA FASE NECESITA UN CANDADO ─────────────────────────────────
 *
 * El defecto que originó todo esto no fue una cifra fea: fue que el registro de clics llevaba
 * un mes escribiendo y **nadie lo leía**, y nada se veía roto. Ahora que se lee, las formas de
 * fallar en silencio son otras tres, y las tres producen una pantalla que parece sana:
 *
 *  1. **Que la cascada rellene con algo inventado.** Si alguna vez se "completa" la fila con
 *     los primeros destinos del mapa, la persona vería seis atajos que nadie usa, presentados
 *     como lo que su equipo abre. Un hueco se nota; un relleno plausible, no.
 *  2. **Que un atajo tuyo vuelva etiquetado como prestado** (o al revés). El `origen` es lo
 *     único que separa una sugerencia de una sorpresa, y si la precedencia se rompe, la
 *     etiqueta miente sin que ninguna cifra cambie.
 *  3. **Que se filtren los clics de otro tenant.** `portal_telemetry_events` **no tiene RLS**
 *     (verificado acá, no asumido): el aislamiento depende de un `WHERE` escrito a mano, que
 *     es exactamente la clase de cosa que una refactorización borra sin querer.
 *
 * ── Y una cuarta, que no es un bug sino una PREMISA que puede caducar ────────────────────
 *
 * La cascada existe porque se midió que la historia propia no alcanza para la mayoría. Si eso
 * dejara de ser cierto —porque la gente ya usa la suite todos los días— el relleno por grupo
 * pasaría de ayuda a ruido. Se vigila la premisa, no sólo el código.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const TENANT = process.env.DEFAULT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DIAS = 90;
const LIMITE = 12;

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

/**
 * La MISMA consulta que `CommercialTelemetryService.misAccesos`. Se copia a propósito: el
 * candado tiene que poder correr contra prod sin levantar el API (que está prohibido), y una
 * copia que se desincronice se delata en la aserción de precedencia, que es estructural.
 */
const SQL = `
WITH yo AS (
  SELECT position_code, department_code FROM identity.users
   WHERE id = ? AND tenant_id = ?
), ev AS (
  SELECT e.user_id, e.props->>'id' AS id, e.created_at
    FROM commercial.portal_telemetry_events e
   WHERE e.name = 'abrio_puerta' AND e.tenant_id = ?
     AND e.created_at >= now() - make_interval(days => ?)
     AND coalesce(e.props->>'id','') <> ''
), mio AS (
  SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
         1 AS personas, 'mio'::text AS origen, 1 AS prio
    FROM ev WHERE user_id = ? GROUP BY 1
), pares_puesto AS (
  SELECT u.id FROM identity.users u, yo
   WHERE u.tenant_id = ? AND u.id <> ? AND u.deleted_at IS NULL
     AND yo.position_code IS NOT NULL AND u.position_code = yo.position_code
), puesto AS (
  SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
         count(DISTINCT user_id)::int AS personas, 'puesto'::text AS origen, 2 AS prio
    FROM ev WHERE user_id IN (SELECT id FROM pares_puesto) GROUP BY 1
), pares_depto AS (
  SELECT u.id FROM identity.users u, yo
   WHERE u.tenant_id = ? AND u.id <> ? AND u.deleted_at IS NULL
     AND yo.department_code IS NOT NULL AND u.department_code = yo.department_code
), depto AS (
  SELECT id, count(*)::int AS clics, max(created_at) AS ultimo_at,
         count(DISTINCT user_id)::int AS personas, 'departamento'::text AS origen, 3 AS prio
    FROM ev WHERE user_id IN (SELECT id FROM pares_depto) GROUP BY 1
), todas AS (
  SELECT * FROM mio UNION ALL SELECT * FROM puesto UNION ALL SELECT * FROM depto
), mejor AS (
  SELECT DISTINCT ON (id) * FROM todas ORDER BY id, prio
)
SELECT id, clics, ultimo_at, personas, origen,
       (SELECT count(*)::int FROM mio) AS propias
  FROM mejor ORDER BY prio, clics DESC, ultimo_at DESC NULLS LAST LIMIT ?`;

const correr = (db, uid, tenant = TENANT, limite = LIMITE) =>
  db.raw(SQL, [uid, tenant, tenant, DIAS, uid, tenant, uid, tenant, uid, limite])
    .then((r) => r.rows);

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [SN.40] «Tus accesos»: la cascada vos → puesto → departamento ===\n');
  try {
    const [{ hay }] = (await db.raw(
      `SELECT to_regclass('commercial.portal_telemetry_events') IS NOT NULL AS hay`)).rows;
    if (!hay) {
      noMedido('todo el candado', 'este destino no tiene la tabla de telemetría');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy();
      process.exit(0);
    }

    // ── 0. La premisa de aislamiento: esta tabla NO tiene RLS, así que el WHERE es la única
    //       defensa. Se verifica el hecho, no se confía en el comentario del servicio.
    {
      const [r] = (await db.raw(`
        SELECT relrowsecurity AS rls_eventos,
               (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='identity' AND c.relname='users') AS rls_users
          FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
         WHERE n.nspname='commercial' AND cl.relname='portal_telemetry_events'`)).rows;
      t('⛔ portal_telemetry_events sigue SIN RLS → el filtro de tenant es obligatorio en la query',
        r.rls_eventos === false, `rls=${r.rls_eventos}`);
      t('identity.users SÍ tiene RLS → la consulta tiene que correr dentro de tk.run()',
        r.rls_users === true, `rls=${r.rls_users}`);
    }

    // ── 1. El índice que sostiene el tiempo de respuesta ────────────────────────────────
    {
      const { rows } = await db.raw(`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname='commercial' AND indexname='idx_portal_tel_aperturas'`);
      if (!rows.length) {
        noMedido('el índice parcial de aperturas',
          'la migración 20261006100000 no corrió contra este destino; la consulta funciona igual '
          + 'por seq scan, y eso deja de alcanzar cuando la tabla llegue a seis cifras');
      } else {
        t('el índice de aperturas es PARCIAL (deja afuera la avalancha de web_vital)',
          /abrio_puerta/.test(rows[0].indexdef), rows[0].indexdef);
      }
    }

    // ── 2. Casos reales: alguien con historia propia y alguien en arranque en frío ──────
    const casos = (await db.raw(`
      SELECT u.id, u.username, u.position_code, u.department_code,
             (SELECT count(DISTINCT e.props->>'id')::int
                FROM commercial.portal_telemetry_events e
               WHERE e.user_id = u.id AND e.name='abrio_puerta'
                 AND e.created_at >= now() - make_interval(days => ?)) AS mias
        FROM identity.users u
       WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.activo
       ORDER BY mias DESC`, [DIAS, TENANT])).rows;

    const conHistoria = casos.find((u) => Number(u.mias) >= 3);
    const enFrio = casos.find((u) => Number(u.mias) === 0 && u.position_code);

    if (!conHistoria) {
      noMedido('la precedencia sobre un caso real', 'nadie en este destino tiene 3+ puertas abiertas');
    } else {
      const filas = await correr(db, conHistoria.id);
      t(`devuelve a lo sumo ${LIMITE} (${conHistoria.username}: ${filas.length})`,
        filas.length <= LIMITE, `n=${filas.length}`);
      t('ninguna puerta se repite',
        new Set(filas.map((f) => f.id)).size === filas.length);
      /*
       * ⛔ PRECEDENCIA, contra un testigo INDEPENDIENTE.
       *
       * La primera versión de esta aserción no servía: era `A || B` con un `B` trivialmente
       * cierto, así que se ponía verde pase lo que pase. Se descubrió mutando la consulta
       * (`ORDER BY id, prio DESC`, que invierte la cascada y hace que el área le gane a lo tuyo)
       * y viendo que el candado NO se ponía rojo.
       *
       * La forma correcta es preguntarle a la base, por separado, qué puertas abrió ESTA persona
       * y exigir que cada una de ésas venga etiquetada `mio`. Un candado que compara la consulta
       * consigo misma no prueba nada — ver [[feedback_cross_check_two_implementations]].
       */
      const propias = new Set((await db.raw(`
        SELECT DISTINCT props->>'id' AS id FROM commercial.portal_telemetry_events
         WHERE user_id = ? AND name='abrio_puerta' AND tenant_id = ?
           AND created_at >= now() - make_interval(days => ?)
           AND coalesce(props->>'id','') <> ''`,
        [conHistoria.id, TENANT, DIAS])).rows.map((r) => r.id));
      const malEtiquetadas = filas.filter((f) => propias.has(f.id) && f.origen !== 'mio');
      t(`⛔ PRECEDENCIA: las ${propias.size} puertas que esta persona abrió vienen como \`mio\``,
        malEtiquetadas.length === 0,
        malEtiquetadas.map((f) => `${f.id}→${f.origen}`).join(', '));
      t('⛔ y al revés: nada se etiqueta `mio` sin que ella lo haya abierto',
        filas.filter((f) => f.origen === 'mio').every((f) => propias.has(f.id)),
        filas.filter((f) => f.origen === 'mio' && !propias.has(f.id)).map((f) => f.id).join(', '));
      t('las de origen `mio` tienen clics > 0 (si son tuyas, las abriste)',
        filas.filter((f) => f.origen === 'mio').every((f) => Number(f.clics) > 0));
      t('el orden es por origen primero: no se intercala una prestada entre dos tuyas',
        (() => {
          const prio = { mio: 1, puesto: 2, departamento: 3 };
          return filas.every((f, i) => i === 0 || prio[filas[i - 1].origen] <= prio[f.origen]);
        })(), filas.map((f) => f.origen).join(','));
      t('`propias` coincide con las puertas que esa persona abrió de verdad',
        filas.length === 0 || Number(filas[0].propias) === Number(conHistoria.mias),
        `propias=${filas[0]?.propias} medidas=${conHistoria.mias}`);
    }

    // ── 3. ⛔ PRUEBA NEGATIVA: el arranque en frío NO inventa relleno ───────────────────
    // Si alguna vez se completara con los primeros destinos del mapa, acá saldrían filas con
    // `clics = 0`. Una sugerencia sin un solo clic detrás es un atajo inventado.
    if (!enFrio) {
      noMedido('el arranque en frío', 'todas las personas de este destino ya tienen clics propios');
    } else {
      const filas = await correr(db, enFrio.id);
      t(`NEGATIVA: en arranque en frío, propias es 0 (${enFrio.username})`,
        filas.length === 0 || Number(filas[0].propias) === 0, `propias=${filas[0]?.propias}`);
      t('NEGATIVA: ninguna sugerencia llega con 0 clics — no hay relleno inventado',
        filas.every((f) => Number(f.clics) > 0), JSON.stringify(filas.filter((f) => !Number(f.clics))));
      t('NEGATIVA: nada se etiqueta `mio` para quien no abrió nada',
        filas.every((f) => f.origen !== 'mio'), filas.map((f) => f.origen).join(','));
      if (filas.length === 0) {
        console.log('    (su puesto y su área tampoco tienen clics: devuelve vacío, que es lo correcto)');
      }
    }

    // ── 4. ⛔ PRUEBA NEGATIVA del aislamiento: con otro tenant no sale NADA ─────────────
    // Sin esta aserción, borrar el `WHERE e.tenant_id = ?` pasaría todos los demás candados.
    if (!conHistoria) {
      noMedido('el aislamiento por tenant', 'no hay un caso con historia con el cual contrastar');
    } else {
      const ajeno = '00000000-0000-0000-0000-0000000000ff';
      const filas = await correr(db, conHistoria.id, ajeno);
      t('⛔ NEGATIVA: pedido con OTRO tenant, la cascada devuelve vacío',
        filas.length === 0, `n=${filas.length}`);
    }

    // ── 5. La PREMISA que justifica la cascada, vigilada ────────────────────────────────
    // No es un invariante de código: es la medición de negocio que hace que el relleno por
    // grupo valga la pena. Si deja de ser cierta, el diseño se revisa — no el código.
    {
      const [p] = (await db.raw(`
        WITH x AS (
          SELECT user_id, count(DISTINCT props->>'id')::int AS d
            FROM commercial.portal_telemetry_events
           WHERE name='abrio_puerta' AND user_id IS NOT NULL AND tenant_id = ?
             AND created_at >= now() - make_interval(days => ?)
           GROUP BY 1)
        SELECT (SELECT count(*)::int FROM identity.users
                 WHERE tenant_id = ? AND deleted_at IS NULL AND activo) AS activos,
               (SELECT count(*)::int FROM x)                            AS con_clics,
               (SELECT count(*)::int FROM x WHERE d >= 6)               AS llenan_la_fila`,
        [TENANT, DIAS, TENANT])).rows;
      const activos = Number(p.activos), conClics = Number(p.con_clics), llenan = Number(p.llenan_la_fila);
      if (!activos) {
        noMedido('la premisa de la cascada', 'no hay usuarios activos en este destino');
      } else {
        const pct = ((llenan / activos) * 100).toFixed(1);
        console.log(`    medido: ${activos} activos · ${conClics} con clics · ${llenan} llenan los 6 solos (${pct}%)`);
        t(`la cascada sigue siendo necesaria: menos de la mitad llena la fila sola (${pct}%)`,
          llenan * 2 < activos,
          'si esto se pone rojo NO es un bug: significa que ya casi todos tienen historia propia '
          + 'y el relleno por puesto pasó de ayuda a ruido. Revisar el diseño, no el código.');
      }
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
