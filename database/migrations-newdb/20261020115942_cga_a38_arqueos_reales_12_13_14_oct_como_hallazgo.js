'use strict';
/**
 * ⭐⭐ `[CGA-A.38]` — **Los arqueos REALES del 12, 13 y 14 de octubre, registrados como hallazgo.**
 *
 * ── Lo que se descubrió, y con qué ──────────────────────────────────────────────────────────
 *
 * Edgar aportó **tres fotos** de la pantalla «Cerrar corte» de esos días. Cruzadas contra lo que
 * quedó sellado y contra los arqueos de Control, dicen que **los conteos están corridos de día**:
 *
 *     dia      foto (lo contado)   Control (cierre)       sellado en la Suite
 *     12-oct      $3,340.00            —                     $3,653.50   ⛔
 *     13-oct      $3,653.50            —                    $57,571.00   ⛔
 *     14-oct     $14,128.50      A23648  $14,128.50  ✔      $24,960.00   ⛔
 *     16-oct          —          A23665  $32,198.50         $32,198.50   ✔
 *     17-oct          —          A23672     $618.50            $618.50   ✔
 *
 * ⭐⭐ **El 14-oct tiene DOS testigos independientes que coinciden al centavo** —la foto y el
 * arqueo de cierre de Control— y la Suite tiene otra cifra. Eso deja de ser interpretación.
 *
 * ⭐ Y el desglose lo confirma, no sólo el total:
 *
 *     foto del 14     500x1 · 200x2  · 100x86 · 50x1  · 20x3  · 10x220 · 5x332 · 2x127 · 1x391 · 0.5x27
 *     sellado del 14  500x1 · 200x77 · 100x68 · 50x28 · 20x43        — ni una sola moneda —
 *
 * El cajón del 14 tenía **1,097 monedas** y lo sellado no tiene ninguna. Son dos conteos de cosas
 * distintas, no el mismo con un error de tecleo.
 *
 * ── Por qué pasó, fechado contra la base ────────────────────────────────────────────────────
 *
 *     06-oct 14:21  `20261006123000` pone `denom_key` NOT NULL actualizando UNO de los dos
 *                   caminos de inserción — el defecto de `[CG.155]`
 *     12-oct 18:00  se abre el corte del 12 y se cuenta. ⛔ Al guardar: ERROR.
 *     15-oct 11:26  se aplica `20261014212702`, el arreglo
 *     15-oct 18:02  recién ahí se cierra el del 12 — y el del 13 VEINTIDÓS SEGUNDOS después
 *     16-oct 19:04  y los del 14, 15 y 16, los tres en 63 segundos
 *
 * Los cortes se llenaron en ráfaga cuando el defecto se arregló, **en orden de folio**, con
 * conteos que no correspondían a esos días. El del 12 se perdió; el del 13 quedó en el corte del
 * 12; y así.
 *
 * ── ⛔⛔ POR QUÉ ESTO NO CORRIGE LOS CORTES ─────────────────────────────────────────────────
 *
 * Porque **la base no lo permite, y hace bien**. El trigger `cash_cut_guardia`, rama 4:
 *
 *     -- 4. Un corte que dejó de ser borrador es una foto.
 *     IF OLD.estado <> 'borrador' THEN ... RAISE 'sus cifras ya no cambian'
 *
 * y la lista de campos congelados incluye `contado`, `esperado`, `diferencia`, `conteo_previo` y
 * `reconteo_motivo`. **No hay `set_config` de escape** — el que existe para el reconteo abre la
 * puerta sólo en estado `borrador`. Es el mismo mensaje rojo que se ve en la foto del 14:
 * *«Este corte ya tiene conteo sellado. Para cambiarlo hay que recontar, y el reconteo pide
 * motivo.»*
 *
 * ⚠️ Una migración anterior (`[CGA-A.37]`, retirada en `e2194728a`) intentó escribir
 * `conteo_previo` en un corte cerrado y **la base la rechazó**. El candado funcionó, y ésta no lo
 * vuelve a intentar: *reescribir siete cifras firmadas de dinero es una decisión de Edgar, no de
 * una migración.*
 *
 * ── Dónde se registran, entonces ────────────────────────────────────────────────────────────
 *
 * En **`finance.findings`**, que es el mecanismo que este repo ya tiene para esto: 158,549 filas,
 * `clase='error_captura'` con 4,003 usos, `evidencia` JSONB, y pantalla propia en
 * `/finanzas/hallazgos`. ⭐ **No se inventa un primitivo** (ADR-056): el hallazgo va donde van
 * todos los hallazgos, y queda a la vista de quien revisa caja.
 *
 * Cada uno lleva en `evidencia` las TRES versiones —la foto con su desglose, el arqueo de Control
 * si existe, y lo que quedó sellado— para que nadie tenga que reconstruir esto de nuevo.
 *
 * ── Guardas ─────────────────────────────────────────────────────────────────────────────────
 *
 * El `up` **aborta entero** si un corte no existe, si su `contado` dejó de ser el que se midió
 * (entonces alguien ya lo tocó y este hallazgo describiría otra cosa), o si el desglose de una
 * foto no suma su propio total al centavo.
 *
 * Idempotente por `dedup_key` (`UNIQUE (tenant_id, dedup_key)`): `ON CONFLICT DO NOTHING`.
 *
 * ⚠️ **Sólo hace INSERT: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA al equipo.
 *    Va aplicada ANTES de mergear.**
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const REGLA = 'caja_conteo_corrido';

/**
 * Las tres fotos. `sellado` es lo que el corte tiene hoy y la guarda lo verifica: si cambió, el
 * hallazgo describiría una realidad que ya no existe.
 */
