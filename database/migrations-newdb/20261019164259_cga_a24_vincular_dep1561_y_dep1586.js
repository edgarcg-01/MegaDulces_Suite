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
/**
 * Tolerancia de REDONDEO DE TECLADO, autorizada por Edgar el 2026-10-19:
 * "la diferencia puede ser hasta de un peso".
 *
 * ⚠️ NO es tolerancia para la morralla. La ecuacion maquina + cajon = libro se sigue
 * exigiendo AL CENTAVO. Esto cubre solo el desfase entre lo que el capturista tecleo y
 * lo que dice el documento de Kepler.
 */
const TOLERANCIA_TECLADO = 1.00;
const DEVICE = 'AST700-19758';

/**
 * Cada caso con TODO lo que hay que creerle, para que la guarda pueda desmentirlo.
 * `doc_ref` en `null` = ya está declarado y no se toca.
 */
const CASOS = [ /* 3 casos: dos con deposito, uno sin el y con motivo declarado */
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
  /**
   * ⭐ El tercero NO tiene depósito, y está bien que no lo tenga.
   *
   * `CI-2026-00042` lo capturó Carmen el 15-oct con el motivo escrito donde corresponde:
   * **«NO FUNCINA CAOS»**. El dinero entró entero al cajón y nada a la bóveda, así que la
   * ecuación cierra igual:  máquina $0.00 + cajón $21,507.00 = Kepler $21,507.00.
   *
   * ⚠️ **La máquina SÍ registró movimientos ese día** — 11, de 08:54 a 15:31. O sea que el
   * motivo, literal, no cuadra con lo que CAOS vio. Eso **no invalida la conciliación**: el
   * efectivo está declarado en el cajón y el documento cuadra al centavo. Pero queda dicho,
   * porque un motivo que contradice al testigo es algo que alguien debería mirar.
   *
   * Lo único que le falta es `declared_doc_ref`: sin él, `01-001|U-A-5|0000012|0011` sigue
   * ofreciéndose en la cola y cualquiera lo captura de nuevo.
   */
  {
    folio: 'CI-2026-00042', deposito: null,
    libro: '21507.00', maquina: '0.00', cajon: '21507.00',
    doc_ref: '01-001|U-A-5|0000012|0011',
    nota: 'ruta 21, cobro U-A-5 0000012 del 15-oct. Sin deposito: "NO FUNCINA CAOS", todo al cajon',
  },
  {
    folio: 'CI-2026-00043', deposito: null,
    libro: '17408.00', maquina: '0.00', cajon: '17408.00',
    doc_ref: '01-006|U-A-5|0000012|0011',
    nota: 'ruta 28, cobro U-A-5 0000012 del 15-oct. Sin deposito: "NO FUNCIONA CAOS", todo al cajon',
  },
  /**
   * ⭐ El quinto es el unico que NO cierra al centavo, y por un motivo distinto a los demas.
   *
   * Carmen escribio **$13,896.00** donde el documento dice **$13,895.87**: 13 centavos de
   * redondeo de teclado. No es morralla -en los casos con deposito el libro vale mas porque la
   * maquina no toma monedas-; aca vale mas porque se redondeo hacia arriba.
   *
   * ⛔ Su motivo decia "NO APARECE EN SWITE", y mi primera busqueda le dio la razon... porque
   * busque el importe EXACTO que ella tecleo. El cobro SI existe: ruta_26, cobro 0000012 del
   * 15-oct, $13,895.87, corte Caja 1-107. De los seis cobros de camioneta de ese dia ninguno
   * otro cae a menos de $337, asi que no hay ambiguedad.
   */
  {
    folio: 'CI-2026-00044', deposito: null,
    libro: '13896.00', maquina: '0.00', cajon: '13896.00',
    doc_ref: '01-004|U-A-5|0000012|0011',
    nota: 'ruta 26, cobro U-A-5 0000012 del 15-oct. Sin deposito; $0.13 de redondeo de teclado',
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
    if (l.monto !== c.libro) {
      throw new Error(`[A.24] ${c.folio} vale ${l.monto} y se midió ${c.libro}. Cambió: ABORTA.`);
    }

    if (c.deposito === null) {
      // ── Guarda 2-bis, para el caso SIN depósito: tiene que estar DECLARADO por qué no lo hay,
      // y no puede apuntar a ninguno. Un movimiento sin depósito y sin motivo es un hueco.
      if (l.origen_ref) {
        throw new Error(`[A.24] ${c.folio} se declaró sin depósito pero apunta a "${l.origen_ref}". ABORTA.`);
      }
      const { rows: [sd] } = await knex.raw(
        `SELECT sin_documento_motivo m FROM finance.cash_ledger
          WHERE tenant_id = ?::uuid AND id = ?::uuid`, [TENANT, l.id]);
      if (!sd || !sd.m || !sd.m.trim()) {
        throw new Error(`[A.24] ${c.folio} no tiene depósito NI motivo declarado. ABORTA.`);
      }
      console.log(`[A.24] ${c.folio} sin depósito, motivo declarado: "${sd.m}"`);
    } else {
      if (l.origen_ref !== `${DEVICE}|${c.deposito}`) {
        throw new Error(`[A.24] ${c.folio} apunta a "${l.origen_ref}", no al depósito ${c.deposito}. ABORTA.`);
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
    const desfase = Number((Number(c.libro) - Number(d.monto)).toFixed(2));
    if (Math.abs(desfase) > TOLERANCIA_TECLADO) {
      throw new Error(`[A.24] ${ref} vale ${d.monto} y el libro ${c.libro} (desfase ${desfase}).`
        + ` Pasa de ${TOLERANCIA_TECLADO}: ABORTA.`);
    }
    if (desfase !== 0) {
      console.log(`[A.24] ${c.folio} difiere del documento en ${desfase.toFixed(2)} —`
        + ` redondeo de teclado, dentro de la tolerancia autorizada.`);
    }

    // ── Guarda 5: nadie más tomó ese documento. Dos movimientos sobre el mismo cobro es
    // exactamente el duplicado que esta fase vino a cerrar.
    const { rows: [otro] } = await knex.raw(
      `SELECT folio FROM finance.cash_ledger
        WHERE tenant_id = ?::uuid AND deleted_at IS NULL AND estado <> 'cancelado'
          AND id <> ?::uuid AND (origen_ref = ? OR declared_doc_ref = ?) LIMIT 1`,
      [TENANT, l.id, ref, ref]);
    if (otro) {
      throw new Error(`[A.24] ${ref} ya lo tiene ${otro.folio}. Sería un duplicado: ABORTA.`);
    }

    // ── El enlace formal a la máquina. Aditivo: no mueve un peso del corte.
    // ⛔ Sólo cuando hay depósito: inventar un enlace a $0 afirmaría que la máquina participó.
    if (c.deposito !== null) {
      await knex.raw(
        `INSERT INTO finance.caos_cash_links
           (tenant_id, cash_ledger_id, caos_device, caos_external_id, monto_enlazado, senales)
         VALUES (?::uuid, ?::uuid, ?, ?, ?::numeric,
                 jsonb_build_object('origen','CGA-A.24','por','conciliacion_uno_a_uno',
                                    'cajon', ?::numeric, 'nota', ?::text))
         ON CONFLICT (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL
         DO NOTHING`,
        [TENANT, l.id, DEVICE, c.deposito, c.maquina, c.cajon, c.nota]);
    }

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
