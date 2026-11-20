import { categoriaDelDocumento, clasificarRenglon } from './clasificador';
import { cuentaDelMovimiento, type MapaDeCuentas } from './cuenta-de-kepler';
import type { EvidenciaDeKepler } from './evidencia-de-kepler.query';

/**
 * `[BFU.7.3]` **El motor de categoría: cada movimiento del banco tiene categoría con su evidencia, o el motivo de por
 * qué no.** Edgar, 2026-11-20: «no necesito parches, necesito un motor que cubra el 100 %, y lo que no podamos cubrir,
 * revisar por qué». Nunca un «sin clasificar» mudo: cobertura = categorizados + con motivo = 100 %.
 *
 * Las fuentes, en orden (la primera que contesta, gana):
 *  1. **manual** — lo que puso una persona no se toca.
 *  2. **cargos propios del banco** — IVA y comisión, por el texto del banco: el documento de Kepler de una comisión
 *     trae su IVA dentro, y por el documento salían como comisión (2,273 en ago–oct).
 *  3. **documento de Kepler** — el pareo de la conciliación (traspaso `N-A-26`, cobro `U-A`, pago `X-D` → la cuenta
 *     contable de lo que liquida) o el pago del Calendario. Contra el árbitro (la categoría de Tesorería en el libro,
 *     ago–oct): 93.6 % de 3,994; con documentos barajados, 36.4 %. Los pases débiles de la conciliación no deciden.
 *  4. **texto del banco y reglas** — lo demás del clasificador (`clasificador.ts`).
 *  5. **depósito** — un depósito sin otra señal es cobranza (declarado `deposito`, no es explicación: D8).
 * Si ninguna contesta, el **motivo** (lista cerrada) y **quién** lo resuelve.
 */

export type MotivoSinCategoria =
  /** El documento de Kepler existe, pero su cuenta no tiene categoría en el mapeo: se resuelve UNA vez por cuenta. */
  | 'cuenta_sin_categoria'
  /** El documento casado no trae renglones con cuenta (o no es compra ni gasto). */
  | 'documento_sin_cuenta'
  /** El pago de Kepler casó pero no se ve qué liquida (`kdxf` vacío) y su acreedor no lo dice. */
  | 'documento_sin_aplicacion'
  /** El pareo vino de un pase débil de la conciliación: no se usa para decidir la categoría. */
  | 'pareo_debil'
  /** Kepler tiene un pago del mismo importe en la MISMA cuenta y fechas cercanas, y la conciliación no lo casó. */
  | 'pareo_pendiente'
  /** Kepler tiene el pago, pero registrado en OTRA cuenta de banco: hay que corregir la captura en Kepler. */
  | 'kepler_en_otra_cuenta'
  /** Kepler todavía no lo registra, dentro del plazo normal de captura. */
  | 'kepler_aun_no_lo_tiene'
  /** Kepler no lo registra y ya pasó el plazo: lo tiene que capturar el área dueña. */
  | 'kepler_no_lo_tiene'
  /** Sin ODS en este destino: no se pudo buscar el documento (CI, desarrollo). */
  | 'sin_ods';

export type Responsable = 'tesoreria' | 'contabilidad' | 'sistemas' | 'area' | 'nadie_todavia';

export const RESPONSABLE: Record<MotivoSinCategoria, Responsable> = {
  cuenta_sin_categoria: 'contabilidad', documento_sin_cuenta: 'sistemas', documento_sin_aplicacion: 'sistemas',
  pareo_debil: 'tesoreria', pareo_pendiente: 'sistemas', kepler_en_otra_cuenta: 'tesoreria',
  kepler_aun_no_lo_tiene: 'nadie_todavia', kepler_no_lo_tiene: 'area', sin_ods: 'sistemas',
};

/** Pases de la conciliación que NO deciden categoría (medido ago–oct: «2p» 2 de 3, «group» 1 de 2). */
export const PASES_DEBILES: ReadonlySet<string> = new Set(['motor-tes-2p', 'motor-tes-group']);
/** Días hábiles que tarda la captura en Kepler (mediana 2–5, CB.53): dentro, «todavía no»; después, «no lo tiene». */
export const PLAZO_DE_CAPTURA = 5;

export type FuenteDelMotor = 'manual' | 'banco' | 'documento' | 'regla_del_libro' | 'deposito';

export interface MovimientoParaElMotor {
  id: string;
  fecha: string;
  amount_in: number | string;
  amount_out: number | string;
  concepto: string | null;
  classified_by: string | null;
  /** El documento de Kepler de mayor importe con que casó (si casó): tipo, entidad y nombre congelado, y su pase. */
  pareo?: { doc_tipo: string; entidad?: string | null; beneficiario?: string | null; pase?: string | null } | null;
  /** Los documentos que liquida y sus renglones con cuenta (`evidencia-de-kepler.query.ts`). */
  kepler?: EvidenciaDeKepler | null;
  /** Lo que la conciliación vio en su bolsa de Kepler para un retiro que no casó. */
  pista?: 'pareo_pendiente' | 'kepler_en_otra_cuenta' | null;
}