const DIAS = [
  {
    fecha: '2026-10-12', corte: 'CC-2026-00001', sellado: 3653.50, foto: 3340.00,
    desglose: [['500', 500, 1], ['100', 100, 5], ['10', 10, 160], ['5', 5, 114], ['2', 2, 57], ['1', 1, 56]],
    control: null,
    nota: 'El conteo de este dia se PERDIO: es el que dio error al guardar. Lo que quedo sellado ($3,653.50) es el conteo del 13-oct.',
  },
  {
    fecha: '2026-10-13', corte: 'CC-2026-00002', sellado: 57571.00, foto: 3653.50,
    desglose: [['20', 20, 2], ['10', 10, 192], ['5', 5, 247], ['2', 2, 111], ['1', 1, 224], ['0.5', 0.5, 25]],
    control: null,
    nota: 'Este conteo quedo sellado en el corte del 12-oct (CC-2026-00001), no en el del 13.',
  },
  {
    fecha: '2026-10-14', corte: 'CC-2026-00003', sellado: 24960.00, foto: 14128.50,
    desglose: [['500', 500, 1], ['200', 200, 2], ['100', 100, 86], ['50', 50, 1], ['20', 20, 3],
      ['10', 10, 220], ['5', 5, 332], ['2', 2, 127], ['1', 1, 391], ['0.5', 0.5, 27]],
    control: { folio: 'A23648', efectivo: 14128.50 },
    nota: 'DOS testigos independientes coinciden al centavo: la foto y el arqueo de cierre A23648 de Control. Lo sellado ($24,960.00) no tiene UNA SOLA moneda, y el cajon tenia 1,097.',
  },
];

const money = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const abortar = (m) => {
    throw new Error(`[CGA-A.38] ${m} -- migracion abortada, no se inserto ninguna fila.`);
  };

  for (const d of DIAS) {
    // Guarda 1: el desglose de la foto suma lo que la foto dice.
    const suma = d.desglose.reduce((a, [, v, p]) => a + v * p, 0);
    if (Math.abs(suma - d.foto) > 0.001) {
      abortar(`${d.fecha}: el desglose de la foto suma ${suma.toFixed(2)} y la foto dice ${d.foto}`);
    }
    // Guarda 2: el corte existe y sigue con el contado que se midio.
    const { rows } = await knex.raw(
      `SELECT contado, estado FROM finance.cash_ledger_cuts WHERE tenant_id = ? AND folio = ?`,
      [TENANT, d.corte]);
    if (rows.length !== 1) abortar(`${d.corte}: esperaba 1 fila y hay ${rows.length}`);
    if (Math.abs(Number(rows[0].contado) - d.sellado) > 0.001) {
      abortar(`${d.corte}: su contado es ${rows[0].contado} y se midio ${d.sellado} -- alguien ya lo toco`);
    }
  }

  for (const d of DIAS) {
    const dif = Number((d.foto - d.sellado).toFixed(2));
    const evidencia = {
      conteo_real: {
        total: d.foto,
        origen: `foto de la pantalla "Cerrar corte" del ${d.fecha}, aportada por Edgar el 2026-10-20`,
        denominaciones: d.desglose.map(([denom_key, denominacion, piezas]) => ({ denom_key, denominacion, piezas })),
      },
      sellado_en_la_suite: { corte: d.corte, contado: d.sellado },
      arqueo_de_control: d.control,
      diferencia: dif,
      por_que: 'El corte se cerro dias tarde por el defecto de [CG.155] (denom_key NOT NULL, migracion 20261006123000). Los cortes del 12 al 16 se llenaron en rafaga el 15 y 16-oct, en orden de folio, con conteos de otros dias.',
      no_se_corrige_porque: 'El trigger cash_cut_guardia rama 4 congela todas las cifras de un corte cerrado, sin escape. Reescribir siete cifras firmadas de dinero es decision de Edgar, no de una migracion.',
      nota: d.nota,
    };
    await knex.raw(
      `INSERT INTO finance.findings
         (tenant_id, rule_key, clase, severity, status, titulo, resumen, entity, periodo, importe,
          evidencia, dedup_key)
       VALUES (?, ?, 'error_captura', 'critical', 'nuevo', ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING`,
      [
        TENANT, REGLA,
        `${d.corte} (${d.fecha}): el conteo sellado no es el de ese dia`,
        `Se conto ${money(d.foto)} y el corte quedo sellado con ${money(d.sellado)}: ${money(Math.abs(dif))} de diferencia. ${d.nota}`,
        JSON.stringify({ corte: d.corte, fecha: d.fecha, sucursal: '00', caja: 'CAJA GENERAL' }),
        d.fecha,
        dif,
        JSON.stringify(evidencia),
        `${REGLA}:00:${d.fecha}`,
      ]);
  }

  // Comprobacion: los tres quedaron, y ningun corte se movio.
  const { rows: n } = await knex.raw(
    `SELECT count(*)::int AS n FROM finance.findings WHERE tenant_id = ? AND rule_key = ?`,
    [TENANT, REGLA]);
  if (Number(n[0].n) !== DIAS.length) {
    abortar(`esperaba ${DIAS.length} hallazgos y hay ${n[0].n}`);
  }
  for (const d of DIAS) {
    const { rows } = await knex.raw(
      `SELECT contado FROM finance.cash_ledger_cuts WHERE tenant_id = ? AND folio = ?`, [TENANT, d.corte]);
    if (Math.abs(Number(rows[0].contado) - d.sellado) > 0.001) {
      abortar(`${d.corte}: se movio una cifra sellada, y eso era justo lo que no debia pasar`);
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: borra los tres hallazgos, nada mas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `DELETE FROM finance.findings WHERE tenant_id = ? AND rule_key = ?`, [TENANT, REGLA]);
};
