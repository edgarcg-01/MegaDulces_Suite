/**
 * `[PGP.122]` S.13 — **La bandeja de facturas del SAT por registrar** (anexo S §14).
 *
 * Una factura de gasto que llegó del SAT y nadie registró es la entrada más automática del gasto: la Suite ya
 * sabe el acreedor, el folio, la fecha, el total y el IVA. Aquí vive la regla, pura; el servicio sólo junta
 * sus fuentes (DS24: el uno a uno es entre filas y no cabe en una vista).
 *
 * Medido en prod (sólo lectura, 15-ago → 13-nov, 1,633 facturas recibidas de acreedores de gasto):
 * - **Kepler no guarda el UUID** de las facturas de gasto (0 de 9,127 X-A-10/15). La gente teclea en `c11` o
 *   `c24` la cola del UUID o el folio: con eso se identifican 665 (40.7 %) con 2 falsos en el placebo.
 * - La cascada de «ya registrada» (DS19) registra 1,329 (81.4 %); quedan 304 sin registro ($2.70 M).
 * - El CFDI no dice la sucursal; la historia del acreedor DESDE EL CORTE del 1-oct sí (DS21): propone en
 *   47.3 % y acierta 93.1 % (98 % en noviembre), contra 27.4 % del placebo.
 *
 * ⛔ Uno a uno POR CERCANÍA (DS20), no «candidato único» como `[PGP.108]`: con «único», cada importe repetido
 * (casetas, recibos fijos) quedaría «sin registro» y la bandeja invitaría a duplicar el gasto. Y de cardinalidad
 * MÁXIMA: si dos facturas pueden quedar cubiertas, quedan las dos (la cercanía sólo desempata).
 *
 * La revisión independiente (2026-11-15) encontró cuatro caminos por los que una factura YA registrada se ofrecía
 * para registrar otra vez, y se cerraron aquí: la referencia tecleada en un gasto de OTRO acreedor (un reembolso),
 * el folio de 3 dígitos, el vale de la Suite capturado con ticket antes de que llegara la factura, y el pago que ya
 * explicaba otro gasto. Y uno por el que una factura NO registrada se escondía: el gasto que escribió un vale.
 */

// Los días entre dos fechas: el primitivo que ya existe (`hasta − desde`, a mediodía UTC), no otra copia.
import { diasEntre } from './pago-vencido.contract';
import { diaCorto } from './dia-corto.contract';

/** El corte del 1-oct-2026: desde entonces cada sucursal captura lo suyo (antes, 97.7 % en 00). */
export const CORTE_SUCURSALES = '2026-10-01';
/** ±$1 entre el total de la factura y el del documento (el mismo margen medido en `[PGP.108]`). */
export const TOLERANCIA_TOTAL = 1;
/** Señal 1 — la referencia identifica la factura: el documento de −30 a +120 días (97.3 % cae de 0 a +15). */
export const VENTANA_REFERENCIA = { desde: -30, hasta: 120 } as const;
/** Señal 2 — difusa: el documento de 0 a +15 días después de la factura (más allá, el placebo se dispara). */
export const VENTANA_DIFUSA = { desde: 0, hasta: 15 } as const;
/** Señal 3 — el pago X-D-26 de 0 a +7 días (llega 1 o 2 días después en 298 de 369). */
export const VENTANA_PAGO = { desde: 0, hasta: 7 } as const;
/** El vale de la Suite capturado con ticket: su documento de −5 a +15 días de la factura. */
export const VENTANA_VALE = { desde: -5, hasta: 15 } as const;
/** Un pago explica un gasto si llega de su primer documento hasta 30 días después del último. */
export const DIAS_PAGO_DEL_GASTO = 30;
/** Regla B (DS21): para proponer, 3+ documentos desde el corte y la sucursal líder con 80 % o más. */
export const SUCURSAL_MIN_DOCUMENTOS = 3;
export const SUCURSAL_MIN_PARTE = 0.8;
/** Las facturas llegan con mediana de 20 h y 96.3 % en 48 h: más de 48 h sin nada nuevo se dice. */
export const HORAS_SIN_LLEGADAS = 48;

/** Cómo se reconoció el RFC del acreedor (la escalera de `resolverRfcAcreedor`, CP.8.71). Se dice en pantalla. */
export type ViaRfcDelAcreedor = 'tal_cual' | 'sin_formato' | 'parecido' | 'por_nombre';

/** Una factura recibida del SAT (tipo I, vigente), con lo que la bandeja necesita. */
export interface FacturaSat {
  /** En minúsculas, con guiones. */
  uuid: string;
  /** En mayúsculas. */
  emisor_rfc: string;
  emisor_nombre: string | null;
  serie: string | null;
  folio: string | null;
  /** `YYYY-MM-DD`: el día del atributo `Fecha` del CFDI. */
  fecha: string;
  total: number;
  subtotal: number;
  descuento: number;
  /** El IVA trasladado del propio CFDI (nunca se calcula); `null` = el CFDI no lo trae. */
  iva: number | null;
  /** `total_retenidos`. */
  retenido: number;
  moneda: string | null;
  /** `receptor_uso_cfdi`. */
  uso: string | null;
  metodo_pago: string | null;
  forma_pago: string | null;
  /** `aso_contabilidad`: ya asociada en ContPAQi (otra contabilidad: NO dice que esté en Kepler). */
  contabilizada: boolean | null;
}

/** Por qué una factura NO entra a la bandeja (DS18); `null` = sí entra. Las canceladas ni se leen. */
export function fueraDeLaBandeja(f: Pick<FacturaSat, 'moneda' | 'retenido' | 'uso'>): string | null {
  const moneda = String(f.moneda ?? '').trim().toUpperCase() || 'MXN';
  if (moneda !== 'MXN') return `está en ${moneda}`;
  if (Number(f.retenido) > 0) return 'trae retención: esta versión no la registra';
  const uso = String(f.uso ?? '').trim().toUpperCase();
  if (uso === 'G01') return 'es mercancía (uso G01): va por compras';
  if (/^I0[1-8]$/.test(uso)) return `es activo fijo (uso ${uso})`;
  return null;
}

