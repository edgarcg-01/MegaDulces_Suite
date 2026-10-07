/**
 * `[DM.17.1]` — **El 82% "no verificable" era MI LLAVE, no un hueco de datos.**
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * `[DM.17]` cruzaba `kdm1.c24` (folio del ticket) contra `wincaja.maestro_mov_almacen.documento`
 * **por cadena exacta**, y declaró `ticket_fuera_de_replica` para el 96.7%. Edgar no se conformó:
 * *"necesitamos un 100%... buscá de nuevo en el flujo, si existe más de un dato"*.
 *
 * Al mirar los tickets que NO casaban, resultó que **están en la réplica**: lo que cambia es cómo
 * los teclea la persona.
 *
 *     casan hoy      T990007838                        (T + 9 dígitos, limpio)
 *     NO casaban     Folio: T900000002        234 docs
 *                    T99-3132                  63 docs
 *                    T990007803 JALH           21 docs
 *                    T-99-7885                 14 docs
 *                    T990008225 CEDIS - …       9 docs
 *
 * **Medido: de los 568 declarados fuera de la réplica, 438 SÍ existen en Wincaja** una vez que el
 * folio se lee normalizado. Y los que ya casaban siguen casando — **cero regresiones**.
 *
 * ⚠️ Dos correcciones de números publicados, de paso:
 *   · El **96.7%** era sobre TODAS las ramas. Para la sucursal `00`, que es la pregunta, era
 *     **82.3%**. *Un agregado correcto sobre un universo que no es el de la pregunta engaña igual.*
 *   · Wincaja escribe el folio como `T` + 2 dígitos de CAJA + 7 de folio, y la caja `99` la
 *     comparten **5 ramas** (30, 10, 00, 50, 32) — por eso el folio solo nunca alcanzó y el
 *     desambiguador sigue siendo el CONTENIDO (sku + cantidad).
 *
 * ── EL EFECTO, MEDIDO EN LA SUCURSAL 00 ─────────────────────────────────────────────────────
 *
 *     veredicto                  antes              después
 *     origen_confirmado           62 · $ 6,607,022    310 · $34,347,256
 *     otra_plaza                  57 · $ 1,515,473    225 · $ 5,144,762   ← 4 plazas: 10/30/32/50
 *     ticket_fuera_de_replica    568 · $35,901,503      7 · $   279,533
 *     sin_renglon_que_case         2 · $   152,325     22 · $   450,854
 *     ambiguo                      1 · $   739,346      3 · $ 1,482,905
 *     sin_ticket_legible           —                  123 · $ 3,210,360   ← bucket NUEVO
 *
 * Cobertura **17.7% → 77.5%**. Y lo que la pantalla publica como CEDIS y no lo es sube de
 * $1.5M a **$5.1M**.
 *
 * ── ⭐ EL BUCKET NUEVO: `sin_ticket_legible` ────────────────────────────────────────────────
 * 123 documentos cuyo `c24` no trae ningún folio: es texto libre. **No se mezcla con
 * "fuera de réplica"**, porque son fallas distintas — uno es un dato que no tenemos, el otro es
 * un dato que nadie escribió. Y varios **nombran la plaza en el propio texto**:
 *
 *     TRASPASO CANINDO A ZAMORA CENTRO   14      LO QUE DIJO LUPITA    9
 *     TRASPASO CANINDO A DAMASO          11+8    BRUNO                 6
 *     TRASPASO CEDIS A LPA                7      CORRECCION            5
 *
 * ⛔ **No se leen acá.** Un texto tecleado es un testigo más débil que el cruce con otro ERP, y
 * mezclarlos borraría la diferencia. Queda declarado y a la vista.
 * ⚠️ Nótese que 14 de esos documentos son **Canindo → Zamora Centro**: ninguna punta es el CEDIS.
 *
 * ── ⛔ SE BUSCÓ UN SEGUNDO TESTIGO Y NO EXISTE (medido, no supuesto) ────────────────────────
 * Con los **535 documentos ya etiquetados** por Wincaja como conjunto de control, se escanearon:
 *
 *     kdm1, sus 200 columnas          máx 67.7%  (piso de ruido 57.9%) — y las mejores son
 *                                     `c10`/`c32`, que son el DESTINO, no el origen
 *     kdm2, columnas de renglón       máx 67.0%
 *     kdpord (cola de surtido)        presente en el 100%, venga de donde venga
 *     el `U-A-50` de quien RECIBE     dice `c10='TI000'` / `c32='CEDIS'` porque COPIA lo que
 *                                     declaró el que embarca → es un espejo, no un árbitro (R5)
 *
 * O sea: **para los traspasos, Kepler genuinamente no guarda el origen físico.** La conclusión de
 * `[DM.17]` era correcta, pero se apoyaba en un diff de DOS documentos; ahora se apoya en 535 ×
 * 200 columnas. *Dos documentos que comparten capturista no prueban que un campo sea inútil.*
 *
 * ⚠️ Límite del escaneo de `kdm2`: se midió **un renglón por documento**, no todos.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * El folio del ticket, leído de lo que la persona tecleó.
 * Wincaja lo escribe `T` + 2 de caja + 7 de folio; acá se recupera esa forma.
 */
