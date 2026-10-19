'use strict';
/**
 * ⭐⭐ `[CGA-A.10c]` — **Una captura sin declarar estaba tapando SIETE cobros de siete
 * sucursales.** Se le pone su llave y los otros seis se destapan solos.
 *
 * ── El caso, medido en prod el 2026-10-16 después de desplegar `[CGA-A.10]` ────────────────
 *
 * `CI-2026-00009` es una captura desde CAOS, del 2026-10-13, por **$22,676.00**, cuya glosa
 * dice `U-A-5 0000007 · CONTADO` y cuyo `declared_doc_ref` quedó en **NULL** porque el relleno
 * de `[CGA-A.10]` se negó —bien— a adivinar: ese `doc_tipo + folio` casa con **siete**
 * documentos distintos, uno por sucursal, porque **el folio de camioneta es consecutivo por
 * unidad**. Mientras siga sin llave, el descuento cae a la rama vieja del `LIKE` y **los siete
 * desaparecen de la bandeja**:
 *
 *     00       U-A-5 0000007  2026-01-05  $23,714.00
 *     01-001   U-A-5 0000007  2026-10-09  $22,676.00   ruta_21
 *     01-003   U-A-5 0000007  2026-10-09  $20,782.00   ruta_23
 *     01-005   U-A-5 0000007  2026-10-09  $20,007.00   ruta_27
 *     01-002   U-A-5 0000007  2026-10-09  $18,475.76   ruta_22
 *     01-004   U-A-5 0000007  2026-10-09  $17,285.65   ruta_26
 *     01-006   U-A-5 0000007  2026-10-09  $13,444.00   ruta_28
 *
 * ⛔ **Y dos de ésos llegaron ESE MISMO DÍA**, con el carril de cobros recién destrabado: el de
 * `ruta_23` y el de `ruta_28`. O sea que **nacieron invisibles**. El hueco de §86 no es deuda
 * quieta: **crece sola** cada vez que una camioneta trae un folio que choca.
 *
 * ── Por qué `01-001` y no otra: DOS testigos independientes ────────────────────────────────
 *
 *  1. **El depósito de CAOS lo dice.** `AST700-19758 #1582`, 2026-10-13 10:57, trae
 *     `ref = 'rd21 09>/10'` — **ruta 21, 09/10**. `ruta_21` es el almacén `01-001`, y la fecha
 *     del documento es el 2026-10-09.
 *  2. **El importe cuadra.** `analytics.route_collections` suma para `01-001|U-A-5|0000007`
 *     exactamente **$22,676.00** (2 renglones), que es el monto de la captura. En la bóveda
 *     entraron $22,670.00 — $6.00 menos, el mismo patrón que el resto de los enlaces del día.
 *
 * ⭐ **Control del cruce por importe** (la regla de la casa: un match por monto exige placebo):
 * el candidato más cercano después de `01-001` es `00` con $23,714.00, **$1,038 arriba**. O sea
 * que el importe por sí solo ya elegía `01-001`, y la referencia lo confirma por otro camino.
 *
 * ── Efecto medido por simulación ANTES de escribir esto ────────────────────────────────────
 *
 *     escondidos de verdad   ANTES  9 · $155,363.19
 *                            DESPUÉS 2 · $ 18,978.78     → libera 7 · $136,384.41
 *
 * `01-001` no se «libera»: pasa a estar tapado **por llave**, que es lo correcto — esa captura
 * ES su pago.
 *
 * ── ⛔ LO QUE NO TOCA, Y POR QUÉ ────────────────────────────────────────────────────────────
 *
 * Quedan **cuatro** capturas ambiguas más (`CI-2026-00003/5/6/7`), todas con glosa
 * `X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ`. Sus referencias de CAOS **también nombran
 * rutas** («ruta 27 120726», «rd 28 12 10 26», «r23 12 10 26», «rd 26 12 10 26») — **pero ahí
 * la referencia significa otra cosa**: de dónde VINO el efectivo, no qué documento paga. El
 * documento declarado es un pago a proveedor.
 *
 * ⚠️ Y los números no cierran: las cuatro suman **$57,865.00** contra un `X-D-26 0000161` que,
 * en los dos únicos candidatos vivos, vale **$12,676.00 (suc. 00, otro beneficiario)** y
 * **$6,302.78 (suc. 03)**. Eso no es una ambigüedad de sucursal: es una glosa usada como cajón
 * de sastre. **No lo resuelve una migración.** Lo mira Finanzas.
 *
 * Idempotente: sólo escribe si sigue en NULL, y aborta si algo no coincide con lo medido.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'CI-2026-00009';
const DESTINO = '01-001|U-A-5|0000007|0011';
const MONTO = '22676.00';
const CAOS_REF = 'AST700-19758|1582';
const SENAL = 'rd21';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows } = await knex.raw(
    `SELECT id, monto::text AS monto, declared_doc_ref, origen_ref, glosa
       FROM finance.cash_ledger
      WHERE tenant_id = ? AND folio = ? AND origen_tipo = 'caos' AND deleted_at IS NULL`,
    [TENANT, FOLIO]);

  if (rows.length !== 1) {
    console.log(`[CGA-A.10c] ${FOLIO}: ${rows.length} filas. No se toca nada.`);
    return;
  }
  const f = rows[0];

  if (f.declared_doc_ref) {
    if (f.declared_doc_ref === DESTINO) {
      console.log(`[CGA-A.10c] ${FOLIO} ya declara ${DESTINO}. Nada que hacer.`);
      return;
    }
    throw new Error(
      `[CGA-A.10c] ${FOLIO} ya declara "${f.declared_doc_ref}" y yo iba a poner "${DESTINO}". ` +
      `Alguien lo decidió antes. ABORTA — no piso una decisión humana.`);
  }

  // ── Testigo 1: el importe de la captura, contra lo medido ────────────────────────────────
  if (Number(f.monto) !== Number(MONTO)) {
    throw new Error(`[CGA-A.10c] ${FOLIO} vale ${f.monto} y yo medí ${MONTO}. ABORTA.`);
  }
  if (f.origen_ref !== CAOS_REF) {
    throw new Error(`[CGA-A.10c] ${FOLIO} apunta a "${f.origen_ref}" y yo medí "${CAOS_REF}". ABORTA.`);
  }

  // ── Testigo 2: la referencia del depósito en CAOS nombra la unidad ───────────────────────
  const { rows: caos } = await knex.raw(
    `SELECT ref FROM analytics.caos_cash_movements
      WHERE tenant_id = ? AND device || '|' || external_id = ?`,
    [TENANT, CAOS_REF]);
  if (!caos.length || !String(caos[0].ref || '').toLowerCase().replace(/\s+/g, '').includes(SENAL)) {
    throw new Error(
      `[CGA-A.10c] el depósito ${CAOS_REF} no dice "${SENAL}" (dice "${caos[0] && caos[0].ref}"). ` +
      `Ese era el testigo que elegía la sucursal. ABORTA.`);
  }

  // ── Testigo 3: el documento destino existe y suma lo mismo ───────────────────────────────
  const { rows: doc } = await knex.raw(
    `SELECT sum(importe)::text AS suma FROM analytics.route_collections
      WHERE tenant_id = ? AND cuenta = '0011'
        AND (almacen || '|U-A-5|' || cobro_folio || '|0011') = ?`,
    [TENANT, DESTINO]);
  if (!doc[0] || Number(doc[0].suma) !== Number(MONTO)) {
    throw new Error(
      `[CGA-A.10c] ${DESTINO} suma ${doc[0] && doc[0].suma} y la captura vale ${MONTO}. ABORTA.`);
  }

  const r = await knex.raw(
    `UPDATE finance.cash_ledger SET declared_doc_ref = ?, updated_at = now()
      WHERE id = ? AND declared_doc_ref IS NULL`,
    [DESTINO, f.id]);

  console.log(`[CGA-A.10c] ${FOLIO} → declared_doc_ref = ${DESTINO} (${r.rowCount} fila).`);
  console.log(`[CGA-A.10c] con eso se destapan 6 cobros de otras sucursales · $113,708.41.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE finance.cash_ledger SET declared_doc_ref = NULL, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND declared_doc_ref = ?`,
    [TENANT, FOLIO, DESTINO]);
};
