/**
 * `[PQ.110]` — **Cancelar una orden de compra (`X-A-35`) en Kepler igual que la cancela Kepler.**
 *
 * Anexo: [`FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md` §3c](../../../../../docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_MENU_COMPRAS_KEPLER.md).
 * Sin base de datos a propósito: la REGLA (¿se puede?) y las SENTENCIAS (¿qué se escribe?) se prueban
 * solas en `kepler-oc-cancelacion.spec.ts`; el adaptador sólo lee, decide con esto y ejecuta.
 *
 * ── Lo que escribe Kepler al cancelar, medido (2026-11-13, respaldo nocturno de `md` contra prod) ──
 *
 *  · **La OC** (`kdm1`): `c43` N→C · `c13`–`c16` y `c42` → 0 (361 de 361 canceladas en 90 días) ·
 *    `c67` → quién cancela · `c68`/`c69` → fecha y hora de la cancelación (la de captura se PIERDE).
 *  · **Sus renglones** (`kdm2`): se borran.
 *  · **La requisición de la que salió** (`c37 = 30`, folio en `c39`): Kepler la REABRE —`c43` F→A,
 *    `c42` = `c16`, y cada renglón vuelve a tener pendiente (`kdm2.c24` = `c9`)—. 25 de 25 requisiciones
 *    reabiertas en 90 días cumplen las tres (169 de 169 renglones), y el caso `08|0000362` (OC de la
 *    Suite, cancelada a mano) se vio pasar de F a A en el respaldo. `c67`–`c69` de la requisición NO
 *    cambian. Otras 17 terminaron canceladas también: eso es un SEGUNDO acto de la persona, no de Kepler.
 *
 * ── Lo que esto se niega a hacer (fail-closed: lo no medido no se escribe) ──────────────────────────
 *
 *  · OC que no está en `N` (pendiente): `R` tiene recepción parcial, `F` está surtida, `C` ya está
 *    cancelada; `A` (9 en 90 días) no se midió.
 *  · OC con un **vale vivo** (`X-A-37` con `c37 = 35`, `c39` = folio, `c43 ≠ C`): eso es deshacer una
 *    recepción, y va por el Andén (`[PQ.112]`).
 *  · Requisición que no está en `F`, o que tiene OTRA OC viva: Kepler no se observó en esos casos
 *    (0 de 45 OC canceladas con requisición tenían otra OC viva).
 */

/** Lo que el adaptador lee de Kepler, ya plano. */
export interface OcEnKepler {
  /** `kdm1.c5`: la serie. La llave es `(c1, c2, c3, c4, c5, c6)`. */
  serie: string;
  folio: string;
  /** `c43`. */
  estado: string;
  /** `c16`: total. */
  total: number;
  /** Capturista, fecha y hora ORIGINALES (`c67`/`c68`/`c69`): Kepler los sobrescribe al cancelar. */
  capturista: string;
  fecha_captura: string;
  hora_captura: string;
  /** Renglones en `kdm2`. */
  renglones: number;
  /** `c37`/`c39`: documento de origen. `30` = requisición. */
  origen_tipo: string | null;
  origen_folio: string | null;
}

export interface RequisicionEnKepler {
  serie: string;
  folio: string;
  estado: string;
  total: number;
  renglones: number;
}

export interface EntradaDecision {
  oc: OcEnKepler | null;
  /** Coincidencias de la OC por sucursal + folio (más de una = la llave no es única por folio). */
  coincidencias: number;
  /** Folios de los vales (`X-A-37`) que apuntan a la OC y no están cancelados. */
  vales_vivos: string[];
  /** La requisición de origen, si `origen_tipo = '30'`. `null` = no se encontró. */
  requisicion: RequisicionEnKepler | null;
  /** Otras OC no canceladas que salieron de la misma requisición. */
  otras_oc_vivas: string[];
}

export type Decision =
  | { ok: true; reabre_requisicion: boolean }
  | { ok: false; motivo: string };

/** Palabras del estado de una OC (`c43`), para que el motivo de rechazo se entienda sin el ERP. */
const ESTADO_OC: Record<string, string> = {
  N: 'pendiente', R: 'con recepción parcial', F: 'surtida', C: 'cancelada', A: 'en estado A',
};

/** Mínimo de letras del motivo: «ya no» no explica nada a quien lo lea después. */
export const MOTIVO_MINIMO = 10;

export function motivoValido(motivo: string | null | undefined): { ok: true; valor: string } | { ok: false; motivo: string } {
  const v = (motivo ?? '').replace(/\s+/g, ' ').trim();
  if (v.length < MOTIVO_MINIMO) {
    return { ok: false, motivo: `Escribe por qué se cancela (al menos ${MOTIVO_MINIMO} letras): queda en la Suite junto a la OC` };
  }
  return { ok: true, valor: v.slice(0, 500) };
}

