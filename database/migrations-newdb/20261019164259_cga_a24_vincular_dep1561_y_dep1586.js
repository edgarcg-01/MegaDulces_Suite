'use strict';
/**
 * ⭐⭐ `[CGA-A.24]` — **Los dos primeros depósitos conciliados, uno por uno.**
 *
 * ── La regla, dicha por Edgar el 2026-10-19 ────────────────────────────────────────────────
 *
 * *«Todo movimiento debe estar vinculado a lo que entró a caja general + CAOS, y debe conciliar
 * con lo que dice Kepler.»*
 *
 * ⛔ **NO es `CAOS = Kepler`.** Es:
 *
 *     lo que contó la MÁQUINA  +  lo que quedó en el CAJÓN  =  lo que dice KEPLER
 *
 * La máquina sólo acepta billetes —todos sus montos son múltiplos de 20—, así que la morralla
 * llega al cajón. Leer la diferencia como «descuadre» fue mi error: estuve a punto de declarar
 * no-conciliables dos depósitos que cierran al centavo.
 *
 * ── Los dos casos, medidos ─────────────────────────────────────────────────────────────────
 *
 *     #1561 → CI-2026-00002        Kepler  U-A-5 0000075   $21,790.00
 *                                  máquina                 $21,770.00
 *                                  al cajón                $    20.00   ✔
 *
 *     #1586 → CI-2026-00021        Kepler  U-A-5 0000011   $17,692.00   (ruta 27, 3 cortes)
 *                                  máquina                 $17,680.00
 *                                  al cajón                $    12.00   ✔
 *
 * ── Qué le falta a cada uno ────────────────────────────────────────────────────────────────
 *
 * Los dos ya apuntan a su depósito por `origen_ref` desde que Carmen los capturó. Lo que falta:
 *
 *  · **Los dos**: la fila en `finance.caos_cash_links`. Sin ella el reparto cajón/bóveda no los
 *    ve y el arqueo publica como movimiento de caja general dinero que está dentro de la máquina.
 *    ⚠️ Yo mismo los conté entre los «18 sin enlace» por mirar sólo esa tabla: **el vínculo vive
 *    en DOS lugares** y `origen_ref` ya lo tenía.
 *  · **Sólo `CI-2026-00021`**: `declared_doc_ref`. Su glosa dice `VTA 13/10/2026`, que no nombra
 *    documento alguno, así que la cola siguió ofreciendo `U-A-5 0000011` — y el motor de
 *    autollenado lo capturó de nuevo. Ése fue uno de los 13 duplicados.
 *
 * ── Lo que esta migración NO hace, a propósito ─────────────────────────────────────────────
 *
 * ⛔ **No toca `morralla`.** Los $20 y los $12 salen de una resta, pero afirmar que ese dinero
 * son monedas que alguien contó y dejó en el cajón es un hecho FÍSICO. Edgar: *«no debemos
 * inventar información, todo debe ir llenado por `carmen_rodriguez`»*. La resta la deja esta
 * migración lista y visible; el renglón lo llena quien contó el efectivo.
 *
 * ⛔ **No toca el importe ni el estado.** Los dos están `en_corte`: su arqueo ya se firmó.
 * Agregar el enlace es aditivo y no mueve un peso; cambiar el monto sería reabrir un corte.
 *
 * ── Guardas ────────────────────────────────────────────────────────────────────────────────
 *
 * El `up` **aborta entero** si cualquiera de estas deja de ser cierta: que el movimiento exista
 * y siga apuntando a su depósito, que el depósito exista en CAOS con el total medido, que el
 * documento de Kepler exista con su importe, y que la ecuación cierre al centavo.
 *
 * Idempotente: `ON CONFLICT` sobre `ux_caos_link_vivo` y `declared_doc_ref` sólo si está NULL.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const DEVICE = 'AST700-19758';

/**
 * Cada caso con TODO lo que hay que creerle, para que la guarda pueda desmentirlo.
 * `doc_ref` en `null` = ya está declarado y no se toca.
 */
