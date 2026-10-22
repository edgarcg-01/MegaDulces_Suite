'use strict';
/**
 * `[CGA-A.41]` — Cuatro depósitos de ruta capturados desde CAOS el 12-oct con la glosa de un GASTO.
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────────────────────────
 *
 * El 12-oct, entre las 15:22 y las 15:50, se capturaron cuatro depósitos de efectivo de ruta
 * desde la caja fuerte (CAOS). Los cuatro quedaron con la glosa
 * «X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ», que es el texto del GASTO `CG-2026-00006`
 * ($6,302.78, sucursal 03) capturado ese mismo día a las 12:36. En el Cuadre de
 * `/finanzas/caja` aparecían como «X-D-26 … ingreso», y Edgar preguntó con razón por qué un
 * documento de gasto estaba marcado como ingreso.
 *
 * La causa es el defecto que `[CG.111]` corrigió el 13-oct a las 10:51: el campo de CAOS se veía
 * aunque ya hubiera un documento elegido, y al usarlo **borraba el documento en silencio pero
 * conservaba su glosa** (`glosa: v.glosa?.trim() || 'CAOS …'`). Estos cuatro son el residuo de
 * ese defecto: medido, son los ÚNICOS ingresos del libro con glosa de gasto (y no hay ningún
 * gasto con glosa de cobro).
 *
 * ── Qué se corrige ──────────────────────────────────────────────────────────────────────────
 *
 * 1. **La glosa**, con la fórmula EXACTA que la pantalla corregida escribe para un depósito de
 *    CAOS: `CAOS <type_label> #<external_id> · <ref>`, leída del movimiento real de la máquina
 *    (`analytics.caos_cash_movements`). No se inventa texto.
 * 2. **El documento de Kepler que pagan** (`declared_doc_ref`), en los tres que lo tienen. El
 *    beneficiario que tecleó Carmen nombra la ruta, y casa con el cobro de esa camioneta:
 *      · CI-2026-00005 «rd 28»  $12,361.00 → 01-006|U-A-5|0000009|0011  ruta_28  $12,361.00
 *      · CI-2026-00006 «r23»    $17,574.00 → 01-003|U-A-5|0000009|0011  ruta_23  $17,574.00
 *      · CI-2026-00007 «rd 26»  $15,336.00 → 01-004|U-A-5|0000009|0011  ruta_26  $15,335.85
 *    Se DECLARA y no se VINCULA: el origen de estos movimientos es la máquina (`origen_tipo =
 *    'caos'`, `origen_ref = AST700-…`) y una captura tiene un solo origen — mismo modelo que la
 *    regla `[CGA-A.10]`.
 * 3. **CI-2026-00003 «ruta 27» $12,594.00 NO se declara**: la ruta 27 no tiene cobro de caja el
 *    12-oct. Su folio 0000009 no existe en Kepler y el 0000010 es de $1,632.98 en la cuenta 4166.
 *    Se escribe el motivo; si el cobro aparece, la guarda 5 aborta para que alguien lo revise.
 *
 * ── Lo que NO toca ───────────────────────────────────────────────────────────────────────────
 *
 * Ni importes, ni estado, ni corte: los cuatro están en `CC-2026-00001` (cerrado) y sus montos
 * son los contados. Sólo cambian texto y la declaración del documento.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO. Aplicala con
 *    `apply-one-migration-prod.js` ANTES de mergear.
 *
 * Idempotente: si la glosa ya es la nueva y la declaración ya está puesta, no hace nada.
 * Todas las guardas corren ANTES de la primera escritura: si una falla, no se toca ninguna fila.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const DEVICE = 'AST700-19758';
const GLOSA_MALA = 'X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ';
const MARCA = 'CGA-A.41 (2026-10-20)';

/** Los cuatro, con lo MEDIDO en prod (sólo lectura, 2026-10-20). */
const FILAS = [
  { folio: 'CI-2026-00003', monto: '12594.00', caosExt: '1564', doc: null,
    motivo: 'ruta 27 sin cobro de caja el 12-oct: el folio U-A-5 0000009 de 01-005 no existe en Kepler y el 0000010 es de $1,632.98 en la cuenta 4166. El deposito de CAOS ($12,590 en la maquina) no tiene documento que lo respalde.' },
  { folio: 'CI-2026-00005', monto: '12361.00', caosExt: '1568',
    doc: { almacen: '01-006', cobroFolio: '0000009', importe: '12361.00', ruta: 'ruta_28' } },
  { folio: 'CI-2026-00006', monto: '17574.00', caosExt: '1569',
    doc: { almacen: '01-003', cobroFolio: '0000009', importe: '17574.00', ruta: 'ruta_23' } },
  { folio: 'CI-2026-00007', monto: '15336.00', caosExt: '1570',
    doc: { almacen: '01-004', cobroFolio: '0000009', importe: '15335.85', ruta: 'ruta_26' } },
];

