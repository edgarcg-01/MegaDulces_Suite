'use strict';
/**
 * `[PGP.27]` — **El RFC del acreedor, resuelto y con procedencia**, y el motor de evidencia del
 * Calendario de Pagos usándolo.
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────────────────────
 *
 * `[PGP.19]` saca el RFC del acreedor de UN solo lugar: `kepler_ods.kdxd.c10`. Si ahí no hay
 * nada, el documento no cruza con ningún CFDI y la pantalla dice *«el proveedor no tiene RFC
 * capturado en Kepler»*. Medido contra prod el 2026-10-28 (sid 7688376744939610156), sobre los
 * 2,917 documentos exigibles por $102,277,689:
 *
 *  · **1,000 documentos · $29,067,071** no tienen RFC en Kepler.
 *  · ⭐ **368 documentos · $20,232,802 · 14 acreedores SÍ tienen RFC, pero MAL ESCRITO** — y
 *    eso no se veía, porque la vista no lo distinguía de tenerlo bien. Los casos:
 *
 *    | Kepler dice      | lo correcto     | acreedor                         | deuda        |
 *    |------------------|-----------------|----------------------------------|-------------:|
 *    | `BALO20930EL9`   | `BAL020930EL9`  | BOLSAS DE LOS ALTOS              | $14,281,642  |
 *    | `VISA41121OUI6`  | `VISA411210UI6` | ARTURO VILLARRUEL SAINZ          |  $1,447,438  |
 *    | `DGR0531773A`    | `DGR05031773A`  | DISTRIBUIDORA GRUBERSA           |  $1,010,402  |
 *    | `CAMR-590304-B`  | `CAMR590304BVA` | J. ROBERTO CASTILLO MENDOZA      |    $774,538  |
 *    | `AA0J620521PJ1`  | `AAOJ620521PJ1` | JUANA AYALA ORTIZ                |    $267,166  |
 *
 *    Una letra `O` donde va un cero, un dígito de menos, guiones. **Un RFC mal formado no es un
 *    RFC capturado**: no puede cruzar con nada, y el documento más caro de la casa estuvo
 *    invisible por un carácter.
 *
 * ── Qué hace esto ───────────────────────────────────────────────────────────────────────────
 *
 * 1. `analytics.v_supplier_rfc` — UNA respuesta a «¿cuál es el RFC de este acreedor?», con su
 *    procedencia declarada (ADR-056). El orden es: el de Kepler **si pasa la forma del SAT**;
 *    si no, el que resuelve el **nombre normalizado** contra ContPAQi y los CFDI recibidos,
 *    exigiendo que el nombre sea ÚNICO en su fuente; si no, nada **y dice por qué**.
 *
 *    ⛔ Vive en su propia vista a propósito (regla 16 / ADR-056): la lista de captura de
 *    proveedores, los estados de cuenta de acreedores y el puente de ContPAQi preguntan lo
 *    mismo y hoy cada uno lo re-deriva. Un primitivo por carril es como se llegó a tener el
 *    RFC en un solo lugar y mal.
 *
 * 2. `analytics.v_payable_evidence` lo consume, y gana dos columnas al final (`rfc` y
 *    `rfc_fuente`) para que la pantalla **no presente como de Kepler un RFC que salió de un
 *    cruce de nombre**.
 *
 * ── El normalizador del nombre, y por qué así ───────────────────────────────────────────────
 *
 * Sin acentos, sin puntuación, sin forma societaria al final, comparado **entero**. ⛔ NO por
 * prefijo: el cruce anterior comparaba los primeros 14 caracteres y perdía a `GAMAHUBIN SA DE
 * CV` contra `GAMAHUBIN` — y con él a otros nueve.
 *
 * ⛔ El índice de nombres del CFDI se arma sobre los **2,867 nombres DISTINTOS**, no sobre las
 *    170,435 filas: medido, 450 ms contra 4.4–9.0 s por la misma respuesta.
 * ⛔ Y se arma con `LEFT JOIN`, **nunca `LEFT JOIN LATERAL`**: con LATERAL el planificador
 *    rehace el índice una vez por cada uno de los 6,566 acreedores y la consulta no termina en
 *    10 minutos (medido, y hubo que cancelar el backend a mano).
 *
 * ── Lo medido, con sus controles ────────────────────────────────────────────────────────────
 *
 *  · Documentos con evidencia: **1,123 → 1,289** (+166) · **+$10,415,534**.
 *  · ⛔ **Pierden evidencia: 0. Bajan de PDF a sólo UUID: 0.** Para eso el RFC **literal** de
 *    Kepler se conserva como SEGUNDA llave (`rfc_crudo`): el comprobante de recepción fue
 *    tecleado desde la misma ficha, así que repite su error de dedo — y ese empate también es
 *    corroboración. Sin esa segunda llave, 1 documento perdía su factura y otro bajaba a UUID.
 *  · **Control negativo: 0.** El mismo motor con el nombre del acreedor corrido 3 letras no
 *    recupera NADA (166 contra 0).
 *  · **Control de reproducción**: el motor en modo «hoy» da exactamente lo que da la vista que
 *    corre en prod (1,123 = 1,123). ⚠️ Ese control atrapó un defecto propio: un `OR` escrito
 *    sin `IS TRUE` dejaba el puntaje en NULL cuando no había RFC y hacía desaparecer 31
 *    documentos del modo de referencia **en silencio**.
 *
 * ── Lo que esto NO hace, declarado ──────────────────────────────────────────────────────────
 *
 * ⚠️ **No corrige a Kepler.** Cuando el RFC de Kepler está bien formado pero el nombre resuelve
 *    a otro, **gana Kepler** y la vista lo publica en `rfc_discrepa` para que alguien decida.
 *    Son 414 documentos; entre ellos MONDELEZ (`PENC620207982`, un RFC de persona física en una
 *    sociedad, $3,067,873) y FABRICAS SELECTAS (dos RFC distintos según la sucursal). Eso es
 *    captura, no derivación: se entrega, no se inventa.
 * ── El costo, que casi hunde esto ───────────────────────────────────────────────────────────
 *
 * ⛔ Medido: la llamada real de la pantalla (`listEvidenceByRefs`, 200 refs) pasaba de
 *    **2.0 s a 6.9–9.2 s**. La causa no es el motor —con el RFC ya resuelto cuesta 2.5–2.8 s—
 *    sino **resolver el nombre contra `fiscal.cfdis`: 460 MB de heap sin ningún índice por
 *    emisor**, o sea un Seq Scan de 170,315 filas (0.8–4.9 s) en cada llamada.
 *
 *    | fuente del nombre | documentos que gana | dinero       | pantalla   |
 *    |-------------------|--------------------:|-------------:|-----------:|
 *    | sólo ContPAQi     | +155                |  $8,636,956  | 2.7–3.3 s  |
 *    | sólo CFDI         | +166                | $10,415,534  | 7.0–7.3 s  |
 *    | las dos           | +166                | $10,415,534  | 6.9–7.2 s  |
 *
 *    ⭐ Por eso esta migración **crea el índice** `ix_fiscal_cfdis_emisor`: es lo que deja tener
 *    las dos fuentes sin pagar el escaneo. ~170 mil entradas angostas sobre una tabla de 460 MB.
 *
 * ⛔⛔ **Y la migración se niega a quedarse si el índice no sirvió**: mide la resolución después
 *    de crearlo y si pasa de `TOPE_MS` **lanza**, con lo que la transacción entera se revierte y
 *    no queda ni el índice ni las vistas. Una vista que triplica el tiempo de la pantalla es
 *    peor que no tener los 166 documentos. ⚠️ **NO MEDIDO antes de aplicar**: el costo con el
 *    índice — la conexión de trabajo contra prod es de sólo lectura y no puede crearlo. Lo que
 *    hay es esta compuerta, que lo mide en el momento y decide.
 *
 * ⚠️ `v_payable_evidence` sigue por encima del tope de 500 ms (2.0 s medidos hoy) y la pantalla
 *    la pide diferida y sin bloquear. Materializarla sigue siendo el pendiente que ya tenía.
 *
 * Idempotente: sólo `CREATE OR REPLACE VIEW` y `GRANT`. No toca ninguna fila.
 *
 * @param { import("knex").Knex } knex
 */