/** «SERIE-FOLIO» como lo escribe la Suite en `c11` (o sólo el folio). */
export function serieFolio(f: Pick<FacturaSat, 'serie' | 'folio'>): string | null {
  const s = String(f.serie ?? '').trim();
  const n = String(f.folio ?? '').trim();
  return [s, n].filter(Boolean).join('-') || null;
}

// ── Señal 1: la referencia que teclea la gente ─────────────────────────────────────────────────

const hex32 = (uuid: string): string => String(uuid ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
const digitos = (s: string | null | undefined): string => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');

/** Los pedazos de `c11` y `c24` que pueden ser la cola de un UUID: alfanuméricos de 4 o más. */
export function tokensDeReferencia(texto: string | null | undefined): string[] {
  return String(texto ?? '').toLowerCase().split(/[^0-9a-z]+/).filter((t) => t.length >= 4);
}

/** Las corridas de dígitos de la referencia, sin ceros a la izquierda («F-0467 TARJ 4512» → 467, 4512). */
export function numerosDeReferencia(texto: string | null | undefined): string[] {
  return (String(texto ?? '').match(/\d+/g) ?? []).map((n) => n.replace(/^0+/, '')).filter(Boolean);
}

/**
 * ¿La referencia del documento identifica ESTA factura? Por la **cola del UUID** (5+ caracteres, o 4 si además el
 * total cuadra ±$1) o por el **folio** como corrida de dígitos (4+ dígitos; de 3, sólo si el total cuadra: «467»,
 * «F-467» y «FAC 467» son el folio 467). Medido: 665 facturas con 2 falsos en el placebo (UUID y folio falsos). Un
 * pedazo EN MEDIO del UUID no cuenta: ahí el placebo ganaba (225 contra 156 reales).
 */
export function referenciaIdentifica(
  referencia: string | null | undefined,
  f: Pick<FacturaSat, 'uuid' | 'folio' | 'total'>,
  totalDocumento: number,
): 'uuid' | 'folio' | null {
  const u = hex32(f.uuid);
  const folio = digitos(f.folio);
  const cuadra = Math.abs(Number(totalDocumento) - Number(f.total)) <= TOLERANCIA_TOTAL;
  for (const t of tokensDeReferencia(referencia)) {
    if (u.length === 32 && u.endsWith(t) && (t.length >= 5 || cuadra)) return 'uuid';
  }
  if (folio.length >= 3 && (folio.length >= 4 || cuadra) && numerosDeReferencia(referencia).includes(folio)) return 'folio';
  return null;
}

/**
 * La referencia FUERTE, la única que vale en el gasto de OTRO acreedor (un reembolso a un empleado, por ejemplo):
 * la cola del UUID de 5+ caracteres, o el folio de 4+ dígitos con el total ±$1.
 */
export function referenciaFuerte(referencia: string | null | undefined, f: Pick<FacturaSat, 'uuid' | 'folio' | 'total'>, totalDocumento: number): boolean {
  const u = hex32(f.uuid);
  if (u.length === 32 && tokensDeReferencia(referencia).some((t) => t.length >= 5 && u.endsWith(t))) return true;
  const folio = digitos(f.folio);
  return folio.length >= 4 && Math.abs(Number(totalDocumento) - Number(f.total)) <= TOLERANCIA_TOTAL
    && numerosDeReferencia(referencia).includes(folio);
}

// ── Uno a uno por cercanía (DS20) ──────────────────────────────────────────────────────────────

export interface ParPorCercania {
  /** La factura (o el gasto, al buscarle su pago). */
  a: string;
  /** El documento (o el gasto, o el pago) que la cubriría. */
  b: string;
  /** Días del documento menos la factura. */
  dias: number;
}

/**
 * **Uno a uno por cercanía, de cardinalidad máxima:** primero gana el par más cercano (a igual distancia, el
 * documento posterior; desempata la llave, así que es determinista); después, a cada factura que se quedó sin
 * nada se le busca un camino aumentante —otra factura cede su documento por el siguiente que le sirva—. Así quedan
 * «sin registro» exactamente las facturas que sobran, no las que perdieron un desempate.
 */
export function asignarPorCercania(pares: readonly ParPorCercania[]): Map<string, { b: string; dias: number }> {
  const orden = [...pares].sort((x, y) => (Math.abs(x.dias) - Math.abs(y.dias))
    || ((x.dias < 0 ? 1 : 0) - (y.dias < 0 ? 1 : 0))
    || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const asignado = new Map<string, { b: string; dias: number }>();
  const duenoDe = new Map<string, string>();
  const opciones = new Map<string, ParPorCercania[]>();
  for (const p of orden) {
    opciones.set(p.a, [...(opciones.get(p.a) ?? []), p]);
    if (asignado.has(p.a) || duenoDe.has(p.b)) continue;
    asignado.set(p.a, { b: p.b, dias: p.dias });
    duenoDe.set(p.b, p.a);
  }
  const intentar = (a: string, visto: Set<string>): boolean => {
    for (const p of opciones.get(a) ?? []) {
      if (visto.has(p.b)) continue;
      visto.add(p.b);
      const otro = duenoDe.get(p.b);
      if (otro === undefined || intentar(otro, visto)) {
        duenoDe.set(p.b, a);
        asignado.set(a, { b: p.b, dias: p.dias });
        return true;
      }
    }
    return false;
  };
  for (const a of [...opciones.keys()].sort()) if (!asignado.has(a)) intentar(a, new Set<string>());
  return asignado;
}

// ── Lo que hay en Kepler y en la Suite ─────────────────────────────────────────────────────────

/** Un documento vivo (`c43 <> 'C'`) de Kepler, X-A-15 o X-A-10, de cualquier acreedor. */
export interface DocumentoDeGasto {
  sucursal: string;
  tipo: 10 | 15;
  folio: string;
  /** La X-A-15 del gasto: la propia, o la que la X-A-10 apunta (`c36 'A'`, `c37 15`, `c39`; 1,970 de 1,970 desde el corte). */
  solicitud: string;
  acreedor: string;
  total: number;
  /** `c9`. */
  fecha: string;
  /** `c11` y `c24`, juntos. */
  referencia: string;
}

/** Un pago X-D-26 vivo a un acreedor de gasto. */
export interface PagoDeGasto {
  sucursal: string;
  folio: string;
  acreedor: string;
  total: number;
  fecha: string;
}

/** Un vale vivo de la Suite que trae el UUID de una factura del SAT. */
export interface ValeConFactura {
  id: string;
  uuid: string;
  sucursal: string | null;
  folio_solicitud: string | null;
  status: string;
}

/** Un vale vivo de la Suite SIN factura ligada (se capturó con ticket o con foto antes de que llegara el CFDI). */
export interface ValeSinFactura {
  id: string;
  sucursal: string | null;
  folio_solicitud: string | null;
  acreedor: string;
  total: number;
  /** El día del documento que ampara (o el de la solicitud). */
  fecha: string;
}

export type SenalDeRegistro = 'suite' | 'suite_ticket' | 'referencia' | 'referencia_otro' | 'difusa' | 'pagada';

export interface DocumentoQueCubre {
  sucursal: string;
  tipo: 'X-A-15' | 'X-A-10' | 'X-D-26';
  folio: string;
  fecha: string;
  total: number;
}

export interface RegistroDeLaFactura {
  senal: SenalDeRegistro;
  /** El documento de Kepler que la cubre (el más cercano del gasto, o el pago). */
  documento: DocumentoQueCubre | null;
  /** El vale de la Suite (señales `suite` y `suite_ticket`). */
  vale: { id: string; folio_solicitud: string | null } | null;
  /** El acreedor del documento, cuando NO es el de la factura (señal `referencia_otro`). */
  acreedor: string | null;
  /** El gasto de Kepler que consumió (`sucursal|X-A-15`), si alguno. */
  gasto: string | null;
  /** Días del documento menos la factura. */
  dias: number | null;
}

export interface FuentesDelRegistro {
  /** Las claves de acreedor de gasto de cada RFC de emisor (la escalera ya aplicada). */
  acreedoresDe: ReadonlyMap<string, ReadonlySet<string>>;
  vales: readonly ValeConFactura[];
  /** Los vales sin factura ligada; sin ellos, la señal `suite_ticket` no corre. */
  valesSinFactura?: readonly ValeSinFactura[];
  /** Los X-A-15 y X-A-10 de TODOS los acreedores (la referencia fuerte se busca también en los de otros). */
  documentos: readonly DocumentoDeGasto[];
  pagos: readonly PagoDeGasto[];
}

interface GastoDeKepler {
  llave: string;
  acreedor: string;
  documentos: DocumentoDeGasto[];
}

const tipoDe = (d: DocumentoDeGasto): DocumentoQueCubre['tipo'] => (d.tipo === 10 ? 'X-A-10' : 'X-A-15');
const cubre = (d: DocumentoDeGasto): DocumentoQueCubre => ({ sucursal: d.sucursal, tipo: tipoDe(d), folio: d.folio, fecha: d.fecha, total: d.total });
const llaveDelGasto = (sucursal: string | null | undefined, solicitud: string | null | undefined): string | null =>
  (sucursal && solicitud ? `${String(sucursal).trim()}|${String(solicitud).trim()}` : null);

/** Agrega al arreglo de la llave sin copiarlo (un acreedor puede tener miles de gastos). */
function meter<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v); else m.set(k, [v]);
}

