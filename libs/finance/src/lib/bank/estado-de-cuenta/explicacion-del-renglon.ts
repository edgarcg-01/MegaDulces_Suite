/**
 * `[BFU.2.8]` Por qué existe cada peso del estado de cuenta — «toda la verdad» (VERDAD §39, propiedad 4).
 *
 * El estado de cuenta del banco dice cuánto entró y salió. El de la suite dice además de quién, por qué, de qué
 * sucursal y con qué documento, y **dice lo que todavía no sabe**. Esta función es el único lugar donde se decide si
 * un renglón está explicado: la usan la pantalla, el Excel y la cifra de la métrica (una sola regla, ADR-056).
 *
 * Un renglón está **explicado** si tiene:
 *   1. **un documento de Kepler** casado (el árbitro más fuerte: quién, qué y de qué sucursal), o
 *   2. **una categoría con evidencia**: el texto del banco, una regla, la clave que puso Tesorería o una persona.
 *
 * ⛔ **D8 (propuesta a Edgar, 2026-11-19):** un depósito «cobranza» sin documento ni cliente **no** está explicado.
 * «Depósito sin otra señal = cobranza» es el piso del clasificador: con los conceptos barajados acierta 62.2 % por
 * esa regla sola (CB.65). Lo mismo si la cobranza la puso Tesorería con su clave: dice «es un cobro», no de quién.
 *
 * La sucursal y la contraparte no deciden si está explicado: se reportan aparte (`falta`), porque un pago al SAT
 * no tiene sucursal y no por eso es un misterio.
 */
import type { FuenteDeCategoria } from './clasificador';

/** Quién puso la categoría: las fuentes del clasificador, más la clave de Tesorería (`libro`) y una persona. */
export type PorDeCategoria = FuenteDeCategoria | 'libro' | 'manual';

export interface HechosDelRenglon {
  entra: number;
  sale: number;
  /** El documento de Kepler con que casó, si casó. */
  documento?: { tipo: string; folio: string; sucursal?: string | null } | null;
  categoria?: { codigo: string; nombre?: string | null; por: PorDeCategoria } | null;
  sucursal?: string | null;
  /** Lo que el banco dice de la otra parte. */
  contraparte?: { nombre?: string | null; rfc?: string | null; referencia?: string | null } | null;
  /** El cliente que alguien declaró (CC.11). */
  cliente?: string | null;
  /** La póliza de ContPAQi con que casó. */
  poliza?: string | null;
  /** El pago del calendario que lo explica. */
  pago?: string | null;
}

export type NivelDeExplicacion = 'documento' | 'evidencia' | 'sin_explicar';

export interface Explicacion {
  nivel: NivelDeExplicacion;
  explicado: boolean;
  /** Las razones, en palabras, de la más fuerte a la más débil. */
  por: string[];
  /** Lo que todavía no se sabe de este renglón. */
  falta: ('documento' | 'categoría' | 'cliente' | 'sucursal')[];
}

const NOMBRE_FUENTE: Record<PorDeCategoria, string> = {
  documento: 'por el documento de Kepler', banco: 'por el texto del banco', regla_del_libro: 'por una regla',
  deposito: 'depósito sin otra señal', ninguna: 'sin señal', libro: 'clave de Tesorería', manual: 'puesta a mano',
};
const COBRANZA = 'cobranza';

export function explicarRenglon(h: HechosDelRenglon): Explicacion {
  const por: string[] = [];
  const falta: Explicacion['falta'] = [];
  const entra = Math.round(Number(h.entra || 0) * 100) > 0;
  const cat = h.categoria && h.categoria.codigo && h.categoria.codigo !== 'sin_clasificar' ? h.categoria : null;

  if (h.documento) por.push(`Kepler ${h.documento.tipo} ${h.documento.folio}${h.documento.sucursal ? ` · sucursal ${h.documento.sucursal}` : ''}`);
  if (h.cliente) por.push(`cliente ${h.cliente}`);
  if (h.pago) por.push(`pago ${h.pago}`);
  if (h.poliza) por.push(`póliza ${h.poliza}`);
  if (cat) por.push(`${cat.nombre || cat.codigo} (${NOMBRE_FUENTE[cat.por] ?? cat.por})`);
  const cp = h.contraparte;
  if (cp && (cp.nombre || cp.rfc)) por.push(`contraparte ${[cp.nombre, cp.rfc].filter(Boolean).join(' · ')}`);

  // ¿Explicado? Documento; si no, categoría con evidencia — pero la cobranza necesita saber de quién (D8).
  const evidencia = !!cat && cat.por !== 'deposito' && cat.por !== 'ninguna' && (cat.codigo !== COBRANZA || !!h.cliente);
  const nivel: NivelDeExplicacion = h.documento ? 'documento' : (evidencia || !!h.cliente || !!h.pago) ? 'evidencia' : 'sin_explicar';

  if (!h.documento) falta.push('documento');
  if (!cat) falta.push('categoría');
  if (entra && (!cat || cat.codigo === COBRANZA) && !h.cliente && !h.documento) falta.push('cliente');
  if (entra && !h.sucursal && !h.documento?.sucursal) falta.push('sucursal');
  return { nivel, explicado: nivel !== 'sin_explicar', por, falta };
}

/** La cifra de la métrica 2: pesos explicados, con su desglose. Pesos = entra + sale de cada renglón. */
export function pesosExplicados(renglones: readonly { entra: number; sale: number; explicacion: Explicacion }[]) {
  const r = { total: 0, documento: 0, evidencia: 0, sin_explicar: 0, renglones: renglones.length, renglones_sin_explicar: 0 };
  for (const x of renglones) {
    const p = Math.round((Number(x.entra || 0) + Number(x.sale || 0)) * 100);
    r.total += p; r[x.explicacion.nivel] += p;
    if (!x.explicacion.explicado) r.renglones_sin_explicar++;
  }
  const pct = (v: number) => (r.total ? Math.round((v / r.total) * 1000) / 10 : null);
  return {
    pesos: r.total / 100, renglones: r.renglones, renglones_sin_explicar: r.renglones_sin_explicar,
    pct_explicado: pct(r.documento + r.evidencia), pct_documento: pct(r.documento), pct_evidencia: pct(r.evidencia), pct_sin_explicar: pct(r.sin_explicar),
  };
}
