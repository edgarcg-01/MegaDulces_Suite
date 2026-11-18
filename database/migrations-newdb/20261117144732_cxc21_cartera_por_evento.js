'use strict';
/**
 * `[CXC.21]` — La cartera por EVENTO: `analytics.customer_receivables_current` guarda la cartera ya calculada y se
 * pone al día sólo en las cuentas que cambiaron, al llegar el cambio. Edgar, 2026-11-10: «ningún cron»; Edgar,
 * 2026-11-17: opción A (por evento) para la lentitud de `/finanzas/cartera`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-17) ──────────────────────────────────────────────────────────────
 *  · `GET /finance/receivables` 4.3 s de promedio y 29 s de máximo (3,532 llamadas en 30 días); la ficha del cliente
 *    3.3 s (910). Cobranza esperaba 10–17 min al día. La causa es la vista `erp_receivable_documents`: recalcula los
 *    ~62 mil documentos en cada consulta (no es la intercalación: con COLLATE "C" mismo md5 y mismo ~1.1 s).
 *  · Las fuentes cambian poco: ~3.3 mil altas al día en `kdue`, ~265 en `kdm5`, ~300 cambios en `kdud` (contadores
 *    desde el 1-nov). Recalcular POR CUENTA es lo barato.
 *  · Prototipo por cuenta (la misma lógica restringida, armada aquí desde la definición VIVA de las vistas):
 *    sobre el UNIVERSO completo, **62,530 filas idénticas a la vista** (0 de más, 0 de menos, en una transacción
 *    REPEATABLE READ). Una cuenta: 20–36 ms; la más pesada (`00|30-73`, 5,073 documentos): 228 ms; 300 cuentas: 490 ms.
 *  · ⚠️ La vista NO era determinista: `kd` toma el renglón del cliente en `kdud` con `DISTINCT ON (código) ORDER BY
 *    límite DESC` y `kdud` está replicada en las 9 sucursales con valores distintos (332 códigos con zona distinta según
 *    la réplica). Con empate en el límite, zona/grupo/teléfono/días salían al azar: **8,170 filas** de la vista viva
 *    difieren de la misma vista con desempate. Aquí se desempata por sucursal (la regla de negocio no cambia: sigue
 *    ganando el límite mayor). Cuál réplica DEBERÍA mandar es una pregunta abierta para Edgar, no se decide aquí.
 *
 * ── Qué crea (sin tocar ninguna fila de lo que hay) ─────────────────────────────────────────────────────────────────
 *  · `analytics.erp_receivable_documents`: CREATE OR REPLACE con el desempate. Mismas columnas.
 *  · `analytics.customer_receivables_for(sucursales text[], clientes text[])`: la cartera de esas cuentas. Se ARMA
 *    desde `pg_get_viewdef` de las dos vistas con empalmes que fallan si el texto no está UNA vez: no es una segunda
 *    copia de la lógica escrita a mano. Los abonos se buscan en `kdue` por su índice (`kdue_distinct_key_idx`), que es
 *    lo que hace la vista completa (el abono puede ser de otra cuenta) y lo que la hace rápida.
 *  · `analytics.customer_receivables_current`: la cartera guardada, mismas columnas que la vista, llave
 *    `folio_digital` (único: 62,530 de 62,530). Nace VACÍA: la llena la primera corrida del drenado.
 *  · `analytics.receivables_dirty_accounts` (cola, SÓLO ALTAS, sin llave única — la ingesta nunca espera al que
 *    drena), `analytics.receivables_dirty_errors`, `analytics.receivables_refresh_runs` (bitácora y árbitro) y
 *    `analytics.receivables_by_event` (interruptor, APAGADO).
 *  · `analytics.drain_customer_receivables()` (`SECURITY DEFINER`): toma la cola y recalcula esas cuentas; o TODO si
 *    hay marca total, si son más de 400 cuentas, si la tabla está vacía o si es la primera corrida del día (hora de
 *    México). La completa compara contra lo guardado y CUENTA lo que difería: como la cartera no depende de la fecha,
 *    ese número debe ser 0; si no lo es, hubo un evento perdido y se ve en la bitácora.
 *  · Disparadores POR SENTENCIA en `kdud`, `kdm5`, `kdue` y `kdm1`, nacen apagados (falla cerrada). Nunca frenan la
 *    ingesta: atrapan su error, lo registran y dejan pasar la escritura (ADR-104 §4). Avisan `NOTIFY cartera_sucia`.
 *
 * ⛔ FUERA DE HORARIO y sin transacción vieja abierta en esas cuatro tablas (skill `entrega` §5): cada CREATE TRIGGER
 *    toma SHARE ROW EXCLUSIVE (frena escrituras de la ingesta, no lecturas) y knex lo retiene hasta el COMMIT. Van al
 *    final, de la tabla más quieta a la más escrita, con CREATE OR REPLACE (DROP TRIGGER toma ACCESS EXCLUSIVE). El
 *    CREATE OR REPLACE VIEW toma ACCESS EXCLUSIVE sobre la vista: milisegundos, pero frena a quien la lea en ese
 *    instante. `lock_timeout` 5 s.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const CANAL = 'cartera_sucia';
/** Más cuentas que esto en una corrida: recalcular todo cuesta lo mismo (~3 s) y compara contra lo guardado. */
const MAX_CUENTAS_POR_LLAVE = 400;
const INICIO_DEL_DIA = `(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`;
const CREDITO = `ARRAY['3','8','9','12','13','25','41']`;
const ABONO = `ARRAY['5','7','21','25','30','35','40']`;