/** Los gastos de Kepler (la X-A-15 con sus X-A-10) y los pagos, indexados. */
function indexar(fuentes: FuentesDelRegistro) {
  const gastos = new Map<string, GastoDeKepler>();
  for (const d of fuentes.documentos) {
    const llave = `${d.sucursal}|${d.solicitud}`;
    const g = gastos.get(llave) ?? { llave, acreedor: d.acreedor, documentos: [] };
    g.documentos.push(d);
    gastos.set(llave, g);
  }
  const gastosDe = new Map<string, GastoDeKepler[]>();
  for (const g of gastos.values()) meter(gastosDe, g.acreedor, g);
  const pagosDe = new Map<string, PagoDeGasto[]>();
  for (const p of fuentes.pagos) meter(pagosDe, p.acreedor, p);
  // Índices de la referencia fuerte: la cola del UUID (por sus 5 últimos caracteres) y los folios de 4+ dígitos.
  const porCola = new Map<string, Array<{ d: DocumentoDeGasto; token: string }>>();
  const porNumero = new Map<string, DocumentoDeGasto[]>();
  for (const d of fuentes.documentos) {
    if (!d.referencia) continue;
    for (const t of tokensDeReferencia(d.referencia)) if (t.length >= 5) meter(porCola, t.slice(-5), { d, token: t });
    for (const n of new Set(numerosDeReferencia(d.referencia))) if (n.length >= 4) meter(porNumero, n, d);
  }
  // Por total redondeado, para avisar de documentos de otros acreedores por el mismo importe sin recorrerlos todos.
  const porTotal = new Map<number, DocumentoDeGasto[]>();
  for (const d of fuentes.documentos) meter(porTotal, Math.round(d.total), d);
  return { gastos, gastosDe, pagosDe, porCola, porNumero, porTotal };
}

