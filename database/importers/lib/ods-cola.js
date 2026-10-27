'use strict';
/**
 * `[OBS.15]` COLA DE CAMBIOS en la réplica — el detector que el carril CTID no puede ser.
 *
 * EL PUNTO CIEGO, MEDIDO EL 2026-10-26. El carril CTID de `replicate-ods-live.js` encuentra filas
 * nuevas por POSICIÓN FÍSICA (`ctid > watermark`). En el suscriptor de la replicación lógica el
 * heap REUSA espacio libre, así que las filas nuevas caen por DEBAJO del watermark:
 *
 *     réplica 01, md.kdm2:  watermark en la página 46,868
 *                           las 2,934 filas de HOY en las páginas 25,688 – 27,318
 *
 * En 90 min de logs de prod el carril no embarcó NI UNA fila de `kdm2` por ctid en las ramas
 * 00/01/06/08, ni de `kdm1` en 06/07 (0 por ctid contra 235 por la red de seguridad en 2 h). Todo
 * eso llegaba con la red de 5 min: la cabecera en segundos y sus renglones de 0 a 5.6 min después.
 * En `/comercial/documentos` se veía como «Detalle no replicado» (01 UD0801-0001853: capturado
 * 14:13, abierto 14:14, renglón 14:18:34).
 *
 * EL ARREGLO. Un trigger `ENABLE ALWAYS` sobre cada tabla anota la LLAVE de cada fila que la
 * replicación aplica en `ods.cola`; el carril vacía la cola, lee esas filas por su PK y las
 * embarca. No depende de dónde cayó la fila, captura INSERT y UPDATE (el `N → A` de `[GX.73]`
 * incluido), y la cabecera y sus renglones —que Kepler escribe en la misma transacción— aparecen
 * en la cola en el MISMO commit, así que viajan en la misma pasada.
 *
 * ⛔ `ENABLE ALWAYS` NO ES OPCIONAL. El apply worker de la suscripción corre con
 * `session_replication_role = replica`, y un trigger normal (`ENABLE`, origen) NO DISPARA ahí.
 * Instalado sin el ALWAYS, la cola quedaría vacía para siempre y el carril creería que no pasa
 * nada. La prueba negativa vive en `database/tests/test-ods-cola.js`.
 *
 * ⛔ EL TRIGGER NO PUEDE ROMPER LA REPLICACIÓN. Corre DENTRO de la transacción del apply worker:
 * si tira, la suscripción reintenta en bucle y la réplica deja de avanzar — se congelarían TODOS
 * los carriles de esa sucursal. Por eso:
 *   · si `ods.cola` no existe, sale sin hacer nada (`to_regclass`), en vez de fallar;
 *   · NO lleva bloque `EXCEPTION`: cada uno abre una subtransacción por fila, y una transacción
 *     grande de Kepler (miles de renglones) desbordaría la caché de subtransacciones, que frena a
 *     TODO el clúster — un costo peor que el que se quiere evitar.
 *   · `quitarSql()` saca los triggers ANTES que la tabla.
 *
 * ⚠️ LO QUE NO CUBRE, DECLARADO:
 *   · BORRADOS. La cola los anota (`op = 'D'`) y el drenado los CUENTA, pero NO los propaga: el
 *     origen PODA historia (la reconciliación nocturna conserva lo podado a propósito, OBS.14), y
 *     un DELETE en vivo la borraría del ODS. Siguen saliendo por `ods-reconcile-full` (02:10).
 *     `[OBS.15.10]` Salvo que el carril pase `borrar` a `drenarCola` (lo prende `ODS_COLA_BORRAR`
 *     en `replicate-ods-live.js`): ahí se propagan SÓLO los de fecha de negocio reciente y con tope
 *     por pasada — una poda trae miles de golpe, o filas viejas, y ninguna de las dos se toca.
 *   · Lo que cambió ANTES de instalar: lo repone la red de seguridad y el reconciliador, como hoy.
 *   · Un re-sync de la suscripción (TRUNCATE + COPY) mete la tabla entera a la cola. Se drena en
 *     lotes; tarda, no se pierde.
 *
 * ⚠️ ESTADO EN LA RÉPLICA, SIN `tenant_id`: igual que `ods.ctl` y `ods.shadow`, `ods.cola` es estado
 * del CDC en la base de la réplica, no una tabla de la app — no lleva tenant ni campos de auditoría.
 */