export interface Evidencia {
  fuente: FuenteDelMotor | null;
  cuenta?: string | null;
  departamento?: string | null;
  documentos?: string[];
  ruta?: 'pareo' | 'calendario' | null;
  pase?: string | null;
  mixta?: boolean;
  dias_habiles?: number;
}

export type DecisionDelMotor =
  | { categoria: string; motivo: null; responsable: null; evidencia: Evidencia }
  | { categoria: null; motivo: MotivoSinCategoria; responsable: Responsable; evidencia: Evidencia };

export interface ContextoDelMotor {
  mapa: MapaDeCuentas;
  hoy: string;
  hayOds: boolean;
  reglaDelLibro?: (concepto: string) => string;
}

const SIN = 'sin_clasificar';
const PROPIOS_DEL_BANCO: ReadonlySet<string> = new Set(['iva_acreditable', 'comision_bancaria']);

/** Días hábiles (lunes a viernes) entre dos fechas `YYYY-MM-DD`. */
export function diasHabiles(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T12:00:00Z`), b = Date.parse(`${hasta}T12:00:00Z`);
  if (!(b > a)) return 0;
  let n = 0;
  for (let t = a + 86400000; t <= b; t += 86400000) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

const ok = (categoria: string, evidencia: Evidencia): DecisionDelMotor => ({ categoria, motivo: null, responsable: null, evidencia });
const no = (motivo: MotivoSinCategoria, evidencia: Evidencia): DecisionDelMotor =>
  ({ categoria: null, motivo, responsable: RESPONSABLE[motivo], evidencia });

export function decidirCategoria(m: MovimientoParaElMotor, ctx: ContextoDelMotor): DecisionDelMotor | { manual: true } {
  if (m.classified_by === 'manual') return { manual: true };
  const sale = Number(m.amount_out || 0), entra = Number(m.amount_in || 0);
  const texto = clasificarRenglon({ amount_in: entra, amount_out: sale, concepto: m.concepto }, ctx.reglaDelLibro);

  // 2. Los cargos propios del banco, por su texto.
  if (texto.por === 'banco' && PROPIOS_DEL_BANCO.has(texto.categoria)) return ok(texto.categoria, { fuente: 'banco' });

  // 3. El documento de Kepler.
  const p = m.pareo;
  const debil = !!p?.pase && PASES_DEBILES.has(p.pase);
  if (p && !debil && !/^X-D-/.test(p.doc_tipo)) {
    const cat = categoriaDelDocumento(p.doc_tipo, p.entidad, p.beneficiario);
    if (cat) return ok(cat, { fuente: 'documento', documentos: [p.doc_tipo], ruta: 'pareo', pase: p.pase ?? null });
  }
  const k = m.kepler && !(m.kepler.ruta === 'pareo' && debil) ? m.kepler : null;
  if (k) {
    const c = cuentaDelMovimiento(k.renglones, sale || entra, ctx.mapa);
    const ev: Evidencia = { fuente: 'documento', documentos: k.documentos, ruta: k.ruta, pase: k.pase };
    if (c) {
      if (c.categoria !== null) return ok(c.categoria, { ...ev, cuenta: c.cuenta, departamento: c.departamento, mixta: c.mixta });
      if (c.motivo === 'cuenta_sin_categoria') return no('cuenta_sin_categoria', { ...ev, fuente: null, cuenta: c.cuenta, departamento: c.departamento });
      return no('documento_sin_cuenta', { ...ev, fuente: null });
    }
  }
  if (p && !debil && /^X-D-/.test(p.doc_tipo)) {
    // Casó un pago pero no se ve qué liquida: el acreedor todavía puede decirlo (C… compra, NOMINA nómina).
    const cat = categoriaDelDocumento(p.doc_tipo, p.entidad, p.beneficiario);
    if (cat) return ok(cat, { fuente: 'documento', documentos: [p.doc_tipo], ruta: 'pareo', pase: p.pase ?? null });
  }

  // 4–5. El texto del banco, las reglas del libro, o «depósito».
  if (texto.categoria !== SIN) {
    const fuente: FuenteDelMotor = texto.por === 'regla_del_libro' ? 'regla_del_libro' : texto.por === 'deposito' ? 'deposito' : 'banco';
    return ok(texto.categoria, { fuente });
  }

  // Sin categoría: por qué.
  if (p && debil) return no('pareo_debil', { fuente: null, documentos: [p.doc_tipo], ruta: 'pareo', pase: p.pase ?? null });
  if (p) return no('documento_sin_aplicacion', { fuente: null, documentos: [p.doc_tipo], ruta: 'pareo', pase: p.pase ?? null });
  if (!ctx.hayOds) return no('sin_ods', { fuente: null });
  if (m.pista === 'pareo_pendiente') return no('pareo_pendiente', { fuente: null });
  if (m.pista === 'kepler_en_otra_cuenta') return no('kepler_en_otra_cuenta', { fuente: null });
  const dias = diasHabiles(m.fecha, ctx.hoy);
  return no(dias <= PLAZO_DE_CAPTURA ? 'kepler_aun_no_lo_tiene' : 'kepler_no_lo_tiene', { fuente: null, dias_habiles: dias });
}
