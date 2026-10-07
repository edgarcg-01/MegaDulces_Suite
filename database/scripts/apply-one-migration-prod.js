/* eslint-disable no-console */
/**
 * Aplica UNA migración de `migrations-newdb` a PROD, por nombre de archivo.
 *
 *   node database/scripts/apply-one-migration-prod.js --list
 *   node database/scripts/apply-one-migration-prod.js 20260903170000_algo.js
 *
 * ── ⛔ LEER ESTO ANTES DE CORRERLO: EL `.env` APUNTA A LA BASE EQUIVOCADA ────────────────────
 *
 * Este script leía `FLEET_DB_URL` a secas. Medido el 2026-09-24, esa variable en el `.env` de
 * esta máquina sigue diciendo **`trolley.proxy.rlwy.net` (Railway)** aunque prod se mudó a
 * **`md` (192.168.0.222)** el 2026-09-22. O sea que el camino documentado para migrar prod
 * llevaba, en silencio, a un clúster que ya no es prod — y una migración aplicada allá se ve
 * exactamente igual de exitosa que una aplicada acá.
 *
 * No es hipotético: es la misma clase de error que dejó al respaldo de prod volcando Railway
 * durante días (ver `ops/prod/backup-prod.sh`, «Compuerta 1-bis»). Un destino equivocado no
 * falla: **triunfa en el lugar equivocado**, y eso no deja rastro que alguien vaya a mirar.
 *
 * Por eso este script ahora **verifica la IDENTIDAD del clúster** (`pg_control_system()`) antes
 * de escribir una sola fila, y se niega si no es la de prod. La identidad no se puede confundir
 * con la forma: una restauración de prod tiene las mismas tablas y los mismos datos, y otro
 * identificador.
 *
 * ── Cómo apuntarlo bien ─────────────────────────────────────────────────────────────────────
 * Define `PROD_DB_URL` en tu `.env` apuntando a `192.168.0.222:5434` (el puerto está abierto en
 * la LAN; la credencial vive en `~/secrets/prod-compose.env` DE `md`, no en este repo).
 *
 * ── ⛔⛔ PROD YA NO CORRE EN DOCKER COMPOSE: SE MUDÓ A k3s (medido el 2026-10-02) ───────────
 * El camino de abajo decía `docker cp … prod-api` y `docker exec prod-api`. **Eso ya no existe.**
 * Verificado en vivo: los contenedores `prod-api`, `prod-worker`, `pg-prod`, `prod-caddy`,
 * `prod-portal`, `prod-vendor` y `prod-redis` están **`Exited` hace 22–26 h**, y lo que sirve es
 * el namespace `prod` de **k3s** (`api`, `worker`, `pg-prod`, `caddy`, `portal`, `vendor`…).
 *
 * ⚠️ **Y NO se nota desde afuera.** `192.168.0.222:5434` sigue respondiendo igual, así que una
 * sesión puede leer prod toda la tarde sin enterarse de que el sustrato cambió. Peor: **`ss -ltn`
 * NO muestra nada en 5434**, porque k3s publica por DNAT de iptables y no abre un socket en
 * LISTEN — o sea que el chequeo reflejo ("¿quién escucha el puerto?") dice *nadie* y miente.
 * Lo que sí lo delata es `inet_server_addr()`: devuelve `10.42.0.x`, una IP de pod.
 *
 * ⭐ La identidad del clúster (`pg_control_system()`) **no cambió** con la mudanza — el volumen es
 * el mismo. O sea que el candado de identidad de este script sigue siendo válido y NO hay que
 * tocar `PROD_CLUSTER_ID`: es la prueba de que se migró el mismo dato, no uno nuevo.
 *
 * ── El camino VIGENTE, el que se usó el 2026-10-02 (batch 704) ──────────────────────────────
 *
 *     scp database/migrations-newdb/<archivo>.js            superoot@192.168.0.222:/tmp/
 *     scp database/scripts/apply-one-migration-prod.js      superoot@192.168.0.222:/tmp/
 *     ssh superoot@192.168.0.222
 *       export KUBECONFIG=/etc/rancher/k3s/k3s.yaml        # legible sin sudo; `sudo k3s kubectl`
 *                                                          # pide terminal y falla por SSH
 *       API=$(kubectl get pods -n prod -l app=api -o jsonpath='{.items[0].metadata.name}')
 *       kubectl cp /tmp/<archivo>.js  prod/$API:/app/database/migrations-newdb/ -c api
 *       kubectl cp /tmp/apply-one-migration-prod.js prod/$API:/app/database/scripts/ -c api
 *       kubectl exec -n prod $API -c api -- sh -c \
 *         'PROD_DB_URL="$DATABASE_URL_NEW" node /app/database/scripts/apply-one-migration-prod.js <archivo>.js'
 *
 * ⚠️ `-c api` no es opcional: el pod trae un init container (`esperar-redis`) y sin `-c` kubectl
 *    elige por default e imprime un aviso que ensucia cualquier salida que se esté parseando.
 * ⚠️ `PROD_DB_URL="$DATABASE_URL_NEW"` se evalúa **dentro** del pod: el secreto nunca sale de ahí
 *    ni aparece en el historial de esta máquina. El pod no trae `NODE_ENV=production`, así que sin
 *    esa asignación la cadena de `DATABASE_URL_NEW` no se elige y el script aborta pidiendo URL.
 * ⚠️ Hay **DOS** pods de `api` en el deployment. Da igual cuál, pero hay que copiar los archivos
 *    al MISMO en el que se va a ejecutar — `{.items[0]}` no garantiza devolver siempre el mismo.
 *
 * ── PRE-VUELO, y por qué no alcanza `knex_migrations_lock` ──────────────────────────────────
 * Antes de aplicar, preguntar por los candados REALES desde dentro del pod de Postgres, donde se
 * ve el `query` y el `usename` de los demás roles (desde `edgar` vienen en blanco y se lee como
 * "no hay nada corriendo" — así se mató un proceso ajeno el 2026-10-02):
 *
 *     PG=$(kubectl get pods -n prod -l app=pg-prod -o name | head -1)
 *     kubectl exec -n prod -i $PG -- psql -U postgres -d railway <<'SQL'
 *     SELECT a.pid, a.usename, a.state, (now()-a.xact_start)::text,
 *            left(coalesce(a.query, chr(45)), 55)
 *       FROM pg_stat_activity a
 *      WHERE a.xact_start IS NOT NULL AND a.datname = 'railway' ORDER BY a.xact_start;
 *     SQL
 *
 * Y comprobar que el rollout terminó (`kubectl rollout status deploy/api -n prod`): aplicar una
 * migración mientras otra sesión despliega es pedir que el pod desaparezca a media corrida.
 *
 * -- HISTORICO: asi se hacia con docker compose, hasta el 2026-10-02. NO funciona hoy -----
 * Correrlo DENTRO del contenedor de prod, que ya tiene knex, las migraciones y la URL buena:
 *
 *     scp database/migrations-newdb/<archivo>.js superoot@192.168.0.222:/tmp/
 *     scp database/scripts/apply-one-migration-prod.js superoot@192.168.0.222:/tmp/
 *     ssh superoot@192.168.0.222 'docker cp /tmp/<archivo>.js prod-api:/app/database/migrations-newdb/ \
 *       && docker cp /tmp/apply-one-migration-prod.js prod-api:/app/database/scripts/ \
 *       && docker exec prod-api node /app/database/scripts/apply-one-migration-prod.js <archivo>.js'
 *
 * ⚠️ Va a `/app/database/scripts/`, NO a `/app/`: el directorio de migraciones se resuelve
 *    relativo a este archivo (`__dirname/../migrations-newdb`). Puesto en `/app` busca en
 *    `/migrations-newdb` y falla con ENOENT — después de haber pasado el candado de identidad,
 *    o sea que el mensaje no se parece en nada a la causa.
 *
 * ⚠️ Knex compara `knex_migrations` contra el DIRECTORIO y aborta con «migration directory is
 *    corrupt» si falta un archivo que la tabla ya registra. En el contenedor eso pasa seguido:
 *    su imagen es de un commit viejo y otras sesiones aplicaron migraciones que todavía no están
 *    pusheadas. Hay que copiarle TAMBIÉN esos archivos (el error los nombra uno por uno). Son
 *    migraciones ya aplicadas: knex no las vuelve a correr, sólo necesita verlas.
 *
 * ── Y por qué una por una y no `migrate:latest` ─────────────────────────────────────────────
 * ⛔ En prod hay **DOS** `knex_migrations` y el `search_path` lleva a la vacía: `migrate:latest`
 *    contra la tabla equivocada reaplicaría 800 migraciones. Acá `schemaName` es explícito.
 * ⛔ Y aplicaría además lo pendiente de OTRAS sesiones, que no te toca aplicar.
 *
 * NUNCA imprime la cadena de conexión.
 */