/** Forma del RFC del SAT: 3 letras (moral) o 4 (física) + AAMMDD + homoclave de 3. */
const FORMA = `'^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'`;

/** Las formas societarias que se quitan del final del nombre, repetidamente. */
const SOCIETARIAS = [
  'S A DE C V', 'SA DE CV', 'S DE R L DE C V', 'S DE RL DE CV', 'SA DE C V', 'S A DE CV',
  'SAPI DE CV', 'S A P I DE C V', 'SPR DE RL DE CV', 'SPR DE RL', 'S P R DE R L',
  'SC DE RL DE CV', 'S EN C', 'SRL DE CV', 'SRL', 'SA', 'SC', 'SAS', 'SOFOM ENR', 'SOFOM',
  'Y CIA', 'Y COMPANIAS', 'Y COMPANIA', 'EN N C DE CV', 'EN NC DE CV', 'INC',
].join('|');

/**
 * El nombre, normalizado para poder compararlo entre sistemas que lo escriben distinto.
 * Todo lo que usa es IMMUTABLE, así que si algún día hace falta un índice de expresión, se
 * puede sacar de acá sin cambiar la regla.
 */
const NORM = (col) => `
  nullif(regexp_replace(
    btrim(regexp_replace(
      upper(translate(coalesce(${col}, ''),
        'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛáéíóúüñàèìòùâêîôû',
        'AEIOUUNAEIOUAEIOUaeiouunaeiouaeiou')),
      '[^A-Za-z0-9]+', ' ', 'g')),
    '( (${SOCIETARIAS}))+$', '', 'g'), '')`;