/** El documento más cercano del gasto que cumple la condición, con sus días (documento − factura). */
function mejorDocumento(g: GastoDeKepler, f: FacturaSat, cumple: (d: DocumentoDeGasto, dias: number) => boolean): { d: DocumentoDeGasto; dias: number } | null {
  let mejor: { d: DocumentoDeGasto; dias: number } | null = null;
  for (const d of g.documentos) {
    const dias = diasEntre(f.fecha, d.fecha);
    if (!cumple(d, dias)) continue;
    if (!mejor || Math.abs(dias) < Math.abs(mejor.dias) || (Math.abs(dias) === Math.abs(mejor.dias) && dias > mejor.dias)) mejor = { d, dias };
  }
  return mejor;
}

/**
 * **¿Ya está registrada?** — DS19: la primera señal que se cumpla. Pura.
 *
 * 0. `suite`: un vale vivo de la Suite con ese UUID (y su gasto de Kepler ya no cubre otra factura).
 * 0b. `suite_ticket`: un vale vivo de la Suite SIN factura ligada, del mismo acreedor y total, de −5 a +15 días: se
 *    capturó con el ticket antes de que llegara el CFDI (la mediana es 20 h).
 * 1. `referencia`: un gasto de Kepler (la X-A-15 con sus X-A-10) del mismo acreedor cuya referencia identifica la
 *    factura, de −30 a +120 días.
 * 1b. `referencia_otro`: lo mismo con la referencia FUERTE en el gasto de OTRO acreedor (un reembolso).
 * 2. `difusa`: un gasto del mismo acreedor por el mismo total (±$1), de 0 a +15 días.
 * 3. `pagada`: un X-D-26 del acreedor por el mismo total, de 0 a +7 días, que NO explica un gasto ya usado: está
 *    pagada contra un gasto agrupado y ofrecerla para registrar duplicaría el gasto.
 *
 * En 0b a 3 cada gasto (o pago, o vale) cubre UNA factura, por cercanía y con cardinalidad máxima (DS20). Un gasto
 * es la X-A-15 con sus X-A-10: contarlas por separado dejaría que una sola solicitud con su comprobación «cubriera»
 * dos facturas del mismo importe.
 */