const refDe = (d) => `${d.almacen}|U-A-5|${d.cobroFolio}|0011`;

/** Añade la nota SIN borrar lo que escribió la persona (mismo patrón que `[CGA-A.31]`). */
const SQL_NOTA = `
  UPDATE finance.cash_ledger
     SET sin_documento_motivo = CASE
           WHEN sin_documento_motivo IS NULL OR sin_documento_motivo = '' THEN ?
           WHEN position('CGA-A.41' in sin_documento_motivo) > 0 THEN sin_documento_motivo
           ELSE sin_documento_motivo || ' | ' || ?
         END,
         updated_at = now()
   WHERE tenant_id = ? AND folio = ?`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const abortar = (m) => {
    throw new Error(`[CGA-A.41] ${m} -- migracion abortada, no se toco ninguna fila.`);
  };
  // ⚠️ Las vistas de analytics filtran por `current_tenant_id()`: sin esto devuelven CERO filas
  //    sin ningún error y las guardas pasarían por vacío.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  const plan = [];
  for (const v of FILAS) {
    // Guarda 1: el movimiento existe, está vivo, es el depósito de CAOS que se midió.
    const { rows } = await knex.raw(
      `SELECT tipo, estado, deleted_at, monto, origen_tipo, origen_ref, glosa, declared_doc_ref
         FROM finance.cash_ledger WHERE tenant_id = ? AND folio = ?`, [TENANT, v.folio]);
    if (rows.length !== 1) abortar(`${v.folio}: esperaba 1 fila y hay ${rows.length}`);
    const m = rows[0];
    if (m.deleted_at) abortar(`${v.folio}: esta borrado`);
    if (m.estado === 'cancelado') abortar(`${v.folio}: esta cancelado`);
    if (m.tipo !== 'ingreso') abortar(`${v.folio}: esperaba ingreso y es ${m.tipo}`);
    if (Math.abs(Number(m.monto) - Number(v.monto)) > 0.001) abortar(`${v.folio}: el monto es ${m.monto} y se midio ${v.monto}`);
    if (m.origen_tipo !== 'caos' || m.origen_ref !== `${DEVICE}|${v.caosExt}`) {
      abortar(`${v.folio}: esperaba origen caos ${DEVICE}|${v.caosExt} y tiene ${m.origen_tipo} ${m.origen_ref}`);
    }

    // Guarda 2: el depósito de la máquina existe y de él sale la glosa nueva.
    const caos = await knex.raw(
      `SELECT type_label, ref FROM analytics.caos_cash_movements
        WHERE tenant_id = ? AND device = ? AND external_id::text = ?`, [TENANT, DEVICE, v.caosExt]);
    if (caos.rows.length !== 1) abortar(`${DEVICE}|${v.caosExt}: esperaba 1 movimiento de CAOS y hay ${caos.rows.length}`);
    if (caos.rows[0].type_label !== 'Deposito') abortar(`${DEVICE}|${v.caosExt}: no es un Deposito (${caos.rows[0].type_label})`);
    const ref = caos.rows[0].ref ? String(caos.rows[0].ref).trim() : '';
    const glosaNueva = `CAOS ${caos.rows[0].type_label} #${v.caosExt}${ref ? ' · ' + ref : ''}`.slice(0, 200);

    // La glosa debe ser la mala (o ya la nueva): si alguien la corrigió a mano, no se pisa.
    if (m.glosa !== GLOSA_MALA && m.glosa !== glosaNueva) {
      abortar(`${v.folio}: la glosa ya no es la del defecto ("${m.glosa}"): alguien la cambio, revisar a mano`);
    }

    if (v.doc) {
      const docRef = refDe(v.doc);
      if (m.declared_doc_ref !== null && m.declared_doc_ref !== docRef) {
        abortar(`${v.folio}: ya declara otro documento (${m.declared_doc_ref})`);
      }
      // Guarda 3: el cobro existe en route_collections, en UN grupo, con su ruta, del 12-oct.
      const doc = await knex.raw(
        `SELECT fecha::text AS fecha, sum(importe) AS imp, string_agg(DISTINCT truck, ',') AS trucks
           FROM analytics.route_collections
          WHERE tenant_id = ? AND almacen = ? AND cobro_folio = ? AND cuenta = '0011'
          GROUP BY fecha`, [TENANT, v.doc.almacen, v.doc.cobroFolio]);
      if (doc.rows.length !== 1) abortar(`${docRef}: esperaba 1 cobro y hay ${doc.rows.length}`);
      const d = doc.rows[0];
      if (d.fecha !== '2026-10-12') abortar(`${docRef}: esperaba el cobro del 2026-10-12 y es del ${d.fecha}`);
      if (Math.abs(Number(d.imp) - Number(v.doc.importe)) > 0.001) abortar(`${docRef}: el cobro mide ${d.imp} y se midio ${v.doc.importe}`);
      if (d.trucks !== v.doc.ruta) abortar(`${docRef}: esperaba ${v.doc.ruta} y trae ${d.trucks}`);
      // Guarda 4: ningún otro movimiento vivo ya tiene ese cobro (vinculado o declarado).
      const usado = await knex.raw(
        `SELECT folio FROM finance.cash_ledger
          WHERE tenant_id = ? AND deleted_at IS NULL AND estado <> 'cancelado' AND folio <> ?
            AND (origen_ref = ? OR declared_doc_ref = ?)`, [TENANT, v.folio, docRef, docRef]);
      if (usado.rows.length) abortar(`${docRef}: ya lo tiene ${usado.rows[0].folio}`);
    } else {
      // Guarda 5: la ruta 27 sigue SIN cobro de caja el 12-oct. Si apareció, alguien lo revisa.
      const r27 = await knex.raw(
        `SELECT count(*)::int AS n FROM analytics.route_collections
          WHERE tenant_id = ? AND truck = 'ruta_27' AND cuenta = '0011' AND fecha = DATE '2026-10-12'`, [TENANT]);
      if (r27.rows[0].n !== 0) abortar(`${v.folio}: ya aparecio un cobro de caja de la ruta 27 del 12-oct; declararlo en vez de anotar el motivo`);
    }
    plan.push({ ...v, glosaNueva });
  }

  // ── Escrituras: sólo después de que pasaron las guardas de las cuatro filas ──
  for (const v of plan) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET glosa = ?, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND glosa = ?`, [v.glosaNueva, TENANT, v.folio, GLOSA_MALA]);
    if (v.doc) {
      await knex.raw(
        `UPDATE finance.cash_ledger SET declared_doc_ref = ?, updated_at = now()
          WHERE tenant_id = ? AND folio = ? AND declared_doc_ref IS NULL`, [refDe(v.doc), TENANT, v.folio]);
    }
    const nota = `${MARCA}: glosa anterior "${GLOSA_MALA}" heredada de CG-2026-00006 por el defecto que corrigio CG.111; `
      + (v.doc
        ? `deposito de ${v.doc.ruta}, declara el cobro ${refDe(v.doc)} ($${v.doc.importe}).`
        : v.motivo);
    await knex.raw(SQL_NOTA, [nota, nota, TENANT, v.folio]);
  }

  // Comprobación final: ningún ingreso del libro queda con glosa de gasto.
  const { rows: quedan } = await knex.raw(
    `SELECT folio FROM finance.cash_ledger
      WHERE tenant_id = ? AND deleted_at IS NULL AND tipo = 'ingreso' AND glosa LIKE 'X-D-%'`, [TENANT]);
  if (quedan.length) abortar(`quedan ingresos con glosa de gasto: ${quedan.map((q) => q.folio).join(', ')}`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: devuelve la glosa anterior, quita la declaración que
 * puso y recorta su nota. Sólo toca filas que siguen tal como las dejó el `up`.
 *
 * ⛔ Sin un solo signo de interrogación literal en el SQL: knex lo toma como parámetro. La
 *    expresión regular usa {0,1} por eso.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const v of FILAS) {
    await knex.raw(
      `UPDATE finance.cash_ledger SET glosa = ?, updated_at = now()
        WHERE tenant_id = ? AND folio = ? AND glosa LIKE ? AND origen_ref = ?`,
      [GLOSA_MALA, TENANT, v.folio, `CAOS Deposito #${v.caosExt}%`, `${DEVICE}|${v.caosExt}`]);
    if (v.doc) {
      await knex.raw(
        `UPDATE finance.cash_ledger SET declared_doc_ref = NULL, updated_at = now()
          WHERE tenant_id = ? AND folio = ? AND declared_doc_ref = ?`, [TENANT, v.folio, refDe(v.doc)]);
    }
  }
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET sin_documento_motivo = NULLIF(regexp_replace(sin_documento_motivo,
              '( [|] ){0,1}CGA-A[.]41 [(]2026-10-20[)].*$', ''), ''),
            updated_at = now()
      WHERE tenant_id = ? AND folio = ANY(?::text[])
        AND position('CGA-A.41' in COALESCE(sin_documento_motivo, '')) > 0`,
    [TENANT, FILAS.map((f) => f.folio)]);
};