const CASOS = [
  {
    folio: 'CI-2026-00002', deposito: 1561,
    libro: '21790.00', maquina: '21770.00', cajon: '20.00',
    doc_ref: null, // ya tiene declared_doc_ref = 01|U-A-5|0000075|0011
    nota: 'vecinal, cobro U-A-5 0000075 del 07-oct',
  },
  {
    folio: 'CI-2026-00021', deposito: 1586,
    libro: '17692.00', maquina: '17680.00', cajon: '12.00',
    doc_ref: '01-005|U-A-5|0000011|0011',
    nota: 'ruta 27, cobro U-A-5 0000011 del 13-oct (3 cortes de POS)',
  },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const c of CASOS) {
    // ── Guarda 1: el movimiento existe, vive, y sigue apuntando a ESE depósito.
    const { rows: [l] } = await knex.raw(
      `SELECT id, monto::text, origen_ref, declared_doc_ref, estado
         FROM finance.cash_ledger
        WHERE tenant_id = ?::uuid AND folio = ? AND deleted_at IS NULL`, [TENANT, c.folio]);
    if (!l) throw new Error(`[A.24] ${c.folio} no existe o está borrado. ABORTA.`);
    if (l.estado === 'cancelado') throw new Error(`[A.24] ${c.folio} está cancelado. ABORTA.`);
    if (l.origen_ref !== `${DEVICE}|${c.deposito}`) {
      throw new Error(`[A.24] ${c.folio} apunta a "${l.origen_ref}", no al depósito ${c.deposito}. ABORTA.`);
    }
    if (l.monto !== c.libro) {
      throw new Error(`[A.24] ${c.folio} vale ${l.monto} y se midió ${c.libro}. Cambió: ABORTA.`);
    }

    // ── Guarda 2: el depósito existe en CAOS, es un Deposito, y contó lo medido.
    const { rows: [m] } = await knex.raw(
      `SELECT total::text, type_id FROM analytics.caos_cash_movements
        WHERE tenant_id = ?::uuid AND device = ? AND external_id = ?`,
      [TENANT, DEVICE, c.deposito]);
    if (!m) throw new Error(`[A.24] el depósito ${c.deposito} no está en CAOS. ABORTA.`);
    if (Number(m.type_id) !== 0) throw new Error(`[A.24] ${c.deposito} no es un Deposito. ABORTA.`);
    if (m.total !== c.maquina) {
      throw new Error(`[A.24] la máquina dice ${m.total} para ${c.deposito}, se midió ${c.maquina}. ABORTA.`);
    }

    // ── Guarda 3: LA ECUACIÓN. máquina + cajón = Kepler. Si no cierra, no se vincula.
    const suma = (Number(c.maquina) + Number(c.cajon)).toFixed(2);
    if (suma !== c.libro) {
      throw new Error(`[A.24] ${c.folio}: ${c.maquina} + ${c.cajon} = ${suma} ≠ ${c.libro}. ABORTA.`);
    }

    // ── Guarda 4: el documento de Kepler existe y vale lo mismo que el libro.
    const ref = c.doc_ref ?? l.declared_doc_ref;
    if (!ref) throw new Error(`[A.24] ${c.folio} no tiene documento declarado ni se le pasa uno. ABORTA.`);
    const [suc, dt, fol, bco] = ref.split('|');
    const { rows: [d] } = await knex.raw(
      `SELECT monto::text FROM (
         SELECT monto, origen_ref FROM finance.v_caja_movimientos_pendientes
         UNION ALL
         SELECT v.importe, v.sucursal||'|'||v.doc_tipo||'|'||v.folio||'|'||v.clave_banco
           FROM analytics.mv_caja_movimientos v WHERE v.tenant_id = ?::uuid) z
        WHERE z.origen_ref = ? LIMIT 1`, [TENANT, ref]);
    if (!d) throw new Error(`[A.24] el documento ${ref} no existe en Kepler. ABORTA.`);
    if (d.monto !== c.libro) {
      throw new Error(`[A.24] ${ref} vale ${d.monto} y el libro ${c.libro}. No concilia: ABORTA.`);
    }

    // ── El enlace formal a la máquina. Aditivo: no mueve un peso del corte.
    await knex.raw(
      `INSERT INTO finance.caos_cash_links
         (tenant_id, cash_ledger_id, caos_device, caos_external_id, monto_enlazado, senales)
       VALUES (?::uuid, ?::uuid, ?, ?, ?::numeric,
               jsonb_build_object('origen','CGA-A.24','por','conciliacion_uno_a_uno',
                                  'cajon', ?::numeric, 'nota', ?))
       ON CONFLICT (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL
       DO NOTHING`,
      [TENANT, l.id, DEVICE, c.deposito, c.maquina, c.cajon, c.nota]);

    // ── El documento, sólo si falta. Nunca se pisa uno ya declarado.
    if (c.doc_ref) {
      await knex.raw(
        `UPDATE finance.cash_ledger SET declared_doc_ref = ?, updated_at = now()
          WHERE tenant_id = ?::uuid AND id = ?::uuid AND declared_doc_ref IS NULL`,
        [c.doc_ref, TENANT, l.id]);
    }

    console.log(`[A.24] ${c.folio} ↔ depósito ${c.deposito}: máquina ${c.maquina}`
      + ` + cajón ${c.cajon} = ${c.libro} ✔  (${c.nota})`);
    console.log(`       ⚠️ morralla sigue en $0.00 — los $${c.cajon} los declara quien contó el efectivo.`);
  }
};

/** Quita SÓLO lo que puso esta migración. El `declared_doc_ref` del 00021 también. */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE finance.cash_ledger SET declared_doc_ref = NULL, updated_at = now()
      WHERE tenant_id = ?::uuid AND folio = 'CI-2026-00021'
        AND declared_doc_ref = '01-005|U-A-5|0000011|0011'`, [TENANT]);
  await knex.raw(
    `DELETE FROM finance.caos_cash_links
      WHERE tenant_id = ?::uuid AND senales ->> 'origen' = 'CGA-A.24'`, [TENANT]);
};