export function registroDeFacturas(facturas: readonly FacturaSat[], fuentes: FuentesDelRegistro): Map<string, RegistroDeLaFactura> {
  const out = new Map<string, RegistroDeLaFactura>();
  const { gastos, gastosDe, pagosDe, porCola, porNumero } = indexar(fuentes);
  const acreedores = (f: FacturaSat): ReadonlySet<string> => fuentes.acreedoresDe.get(f.emisor_rfc.trim().toUpperCase()) ?? new Set<string>();
  const usados = new Set<string>();
  const usar = (llave: string | null): string | null => {
    if (llave && gastos.has(llave)) { usados.add(llave); return llave; }
    return null;
  };

  // 0. La Suite: el UUID exacto. Su gasto de Kepler (si ya se escribió) queda consumido.
  const vales = new Map<string, ValeConFactura>();
  for (const v of fuentes.vales) if (v.uuid && v.status !== 'rechazada') vales.set(v.uuid.trim().toLowerCase(), v);
  for (const f of facturas) {
    const v = vales.get(f.uuid.trim().toLowerCase());
    if (v) out.set(f.uuid, { senal: 'suite', documento: null, vale: { id: v.id, folio_solicitud: v.folio_solicitud }, acreedor: null,
      gasto: usar(llaveDelGasto(v.sucursal, v.folio_solicitud)), dias: null });
  }
  // Los gastos de los vales con factura que no casaron con ninguna factura de esta lectura también están tomados.
  for (const v of vales.values()) usar(llaveDelGasto(v.sucursal, v.folio_solicitud));

  // 0b. El vale de la Suite capturado con ticket, sin la factura ligada.
  {
    const pares: ParPorCercania[] = [];
    const valePor = new Map<string, ValeSinFactura>();
    for (const v of fuentes.valesSinFactura ?? []) valePor.set(v.id, v);
    for (const f of facturas) {
      if (out.has(f.uuid)) continue;
      const acs = acreedores(f);
      for (const v of valePor.values()) {
        if (!acs.has(v.acreedor) || Math.abs(Number(v.total) - f.total) > TOLERANCIA_TOTAL) continue;
        const dias = diasEntre(f.fecha, v.fecha);
        if (dias >= VENTANA_VALE.desde && dias <= VENTANA_VALE.hasta) pares.push({ a: f.uuid, b: v.id, dias });
      }
    }
    for (const [uuid, { b, dias }] of asignarPorCercania(pares)) {
      const v = valePor.get(b) as ValeSinFactura;
      out.set(uuid, { senal: 'suite_ticket', documento: null, vale: { id: v.id, folio_solicitud: v.folio_solicitud }, acreedor: null,
        gasto: usar(llaveDelGasto(v.sucursal, v.folio_solicitud)), dias });
    }
    // Los gastos de los vales sin factura que no casaron también están tomados: son de otra factura (o de un ticket).
    for (const v of valePor.values()) usar(llaveDelGasto(v.sucursal, v.folio_solicitud));
  }

  const pasoDeGastos = (senal: 'referencia' | 'difusa', cumple: (d: DocumentoDeGasto, dias: number, f: FacturaSat) => boolean): void => {
    const pares: ParPorCercania[] = [];
    const elegido = new Map<string, DocumentoDeGasto>();
    for (const f of facturas) {
      if (out.has(f.uuid)) continue;
      for (const a of acreedores(f)) {
        for (const g of gastosDe.get(a) ?? []) {
          if (usados.has(g.llave)) continue;
          const m = mejorDocumento(g, f, (d, dias) => cumple(d, dias, f));
          if (!m) continue;
          pares.push({ a: f.uuid, b: g.llave, dias: m.dias });
          elegido.set(`${f.uuid}|${g.llave}`, m.d);
        }
      }
    }
    for (const [uuid, { b, dias }] of asignarPorCercania(pares)) {
      usados.add(b);
      const d = elegido.get(`${uuid}|${b}`) as DocumentoDeGasto;
      out.set(uuid, { senal, documento: cubre(d), vale: null, acreedor: null, gasto: b, dias });
    }
  };

  // 1. La referencia identifica la factura (gastos de SU acreedor).
  pasoDeGastos('referencia', (d, dias, f) => dias >= VENTANA_REFERENCIA.desde && dias <= VENTANA_REFERENCIA.hasta
    && referenciaIdentifica(d.referencia, f, d.total) !== null);

  // 1b. La referencia FUERTE en el gasto de OTRO acreedor (un reembolso, un gasto capturado a nombre de quien pagó).
  {
    const pares: ParPorCercania[] = [];
    const elegido = new Map<string, DocumentoDeGasto>();
    for (const f of facturas) {
      if (out.has(f.uuid)) continue;
      const propios = acreedores(f);
      const u = hex32(f.uuid);
      const candidatos = [
        ...(u.length === 32 ? (porCola.get(u.slice(-5)) ?? []).filter((x) => u.endsWith(x.token)).map((x) => x.d) : []),
        ...(porNumero.get(digitos(f.folio)) ?? []),
      ];
      const mejorPor = new Map<string, { d: DocumentoDeGasto; dias: number }>();
      for (const d of candidatos) {
        if (propios.has(d.acreedor)) continue;
        const llave = `${d.sucursal}|${d.solicitud}`;
        if (usados.has(llave)) continue;
        const dias = diasEntre(f.fecha, d.fecha);
        if (dias < VENTANA_REFERENCIA.desde || dias > VENTANA_REFERENCIA.hasta || !referenciaFuerte(d.referencia, f, d.total)) continue;
        const m = mejorPor.get(llave);
        if (!m || Math.abs(dias) < Math.abs(m.dias)) mejorPor.set(llave, { d, dias });
      }
      for (const [llave, m] of mejorPor) {
        pares.push({ a: f.uuid, b: llave, dias: m.dias });
        elegido.set(`${f.uuid}|${llave}`, m.d);
      }
    }
    for (const [uuid, { b, dias }] of asignarPorCercania(pares)) {
      usados.add(b);
      const d = elegido.get(`${uuid}|${b}`) as DocumentoDeGasto;
      out.set(uuid, { senal: 'referencia_otro', documento: cubre(d), vale: null, acreedor: d.acreedor, gasto: b, dias });
    }
  }

  // 2. Mismo acreedor y total, de 0 a +15 días.
  pasoDeGastos('difusa', (d, dias, f) => dias >= VENTANA_DIFUSA.desde && dias <= VENTANA_DIFUSA.hasta
    && Math.abs(d.total - f.total) <= TOLERANCIA_TOTAL);

  // Los pagos que explican un gasto ya usado no pueden marcar OTRA factura como pagada.
  const pagosUsados = new Set<string>();
  {
    const pares: ParPorCercania[] = [];
    for (const llave of usados) {
      const g = gastos.get(llave);
      if (!g) continue;
      const fechas = g.documentos.map((d) => d.fecha).sort();
      const totales = g.documentos.map((d) => d.total);
      for (const p of pagosDe.get(g.acreedor) ?? []) {
        if (!totales.some((t) => Math.abs(t - p.total) <= TOLERANCIA_TOTAL)) continue;
        const desdePrimero = diasEntre(fechas[0], p.fecha);
        const desdeUltimo = diasEntre(fechas[fechas.length - 1], p.fecha);
        if (desdePrimero < 0 || desdeUltimo > DIAS_PAGO_DEL_GASTO) continue;
        pares.push({ a: llave, b: `${p.sucursal}|${p.folio}`, dias: desdeUltimo });
      }
    }
    for (const { b } of asignarPorCercania(pares).values()) pagosUsados.add(b);
  }

  // 3. Pagada contra un gasto agrupado.
  const pares: ParPorCercania[] = [];
  const pagoDe = new Map<string, PagoDeGasto>();
  for (const f of facturas) {
    if (out.has(f.uuid)) continue;
    for (const a of acreedores(f)) {
      for (const p of pagosDe.get(a) ?? []) {
        const llave = `${p.sucursal}|${p.folio}`;
        if (pagosUsados.has(llave)) continue;
        const dias = diasEntre(f.fecha, p.fecha);
        if (dias < VENTANA_PAGO.desde || dias > VENTANA_PAGO.hasta || Math.abs(p.total - f.total) > TOLERANCIA_TOTAL) continue;
        pares.push({ a: f.uuid, b: llave, dias });
        pagoDe.set(llave, p);
      }
    }
  }
  for (const [uuid, { b, dias }] of asignarPorCercania(pares)) {
    const p = pagoDe.get(b) as PagoDeGasto;
    out.set(uuid, { senal: 'pagada', documento: { sucursal: p.sucursal, tipo: 'X-D-26', folio: p.folio, fecha: p.fecha, total: p.total },
      vale: null, acreedor: null, gasto: null, dias });
  }
  return out;
}

const TEXTO_SENAL: Record<SenalDeRegistro, string> = {
  suite: 'ya tiene vale en la Suite',
  suite_ticket: 'ya tiene vale en la Suite, capturado con el ticket (sin la factura ligada)',
  referencia: 'su folio o su UUID está en la referencia de un gasto de Kepler',
  referencia_otro: 'su folio o su UUID está en la referencia de un gasto de Kepler de OTRO acreedor (un reembolso)',
  difusa: 'un gasto de Kepler del mismo acreedor y total',
  pagada: 'pagada en Kepler contra un gasto agrupado',
};
export function textoDeLaSenal(s: SenalDeRegistro): string { return TEXTO_SENAL[s]; }

// ── Por qué está en la bandeja, sin afirmar de más ─────────────────────────────────────────────