function una(s, de, a, que) {
  const n = s.split(de).length - 1;
  if (n !== 1) {
    throw new Error(`[CXC.21] la definición de ${que} cambió: el empalme aparece ${n} veces (se esperaba 1): ${de.slice(0, 120)}. `
      + 'Revisar la vista y ajustar esta migración; NO forzarla.');
  }
  return s.replace(de, () => a);
}

const KD_ORDER = "ORDER BY (btrim(kdud.c2)), (NULLIF(regexp_replace(kdud.c15::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric) DESC NULLS LAST";

/** La vista de documentos con el desempate determinista de `kd`. Idempotente: si ya lo tiene, no lo repite. */
function conDesempate(erp) {
  if (erp.includes(`${KD_ORDER}, kdud.sucursal`)) return erp;
  return una(erp, KD_ORDER, `${KD_ORDER}, kdud.sucursal`, 'analytics.erp_receivable_documents (kd)');
}

/** El cuerpo de `customer_receivables_for`: las dos vistas, restringidas a las cuentas de $1/$2. */
function armarPorCuenta(erp, cr) {
  const W = "WHERE kdue.c29 = 'C'::text AND (btrim(kdue.c4::text) = ANY (ARRAY['3'::text, '8'::text, '9'::text, '12'::text, '13'::text, '25'::text, '41'::text])) OR kdue.c29 = 'A'::text AND (btrim(kdue.c4::text) = ANY (ARRAY['5'::text, '7'::text, '21'::text, '25'::text, '30'::text, '35'::text, '40'::text]))";
  erp = una(erp, W, `WHERE (${W.slice(6)}) AND ((btrim(kdue.c1), COALESCE(btrim(kdue.c2), '')) IN (SELECT ll.s, ll.c FROM llaves ll))`, 'erp_receivable_documents (src)');
  erp = una(erp, 'FROM kepler_ods.kdud\n', "FROM kepler_ods.kdud\n          WHERE btrim(kdud.c2) IN (SELECT ll.c FROM llaves ll)\n", 'erp_receivable_documents (kd)');
  const MW = "WHERE kdm5.c2 = 'U'::text AND (btrim(kdm5.c4::text) = ANY (ARRAY['5'::text, '7'::text, '21'::text, '25'::text, '30'::text, '35'::text, '40'::text]))";
  erp = una(erp, MW, `${MW} AND ((btrim(kdm5.c1), btrim(kdm5.c8), btrim(kdm5.c9::text), btrim(kdm5.c10::text), btrim(kdm5.c11)) IN (SELECT btrim(s.c1), 'D'::text, btrim(s.c4::text), btrim(s.c5::text), btrim(s.c6) FROM src s WHERE s.c29 = 'C'::text))`, 'erp_receivable_documents (m0)');
  // El abono de una aplicación se busca en kdue por su índice, como el primero por fecha de la vista (DISTINCT ON … c7).
  const ABO = "LEFT JOIN abo a ON a.suc = btrim(m.c1) AND a.doc = ((('U'::text || btrim(m.c3)) || lpad(btrim(m.c4::text), 2, '0'::text)) || lpad(btrim(m.c5::text), 2, '0'::text)) AND a.folio = btrim(m.c6)";
  erp = una(erp, ABO, `LEFT JOIN LATERAL (SELECT k.c7::date AS fecha FROM kepler_ods.kdue k
               WHERE btrim(m.c3) = 'A'::text AND btrim(k.c1) = btrim(m.c1) AND k.c29 = 'A'::text
                 AND btrim(k.c4::text) = btrim(m.c4::text) AND btrim(k.c5::text) = btrim(m.c5::text) AND btrim(k.c6) = btrim(m.c6)
               ORDER BY k.c7 LIMIT 1) a ON true`, 'erp_receivable_documents (abo)');
  erp = una(erp, 'WITH src AS (', 'WITH llaves AS (SELECT * FROM unnest($1, $2) AS t(s, c)), src AS (', 'erp_receivable_documents (inicio)');
  const crX = cr.split('FROM analytics.erp_receivable_documents').join('FROM erd erp_receivable_documents');
  if (crX === cr) throw new Error('[CXC.21] customer_receivables ya no lee analytics.erp_receivable_documents: revisar la migración');
  return una(crX, 'WITH base AS (', `WITH erd AS (${erp}), base AS (`, 'customer_receivables (inicio)');
}