const TICKET = (c) => `CASE
    WHEN length(substring(upper(regexp_replace(${c}, '[^0-9A-Za-z]', '', 'g')) from 'T([0-9]+)')) = 9
      THEN 'T' || substring(upper(regexp_replace(${c}, '[^0-9A-Za-z]', '', 'g')) from 'T([0-9]+)')
    WHEN length(substring(upper(regexp_replace(${c}, '[^0-9A-Za-z]', '', 'g')) from 'T([0-9]+)')) BETWEEN 3 AND 8
      THEN 'T' || substring(substring(upper(regexp_replace(${c}, '[^0-9A-Za-z]', '', 'g')) from 'T([0-9]+)'), 1, 2)
             || lpad(substring(substring(upper(regexp_replace(${c}, '[^0-9A-Za-z]', '', 'g')) from 'T([0-9]+)'), 3), 7, '0')
  END`;

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_transfer_true_origin
      WITH (security_invoker = true) AS
    WITH kep AS (
      SELECT m.sucursal, m.c1 AS almacen, m.c6 AS folio, m.c5 AS doc_serie,
             m.c9::date AS doc_date,
             m.c24 AS ticket_tecleado,
             ${TICKET('m.c24')} AS ticket_ref,
             m.c16::numeric AS importe, m.c10 AS dest_code
        FROM kepler_ods.kdm1 m
       WHERE m.c2 = 'U' AND m.c3 = 'D' AND m.c4 = 41
         AND COALESCE(m.c24, '') <> ''
    ), kl AS (
      SELECT k.sucursal, k.folio, k.doc_serie, l.c8 AS sku, round(l.c9::numeric, 2) AS qty
        FROM kep k
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = k.sucursal AND l.c2 = 'U' AND l.c3 = 'D' AND l.c4 = 41
         AND l.c6 = k.folio AND l.c5 = k.doc_serie
    ), mae AS (
      SELECT w.tenant_id, w.source_branch, w.source_dataset, w.consecutivo, w.documento
        FROM wincaja.maestro_mov_almacen w
        JOIN (SELECT DISTINCT ticket_ref FROM kep WHERE ticket_ref IS NOT NULL) t
          ON t.ticket_ref = w.documento
    ), wl AS (
      SELECT m.source_branch AS rama, m.documento,
             d.articulo AS sku, round(abs(d.cantidad_regular)::numeric, 2) AS qty
        FROM mae m
        JOIN wincaja.detalles_mov_almacen d
          ON d.tenant_id = m.tenant_id AND d.source_branch = m.source_branch
         AND d.source_dataset = m.source_dataset AND d.consecutivo = m.consecutivo
    )
    SELECT k.sucursal AS sucursal_kepler, k.almacen, k.folio, k.doc_serie, k.doc_date,
           k.ticket_ref, k.importe, k.dest_code,
           r.ramas AS origen_rama_wincaja,
           t.existe AS ticket_en_replica,
           CASE
             WHEN k.ticket_ref IS NULL              THEN 'sin_ticket_legible'
             WHEN NOT t.existe                      THEN 'ticket_fuera_de_replica'
             WHEN r.ramas IS NULL                   THEN 'sin_renglon_que_case'
             WHEN r.ramas LIKE '%,%'                THEN 'ambiguo'
             WHEN r.ramas = k.sucursal              THEN 'origen_confirmado'
             ELSE 'otra_plaza'
           END AS origen_veredicto,
           -- ⚠️ Va al FINAL: un CREATE OR REPLACE VIEW no puede reordenar columnas.
           -- Se publica lo que la persona TECLEÓ, no sólo lo normalizado: sin eso, nadie puede
           -- auditar por que un documento quedo en sin_ticket_legible.
           k.ticket_tecleado
      FROM kep k
      LEFT JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM mae m WHERE m.documento = k.ticket_ref) AS existe
      ) t ON true
      LEFT JOIN LATERAL (
        -- Una rama CASA si comparte al menos un renglón (sku + cantidad) con el documento
        -- Kepler. Si casan varias, se declara ambiguo: elegir una sería inventar. Sigue siendo
        -- obligatorio porque la caja 99 del folio la comparten 5 ramas.
        SELECT string_agg(DISTINCT w.rama, ',' ORDER BY w.rama) AS ramas
          FROM wl w
         WHERE w.documento = k.ticket_ref
           AND EXISTS (
             SELECT 1 FROM kl x
              WHERE x.sucursal = k.sucursal AND x.folio = k.folio AND x.doc_serie = k.doc_serie
                AND x.sku = w.sku AND abs(x.qty - w.qty) < 0.01)
      ) r ON true`);

  await knex.raw(`GRANT SELECT ON analytics.v_transfer_true_origin TO app_runtime`);
};

exports.down = async function () {
  // Sin vuelta atras: revertir devolveria 438 documentos a "no verificable" sin que lo sean.
};