const RFC_VIEW = `
WITH acre AS (
  SELECT sucursal, btrim(c2) AS proveedor_code,
         min(nullif(btrim(c10), '')) AS rfc_kepler,
         min(nullif(btrim(c3),  '')) AS proveedor_nombre
    FROM kepler_ods.kdxd
   GROUP BY 1, 2),
-- Sobre los nombres DISTINTOS (2,867), no sobre las 170,435 filas: misma respuesta, 10x menos.
cfn AS (
  SELECT ${NORM('nombre')} AS n, min(rfc) AS rfc, count(DISTINCT rfc)::int AS cand
    FROM (SELECT DISTINCT emisor_nombre AS nombre, emisor_rfc AS rfc
            FROM fiscal.cfdis WHERE rol = 'recibidas' AND emisor_nombre IS NOT NULL) y
   GROUP BY 1 HAVING ${NORM('nombre')} IS NOT NULL),
cpn AS (
  SELECT ${NORM('nombre')} AS n, min(btrim(rfc)) AS rfc, count(DISTINCT btrim(rfc))::int AS cand
    FROM analytics.contpaqi_suppliers
   WHERE rfc IS NOT NULL AND btrim(rfc) <> ''
   GROUP BY 1 HAVING ${NORM('nombre')} IS NOT NULL),
-- Dos capas. Con LATERAL el planificador rehace cpn/cfn por cada acreedor: no termina.
res AS (
  SELECT k.*,
         -- El nombre sólo resuelve si es ÚNICO en su fuente. Si las dos fuentes lo conocen y
         -- se contradicen, NO se elige: se declara en la columna rfc_discrepa.
         CASE WHEN a.cand = 1 AND b.cand = 1 AND a.rfc = b.rfc THEN a.rfc
              WHEN a.cand = 1 AND b.cand = 1 THEN NULL
              WHEN b.cand = 1 THEN b.rfc
              WHEN a.cand = 1 THEN a.rfc END AS rfc_nombre,
         CASE WHEN a.cand = 1 AND b.cand = 1 AND a.rfc = b.rfc THEN 'contpaqi y sus facturas coinciden'
              WHEN a.cand = 1 AND b.cand = 1 THEN 'contpaqi y sus facturas se contradicen'
              WHEN b.cand = 1 THEN 'sus facturas (CFDI del SAT)'
              WHEN a.cand = 1 THEN 'contpaqi'
              WHEN a.n IS NOT NULL OR b.n IS NOT NULL THEN 'varios acreedores con ese nombre'
              END AS via
    FROM acre k
    LEFT JOIN cpn a ON a.n = ${NORM('k.proveedor_nombre')}
    LEFT JOIN cfn b ON b.n = ${NORM('k.proveedor_nombre')})
SELECT sucursal, proveedor_code, proveedor_nombre,
       -- El RFC USABLE. Gana Kepler cuando su valor tiene forma de RFC; si no, el nombre.
       CASE WHEN upper(rfc_kepler) ~ ${FORMA} THEN rfc_kepler ELSE rfc_nombre END AS rfc,
       -- Lo que Kepler dice LITERAL, aunque esté mal escrito. Sirve de segunda llave: el papel
       -- que Compras captura se teclea desde esta misma ficha y repite su error.
       rfc_kepler AS rfc_crudo,
       (rfc_kepler IS NOT NULL AND NOT (upper(rfc_kepler) ~ ${FORMA})) AS rfc_kepler_mal_formado,
       CASE WHEN upper(rfc_kepler) ~ ${FORMA} THEN 'kepler'
            WHEN rfc_nombre IS NOT NULL THEN 'nombre'
            ELSE 'ninguna' END::text AS fuente,
       CASE WHEN upper(rfc_kepler) ~ ${FORMA} THEN NULL ELSE via END::text AS via,
       -- Kepler trae uno bien formado y el nombre dice OTRO. No se corrige acá: se declara.
       CASE WHEN upper(rfc_kepler) ~ ${FORMA} AND rfc_nombre IS NOT NULL AND rfc_nombre <> rfc_kepler
            THEN rfc_nombre END AS rfc_discrepa,
       CASE WHEN upper(rfc_kepler) ~ ${FORMA} OR rfc_nombre IS NOT NULL THEN NULL
            WHEN rfc_kepler IS NOT NULL
              THEN 'el RFC capturado en Kepler (' || rfc_kepler || ') no tiene forma de RFC, y el nombre no resuelve en ningun otro sistema'
            WHEN proveedor_nombre IS NULL THEN 'el acreedor no tiene ni RFC ni nombre en Kepler'
            ELSE 'sin RFC en Kepler y el nombre no aparece en ContPAQi ni en ningun CFDI recibido'
            END::text AS motivo
  FROM res`;