export interface PistasSinRegistro {
  /** Gastos del mismo acreedor y total en la ventana que YA cubren otra factura (más cercana). */
  ocupados: Array<{ documento: DocumentoQueCubre; cubre: string }>;
  /**
   * Documentos de OTRO acreedor por el mismo total, de 0 a +15 días, en una sucursal que VE la factura: un posible
   * reembolso (no se da por registrada).
   */
  otros: Array<{ documento: DocumentoQueCubre; acreedor: string }>;
}

/**
 * Lo que SÍ hay alrededor de una factura que quedó sin registro. Medido en prod: 219 de 304 facturas sin registro
 * casan por total con un documento de OTRO acreedor, contra 88 del placebo; es señal débil, así que se AVISA y no
 * se esconde. Y con importes que se repiten, el gasto que «parece suyo» casi siempre cubre otra factura más cercana.
 *
 * `[PGP.123]` S.13 (H11) — **El aviso de reembolso sólo cuenta documentos de las sucursales que ven la factura**
 * (`sucursalesQueLaVen`: la propuesta o sus dos de historia, y la 00). La prueba visual encontró 5 avisos en la 05,
 * todos de otras sucursales, y 3 sobre una factura de $200.00. Re-medido el 2026-11-15 sobre las 176 sin registro
 * (las reglas de registro ya absorbieron los reembolsos con referencia): en cualquier sucursal avisaban 44 facturas
 * (107 avisos), con placebo de importe ×1.07 19 y de fecha −30 días 59; con la regla, 28 (67 avisos), placebo de
 * importe 10 y de fecha 48. Los dos placebos tiran en sentidos opuestos (el de fecha cae en septiembre, antes del
 * corte, con más documentos libres; el de importe subestima los montos redondos): la señal sigue débil y por eso se
 * avisa, no se decide. La parte que se quita es la más ruidosa.
 */
export function pistasSinRegistro(f: FacturaSat, fuentes: FuentesDelRegistro, registro: ReadonlyMap<string, RegistroDeLaFactura>,
  sucursales: ReadonlySet<string>): PistasSinRegistro {
  return pistasDeLaBandeja(fuentes, registro)(f, sucursales);
}

/** Lo mismo que `pistasSinRegistro`, indexando UNA vez para toda la bandeja (se llama por cada factura sin registro). */
export function pistasDeLaBandeja(fuentes: FuentesDelRegistro, registro: ReadonlyMap<string, RegistroDeLaFactura>):
  (f: FacturaSat, sucursales: ReadonlySet<string>) => PistasSinRegistro {
  const { gastosDe, porTotal } = indexar(fuentes);
  const quienUsa = new Map<string, string>();
  for (const [uuid, r] of registro) if (r.gasto) quienUsa.set(r.gasto, uuid);
  const orden = (x: { documento: DocumentoQueCubre }, y: { documento: DocumentoQueCubre }) =>
    x.documento.fecha.localeCompare(y.documento.fecha) || x.documento.folio.localeCompare(y.documento.folio);
  return (f, sucursales) => {
    const propios = fuentes.acreedoresDe.get(f.emisor_rfc.trim().toUpperCase()) ?? new Set<string>();
    const ocupados: PistasSinRegistro['ocupados'] = [];
    for (const a of propios) {
      for (const g of gastosDe.get(a) ?? []) {
        const cubreA = quienUsa.get(g.llave);
        if (!cubreA || cubreA === f.uuid) continue;
        const m = mejorDocumento(g, f, (d, dias) => dias >= VENTANA_DIFUSA.desde && dias <= VENTANA_DIFUSA.hasta && Math.abs(d.total - f.total) <= TOLERANCIA_TOTAL);
        if (m) ocupados.push({ documento: cubre(m.d), cubre: cubreA });
      }
    }
    const otros: PistasSinRegistro['otros'] = [];
    const k = Math.round(f.total);
    for (const d of [...(porTotal.get(k - 1) ?? []), ...(porTotal.get(k) ?? []), ...(porTotal.get(k + 1) ?? [])]) {
      if (propios.has(d.acreedor) || Math.abs(d.total - f.total) > TOLERANCIA_TOTAL) continue;
      // H11: un documento de una sucursal que no ve la factura es coincidencia de importe, no su reembolso.
      if (!sucursales.has(d.sucursal)) continue;
      // Un gasto que ya cubre una factura (de su propio acreedor) no puede ser ésta: no se avisa de él.
      if (quienUsa.has(`${d.sucursal}|${d.solicitud}`)) continue;
      const dias = diasEntre(f.fecha, d.fecha);
      if (dias >= VENTANA_DIFUSA.desde && dias <= VENTANA_DIFUSA.hasta) otros.push({ documento: cubre(d), acreedor: d.acreedor });
    }
    return { ocupados: ocupados.sort(orden).slice(0, 3), otros: otros.sort(orden).slice(0, 3) };
  };
}

// ── Cómo se dicen las cosas en pantalla (`[PGP.123]` S.13, prueba visual del 2026-11-15) ─────────────────────────
// El porqué y las advertencias decían «X-A-15… X-D-26», «$1234.50» y «2026-10-08», mientras la misma pantalla dice
// «$1,234.50» y «08-oct». Se dicen con el formato de la pantalla y con el nombre del documento; la clave de la
// sucursal sólo va pegada a su folio (es lo que se teclea en Kepler: VALORES §10). La fecha, con el `diaCorto`
// compartido (CGP-L.4: un solo formateador para servidor y pantalla).
/** `1234.5` → `$1,234.50`. Privado del módulo: un `export` con este nombre chocaría en el índice de contracts. */
const pesos = (n: number): string => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** El documento por su nombre: la solicitud, el gasto o el pago, con su folio y su sucursal pegada. */
function nombreDelDocumento(d: Pick<DocumentoQueCubre, 'tipo' | 'folio' | 'sucursal' | 'fecha'>): string {
  const nombre = d.tipo === 'X-A-15' ? 'la solicitud' : d.tipo === 'X-A-10' ? 'el gasto' : d.tipo === 'X-D-26' ? 'el pago' : `el ${d.tipo}`;
  return `${nombre} ${d.folio} de la ${d.sucursal}, del ${diaCorto(d.fecha)}`;
}