const LOTE_DEFAULT = 5000;
const TRIGGER = 'ods_cola';
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** Tipos de PK que se comparan con su propio tipo (el índice entra). El resto, como texto. */
const TIPOS_LLAVE = new Set([
  'character varying', 'character', 'text', 'numeric', 'integer', 'smallint', 'bigint',
  'date', 'timestamp without time zone', 'timestamp with time zone', 'double precision', 'real', 'boolean',
]);

/**
 * Sentencias para instalar la cola sobre `tablas` (idempotente). Cada tabla va en su propia
 * transacción: CREATE OR REPLACE TRIGGER + ENABLE ALWAYS juntos, para que no exista un instante en
 * que el trigger esté puesto pero no dispare en el apply worker.
 *
 * @param {{ tabla: string, pk: string[] }[]} tablas
 * @returns {string[][]} una lista de sentencias por transacción
 */
function instalarSql(tablas, { esquemaFuente = 'md', esquemaCola = 'ods' } = {}) {
  const q = qid(esquemaCola);
  const cola = `${q}.cola`;
  const base = [
    `CREATE SCHEMA IF NOT EXISTS ${q}`,
    `CREATE TABLE IF NOT EXISTS ${cola} (
       id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       tabla text        NOT NULL,
       llave jsonb       NOT NULL,
       op    text        NOT NULL,
       en    timestamptz NOT NULL DEFAULT clock_timestamp())`,
    `CREATE INDEX IF NOT EXISTS cola_tabla_id ON ${cola} (tabla, id)`,
    // Sin comentarios `--` adentro a propósito: el instalador imprime el SQL en una línea, y un
    // comentario de línea se tragaría el resto de la función a quien lo copie.
    //   · el `to_regclass` es el «sin cola, sin error» del encabezado;
    //   · un UPDATE que cambia la llave deja la vieja huérfana: se anota como borrado ('D').
    `CREATE OR REPLACE FUNCTION ${q}.encolar() RETURNS trigger LANGUAGE plpgsql AS $f$
     DECLARE
       fila  jsonb;
       vieja jsonb;
       llave jsonb := '{}'::jsonb;
       antes jsonb := '{}'::jsonb;
       i     int;
     BEGIN
       IF to_regclass(${lit(`${qid(esquemaCola)}.cola`)}) IS NULL THEN RETURN NULL; END IF;
       IF TG_OP = 'DELETE' THEN fila := to_jsonb(OLD); ELSE fila := to_jsonb(NEW); END IF;
       FOR i IN 0 .. TG_NARGS - 1 LOOP
         llave := llave || jsonb_build_object(TG_ARGV[i], fila -> TG_ARGV[i]);
       END LOOP;
       INSERT INTO ${cola} (tabla, llave, op) VALUES (TG_TABLE_NAME, llave, left(TG_OP, 1));
       IF TG_OP = 'UPDATE' THEN
         vieja := to_jsonb(OLD);
         FOR i IN 0 .. TG_NARGS - 1 LOOP
           antes := antes || jsonb_build_object(TG_ARGV[i], vieja -> TG_ARGV[i]);
         END LOOP;
         IF antes IS DISTINCT FROM llave THEN
           INSERT INTO ${cola} (tabla, llave, op) VALUES (TG_TABLE_NAME, antes, 'D');
         END IF;
       END IF;
       RETURN NULL;
     END $f$`,
  ];
  const porTabla = tablas.map(({ tabla, pk }) => {
    if (!pk || !pk.length) throw new Error(`ods-cola: ${tabla} sin PK — no se puede leer por llave`);
    const rel = `${qid(esquemaFuente)}.${qid(tabla)}`;
    return [
      // Esperar el candado del apply worker, pero no colgarse detrás de una transacción larga.
      `SET LOCAL lock_timeout = '3s'`,
      `CREATE OR REPLACE TRIGGER ${TRIGGER} AFTER INSERT OR UPDATE OR DELETE ON ${rel}
         FOR EACH ROW EXECUTE FUNCTION ${q}.encolar(${pk.map(lit).join(', ')})`,
      `ALTER TABLE ${rel} ENABLE ALWAYS TRIGGER ${TRIGGER}`,
    ];
  });
  return [base, ...porTabla];
}

