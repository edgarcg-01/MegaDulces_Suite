/**
 * `[GP.A.2]` C1 — **Autorizar (o regresar) un pedido TELEMARK en Kepler, igual que lo hace Kepler.** La REGLA y la
 * SENTENCIA son puras y se prueban solas; el adaptador (`kepler-autorizacion-pedido.adapter.ts`) las ejecuta.
 *
 * ── Lo medido (GP.A.0a, anexo EA) ─────────────────────────────────────────────────────────────────────────────────
 *  · Autorizar en Kepler (Finanzas › Crédito y cobranza › Operación CFDI › Autorización de Pedidos) cambia **sólo
 *    `kdm1.c11`**, de `CREADO` a `AUTORIZADO`: 8 de 8 casos en la foto antes/después del 2026-11-19, sin renglones,
 *    sin apartar existencia (control positivo en `kdik`) y sin crear cartera.
 *  · ADR-117, enmienda del 2026-11-20 (D-A1, firmada por Edgar): la Suite escribe CREADO → AUTORIZADO, y Crédito y
 *    cobranza puede REGRESAR un autorizado (AUTORIZADO → CREADO, D-A7) mientras no se haya surtido.
 *  · Permiso: `UPDATE (c11)` en `md.kdm1` para `kepler_push` (`ops/prod/kepler-grants/gpa0d_kdm1_update_c11.sql`).
 *
 * ── Lo que se niega a hacer (fail-closed) ─────────────────────────────────────────────────────────────────────────
 *  · Un pedido que no es TELEMARK (`c27`), uno cancelado (`c43 = 'C'`), o uno que no se encuentra exactamente una vez.
 *  · Autorizar uno que ya avanzó más allá de AUTORIZADO, o regresar uno que ya se surtió: no se vio cómo lo hace Kepler.
 *  · El `UPDATE` repite en el `WHERE` el estatus leído: si alguien lo movió en Kepler entre la lectura y la escritura,
 *    toca 0 filas y todo se deshace en vez de pisar su cambio.
 */

export type AccionAutorizacion = 'autorizar' | 'regresar';

/** Lo que se lee del Kepler vivo, con candado (`FOR UPDATE`), antes de decidir. */
export interface PedidoLeidoKepler {
  /** `c11`: CREADO, AUTORIZADO, SURTIDO, CHECADO, EMBARCADO. */
  estado: string;
  /** `c27`: TELEMARK o SUCURSAL. */
  canal: string;
  /** `c43`: N, A, F, C (C = cancelado). */
  doc_estado: string;
}

export const CREADO = 'CREADO';
export const AUTORIZADO = 'AUTORIZADO';

/** De dónde sale y a dónde va el estatus, según la acción. */
export const TRANSICION: Record<AccionAutorizacion, { de: string; a: string }> = {
  autorizar: { de: CREADO, a: AUTORIZADO },
  regresar: { de: AUTORIZADO, a: CREADO },
};

export type DecisionEscritura =
  | { ok: true; de: string; a: string }
  | { ok: false; motivo: string; yaEstaba?: boolean };

/** La regla: ¿se puede escribir esta acción sobre lo que se leyó? */
export function decidirEscrituraAutorizacion(leidos: PedidoLeidoKepler[], accion: AccionAutorizacion): DecisionEscritura {
  if (leidos.length === 0) return { ok: false, motivo: 'El pedido no está en Kepler' };
  if (leidos.length > 1) return { ok: false, motivo: `Hay ${leidos.length} pedidos con esa llave en Kepler: no se toca ninguno` };
  const p = leidos[0];
  const estado = p.estado.trim().toUpperCase();
  if (p.canal.trim().toUpperCase() !== 'TELEMARK') return { ok: false, motivo: 'No es un pedido de telemarketing' };
  if (p.doc_estado.trim().toUpperCase() === 'C') return { ok: false, motivo: 'El pedido está cancelado en Kepler' };
  const t = TRANSICION[accion];
  if (estado === t.a) return { ok: false, motivo: `Ya estaba ${t.a.toLowerCase()} en Kepler`, yaEstaba: true };
  if (estado !== t.de) {
    return {
      ok: false,
      motivo: accion === 'autorizar'
        ? `Ya va en ${estado.toLowerCase()} en Kepler: no se toca`
        : `Ya va en ${estado.toLowerCase()} en Kepler: un pedido surtido no se regresa`,
    };
  }
  return { ok: true, de: t.de, a: t.a };
}

/** La llave del pedido `U-D-40` en `md.kdm1`: sucursal ($1), serie ($2), folio ($3). */
export const LLAVE_PEDIDO = `c1 = $1 AND c2 = 'U' AND c3 = 'D' AND c4 = 40 AND c5 = $2 AND btrim(c6) = $3`;

/** La lectura con candado. Se lee el estatus, el canal y el estado del documento para decidir. */
export const LECTURA_PEDIDO =
  `SELECT btrim(c11) AS estado, btrim(coalesce(c27, '')) AS canal, btrim(coalesce(c43, '')) AS doc_estado
     FROM md.kdm1 WHERE ${LLAVE_PEDIDO} FOR UPDATE`;

/** Una sentencia con las filas que debe tocar: si toca otras, se deshace todo. */
export interface SentenciaAutorizacion {
  que: string;
  sql: string;
  params: unknown[];
  esperadas: number;
}

/** La sentencia: sólo `c11`, y con el estatus leído en el `WHERE`. */
export function sentenciaAutorizacion(p: { sucursal: string; serie: number; folio: string; de: string; a: string }): SentenciaAutorizacion {
  return {
    que: `el estatus del pedido (${p.de} → ${p.a})`,
    sql: `UPDATE md.kdm1 SET c11 = $4 WHERE ${LLAVE_PEDIDO} AND btrim(c11) = $5`,
    params: [p.sucursal, p.serie, p.folio, p.a, p.de],
    esperadas: 1,
  };
}

/** El permiso que necesita `kepler_push`. El ensayo lo pregunta; el adaptador falla igual si falta. */
export const PERMISOS_AUTORIZACION = [`has_column_privilege(current_user, 'md.kdm1', 'c11', 'UPDATE')`] as const;