const EVIDENCIA = `
WITH pay AS (
  SELECT v.tenant_id, v.sucursal, v.doc_tipo, v.doc_sub, btrim(v.folio) AS folio,
         v.proveedor, v.fecha::date AS fecha, v.importe, v.pendiente,
         nullif(btrim(coalesce(v.referencia, '')), '') AS referencia,
         nullif(regexp_replace(btrim(v.folio), '[^0-9]', '', 'g'), '')::numeric AS folio_n,
         nullif(regexp_replace(coalesce(v.referencia, ''), '[^0-9]', '', 'g'), '')::numeric AS ref_n,
         r.rfc, r.rfc_crudo, coalesce(r.fuente, 'ninguna') AS rfc_fuente, r.motivo AS rfc_motivo
    FROM analytics.v_supplier_payables v
    LEFT JOIN analytics.v_supplier_rfc r
           ON r.sucursal = v.sucursal AND r.proveedor_code = btrim(v.proveedor)
   WHERE v.pendiente > 0
     -- Lo financiero no puede tener factura de proveedor. Mismos prefijos que
     -- PREFIJOS_FINANCIEROS / GRUPOS_FINANCIEROS en creditor-statements.engine.ts.
     AND NOT ( btrim(coalesce(v.grupo, '')) = '140'
            OR upper(btrim(v.proveedor)) LIKE 'A%'
            OR upper(btrim(v.proveedor)) LIKE 'TC%'
            OR upper(btrim(v.proveedor)) LIKE 'B.B.%' )),
pr AS (
  SELECT id, sucursal, receipt_monto AS imp, receipt_date AS fec,
         nullif(btrim(coalesce(proveedor_rfc, '')), '') AS rfc,
         nullif(regexp_replace(btrim(folio), '[^0-9]', '', 'g'), '')::numeric AS folio_n,
         nullif(regexp_replace(coalesce(ocr_folio, ''), '[^0-9]', '', 'g'), '')::numeric AS ocr_n
    FROM finance.goods_receipt_proofs
   WHERE jsonb_array_length(files) > 0),
cfd AS (
  SELECT uuid, emisor_rfc AS rfc, total AS imp, fecha::date AS fec,
         nullif(regexp_replace(coalesce(folio, ''), '[^0-9]', '', 'g'), '')::numeric AS folio_n
    FROM fiscal.cfdis
   WHERE rol = 'recibidas'),
-- Cada rama entra por UNA llave de IGUALDAD (hash join). Un OR en el ON fuerza bucle
-- anidado sobre 170 mil filas y lleva la consulta de 16 s a mas de 2 min: no se toca.
-- ⛔ La senal del RFC compara contra el RESUELTO y contra el LITERAL de Kepler, y va envuelta
--    en IS TRUE: sin eso, un acreedor sin RFC deja el puntaje en NULL y el documento
--    desaparece en silencio (medido: 31 documentos).
cand AS (
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf'::text AS clase, x.id::text AS ref_evidencia,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int AS s_imp,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int AS s_fec,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int AS s_fol,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int AS s_ref,
         ((x.rfc = p.rfc OR x.rfc = p.rfc_crudo) IS TRUE)::int AS s_rfc
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.folio_n = p.folio_n
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf', x.id::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int,
         (x.ocr_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.ocr_n = p.ref_n)::int,
         ((x.rfc = p.rfc OR x.rfc = p.rfc_crudo) IS TRUE)::int
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.ocr_n = p.ref_n
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf', x.id::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int,
         1
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.rfc = p.rfc
  UNION ALL
  -- La rama del RFC LITERAL de Kepler. Existe para que nadie PIERDA lo que hoy ve: el
  -- comprobante tecleado desde una ficha con el RFC mal escrito trae el mismo error.
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'pdf', x.id::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (x.fec IS NOT NULL AND abs(x.fec - p.fecha) <= 5)::int,
         (x.folio_n IS NOT NULL AND x.folio_n = p.folio_n)::int,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int,
         1
    FROM pay p JOIN pr x ON x.sucursal = p.sucursal AND x.rfc = p.rfc_crudo
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'uuid', x.uuid::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (abs(x.fec - p.fecha) <= 5)::int,
         0,
         (x.folio_n IS NOT NULL AND p.ref_n IS NOT NULL AND x.folio_n = p.ref_n)::int,
         1
    FROM pay p JOIN cfd x ON x.rfc = p.rfc
  UNION ALL
  SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor,
         'uuid', x.uuid::text,
         (abs(x.imp - p.importe) <= 0.01 * p.importe)::int,
         (abs(x.fec - p.fecha) <= 5)::int,
         0, 1,
         ((x.rfc = p.rfc OR x.rfc = p.rfc_crudo) IS TRUE)::int
    FROM pay p JOIN cfd x ON x.folio_n = p.ref_n),
punt AS (
  SELECT c.*, (c.s_imp + c.s_fec + c.s_fol + c.s_ref + c.s_rfc) AS puntaje
    FROM cand c
   WHERE c.s_imp = 1 OR c.s_rfc = 1),
mejor AS (
  SELECT DISTINCT ON (tenant_id, sucursal, doc_tipo, doc_sub, folio) *
    FROM punt
   WHERE puntaje >= 3
   ORDER BY tenant_id, sucursal, doc_tipo, doc_sub, folio,
            (clase = 'pdf') DESC, puntaje DESC, ref_evidencia)
SELECT p.tenant_id, p.sucursal, p.doc_tipo, p.doc_sub, p.folio, p.proveedor, p.pendiente,
       coalesce(m.clase, 'ninguna')::text AS evidencia,
       m.ref_evidencia,
       coalesce(m.puntaje, 0)::int AS puntaje,
       array_remove(ARRAY[
         CASE WHEN m.s_imp = 1 THEN 'importe' END,
         CASE WHEN m.s_fec = 1 THEN 'fecha' END,
         CASE WHEN m.s_fol = 1 THEN 'folio' END,
         CASE WHEN m.s_ref = 1 THEN 'referencia' END,
         CASE WHEN m.s_rfc = 1 THEN 'rfc' END], NULL)::text[] AS senales,
       CASE WHEN m.clase IS NOT NULL THEN NULL
            WHEN p.rfc IS NULL THEN coalesce(p.rfc_motivo, 'el acreedor no tiene RFC')
            WHEN p.fecha < DATE '2026-08-04' THEN 'anterior a que se empezara a adjuntar la factura'
            WHEN p.referencia IS NULL THEN 'el documento no trae referencia del proveedor'
            ELSE 'no hay ninguna prueba que alcance el umbral de confianza' END::text AS motivo,
       -- Columnas NUEVAS, al final (es lo unico que CREATE OR REPLACE VIEW permite agregar).
       p.rfc,
       p.rfc_fuente
  FROM pay p
  LEFT JOIN mejor m
    ON m.tenant_id = p.tenant_id AND m.sucursal = p.sucursal AND m.doc_tipo = p.doc_tipo
   AND m.doc_sub = p.doc_sub AND m.folio = p.folio`;