/** Por qué una factura está en la bandeja, en llano (§14.5), con lo que sí hay alrededor. */
export function motivoSinRegistro(f: Pick<FacturaSat, 'fecha' | 'total'>, acreedores: readonly string[], pistas?: PistasSinRegistro): string {
  const hasta = new Date(`${f.fecha}T12:00:00Z`);
  hasta.setUTCDate(hasta.getUTCDate() + VENTANA_DIFUSA.hasta);
  const quien = acreedores.length ? acreedores.join(' / ') : 'el acreedor';
  const monto = pesos(f.total);
  const ocupados = pistas?.ocupados ?? [];
  if (ocupados.length) {
    const docs = ocupados.map((o) => nombreDelDocumento(o.documento)).join('; ');
    return `En Kepler hay ${ocupados.length === 1 ? 'un gasto' : `${ocupados.length} gastos`} de ${quien} por ${monto} cerca de esta factura (${docs}), `
      + `pero ${ocupados.length === 1 ? 'ya cubre otra factura' : 'ya cubren otras facturas'} del mismo importe, más cercana${ocupados.length === 1 ? '' : 's'}. `
      + 'Ninguno queda libre para ésta, ni su folio o su UUID está en la referencia de algún gasto.';
  }
  return `En Kepler no hay solicitud ni gasto de ${quien} por ${monto} del ${diaCorto(f.fecha)} al `
    + `${diaCorto(hasta.toISOString().slice(0, 10))}, ni su folio o su UUID en la referencia de algún gasto, ni un pago por ese importe.`;
}

/** Los avisos de una factura sin registro: lo que podría ser ella con OTRO acreedor (no se esconde: se dice). */
export function avisosSinRegistro(pistas: PistasSinRegistro): string[] {
  return pistas.otros.map((o) => `Puede estar registrada como reembolso: ${nombreDelDocumento(o.documento)} `
    + `es de otro acreedor (${o.acreedor}) por el mismo importe.`);
}

// ── La sucursal (DS21) ─────────────────────────────────────────────────────────────────────────

export type ViaDeLaSucursal = 'historia' | 'sin_historia' | 'poca_historia' | 'repartida' | 'empate';

export interface SucursalPropuesta {
  /** La que se propone; `null` = se pregunta. */
  propuesta: string | null;
  via: ViaDeLaSucursal;
  /** Las 2 de su historia, primero la que más (lo que se ofrece al preguntar: ahí está la correcta en 80.8 %). */
  opciones: string[];
  /** Documentos del acreedor desde el corte (X-A-15 y X-A-10 vivos). */
  documentos: number;
  /** Parte de la líder (0–1); `null` sin historia. */
  parte: number | null;
}

/**
 * **Regla B** (DS21): la sucursal líder de los documentos del acreedor desde el corte, con 3+ documentos y 80 %+.
 * Si no, se pregunta. ⛔ Nunca con historia anterior al corte: entonces todo era 00 (acierta 36.5 %, igual que el
 * placebo).
 */
export function sucursalPropuesta(conteo: ReadonlyMap<string, number>): SucursalPropuesta {
  const filas = [...conteo.entries()].filter(([, n]) => n > 0).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const documentos = filas.reduce((s, [, n]) => s + n, 0);
  const opciones = filas.slice(0, 2).map(([s]) => s);
  if (!documentos) return { propuesta: null, via: 'sin_historia', opciones, documentos, parte: null };
  const parte = filas[0][1] / documentos;
  if (filas.length > 1 && filas[1][1] === filas[0][1]) return { propuesta: null, via: 'empate', opciones, documentos, parte };
  if (documentos < SUCURSAL_MIN_DOCUMENTOS) return { propuesta: null, via: 'poca_historia', opciones, documentos, parte };
  if (parte < SUCURSAL_MIN_PARTE) return { propuesta: null, via: 'repartida', opciones, documentos, parte };
  return { propuesta: filas[0][0], via: 'historia', opciones, documentos, parte };
}

/**
 * ¿La bandeja de esta sucursal la muestra? La propuesta, o —sin propuesta— si la tiene entre sus 2 opciones.
 * **00 ve todas**: registra el gasto de logística de las sucursales y es quien atiende lo que no tiene historia.
 */
export function laVeLaSucursal(p: SucursalPropuesta, sucursal: string): boolean {
  if (sucursal === '00') return true;
  if (p.propuesta) return p.propuesta === sucursal;
  return p.opciones.includes(sucursal);
}

/** Las sucursales que ven la factura en su bandeja (las mismas de `laVeLaSucursal`): la propuesta o sus dos, y 00. */
export function sucursalesQueLaVen(p: SucursalPropuesta): ReadonlySet<string> {
  return new Set([...(p.propuesta ? [p.propuesta] : p.opciones), '00']);
}

/**
 * La sucursal propuesta, dicha con su origen (ADR-056). `nombre` pone el nombre de la sucursal (la vista pasa
 * `branchLabel`: «05 Zamora Centro»); sin él queda la clave, que es lo único que el servidor sabe.
 */
export function textoDeLaSucursal(p: SucursalPropuesta, nombre: (sucursal: string) => string = (s) => s): string {
  // `[PGP.123]` S.13: el porcentaje va SIN paréntesis propios: «(la líder tiene (33 %))» salía doble (prueba visual).
  const pct = p.parte === null ? null : `${Math.round(p.parte * 100)} %`;
  switch (p.via) {
    case 'historia': return `${nombre(p.propuesta ?? '')}: ${p.documentos} documentos de este acreedor desde el corte${pct ? ` (${pct})` : ''}`;
    case 'sin_historia': return 'Sin historia desde el corte: elige la sucursal';
    case 'poca_historia': return `Sólo ${p.documentos} documento(s) desde el corte: elige la sucursal`;
    case 'repartida': return `Su historia está repartida${pct ? ` (la que más tiene, ${pct})` : ''}: elige la sucursal`;
    case 'empate': return 'Su historia empata entre dos sucursales: elige la sucursal';
  }
}