'use strict';
const path = require('path');

// Dentro del contenedor de prod no hay `.env` del repo ni `dotenv`: ahí la URL ya viene del
// entorno. Por eso el require es tolerante — si falla, se sigue con `process.env` tal cual.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
} catch { /* sin dotenv (p. ej. corriendo dentro del contenedor): se usa el entorno */ }

/**
 * La identidad del clúster de PROD, medida el 2026-09-24 con
 * `select system_identifier from pg_control_system()` contra `pg-prod` en `md`.
 *
 * ⚠️ Este número cambia si prod se restaura desde cero en otro clúster. Cuando eso pase hay que
 * actualizarlo A MANO y decir por qué — que es justamente el punto: un destino nuevo tiene que
 * ser una decisión escrita, no algo que ocurra porque una variable de entorno cambió sola.
 */
const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';

// Orden a propósito: primero la URL que el contenedor de prod ya tiene bien, después la explícita
// del `.env`, y `FLEET_DB_URL` **última** porque es la que quedó vieja. Cualquiera de las tres
// pasa igual por el candado de identidad — la lista no decide nada, sólo ahorra escribir.
const url = process.env.DATABASE_URL_NEW_PROD || process.env.PROD_DB_URL
  || (process.env.DATABASE_URL_NEW && process.env.NODE_ENV === 'production' ? process.env.DATABASE_URL_NEW : null)
  || process.env.FLEET_DB_URL;