/**
 * Las fuentes. `pk` empareja el renglón viejo con el nuevo en un UPDATE; `cols` es lo que la cartera lee (un UPDATE
 * que no cambia ninguna no anota nada). `cuentas(x)` da las cuentas (sucursal, cliente) que tocan los renglones `x`.
 * `sucursal = '*'` = ese cliente en todas; `('*','*')` = todo.
 */
const facturaACuenta = (suc, d4, d5, folio) => `SELECT btrim(f.c1), COALESCE(btrim(f.c2), '') FROM kepler_ods.kdue f
   WHERE btrim(f.c1) = ${suc} AND f.c29 = 'C' AND btrim(f.c4::text) = ${d4} AND btrim(f.c5::text) = ${d5} AND btrim(f.c6) = ${folio}`;
/**
 * Las aplicaciones de un ABONO (por su llave), y de ahí la cuenta de cada factura. Va por `ix_kdm5_abono` (la crea esta
 * migración): sin él serían 78 mil renglones de kdm5 por cada abono, DENTRO de la transacción de la ingesta.
 */
const abonoACuentas = (r) => `SELECT q.* FROM kepler_ods.kdm5 m
     CROSS JOIN LATERAL (${facturaACuenta('btrim(m.c1)', 'btrim(m.c9::text)', 'btrim(m.c10::text)', 'btrim(m.c11)')}) q
   WHERE m.c2 = 'U' AND btrim(m.c1) = btrim(${r}.c1) AND btrim(m.c3) = btrim(${r}.c3_doc)
     AND btrim(m.c4::text) = btrim(${r}.c4::text) AND btrim(m.c5::text) = btrim(${r}.c5::text) AND btrim(m.c6) = btrim(${r}.c6)`;
// ⚠️ Sin «btrim(m.c8) = 'D'» A PROPÓSITO: con esa condición el planificador prefiere ix_kdm5_aplicacion_factura (empieza
// por sucursal y c8) y filtra ~14 mil renglones por abono. Medido el 2026-11-17 en la base de prueba: un lote de 500
// renglones de kdue pasaba de 28 ms a 7.2 s DENTRO de la ingesta. Sin ella, ix_kdm5_abono es el único índice que embona;
// una aplicación que no sea a factura «D» no encuentra factura en kdue (c29 = 'C') y no anota nada.
const FUENTES = [
  { corto: 'kdud', tabla: 'kepler_ods.kdud', pk: ['sucursal', 'c2'], cols: ['c7', 'c13', 'c14', 'c15', 'c16'],
    // Los datos del cliente (zona, límite, teléfono…) valen para todas sus cuentas.
    cuentas: (x) => `SELECT '*'::text, btrim(r.c2) FROM ${x} r WHERE COALESCE(btrim(r.c2), '') <> ''` },
  { corto: 'kdm5', tabla: 'kepler_ods.kdm5', pk: ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], cols: ['c8', 'c9', 'c10', 'c11', 'c13'],
    // Una aplicación mueve el saldo de la FACTURA a la que se aplica: la cuenta de esa factura.
    cuentas: (x) => `SELECT q.* FROM ${x} r CROSS JOIN LATERAL (${facturaACuenta('btrim(r.c1)', 'btrim(r.c9::text)', 'btrim(r.c10::text)', 'btrim(r.c11)')}) q
       WHERE r.c2 = 'U' AND btrim(r.c8) = 'D' AND btrim(r.c4::text) = ANY (${ABONO})` },
  { corto: 'kdue', tabla: 'kepler_ods.kdue', pk: ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    cols: ['c7', 'c8', 'c10', 'c11', 'c16', 'c18', 'c29'],
    // El documento es de su cuenta. Y un ABONO además fecha las aplicaciones a facturas de otras cuentas.
    cuentas: (x) => `SELECT btrim(r.c1), COALESCE(btrim(r.c2), '') FROM ${x} r
       WHERE (r.c29 = 'C' AND btrim(r.c4::text) = ANY (${CREDITO})) OR (r.c29 = 'A' AND btrim(r.c4::text) = ANY (${ABONO}))
       UNION
       SELECT a.* FROM (SELECT r.c1, 'A'::text AS c3_doc, r.c4, r.c5, r.c6 FROM ${x} r
                         WHERE r.c29 = 'A' AND btrim(r.c4::text) = ANY (${ABONO})) r2
         CROSS JOIN LATERAL (${abonoACuentas('r2')}) a` },
  { corto: 'kdm1', tabla: 'kepler_ods.kdm1', pk: ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], cols: ['c43'],
    // Sólo la CANCELACIÓN importa aquí: saca la aplicación de kepler_kdm5_vigente. Un abono que entra o sale
    // cancelado (o que se cancela / descancela) mueve las facturas a las que se aplicaba. Se compara con btrim (la
    // vista compara crudo): anotar una cuenta de más sólo cuesta recalcularla.
    cuentas: (x) => `SELECT a.* FROM (SELECT r.c1, r.c3 AS c3_doc, r.c4, r.c5, r.c6 FROM ${x} r
                         WHERE r.c2 = 'U' AND r.c3 = 'A' AND btrim(COALESCE(r.c43, '')) = 'C') r2
         CROSS JOIN LATERAL (${abonoACuentas('r2')}) a` },
];
/** De la tabla que la ingesta escribe menos a la que escribe más (contadores de prod desde el 1-nov). */
const ORDEN_CANDADO = ['kdud', 'kdm5', 'kdue', 'kdm1'];

