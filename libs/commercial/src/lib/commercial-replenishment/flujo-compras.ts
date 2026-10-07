/**
 * `[RA-PRO.63]` Decisiones del flujo de compras (requisición → OC Kepler → entrada), sin base de
 * datos, para probarlas (ADR-056: lo que decide un número se prueba). El servicio sólo trae filas.
 *
 * Contexto medido 2026-09-26 (prod, 244 requisiciones de proveedor):
 *   - Con la misma sucursal + proveedor y una ventana de 14 días, 91 requisiciones tienen una OC que
 *     trae ≥80% de sus productos y 8 más entre 50–79%. Por debajo de 50% casi siempre es OTRA
 *     compra del mismo proveedor, no la de la requisición → no se liga.
 *   - 22 de 66 OC juntan 2–4 requisiciones: el surtido en dinero cuenta cada OC una vez.
 */
import type {
  FlujoConfianza, FlujoEtapa, FlujoNegadoDto, FlujoRequisicionDto, FlujoResumenDto,
} from '@megadulces/contracts';
import { FLUJO_ETAPAS } from '@megadulces/contracts';

/** Días que se espera a que la OC aparezca en Kepler después de la requisición. */
export const VENTANA_OC_DIAS = 14;
/** ≥ este % de productos en común = confianza alta. */
export const COINCIDENCIA_ALTA = 80;
/** ≥ este % = confianza media; debajo no se liga. */
export const COINCIDENCIA_MEDIA = 50;
/** Veces negado para aparecer en "negados recurrentes". */
export const MIN_VECES_NEGADO = 2;

/** Una OC de Kepler candidata para una requisición (misma sucursal y proveedor, en la ventana). */
export interface CandidatoOc {
  sucursal: string;
  folio: string;
  fecha: string;
  /** Días de la requisición a la OC (0 = el mismo día). */
  dias: number;
  monto: number;
  /** Productos de la requisición que también vienen en la OC. */
  comunes: number;
}

export interface OcElegida {
  oc: CandidatoOc;
  pct: number;
  confianza: FlujoConfianza;
  ambigua: boolean;
}

/**
 * La OC que mejor explica una requisición: la que trae MÁS de sus productos; a igualdad, la más
 * cercana en fecha; a igualdad, el folio menor (determinista). `null` si ninguna llega a
 * `COINCIDENCIA_MEDIA` — mejor "sin OC" que una liga inventada.
 */
export function elegirOc(nRenglones: number, candidatos: CandidatoOc[]): OcElegida | null {
  if (!(nRenglones > 0)) return null;
  const validos = candidatos.filter((c) =>
    Number.isFinite(c.dias) && c.dias >= 0 && c.dias <= VENTANA_OC_DIAS && c.comunes > 0);
  if (!validos.length) return null;
  const orden = [...validos].sort((a, b) =>
    b.comunes - a.comunes || a.dias - b.dias || a.folio.localeCompare(b.folio));
  const best = orden[0];
  const pct = Math.round((Math.min(best.comunes, nRenglones) / nRenglones) * 100);
  if (pct < COINCIDENCIA_MEDIA) return null;
  return {
    oc: best,
    pct,
    confianza: pct >= COINCIDENCIA_ALTA ? 'alta' : 'media',
    ambigua: orden.length > 1 && orden[1].comunes === best.comunes,
  };
}

/**
 * Etapa de una requisición. `sinFuente` = su almacén no tiene OC en Kepler (Wincaja/MD-32);
 * `diasDesde` = días desde la requisición hasta hoy (para no dar por "sin OC" una que aún está en
 * la ventana de espera).
 */
export function etapaRequisicion(p: {
  sinFuente: boolean; conOc: boolean; conEntrada: boolean; diasDesde: number;
}): FlujoEtapa {
  if (p.sinFuente) return 'sin_fuente';
  if (p.conOc) return p.conEntrada ? 'con_entrada' : 'en_oc';
  return p.diasDesde <= VENTANA_OC_DIAS ? 'esperando' : 'sin_oc';
}

/** Surtido OC→entrada en dinero, entero 0–N. `null` si la OC no trae monto (no se divide por cero). */
export function surtidoPct(montoOc: number, montoEntradas: number): number | null {
  if (!(montoOc > 0)) return null;
  return Math.round((Math.max(0, montoEntradas) / montoOc) * 100);
}

/** Mediana entera; `null` sin datos. */
export function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = o.length >> 1;
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
}