/** Sentencias para retirar la cola. Los triggers SIEMPRE antes que la tabla (ver encabezado). */
function quitarSql(tablas, { esquemaFuente = 'md', esquemaCola = 'ods' } = {}) {
  const q = qid(esquemaCola);
  return [
    ...tablas.map(({ tabla }) => [`SET LOCAL lock_timeout = '3s'`,
      `DROP TRIGGER IF EXISTS ${TRIGGER} ON ${qid(esquemaFuente)}.${qid(tabla)}`]),
    [`DROP FUNCTION IF EXISTS ${q}.encolar()`, `DROP TABLE IF EXISTS ${q}.cola`],
  ];
}

/**
 * ¿Dónde está activa la cola? `activa` = el trigger existe y DISPARA en el apply worker
 * (`tgenabled` A = always, R = replica). `apagada` = existe pero no dispara ahí (O/D): es el
 * caso que se vería como «no pasa nada», y se nombra aparte para no confundirlo con «ausente».
 *
 * @returns {Promise<{ cola: boolean, tablas: Record<string, 'activa'|'apagada'|'ausente'> }>}
 */
async function estadoCola(p, tablas, { esquemaFuente = 'md', esquemaCola = 'ods' } = {}) {
  const cola = (await p.query(`SELECT to_regclass($1) IS NOT NULL AS hay`,
    [`${qid(esquemaCola)}.cola`])).rows[0].hay;
  const { rows } = await p.query(
    `SELECT c.relname AS tabla, t.tgenabled::text AS en
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal AND c.relname = ANY($3)`,
    [esquemaFuente, TRIGGER, tablas]);
  const porTabla = new Map(rows.map((r) => [r.tabla, r.en]));
  const out = {};
  for (const t of tablas) {
    const en = porTabla.get(t);
    out[t] = !cola || en == null ? 'ausente' : (en === 'A' || en === 'R') ? 'activa' : 'apagada';
  }
  return { cola, tablas: out };
}

/** Lo que hay en la cola sin tocarla (para el modo en seco). */
async function profundidadCola(p, tablas, { esquemaCola = 'ods' } = {}) {
  const { rows } = await p.query(
    `SELECT tabla, count(*)::int AS n,
            coalesce(max(extract(epoch FROM clock_timestamp() - en) * 1000), 0)::int AS espera_max_ms
       FROM ${qid(esquemaCola)}.cola WHERE tabla = ANY($1) GROUP BY tabla`, [tablas]);
  return rows;
}

/**
 * Lee las filas ACTUALES de `tabla` para un conjunto de llaves. Une contra `jsonb_to_recordset`
 * con el tipo REAL de cada columna de la PK, para que la comparación use el índice de la PK.
 */
async function leerPorLlave(p, tabla, meta, llaves, { esquemaFuente = 'md' } = {}) {
  if (!llaves.length) return [];
  const tipos = new Map(meta.cols.map((c) => [c.column_name, c.data_type]));
  const def = meta.pk.map((k) => `${qid(k)} ${TIPOS_LLAVE.has(tipos.get(k)) ? tipos.get(k) : 'text'}`).join(', ');
  const on = meta.pk.map((k) => (TIPOS_LLAVE.has(tipos.get(k))
    ? `t.${qid(k)} = k.${qid(k)}`
    : `t.${qid(k)}::text = k.${qid(k)}`)).join(' AND ');
  const sel = meta.cols.map((c) => `t.${qid(c.column_name)}`).join(', ');
  const { rows } = await p.query(
    `SELECT ${sel} FROM ${qid(esquemaFuente)}.${qid(tabla)} t
       JOIN jsonb_to_recordset($1::jsonb) AS k(${def}) ON ${on}`, [JSON.stringify(llaves)]);
  return rows;
}

/** Firma estable de una llave (mismo orden de columnas que la PK). */
const firma = (pk, llave) => JSON.stringify(pk.map((k) => (llave[k] == null ? null : String(llave[k]))));