function funcionDisparador(f) {
  const pkIgual = f.pk.map((c) => `o.${c} = n.${c}`).join(' AND ');
  const mismo = `(${f.cols.map((c) => `o.${c}`).join(', ')}) IS NOT DISTINCT FROM (${f.cols.map((c) => `n.${c}`).join(', ')})`;
  // En kdm1 (UPDATE) sólo cuenta si la cancelación cambió: se toman ambos lados SÓLO cuando c43 se movió.
  const cambiaron = (de, contra, a, b) => `(SELECT ${a}.* FROM ${de} ${a} WHERE NOT EXISTS (SELECT 1 FROM ${contra} ${b} WHERE ${pkIgual} AND ${mismo}))`;
  const anota = (sel) => `INSERT INTO analytics.receivables_dirty_accounts (sucursal, cliente_code, source)
          SELECT DISTINCT x.s, x.c, '${f.corto}' FROM (${sel}) x(s, c) WHERE x.s IS NOT NULL AND x.c IS NOT NULL`;
  return `
    CREATE OR REPLACE FUNCTION analytics.tg_receivables_${f.corto}()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $fn$
    DECLARE v_n integer := 0; v_state text; v_msg text;
    BEGIN
      BEGIN
        -- Falla cerrada: apagado (o sin renglón), no anota nada y la escritura pasa igual.
        IF NOT EXISTS (SELECT 1 FROM analytics.receivables_by_event WHERE enabled) THEN RETURN NULL; END IF;
        IF TG_OP = 'TRUNCATE' THEN
          INSERT INTO analytics.receivables_dirty_accounts (sucursal, cliente_code, source) VALUES ('*', '*', '${f.corto}');
          v_n := 1;
        ELSIF TG_OP = 'INSERT' THEN
          ${anota(f.cuentas('new_rows'))};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        ELSIF TG_OP = 'DELETE' THEN
          ${anota(f.cuentas('old_rows'))};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        ELSE
          ${anota(`${f.cuentas(cambiaron('new_rows', 'old_rows', 'n', 'o'))} UNION ${f.cuentas(cambiaron('old_rows', 'new_rows', 'o', 'n'))}`)};
          GET DIAGNOSTICS v_n = ROW_COUNT;
        END IF;
        IF v_n > 0 THEN PERFORM pg_notify('${CANAL}', ''); END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.receivables_dirty_errors (source_table, operation, sqlstate, message)
        VALUES ('${f.tabla}', TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END
    $fn$`;
}

/**
 * El que drena. `v_cols` son las columnas de la vista salvo `computed_at`: lo que se compara para saber si una fila
 * cambió (y lo que se escribe).
 */