// ── Sacar de la bandeja (DS23) ─────────────────────────────────────────────────────────────────

/**
 * `todas`: no es un gasto que se registre por aquí (no es de la empresa, ya se registró de otra forma, es mercancía):
 * sale de todas las bandejas y se ve en «Descartadas» de cada sucursal que la veía. `sucursal`: «no es de esta
 * sucursal»: sólo sale de la que lo dijo; las otras de su historia y 00 la siguen viendo.
 */
export type AlcanceDelDescarte = 'todas' | 'sucursal';

export const MOTIVO_OTRA_SUCURSAL = 'No es de esta sucursal';

// ── Lo que viaja a la pantalla ────────────────────────────────────────────────────────────────

export interface AcreedorDeLaFactura {
  clave: string;
  nombre: string | null;
  via: ViaRfcDelAcreedor;
  /** ¿Está en el catálogo de Kepler de la sucursal de la bandeja? (sin eso no se puede pedir ahí). */
  en_la_sucursal: boolean;
  /**
   * ¿La solicitud pasaría la validación del RFC (`rfcCompatible`, la MISMA de «Mandar a firma»)? Un acreedor
   * reconocido por el nombre cuyo RFC de Kepler es de otra razón social no pasa: no se ofrece «Registrar».
   */
  registrable: boolean;
  /** Por qué no se puede registrar con este acreedor, en llano; `null` si se puede. */
  por_que_no: string | null;
}

export interface FacturaPorRegistrar {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string | null;
  serie_folio: string | null;
  fecha: string;
  /** Días desde que se emitió (más de 30 piden motivo al pedir). */
  dias: number;
  total: number;
  subtotal: number;
  descuento: number;
  iva: number | null;
  metodo_pago: string | null;
  forma_pago: string | null;
  acreedores: AcreedorDeLaFactura[];
  sucursal: SucursalPropuesta;
  contabilizada: boolean | null;
  /** Por qué está aquí, en llano. */
  motivo: string;
  /** Lo que hay que revisar antes de registrar (posible reembolso, otra sucursal dijo que no es suya…). */
  avisos: string[];
}

export interface FacturaYaRegistrada {
  uuid: string;
  emisor_nombre: string | null;
  serie_folio: string | null;
  fecha: string;
  total: number;
  registro: RegistroDeLaFactura;
}

export interface FacturaDescartada {
  uuid: string;
  emisor_nombre: string | null;
  serie_folio: string | null;
  fecha: string;
  total: number;
  /** La sucursal desde la que se sacó. */
  sucursal: string;
  alcance: AlcanceDelDescarte;
  motivo: string;
  por: string;
  cuando: string;
}

export interface BandejaDeFacturasSat {
  sucursal: string;
  /** Desde cuándo (el corte). */
  desde: string;
  /** La última factura recibida que llegó a la Suite (frescura, §14.4); `null` = no se pudo leer. */
  ultima_llegada: string | null;
  /** Horas desde esa llegada; más de 48 se dice en pantalla. */
  horas_sin_llegadas: number | null;
  por_registrar: FacturaPorRegistrar[];
  registradas: FacturaYaRegistrada[];
  descartadas: FacturaDescartada[];
  /** De las por registrar, cuántas no tienen sucursal propuesta y esta sucursal ve por tenerla entre sus 2. */
  sin_sucursal_clara: number;
  /** Lo que la regla no ve, dicho (ADR-056). */
  declarado: string[];
}

export interface ConceptoDeLaFactura {
  descripcion: string;
  cantidad: number | null;
  unidad: string | null;
  importe: number | null;
}

export interface DetalleDeFacturaSat {
  uuid: string;
  /** La factura tal como la ve la bandeja de esa sucursal (`null` si ya está registrada o descartada). */
  por_registrar: FacturaPorRegistrar | null;
  registrada: FacturaYaRegistrada | null;
  descartada: FacturaDescartada | null;
  conceptos: ConceptoDeLaFactura[];
  tiene_xml: boolean;
}

export interface DescartarFacturaSatDto {
  sucursal: string;
  /** `sucursal` = «no es de esta sucursal» (sólo sale de ésta); `todas` = no es un gasto que se registre aquí. */
  alcance: AlcanceDelDescarte;
  motivo: string;
}

/** Un emisor de la bandeja, con sus facturas (DS22: 63 % es combustible de 13 gasolineras). */
export interface GrupoDeEmisor {
  emisor_rfc: string;
  emisor_nombre: string | null;
  facturas: FacturaPorRegistrar[];
  total: number;
  mas_antigua: string;
}

/** Agrupa por emisor: primero el que tiene la factura más antigua (la que más se atrasa), y dentro, por fecha. */
export function agruparPorEmisor(facturas: readonly FacturaPorRegistrar[]): GrupoDeEmisor[] {
  const grupos = new Map<string, GrupoDeEmisor>();
  for (const f of facturas) {
    const g = grupos.get(f.emisor_rfc) ?? { emisor_rfc: f.emisor_rfc, emisor_nombre: f.emisor_nombre, facturas: [], total: 0, mas_antigua: f.fecha };
    g.facturas.push(f);
    g.total = Math.round((g.total + f.total) * 100) / 100;
    if (f.fecha < g.mas_antigua) g.mas_antigua = f.fecha;
    grupos.set(f.emisor_rfc, g);
  }
  for (const g of grupos.values()) g.facturas.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.uuid.localeCompare(b.uuid));
  return [...grupos.values()].sort((a, b) => a.mas_antigua.localeCompare(b.mas_antigua) || (b.total - a.total) || a.emisor_rfc.localeCompare(b.emisor_rfc));
}