if (!url) {
  console.error('Falta la URL de prod. Define PROD_DB_URL en .env, o corré esto dentro de `prod-api` (ver la cabecera).');
  process.exit(1);
}

const knex = require('knex')({
  client: 'pg',
  connection: /rlwy\.net|railway\.app/.test(url)
    ? { connectionString: url, ssl: { rejectUnauthorized: false } }
    : { connectionString: url },
  pool: {
    min: 0,
    max: 2,
    // `lock_timeout` es la red de seguridad: si una migración no consigue su lock en 15 s, falla
    // ELLA en vez de hacer cola delante de todo el tráfico de prod. `statement_timeout` en 0
    // porque un `CREATE INDEX CONCURRENTLY` puede tardar y cortarlo a mitad deja el índice
    // INVÁLIDO — que el planificador ignora, o sea lento y en silencio.
    afterCreate: (conn, done) =>
      conn.query("SET lock_timeout='15s'; SET statement_timeout=0;", (e) => done(e, conn)),
  },
  migrations: {
    directory: path.resolve(__dirname, '..', 'migrations-newdb'),
    tableName: 'knex_migrations',
    schemaName: 'public',
  },
});

(async () => {
  // ── Compuerta de IDENTIDAD, antes de cualquier escritura ──────────────────────────────────
  const { rows: [id] } = await knex.raw(
    'select (select system_identifier from pg_control_system())::text as id, current_database() as db',
  );
  if (id.id !== PROD_CLUSTER_ID) {
    throw new Error(
      `DESTINO EQUIVOCADO — no se escribe nada.\n` +
      `  clúster conectado : ${id.id} (base "${id.db}")\n` +
      `  clúster de prod   : ${PROD_CLUSTER_ID}\n` +
      `Casi seguro estás apuntando a Railway por el FLEET_DB_URL viejo del .env, o a una copia. ` +
      `Ver la cabecera de este archivo.`,
    );
  }
  console.log(`  identidad de prod verificada: ${id.id} · base "${id.db}"`);

  const arg = process.argv[2];
  const [done, pending] = await knex.migrate.list();
  const names = pending.map((p) => p.file || p);
  if (!arg || arg === '--list') {
    console.log(`aplicadas: ${done.length} · pendientes: ${pending.length}`);
    if (names.length) { console.log('\nPENDIENTES:'); names.forEach((p) => console.log('  ·', p)); }
    await knex.destroy();
    return;
  }
  if (!names.includes(arg)) {
    console.error(`"${arg}" NO está pendiente. Pendientes:\n  ${names.join('\n  ') || '(ninguna)'}`);
    await knex.destroy();
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`aplicando ${arg} …`);
  const res = await knex.migrate.up({ name: arg });
  console.log(`OK → ${JSON.stringify(res)} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await knex.destroy();
})().catch(async (e) => {
  console.error('FALLA:', e.message);
  try { await knex.destroy(); } catch { /* noop */ }
  process.exit(1);
});