/**
 * Vacía la cola: lee hasta `lote` entradas, agrupa por tabla EN EL ORDEN de `tablas` (cabeceras
 * antes que renglones), deduplica llaves, lee las filas actuales por PK, las entrega con
 * `enviar(tabla, meta, filas)` y SÓLO ENTONCES borra esas entradas. Si `enviar` tira, las entradas
 * de esa tabla se quedan y se reintentan en la pasada siguiente — no se pierde nada.
 *
 * Sin watermark a propósito: dos transacciones pueden confirmar sus entradas fuera del orden de
 * `id` (con `streaming = parallel` el apply worker aplica en paralelo), y un «id > último» saltaría
 * la que confirmó tarde. Se lee lo que HAY y se borra lo que se leyó.
 *
 * `espera_max_ms` = cuánto llevaba en la cola la entrada más vieja AL LEERLA, medido con el reloj de
 * la base (no se mezclan relojes). Sumado a `ms` es la latencia réplica → ODS de esta pasada.
 */
async function drenarCola(p, { tablas, metaDe, enviar, borrar = null, lote = LOTE_DEFAULT, esquemaFuente = 'md', esquemaCola = 'ods' }) {
  const t0 = Date.now();
  const cola = `${qid(esquemaCola)}.cola`;
  const { rows } = await p.query(
    `SELECT id, tabla, llave, op, (extract(epoch FROM clock_timestamp() - en) * 1000)::int AS espera_ms
       FROM ${cola} WHERE tabla = ANY($1) ORDER BY id LIMIT $2`, [tablas, lote]);
  const res = { leidas: rows.length, llaves: 0, escritas: 0, enviadas: 0, borradas: 0, espera_max_ms: 0, porTabla: {}, ms: 0 };
  if (!rows.length) return res;
  res.espera_max_ms = rows.reduce((m, r) => Math.max(m, r.espera_ms), 0);

  for (const tabla of tablas) {
    const mias = rows.filter((r) => r.tabla === tabla);
    if (!mias.length) continue;
    const ids = mias.map((r) => r.id);
    const meta = await metaDe(tabla);
    if (!meta || !meta.pk.length) {
      // La tabla ya no existe (o perdió su PK): sus entradas no se pueden atender nunca.
      await p.query(`DELETE FROM ${cola} WHERE id = ANY($1::bigint[])`, [ids]);
      res.porTabla[tabla] = { llaves: 0, escritas: 0, descartadas: ids.length };
      continue;
    }
    const unicas = new Map();
    for (const r of mias) unicas.set(firma(meta.pk, r.llave), r.llave);
    const llaves = [...unicas.values()];
    const filas = await leerPorLlave(p, tabla, meta, llaves, { esquemaFuente });
    const r = filas.length ? await enviar(tabla, meta, filas) : { rowCount: 0 };
    // Llave sin fila = se borró en el origen. Por defecto se CUENTA y no se propaga (ver
    // encabezado). `[OBS.15.10]` Con `borrar`, quien llama decide qué propagar —con sus frenos—;
    // va ANTES de vaciar la cola: si tira, las entradas se quedan y se reintentan.
    const presentes = new Set(filas.map((f) => firma(meta.pk, f)));
    const sinFila = llaves.filter((k) => !presentes.has(firma(meta.pk, k)));
    const rb = borrar && sinFila.length ? await borrar(tabla, meta, sinFila) : null;
    await p.query(`DELETE FROM ${cola} WHERE id = ANY($1::bigint[])`, [ids]);
    const escritas = Number(r?.rowCount || 0);
    const borradas = sinFila.length;
    const propagadas = Number(rb?.borradas || 0);
    res.llaves += llaves.length; res.enviadas += filas.length; res.escritas += escritas; res.borradas += borradas;
    res.propagadas = (res.propagadas || 0) + propagadas;
    res.porTabla[tabla] = { llaves: llaves.length, enviadas: filas.length, escritas, borradas, propagadas, ...(rb?.nota ? { nota: rb.nota } : {}) };
  }
  res.ms = Date.now() - t0;
  return res;
}