/** ¿Se puede cancelar? Sólo los casos que se midieron en Kepler; el resto se rechaza con su porqué. */
export function decidirCancelacionOc(e: EntradaDecision): Decision {
  if (e.coincidencias === 0 || !e.oc) return { ok: false, motivo: 'Kepler no tiene esa orden de compra en esa sucursal' };
  if (e.coincidencias > 1) {
    return { ok: false, motivo: `Kepler tiene ${e.coincidencias} órdenes con ese folio en la sucursal (series distintas): no se sabe cuál cancelar` };
  }
  const oc = e.oc;
  if (oc.estado !== 'N') {
    const como = ESTADO_OC[oc.estado] ?? `en estado ${oc.estado}`;
    if (oc.estado === 'R') return { ok: false, motivo: `La OC está ${como}: deshacer lo recibido va por el Andén, no por aquí` };
    return { ok: false, motivo: `La OC está ${como}: sólo se cancela una OC pendiente` };
  }
  if (e.vales_vivos.length) {
    return {
      ok: false,
      motivo: `La OC ya tiene vale de entrada (${e.vales_vivos.slice(0, 3).join(', ')}): cancelarla es deshacer una recepción, y eso va por el Andén`,
    };
  }
  if (oc.origen_tipo !== '30') return { ok: true, reabre_requisicion: false };

  // Salió de una requisición: Kepler la reabre. Sólo se imita el caso observado.
  if (!e.requisicion) {
    return { ok: false, motivo: `La OC dice venir de la requisición ${oc.origen_folio ?? '(sin folio)'}, pero Kepler no la tiene: no se puede reabrir` };
  }
  if (e.requisicion.estado !== 'F') {
    return {
      ok: false,
      motivo: `La requisición ${e.requisicion.folio} está en estado ${e.requisicion.estado}, no convertida (F): no se ha visto qué hace Kepler en ese caso`,
    };
  }
  if (e.otras_oc_vivas.length) {
    return {
      ok: false,
      motivo: `La requisición ${e.requisicion.folio} tiene otra OC viva (${e.otras_oc_vivas.slice(0, 3).join(', ')}): no se ha visto qué hace Kepler en ese caso`,
    };
  }
  return { ok: true, reabre_requisicion: true };
}

/** Lo que se va a escribir, con lo que debe afectar cada sentencia. */
export interface PlanCancelacion {
  sucursal: string;
  oc: { serie: string; folio: string; renglones: number };
  requisicion: { serie: string; folio: string; renglones: number } | null;
  /** `c67`: quién cancela, como Kepler lo escribe. */
  capturista: string;
  /** `c68` (`YYYY-MM-DD`) y `c69` (`HH:MM`), hora de México. */
  fecha: string;
  hora: string;
}

export interface Sentencia {
  /** Para el log y el motivo de rechazo. */
  que: string;
  sql: string;
  params: unknown[];
  /** Filas que DEBE afectar. Si afecta otras, todo se deshace. */
  esperadas: number;
}

/** Nombres de tabla: los reales en el adaptador, copias temporales en el ensayo. */
export interface Tablas { kdm1: string; kdm2: string }
export const TABLAS_KEPLER: Tablas = { kdm1: 'md.kdm1', kdm2: 'md.kdm2' };

/** Llave de un documento de compra (`X-A-<tipo>`) — mismos `btrim` que las lecturas. */
const llave = (tipo: '30' | '35', base: number) =>
  `btrim(c1) = $${base} AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '${tipo}' AND btrim(c5::text) = $${base + 1} AND btrim(c6) = $${base + 2}`;

/**
 * Las sentencias, en orden. Cada `UPDATE` de cabecera repite en el `WHERE` el estado que se leyó
 * (`N` la OC, `F` la requisición): si alguien la tocó en Kepler entre la lectura y la escritura,
 * afecta 0 filas y todo se deshace en vez de pisar su cambio.
 */
export function sentenciasCancelacion(p: PlanCancelacion, t: Tablas = TABLAS_KEPLER): Sentencia[] {
  const oc = [p.sucursal, p.oc.serie, p.oc.folio];
  const out: Sentencia[] = [
    {
      que: 'cabecera de la OC',
      sql: `UPDATE ${t.kdm1} SET c43 = 'C', c13 = 0, c14 = 0, c15 = 0, c16 = 0, c42 = 0, c67 = $4, c68 = $5, c69 = $6
             WHERE ${llave('35', 1)} AND btrim(c43) = 'N'`,
      params: [...oc, p.capturista, p.fecha, p.hora],
      esperadas: 1,
    },
    {
      que: 'renglones de la OC',
      sql: `DELETE FROM ${t.kdm2} WHERE ${llave('35', 1)}`,
      params: oc,
      esperadas: p.oc.renglones,
    },
  ];
  if (p.requisicion) {
    const rq = [p.sucursal, p.requisicion.serie, p.requisicion.folio];
    out.push(
      {
        que: 'cabecera de la requisición',
        sql: `UPDATE ${t.kdm1} SET c43 = 'A', c42 = c16 WHERE ${llave('30', 1)} AND btrim(c43) = 'F'`,
        params: rq,
        esperadas: 1,
      },
      {
        que: 'renglones de la requisición',
        sql: `UPDATE ${t.kdm2} SET c24 = c9 WHERE ${llave('30', 1)}`,
        params: rq,
        esperadas: p.requisicion.renglones,
      },
    );
  }
  return out;
}

/**
 * Los permisos que `kepler_push` necesita para el plan, como expresiones `has_*_privilege`. El ensayo
 * los pregunta en vez de escribir en las tablas reales; el adaptador falla igual si falta uno.
 */
export function permisosNecesarios(conRequisicion: boolean): string[] {
  const col = (c: string) => `has_column_privilege(current_user, 'md.kdm1', '${c}', 'UPDATE')`;
  const p = ['c13', 'c14', 'c15', 'c16', 'c42', 'c43', 'c67', 'c68', 'c69'].map(col);
  p.push(`has_table_privilege(current_user, 'md.kdm2', 'DELETE')`);
  if (conRequisicion) p.push(`has_column_privilege(current_user, 'md.kdm2', 'c24', 'UPDATE')`);
  return p;
}