function funcionDrenado(cols) {
  const lista = cols.join(', ');
  const t = (p) => cols.map((c) => `${p}.${c}`).join(', ');
  const set = cols.filter((c) => c !== 'folio_digital').map((c) => `${c} = t.${c}`).join(', ');
  // El mismo diff para las dos formas; `alcance` limita qué filas guardadas pueden borrarse (todas, o las de las cuentas).
  // La temporal lleva índice y estadísticas: sin ellas el DELETE … NOT EXISTS cae en nested loop (medido el 2026-11-17 en
  // la base de prueba: el llenado de 20 mil filas pasó de 1.4 s a 15.8 s según el plan que tocara).
  const diff = (alcance) => `
        CREATE INDEX ON pg_temp.cr_nueva (folio_digital);
        ANALYZE pg_temp.cr_nueva;
        UPDATE analytics.customer_receivables_current cur SET ${set}, computed_at = now()
          FROM pg_temp.cr_nueva t
         WHERE cur.folio_digital = t.folio_digital AND (${t('cur')}) IS DISTINCT FROM (${t('t')});
        GET DIAGNOSTICS v_upd = ROW_COUNT;
        INSERT INTO analytics.customer_receivables_current (${lista}, computed_at)
        SELECT ${t('t')}, now() FROM pg_temp.cr_nueva t
         WHERE NOT EXISTS (SELECT 1 FROM analytics.customer_receivables_current cur WHERE cur.folio_digital = t.folio_digital);
        GET DIAGNOSTICS v_ins = ROW_COUNT;
        DELETE FROM analytics.customer_receivables_current cur
         WHERE ${alcance}
           AND NOT EXISTS (SELECT 1 FROM pg_temp.cr_nueva t WHERE t.folio_digital = cur.folio_digital);
        GET DIAGNOSTICS v_del = ROW_COUNT;`;
  return `
    CREATE OR REPLACE FUNCTION analytics.drain_customer_receivables()
    RETURNS TABLE (mode text, reason text, marks integer, accounts integer, inserted integer, updated integer,
                   deleted integer, ms integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    DECLARE v_t0 timestamptz := clock_timestamp(); v_hasta bigint; v_marcas integer := 0; v_todo boolean := false;
            v_suc text[]; v_cli text[]; v_n integer := 0; v_modo text; v_motivo text;
            v_ins integer := 0; v_upd integer := 0; v_del integer := 0; v_state text; v_msg text;
    BEGIN
      -- Uno a la vez; si otro ya recalcula, no se espera: lo que quede en la cola lo toma la siguiente corrida.
      IF NOT pg_try_advisory_xact_lock(hashtext('analytics.drain_customer_receivables')) THEN
        mode := 'ocupado'; RETURN NEXT; RETURN;
      END IF;
      BEGIN
        -- Hasta el último id visible; lo que se confirme después se queda para la siguiente.
        SELECT max(q.id) INTO v_hasta FROM analytics.receivables_dirty_accounts q;
        CREATE TEMP TABLE IF NOT EXISTS cr_marcas (s text, c text) ON COMMIT DROP;
        TRUNCATE pg_temp.cr_marcas;
        WITH t AS (DELETE FROM analytics.receivables_dirty_accounts q WHERE q.id <= v_hasta RETURNING q.sucursal, q.cliente_code)
        INSERT INTO pg_temp.cr_marcas SELECT DISTINCT t.sucursal, t.cliente_code FROM t;
        GET DIAGNOSTICS v_marcas = ROW_COUNT;
        v_todo := EXISTS (SELECT 1 FROM pg_temp.cr_marcas WHERE c = '*');
        -- Un cliente marcado en todas las sucursales ('*') se abre en las sucursales donde la cartera existe.
        SELECT array_agg(x.s), array_agg(x.c) INTO v_suc, v_cli FROM (
          SELECT m.s, m.c FROM pg_temp.cr_marcas m WHERE m.s <> '*' AND m.c <> '*'
          UNION
          SELECT DISTINCT cur.sucursal, m.c FROM pg_temp.cr_marcas m
            JOIN analytics.customer_receivables_current cur ON COALESCE(cur.cliente_code, '') = m.c
           WHERE m.s = '*' AND m.c <> '*') x;
        v_n := COALESCE(cardinality(v_suc), 0);
        IF v_todo THEN
          v_motivo := 'marca_total';
        ELSIF NOT EXISTS (SELECT 1 FROM analytics.customer_receivables_current) THEN
          v_motivo := 'tabla_vacia';
        ELSIF NOT EXISTS (SELECT 1 FROM analytics.receivables_refresh_runs r
                           WHERE r.mode = 'completo' AND r.created_at >= ${INICIO_DEL_DIA}) THEN
          v_motivo := 'primero_del_dia';
        ELSIF v_marcas = 0 THEN
          mode := 'vacio'; RETURN NEXT; RETURN;
        ELSIF v_n > ${MAX_CUENTAS_POR_LLAVE} THEN
          v_motivo := 'umbral';
        ELSE
          v_motivo := 'cola';
        END IF;
        v_modo := CASE WHEN v_motivo = 'cola' THEN 'llave' ELSE 'completo' END;
        DROP TABLE IF EXISTS pg_temp.cr_nueva;
        IF v_modo = 'completo' THEN
          CREATE TEMP TABLE cr_nueva ON COMMIT DROP AS SELECT * FROM analytics.customer_receivables;
          ${diff('true')}
        ELSE
          CREATE TEMP TABLE cr_nueva ON COMMIT DROP AS SELECT * FROM analytics.customer_receivables_for(v_suc, v_cli);
          ${diff(`(cur.sucursal, COALESCE(cur.cliente_code, '')) IN (SELECT * FROM unnest(v_suc, v_cli))`)}
        END IF;
        INSERT INTO analytics.receivables_refresh_runs (mode, reason, marks, accounts, inserted, updated, deleted, ms)
        VALUES (v_modo, v_motivo, v_marcas, v_n, v_ins, v_upd, v_del,
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
        mode := v_modo; reason := v_motivo; marks := v_marcas; accounts := v_n;
        inserted := v_ins; updated := v_upd; deleted := v_del;
        ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
        RETURN NEXT;
      EXCEPTION WHEN OTHERS THEN
        -- Se deshace la toma de la cola (las marcas siguen ahí) y la falla queda escrita.
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.receivables_refresh_runs (mode, reason, marks, accounts, message, ms)
        VALUES ('error', v_motivo, v_marcas, v_n, v_state || ' ' || left(v_msg, 500),
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
        mode := 'error'; reason := v_motivo; marks := v_marcas; accounts := v_n;
        inserted := NULL; updated := NULL; deleted := NULL;
        ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
        RETURN NEXT;
      END;
    END
    $fn$`;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = async (rel) => (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [rel])).rows[0].ok;
  if (!(await hay('analytics.customer_receivables')) || !(await hay('analytics.erp_receivable_documents'))) {
    console.log('[CXC.21] sin las vistas de la cartera (entorno sin ODS): no hay nada que poner por evento.');
    return;
  }
  const viewdef = async (v) => (await knex.raw(`SELECT pg_get_viewdef(?::regclass, true) AS d`, [v])).rows[0].d.trim().replace(/;$/, '');

  // ── 1. El desempate determinista de kd ────────────────────────────────────────────────────────────────────────
  const erp0 = await viewdef('analytics.erp_receivable_documents');
  const erp = conDesempate(erp0);
  if (erp !== erp0) await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_receivable_documents AS ${erp}`);

  // ── 2. La cartera por cuenta, armada desde las vistas vivas ───────────────────────────────────────────────────
  const cr = await viewdef('analytics.customer_receivables');
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.customer_receivables_for(p_sucursal text[], p_cliente text[])
    RETURNS SETOF analytics.customer_receivables
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $fn$ ${armarPorCuenta(erp, cr)} $fn$`);
  await knex.raw(`COMMENT ON FUNCTION analytics.customer_receivables_for(text[], text[]) IS
    '[CXC.21] La cartera (mismas columnas que analytics.customer_receivables) de las cuentas (sucursal, cliente) pedidas. '
    'Armada por la migración 20261117144732 desde pg_get_viewdef de las dos vistas: si una vista cambia, hay que volver a '
    'armarla (el árbitro diario de receivables_refresh_runs lo delataría). Cliente vacío = ''''.'`);

  // ── 3. Las tablas ─────────────────────────────────────────────────────────────────────────────────────────────
  if (!(await hay('analytics.customer_receivables_current'))) {
    await knex.raw(`CREATE TABLE analytics.customer_receivables_current AS SELECT * FROM analytics.customer_receivables WITH NO DATA`);
    await knex.raw(`ALTER TABLE analytics.customer_receivables_current
      ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT '${M}'::uuid,
      ALTER COLUMN folio_digital SET NOT NULL, ALTER COLUMN computed_at SET DEFAULT now(),
      ADD CONSTRAINT customer_receivables_current_pkey PRIMARY KEY (folio_digital)`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_crc_cuenta ON analytics.customer_receivables_current (sucursal, cliente_code)`);
  await knex.raw(`COMMENT ON TABLE analytics.customer_receivables_current IS
    '[CXC.21] La cartera ya calculada (mismas columnas que analytics.customer_receivables). La escribe SÓLO '
    'analytics.drain_customer_receivables, por cuenta al llegar el cambio. computed_at = cuándo se recalculó esa fila. '
    'La API la lee cuando está lista (hay una corrida completa); si no, lee la vista.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.receivables_dirty_accounts (
      id            bigserial PRIMARY KEY,
      tenant_id     uuid NOT NULL DEFAULT '${M}'::uuid,
      sucursal      text NOT NULL,
      cliente_code  text NOT NULL,
      source        text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`COMMENT ON TABLE analytics.receivables_dirty_accounts IS
    '[CXC.21] Cola de cuentas (sucursal, cliente) por recalcular. Sólo altas, sin llave única (la ingesta nunca espera '
    'al que drena); la escriben SÓLO los disparadores tg_receivables_*; la vacía analytics.drain_customer_receivables. '
    'sucursal ''*'' = ese cliente en todas; (''*'', ''*'') = todo.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.receivables_dirty_errors (
      id            bigserial PRIMARY KEY,
      tenant_id     uuid NOT NULL DEFAULT '${M}'::uuid,
      source_table  text NOT NULL,
      operation     text NOT NULL,
      sqlstate      text,
      message       text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`COMMENT ON TABLE analytics.receivables_dirty_errors IS
    '[CXC.21] Lo que un disparador tg_receivables_* no pudo anotar. Nunca frena la ingesta: deja pasar la escritura y lo '
    'deja aquí. La corrida completa de cada mañana lo corrige; una fila aquí = un hueco con nombre.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.receivables_refresh_runs (
      id            bigserial PRIMARY KEY,
      tenant_id     uuid NOT NULL DEFAULT '${M}'::uuid,
      mode          text NOT NULL CHECK (mode IN ('llave', 'completo', 'error')),
      reason        text,
      marks         integer,
      accounts      integer,
      inserted      integer,
      updated       integer,
      deleted       integer,
      message       text,
      ms            integer,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rrr_modo ON analytics.receivables_refresh_runs (mode, created_at DESC)`);
  await knex.raw(`COMMENT ON TABLE analytics.receivables_refresh_runs IS
    '[CXC.21] Una fila por corrida del drenado. La COMPLETA es el árbitro: inserted/updated/deleted cuentan lo que '
    'difería de lo guardado. La cartera no depende de la fecha, así que en una completa del día debe ser 0 salvo la '
    'primera vez: otro número = un evento perdido.'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.receivables_by_event (
      tenant_id   uuid PRIMARY KEY DEFAULT '${M}'::uuid,
      enabled     boolean NOT NULL DEFAULT false,
      note        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`INSERT INTO analytics.receivables_by_event (tenant_id, enabled, note)
    VALUES ('${M}', false, 'Instalado apagado por 20261117144732: se prende junto con el worker que drena (CarteraPorEventoService).')
    ON CONFLICT (tenant_id) DO NOTHING`);
  await knex.raw(`COMMENT ON TABLE analytics.receivables_by_event IS
    '[CXC.21] Interruptor de los disparadores tg_receivables_*. Falla cerrada: apagado o sin renglón, no anotan nada. '
    'Apagarlo es la salida de emergencia sin DDL; prenderlo sin quien drene sólo llena la cola.'`);

  // ── 4. El drenado ─────────────────────────────────────────────────────────────────────────────────────────────
  const { rows: colsRows } = await knex.raw(`
    SELECT a.attname AS c FROM pg_attribute a
     WHERE a.attrelid = 'analytics.customer_receivables'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname <> 'computed_at' ORDER BY a.attnum`);
  await knex.raw(funcionDrenado(colsRows.map((r) => r.c)));
  await knex.raw(`REVOKE ALL ON FUNCTION analytics.drain_customer_receivables() FROM PUBLIC`);
  await knex.raw(`COMMENT ON FUNCTION analytics.drain_customer_receivables() IS
    '[CXC.21] Toma la cola receivables_dirty_accounts y recalcula esas cuentas con customer_receivables_for; o TODO (contra '
    'la vista) con marca total, tabla vacía, más de ${MAX_CUENTAS_POR_LLAVE} cuentas o en la primera corrida del día (México). '
    'ocupado = otro recalcula; vacio = nada; error = la cola quedó intacta y la falla está en receivables_refresh_runs.'`);

  // ── 5. Los disparadores (las funciones; los CREATE TRIGGER van al final) ───────────────────────────────────────
  // El índice que usan desde kdue (abonos) y kdm1 (cancelaciones) para llegar a las aplicaciones de un abono. kdm5 es
  // chica (~78 mil renglones): se crea en la transacción, frenando sus escrituras menos de un segundo.
  if (await hay('kepler_ods.kdm5')) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_kdm5_abono ON kepler_ods.kdm5
      (btrim(c1), btrim(c3), btrim((c4)::text), btrim((c5)::text), btrim(c6)) WHERE c2 = 'U'`);
  }
  const presentes = [];
  for (const f of FUENTES) {
    if (!(await hay(f.tabla))) { console.log(`[CXC.21] falta ${f.tabla} — sin disparador.`); continue; }
    const { rows: faltan } = await knex.raw(`
      SELECT c FROM unnest(ARRAY[${[...f.pk, ...f.cols].map((c) => `'${c}'`).join(', ')}]) c
       WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = '${f.tabla}'::regclass AND a.attname = c AND NOT a.attisdropped)`);
    if (faltan.length) throw new Error(`[CXC.21] ${f.tabla} no tiene ${faltan.map((x) => x.c).join(', ')}: el disparador fallaría en cada escritura`);
    await knex.raw(funcionDisparador(f));
    await knex.raw(`REVOKE ALL ON FUNCTION analytics.tg_receivables_${f.corto}() FROM PUBLIC`);
    presentes.push(f);
  }

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT ON analytics.customer_receivables_current, analytics.receivables_dirty_accounts,
          analytics.receivables_dirty_errors, analytics.receivables_refresh_runs, analytics.receivables_by_event TO app_runtime;
        GRANT EXECUTE ON FUNCTION analytics.drain_customer_receivables() TO app_runtime;
        GRANT EXECUTE ON FUNCTION analytics.customer_receivables_for(text[], text[]) TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON analytics.customer_receivables_current, analytics.receivables_dirty_accounts,
          analytics.receivables_dirty_errors, analytics.receivables_refresh_runs, analytics.receivables_by_event TO dev_ro;
      END IF;
    END $$`);
  const { rows: [g] } = await knex.raw(`
    SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS sin_rol,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
             has_function_privilege('app_runtime', 'analytics.drain_customer_receivables()', 'EXECUTE')
             AND has_table_privilege('app_runtime', 'analytics.customer_receivables_current', 'SELECT')
             AND NOT has_table_privilege('app_runtime', 'analytics.customer_receivables_current', 'INSERT')
             AND NOT has_table_privilege('app_runtime', 'analytics.receivables_dirty_accounts', 'INSERT')
             AND NOT has_table_privilege('app_runtime', 'analytics.receivables_by_event', 'UPDATE')
           END AS ok`);
  if (!g.sin_rol && !g.ok) throw new Error('[CXC.21] los permisos de app_runtime no quedaron como se declara');

  // ── 6. Los disparadores: AL FINAL, de la tabla más quieta a la más escrita, con CREATE OR REPLACE ──────────────
  const faltanEnOrden = presentes.filter((f) => !ORDEN_CANDADO.includes(f.corto));
  if (faltanEnOrden.length) throw new Error(`[CXC.21] fuentes sin lugar en ORDEN_CANDADO: ${faltanEnOrden.map((f) => f.corto).join(', ')}`);
  const OPS = [
    ['ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
    ['upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'],
    ['del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
    ['trn', 'TRUNCATE', ''],
  ];
  for (const corto of ORDEN_CANDADO) {
    const f = presentes.find((x) => x.corto === corto);
    if (!f) continue;
    for (const [suf, op, ref] of OPS) {
      await knex.raw(`CREATE OR REPLACE TRIGGER tg_receivables_${f.corto}_${suf}
        AFTER ${op} ON ${f.tabla} ${ref}
        FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_receivables_${f.corto}()`);
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más (la vista conserva el desempate: es un arreglo). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const f of FUENTES) {
    const { rows: [r] } = await knex.raw(`SELECT to_regclass('${f.tabla}') IS NOT NULL AS hay`);
    if (!r.hay) continue;
    for (const suf of ['ins', 'upd', 'del', 'trn']) await knex.raw(`DROP TRIGGER IF EXISTS tg_receivables_${f.corto}_${suf} ON ${f.tabla}`);
    await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_receivables_${f.corto}()`);
  }
  await knex.raw(`DROP INDEX IF EXISTS kepler_ods.ix_kdm5_abono`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.drain_customer_receivables()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.customer_receivables_for(text[], text[])`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.receivables_by_event, analytics.receivables_refresh_runs,
    analytics.receivables_dirty_errors, analytics.receivables_dirty_accounts, analytics.customer_receivables_current`);
};

// Para las pruebas: el mismo armado, sin base.
exports.armarPorCuenta = armarPorCuenta;
exports.conDesempate = conDesempate;
exports.FUENTES = FUENTES;
exports.MAX_CUENTAS_POR_LLAVE = MAX_CUENTAS_POR_LLAVE;