/**
 * `[OPS-AUD.13]` LA COLA SE PONE SOLA EN LAS TABLAS NUEVAS — sin cron.
 *
 * Kepler crea una tabla de pólizas POR MES (`kdc2YYMM`). Instalar la cola a mano (o con un cron)
 * deja cada mes nuevo sin cola hasta que alguien se acuerde. Un EVENT TRIGGER en la réplica la pone
 * en el instante en que la tabla aparece (la crea `kepler-replica-refresh.js`, DDL en una sesión
 * normal: el apply worker no ejecuta DDL, así que no hay riesgo de que esto corra dentro de él).
 *
 * `patrones` son prefijos con `*` final (`kdc2*`) o nombres exactos. Sólo tablas de `esquemaFuente`
 * con PK. Si la tabla ya tiene la cola, no hace nada (también corta la recursión: el
 * `ENABLE ALWAYS` de adentro vuelve a disparar el evento como ALTER TABLE).
 *
 * ⛔ A diferencia de `encolar()`, ESTA función SÍ lleva EXCEPTION: corre una vez por DDL (no por
 *    fila, así que no hay caché de subtransacciones que desbordar), y si tirara haría fallar el
 *    CREATE TABLE de `kepler-replica-refresh` — o sea, la tabla nueva ni siquiera se suscribiría.
 *    Un error se avisa con WARNING y la tabla queda sin cola: `estadoCola` lo ve como 'ausente'.
 */
function autoSql(patrones, { esquemaFuente = 'md', esquemaCola = 'ods' } = {}) {
  const q = qid(esquemaCola);
  const likes = patrones.map((p) => lit(p.endsWith('*') ? p.slice(0, -1).replace(/[\\%_]/g, '\\$&') + '%' : p.replace(/[\\%_]/g, '\\$&')));
  return [[
    `CREATE OR REPLACE FUNCTION ${q}.cola_auto() RETURNS event_trigger LANGUAGE plpgsql AS $f$
     DECLARE
       r   record;
       pk  text;
     BEGIN
       FOR r IN SELECT c.oid, c.relname
                  FROM pg_event_trigger_ddl_commands() d
                  JOIN pg_class c ON c.oid = d.objid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE d.object_type = 'table' AND n.nspname = ${lit(esquemaFuente)}
                   AND c.relname LIKE ANY (ARRAY[${likes.join(', ')}]) LOOP
         BEGIN
           IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = r.oid AND tgname = ${lit(TRIGGER)}) THEN CONTINUE; END IF;
           SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY array_position(i.indkey, a.attnum)) INTO pk
             FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = r.oid AND i.indisprimary;
           IF pk IS NULL THEN CONTINUE; END IF;
           EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ${q}.encolar(%s)',
                          ${lit(TRIGGER)}, r.oid::regclass, pk);
           EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', r.oid::regclass, ${lit(TRIGGER)});
         EXCEPTION WHEN OTHERS THEN
           RAISE WARNING 'ods cola_auto: % sin cola (%)', r.relname, SQLERRM;
         END;
       END LOOP;
     END $f$`,
    `DROP EVENT TRIGGER IF EXISTS ${qid('ods_cola_auto_' + esquemaFuente)}`,
    `CREATE EVENT TRIGGER ${qid('ods_cola_auto_' + esquemaFuente)} ON ddl_command_end
       WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'ALTER TABLE')
       EXECUTE FUNCTION ${q}.cola_auto()`,
  ]];
}

/** Retira el event trigger de `autoSql` (no toca las colas ya puestas). */
function quitarAutoSql({ esquemaFuente = 'md', esquemaCola = 'ods' } = {}) {
  return [[
    `DROP EVENT TRIGGER IF EXISTS ${qid('ods_cola_auto_' + esquemaFuente)}`,
    `DROP FUNCTION IF EXISTS ${qid(esquemaCola)}.cola_auto()`,
  ]];
}

/**
 * `[OPS-AUD.13]` Resuelve una lista con patrones (`kdc2*`) contra las tablas que EXISTEN en la
 * réplica. Los nombres exactos se devuelven tal cual (exista o no la tabla: `estadoCola` dirá
 * 'ausente'); los patrones, sólo lo que existe, en orden alfabético.
 */
async function expandirTablas(p, nombres, { esquemaFuente = 'md' } = {}) {
  const out = [];
  for (const n of nombres) {
    if (!n.endsWith('*')) { out.push(n); continue; }
    const { rows } = await p.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = $1 AND c.relkind IN ('r', 'p') AND starts_with(c.relname, $2)
        ORDER BY c.relname`, [esquemaFuente, n.slice(0, -1)]);
    for (const r of rows) out.push(r.relname);
  }
  return [...new Set(out)];
}

module.exports = {
  TRIGGER, LOTE_DEFAULT, instalarSql, quitarSql, estadoCola, profundidadCola, leerPorLlave, drenarCola,
  autoSql, quitarAutoSql, expandirTablas,
};
