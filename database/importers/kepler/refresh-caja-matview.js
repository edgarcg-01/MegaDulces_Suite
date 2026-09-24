/**
 * CG.22.3 — Refresca `analytics.mv_caja_movimientos`, el corte de caja materializado.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-22: la bandeja de `/finanzas/caja-general` tardaba **415–720 ms
 * por consulta** tocando **~565,000 páginas de buffer**, porque `analytics.kepler_bank_movements`
 * tiene que leer las **651,450 filas / 567 MB** de `kepler_ods.kdm1` para clasificar cada
 * movimiento. Con la lista materializada, la misma consulta cuesta **0.4 ms y 99 páginas** —
 * 1,085× menos.
 *
 * ⚠️ [CG.22.4] ACÁ DECÍA "el corte entero son 12,237 filas y armarlo cuesta ~0.5–2 s". Medido el
 * 2026-09-24 sobre 951 corridas: son **12,294 filas** y el refresh mide **4,582 ms de media**
 * (min 2,446 · max 16,521 · desvío 1,863), con latidos en vivo de 3,846 y 6,602 ms. Armar la
 * vista tampoco son los 507 ms que dice la migración: medido tres veces da **2,289–3,279 ms**.
 * Un comentario que deja de ser cierto no avisa; por eso los números van con su fecha.
 *
 * Dos hipótesis más baratas se probaron y se REFUTARON antes de llegar a esto: un índice (existe
 * `idx_kdm1_tesoreria_c45` y con `enable_seqscan=off` el plan no cambia) y desmaterializar el CTE
 * `flj` (`NOT MATERIALIZED` salió PEOR: 501 ms y el doble de páginas). El detalle está en la
 * migración `20260923130000_mv_caja_movimientos.js`.
 *
 * ── Lo que este carril DECLARA ──────────────────────────────────────────────────────────────
 * El latido reporta **filas entregadas**, no "el proceso corrió" (ADR-053). Un matview que dejó
 * de refrescarse sirve datos viejos **sin un solo error**, y en una bandeja de caja eso se lee
 * como "no hay trabajo" — que es la peor lectura posible. Por eso:
 *   · si el matview no existe todavía, sale en `ok` con nota y NO se pone rojo (la migración
 *     puede no estar aplicada aún en ese entorno);
 *   · si queda en CERO filas, se reporta `error` — cero no es un refresh exitoso;
 *   · cada fila lleva `refrescado_en`, así que el consumidor puede declarar la edad del dato.
 *
 *   node database/importers/kepler/refresh-caja-matview.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

// ⚠️ `.trim()` en cada argumento a propósito: el `crontab.feeds` se exportó una vez con CRLF y
// `argv.includes('--apply')` —comparación exacta— no matcheaba `--apply\r`, así que NUEVE carriles
// corrieron en seco diciendo "ok" durante horas. Que no vuelva a depender de un retorno de carro.
const APPLY = process.argv.slice(2).some((a) => a.trim() === '--apply');
const KEY = 'mv_caja_refresh';
const MV = 'analytics.mv_caja_movimientos';

function conexion() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  return new Client({
    connectionString: cs,
    ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
}

/**
 * CG.23.2 — Avisa por `NOTIFY` que el corte de caja cambió, para que la pantalla no tenga que
 * preguntar cada tanto si pasó algo.
 *
 * ── Qué viaja, y qué NO ─────────────────────────────────────────────────────────────────────
 * Viaja la **firma** del corte, no los movimientos. `NOTIFY` no se persiste: lo que se emite
 * mientras nadie escucha se pierde, así que un aviso que llevara el dato convertiría un socket
 * caído tres segundos en un movimiento que no aparece nunca. Con la firma, el peor caso de un
 * aviso perdido es que la pantalla se entere en su repaso lento — no que pierda el dato.
 *
 * La firma incluye la SUMA de importes además del conteo: sólo con `count(*)` un movimiento
 * corregido (mismo folio, otro monto) no movería nada y la pantalla se quedaría con la cifra
 * vieja creyendo que está al día.
 *
 * Se avisa SIEMPRE tras un refresh exitoso, sin comparar contra la corrida anterior: este script
 * es un proceso nuevo en cada pasada del cron y no tiene memoria. Quien compara es la pantalla,
 * que sí tiene delante lo que está mostrando. El costo de avisar de más es un mensaje diminuto;
 * el de avisar de menos es una caja que miente.
 *
 * ⚠️ Un `NOTIFY` viaja al COMMIT. Estas consultas van fuera de una transacción explícita
 * (autocommit), así que sale al terminar cada `SELECT pg_notify(...)`.
 */