/** Resumen del periodo. Cada OC se suma UNA vez aunque cubra varias requisiciones. */
export function resumenFlujo(reqs: FlujoRequisicionDto[]): FlujoResumenDto {
  const por_etapa = Object.fromEntries(FLUJO_ETAPAS.map((e) => [e, 0])) as Record<FlujoEtapa, number>;
  let conOc = 0, ambiguas = 0, ligados = 0, negados = 0;
  const ocs = new Map<string, { monto: number; entradas: number; pct: number | null }>();
  for (const r of reqs) {
    por_etapa[r.etapa] += 1;
    if (!r.oc) continue;
    conOc += 1;
    if (r.oc.ambigua) ambiguas += 1;
    ligados += r.renglones;
    negados += r.negados;
    const k = `${r.oc.sucursal}|${r.oc.folio}`;
    if (!ocs.has(k)) ocs.set(k, { monto: r.oc.monto, entradas: r.entrada?.monto ?? 0, pct: r.entrada?.surtido_pct ?? null });
  }
  let montoOc = 0, montoEnt = 0;
  const pcts: number[] = [];
  for (const o of ocs.values()) {
    montoOc += o.monto; montoEnt += o.entradas;
    if (o.pct !== null) pcts.push(o.pct);
  }
  return {
    requisiciones: reqs.length,
    por_etapa,
    con_oc: conOc,
    ambiguas,
    renglones_ligados: ligados,
    negados,
    renglones_en_oc_pct: ligados > 0 ? Math.round(((ligados - negados) / ligados) * 1000) / 10 : null,
    surtido_mediana_pct: mediana(pcts),
    surtido_dinero_pct: ocs.size ? surtidoPct(montoOc, montoEnt) : null,
    ocs_con_entrada: pcts.length,
    ocs_distintas: ocs.size,
  };
}

/**
 * Productos que se piden y no vienen en la OC una y otra vez. Sólo cuentan las requisiciones CON
 * OC ligada: en una sin OC no se sabe si se negó o si simplemente no se ha comprado.
 */
export function negadosRecurrentes(
  reqs: FlujoRequisicionDto[], minVeces = MIN_VECES_NEGADO, limite = 50,
): FlujoNegadoDto[] {
  const m = new Map<string, FlujoNegadoDto>();
  for (const r of reqs) {
    if (!r.oc) continue;
    for (const l of r.lineas) {
      if (l.en_oc === null) continue;
      const k = `${l.sku}|${r.proveedor ?? ''}`;
      const acc = m.get(k) ?? { sku: l.sku, nombre: l.nombre, proveedor: r.proveedor, veces_pedido: 0, veces_negado: 0, costo_negado: 0 };
      acc.veces_pedido += 1;
      if (l.en_oc === false) { acc.veces_negado += 1; acc.costo_negado += l.costo; }
      m.set(k, acc);
    }
  }
  return [...m.values()]
    .filter((n) => n.veces_negado >= minVeces)
    .map((n) => ({ ...n, costo_negado: Math.round(n.costo_negado * 100) / 100 }))
    .sort((a, b) => b.veces_negado - a.veces_negado || b.costo_negado - a.costo_negado || a.sku.localeCompare(b.sku))
    .slice(0, limite);
}

/**
 * Código Kepler de la sucursal de un almacén: `kepler_code` si lo tiene; si no, el `code` cuando es
 * de dos dígitos (el CEDIS `00`). `null` = no hay OC de Kepler para ese almacén (Wincaja, `MD-32`).
 */
export function sucursalKepler(code: string | null, keplerCode: string | null): string | null {
  const k = String(keplerCode ?? '').trim();
  if (/^\d{2}$/.test(k)) return k;
  const c = String(code ?? '').trim();
  return /^\d{2}$/.test(c) ? c : null;
}

// ── Filas tal como salen de la base (sin `any`) ────────────────────────────────────────────────

/** Un renglón de requisición con su encabezado. */
export interface FlujoRqLineRow {
  id: string; folio: string; fecha: string; dias_desde: number | string;
  source_type: string | null;
  wcode: string | null; kepler_code: string | null; wname: string | null;
  prov_code: string | null; prov_name: string | null;
  sku: string | null; nombre: string | null; line_cost: number | string | null;
}

export interface FlujoCandidatoRow {
  rq_id: string; sucursal: string; folio: string; fecha: string;
  dias: number | string; monto: number | string | null; comunes: number | string;
}

export interface FlujoOcSkuRow { sucursal: string; folio: string; sku: string | null; }

export interface FlujoEntradaRow {
  sucursal: string; oc_folio: string; folio: string; fecha: string | null;
  monto: number | string | null; proveedor_code: string | null;
}
