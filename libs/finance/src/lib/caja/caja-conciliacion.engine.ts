/**
 * ⭐⭐ `[CG.124]` — **Un movimiento de caja no se guarda sin estar conciliado.**
 *
 * Regla de Edgar, dicha tres veces: *"todos los movimientos deben estar vinculados a una cuenta
 * concepto, nada debe llenar el usuario, sólo llenar el arqueo"* · *"el usuario sólo va a llenar
 * el arqueo, y a lo mucho enlazarlo con un movimiento de CAOS"* · *"aún salen capturas a mano y te
 * mencioné que todas deben estar conciliadas con un movimiento"*.
 *
 * ── Lo medido en prod, 2026-10-13 ───────────────────────────────────────────────────────────
 *
 * De 59 movimientos vivos, **6 están sin `origen_ref`**. Y NO son el mismo caso: se parten en dos,
 * y confundirlos es lo que hace que el problema parezca irresoluble.
 *
 * **(a) DOS que SÍ eligieron documento y perdieron el enlace** — y eso es un defecto, no una
 * decisión de quien captura:
 *
 *     CG-2026-00006  $6,303.00   glosa "X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ"
 *                                el documento real: sucursal 03, $6,302.78
 *     CG-2026-00028 $10,490.00   glosa "X-D-26 0023047 · GASTOS GENERALES OFICINAS"
 *                                el documento real: sucursal 00, $1,250.00
 *
 * ⭐ Esa glosa **la arma el sistema**, no la persona: sale de
 * `` `${c.doc_tipo} ${c.folio} · ${c.beneficiario}` `` cuando se elige el documento de la bandeja.
 * Si está y `origen_ref` no, el enlace se cayó en el camino — la misma familia de `[CG.111]`, donde
 * el campo de CAOS borraba el documento del ERP en silencio.
 *
 * ⛔ **Y el daño es doble**: el movimiento queda sin conciliar **y el documento sigue
 * ofreciéndose en la bandeja** (verificado: los dos siguen ahí), así que se puede capturar otra
 * vez. Un movimiento huérfano se ve; un documento capturado dos veces, no.
 *
 * **(b) CUATRO que no tenían a qué enlazarse.** Los ingresos `VENTA 08/10` son las rutas 501/502/503
 * de Canindo, y **no existe cobro `U-A-5` en Kepler** por esos importes (buscado del 05 al 14-oct,
 * en caja y en banco) ni depósito de CAOS que cuadre. No hay defecto que arreglar acá: falta el
 * documento del otro lado (§28 de `VERDAD_ABSOLUTA.md`).
 *
 * ── Por qué (a) se BLOQUEA y (b) se DECLARA ─────────────────────────────────────────────────
 *
 * Bloquear los dos dejaría a la cajera sin poder registrar efectivo que de verdad entró — y el
 * dinero no deja de existir porque el sistema lo rechace. Dejar pasar los dos es lo que tenemos
 * hoy. La línea va donde está la diferencia real: **si el documento EXISTE y se eligió, no
 * guardar sin él; si no existe, exigir que se diga por qué.**
 *
 * ⚠️ Esta función **no mira la base**: recibe lo que llegó y decide. Así se puede probar de
 * verdad — un doble de Knex no ejecuta SQL y una prueba contra él no prueba nada.
 */

/**
 * La firma de una glosa armada al elegir un documento: `X-D-26 0023047 · BENEFICIARIO`.
 *
 * ⚠️ El `·` es parte de la firma, no decoración: separa el documento del beneficiario y es lo que
 * distingue una glosa ARMADA de una escrita a mano que casualmente mencione un folio. Sin él,
 * `"pago de X-D-26 0023047"` —prosa legítima— se leería como enlace perdido y bloquearía a quien
 * sólo estaba describiendo.
 *
 * ⚠️ Y el ancla `^` también: la glosa armada EMPIEZA con el documento.
 */
const RX_GLOSA_DOC = /^\s*([A-Z]{1,2}-[A-Z]-\d{1,3})\s+(\S+)\s+·/;

export interface EntradaConciliacion {
  /** El enlace al documento de Kepler o al movimiento de CAOS. Vacío = sin conciliar. */
  readonly origen_ref?: string | null;
  readonly origen_tipo?: string | null;
  readonly glosa?: string | null;
  /** Por qué este movimiento NO puede enlazarse. Obligatorio cuando no hay documento. */
  readonly sin_documento_motivo?: string | null;
}

export type VeredictoConciliacion =
  | { readonly ok: true; readonly via: 'enlazado' | 'motivo_declarado' }
  | { readonly ok: false; readonly motivo: 'enlace_perdido' | 'sin_declarar'; readonly texto: string };

/** Lo que la glosa declara, o `null` si no fue armada al elegir un documento. */
export function documentoEnLaGlosa(glosa: string | null | undefined): { doc: string; folio: string } | null {
  const m = RX_GLOSA_DOC.exec(String(glosa ?? ''));
  return m ? { doc: m[1], folio: m[2] } : null;
}

/** Largo mínimo del motivo. Menos que esto no es una razón, es un trámite. */
export const MOTIVO_MIN = 12;

export function conciliacion(e: EntradaConciliacion): VeredictoConciliacion {
  const ref = String(e.origen_ref ?? '').trim();
  if (ref) return { ok: true, via: 'enlazado' };

  const doc = documentoEnLaGlosa(e.glosa);
  if (doc) {
    return {
      ok: false,
      motivo: 'enlace_perdido',
      texto:
        `Este movimiento dice venir del documento ${doc.doc} ${doc.folio}, pero llegó sin el enlace. `
        + 'No se guarda así: el documento seguiría en la bandeja y alguien lo capturaría de nuevo. '
        + 'Elige el documento otra vez desde la lista.',
    };
  }

  const motivo = String(e.sin_documento_motivo ?? '').trim();
  if (motivo.length >= MOTIVO_MIN) return { ok: true, via: 'motivo_declarado' };

  return {
    ok: false,
    motivo: 'sin_declarar',
    texto:
      'Todo movimiento de caja se concilia contra un documento de Kepler o un movimiento del cajero. '
      + 'Si éste no tiene ninguno —por ejemplo, cobranza de una ruta que nadie registró en Kepler— '
      + `hay que decir por qué, en al menos ${MOTIVO_MIN} caracteres. Un movimiento sin origen y sin `
      + 'motivo no se puede auditar después.',
  };
}