/* [CG.22.4] `al` llega por PARÁMETRO y ya no se lee del matview. La columna `refrescado_en` se
 * retira porque hacía que `REFRESH ... CONCURRENTLY` reescribiera la tabla ENTERA cada minuto —
 * ver la nota larga en `ciclo()`. La forma del payload NO cambia: `caja-realtime.service.ts:80`
 * sigue leyendo `datos_al`. */
async function avisar(c, al) {
  const q = await c.query(`
    SELECT tenant_id::text            AS tenant_id,
           count(*)::int              AS filas,
           max(folio)                 AS max_folio,
           max(fecha_captura)::text   AS max_captura,
           round(sum(importe), 2)::text AS suma
      FROM ${MV}
     GROUP BY tenant_id`);

  let n = 0;
  for (const t of q.rows) {
    const payload = JSON.stringify({
      tenant_id: t.tenant_id,
      filas: t.filas,
      max_folio: t.max_folio,
      max_captura: t.max_captura,
      firma: `${t.filas}|${t.max_folio || ''}|${t.max_captura || ''}|${t.suma || ''}`,
      datos_al: al,
    });
    // El tope de un payload de NOTIFY son 8000 bytes; esto son ~200. Si algún día creciera,
    // reventaría acá con un error claro en vez de truncarse en silencio.
    await c.query(`SELECT pg_notify('caja_movimientos', $1)`, [payload]);
    n++;
  }
  return n;
}

async function ciclo() {
  const c = conexion();
  await c.connect();
  try {
    const existe = await c.query(`SELECT to_regclass($1) AS t`, [MV]);
    if (!existe.rows[0] || !existe.rows[0].t) {
      return { filas: null, nota: `${MV} todavía no existe (migración sin aplicar en este entorno)` };
    }

    const t0 = Date.now();
    // CONCURRENTLY para no tomar el lock exclusivo: sin esto la bandeja queda EN BLANCO mientras
    // corre el refresh. Requiere el índice UNIQUE que crea la migración.
    await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV}`);
    const ms = Date.now() - t0;

    // ⛔⛔ [CG.22.4] LA EDAD DEL DATO NO PUEDE VIAJAR DENTRO DEL MATVIEW, y no es una preferencia.
    //
    // `REFRESH ... CONCURRENTLY` no copia la tabla: calcula lo nuevo a una temp, hace un FULL JOIN
    // por la llave única y aplica SÓLO lo que difiere, comparando la FILA COMPLETA con
    // `(y.*) IS DISTINCT FROM (x.*)`. El matview cargaba DOS columnas que cambian en cada pasada
    // por construcción -- `computed_at` (heredada de la vista base por el `SELECT k.*`) y
    // `refrescado_en` (`now()`, que agregaba la migración) -- así que el 100 % de las filas
    // parecía distinto. Medido: el diff veía 12,294 filas cambiadas y las que cambiaban de verdad
    // eran CERO. O sea, `CONCURRENTLY` —que existe justamente para aplicar el delta— aplicaba la
    // tabla entera, que es su PEOR caso, y encima pagando el sobrecosto del diff.
    //
    // El precio, medido: 12,294 DELETE + 12,294 INSERT por minuto sobre una tabla cuyo contenido
    // de negocio crece **58-74 filas por DÍA**; **8.72 MB de WAL por refresh = 12.3 GB por día**;
    // 854 autovacuums; y los índices al 54.6x y 417x de su tamaño reconstruido.
    //
    // Ahora la marca sale del reloj de ESTE proceso, y a propósito DESPUÉS de que el REFRESH
    // volvió: ése es el instante en que el dato se hizo visible, que es más honesto que el `now()`
    // del arranque de la transacción (el refresh tarda segundos).
    const al = new Date().toISOString();

    const r = await c.query(`SELECT count(*)::int n FROM ${MV}`);
    const filas = r.rows[0].n;
    if (!filas) throw new Error(`${MV} quedó con 0 filas: eso no es un refresh exitoso`);

    const avisados = await avisar(c, al);
    return { filas, ms, al, avisados };
  } finally {
    await c.end().catch(() => {});
  }
}

(async () => {
  if (!APPLY) {
    console.log('dry-run: no se refresca nada. Agregá --apply.');
    return;
  }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  await hb.begin(KEY, 'Caja — refresca mv_caja_movimientos').catch(() => {});
  try {
    const r = await ciclo();
    if (r.filas == null) {
      console.log(r.nota);
      await hb.end(KEY, { status: 'ok', rows: 0, note: r.nota }).catch(() => {});
      return;
    }
    console.log(`refrescado: ${r.filas} filas en ${r.ms} ms (al ${r.al}) · ${r.avisados} aviso(s) NOTIFY`);
    await hb.end(KEY, { status: 'ok', rows: r.filas }).catch(() => {});
  } catch (e) {
    console.error('falló:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  }
})();