/**
 * El cuerpo de las dos vistas, expuesto para poder EJERCERLO sin aplicar nada: la conexión de
 * trabajo contra prod es de sólo lectura (`cannot execute CREATE VIEW in a read-only
 * transaction`), así que un ensayo con ROLLBACK no alcanza. Armando `EVIDENCIA` con
 * `RFC_VIEW` metido como subconsulta se corre el MISMO texto que se va a aplicar.
 * Knex sólo mira `up`/`down`; esto no cambia lo que la migración hace.
 */
exports.SQL = { RFC_VIEW, EVIDENCIA };

/**
 * Lo que la resolución puede costar y seguir siendo aceptable. Hoy, sin la pata del CFDI,
 * cuesta ~200 ms (ContPAQi son 3,417 filas). Con el índice se espera el mismo orden. Si pasa
 * de acá, el índice no sirvió y la migración se revierte entera.
 */
const TOPE_MS = 1000;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '15s'`);

  // ⭐ El índice que hace viable resolver el nombre contra el CFDI. `tenant_id` va PRIMERO
  //    porque RLS agrega `tenant_id = current_setting('app.tenant_id')` a toda lectura, y sin
  //    él la condición no entra por el índice. Parcial por `rol`: de las 450 mil filas, sólo
  //    170,315 son recibidas. ⛔ NO va CONCURRENTLY: dentro de una migración no se puede, y el
  //    aplicador ya acota el bloqueo con `lock_timeout` — si no lo consigue, falla sin dejar
  //    nada, que es lo correcto. Por eso esto se aplica FUERA de horario hábil (regla 9).
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ix_fiscal_cfdis_emisor
       ON fiscal.cfdis (tenant_id, emisor_nombre, emisor_rfc)
      WHERE rol = 'recibidas'`,
  );

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_rfc AS ${RFC_VIEW}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_supplier_rfc IS ` +
      `'[PGP.27] El RFC de cada acreedor de Kepler con su PROCEDENCIA: el de kdxd.c10 si pasa la forma del SAT, si no el que resuelve el nombre normalizado contra ContPAQi y los CFDI recibidos (unico en su fuente), si no NULL con su motivo. rfc_crudo conserva lo que Kepler dice literal. Derivada: no materializa nada.'`,
  );
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_rfc TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_supplier_rfc TO dev_ro`);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS ${EVIDENCIA}`);
  await knex.raw(
    `COMMENT ON VIEW analytics.v_payable_evidence IS ` +
      `'[PGP.27] La mejor prueba documental de cada documento por pagar. 5 senales, ancla importe-o-RFC, umbral 3. El RFC del acreedor sale de analytics.v_supplier_rfc y declara su procedencia en rfc_fuente. Medido 2026-10-28: 1123 -> 1289 documentos con evidencia (+10,415,534 pesos), 0 pierden, placebo 0.'`,
  );

  // ── La compuerta de costo, con su medición en voz alta ────────────────────────────────────
  // Primera pasada para calentar, segunda para medir: lo que se publica es la segunda.
  const medir = async () => {
    const t0 = Date.now();
    const [{ n }] = (await knex.raw(
      `SELECT count(*) FILTER (WHERE fuente = 'nombre')::int AS n FROM analytics.v_supplier_rfc`,
    )).rows;
    return { ms: Date.now() - t0, n };
  };
  await medir();
  const { ms, n } = await medir();
  console.log(`[PGP.27] acreedores cuyo RFC lo resuelve el nombre: ${n} · resolver cuesta ${ms} ms`);
  if (ms > TOPE_MS) {
    throw new Error(
      `[PGP.27] resolver el RFC cuesta ${ms} ms (tope ${TOPE_MS} ms): el indice ix_fiscal_cfdis_emisor ` +
        `no bajo el costo. Se revierte TODO. Sin el indice, la pantalla de pagos pasa de 2.0 s a ~7 s ` +
        `por 11 documentos mas, y eso no se entrega. Siguiente paso: medir el plan a mano ` +
        `(EXPLAIN ANALYZE sobre el cuerpo de analytics.v_supplier_rfc) antes de reintentar.`,
    );
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve `v_payable_evidence` a su cuerpo de `[PGP.19]`. */
exports.down = async function down(knex) {
  // ⛔ No se puede volver con CREATE OR REPLACE: el cuerpo viejo tiene DOS columnas menos y
  //    Postgres no deja QUITAR columnas de una vista. Se baja y se vuelve a crear.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_payable_evidence`);
  const viejo = require('./20261027103328_pgp19_evidencia_de_factura_por_pagable.js');
  await viejo.up(knex);
  // ⛔ Los GRANT NO sobreviven a un DROP. Sin esto, el `down` deja la vista viva y a la API
  //    sin permiso de leerla, que se ve igual que «no hay datos».
  await knex.raw(`GRANT SELECT ON analytics.v_payable_evidence TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_payable_evidence TO dev_ro`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_supplier_rfc`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.ix_fiscal_cfdis_emisor`);
};
