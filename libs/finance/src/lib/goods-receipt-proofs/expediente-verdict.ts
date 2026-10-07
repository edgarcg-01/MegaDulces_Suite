/**
 * `[RE.35]` — **El expediente de la factura: lo que cuadra pasa solo.** (ADR-085)
 *
 * Módulo PURO, sin base de datos (mismo patrón que `receipt-match.ts`): cada veredicto tiene que
 * poder explicarse con una regla y reproducirse en un test, porque decide sobre dinero.
 *
 * Dos piezas:
 *   1. `ligarCfdi` — encuentra el CFDI de la entrada en `fiscal.cfdis` usando las LLAVES que se leen
 *      del documento subido. Regla de fuentes: **el papel identifica, el CFDI informa.**
 *   2. `veredictoExpediente` — corre los checks y pone la entrada en EXACTAMENTE un cubo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Las reglas y los esperados están MEDIDOS en prod (sólo lectura, 2026-10-06), no supuestos.
 * Detalle en `FASE_RE` §RE.35–RE.41:
 *   · F1 receptor y F2 su régimen: 11,227 de 11,227 facturas recibidas de 2026 → el de
 *     `fiscal.issuer_config`.
 *   · F3 uso `G01`: 100% de las facturas ligadas a una entrada.
 *   · F4 régimen del emisor: 206 de 209 emisores usan uno solo; el que alterna (612/621) es
 *     legítimo → se acepta un régimen que ya usó (≥10% de su historia).
 *   · F5 método↔forma: PPD sin `99` = 0 casos; PUE con `99` = 9 facturas ($1.9M).
 *   · F6 método: 95% PPD; se exige el habitual del emisor si lo usa en ≥90%.
 *   · F7 nombre: las fallas eran tecleo en Kepler (LUCHETTI/LUCCHETTI) → vale el de Kepler O el
 *     que ese RFC usa siempre.
 *   · Con todo eso, 99.3% de las facturas ligadas pasan los checks fiscales.
 *   · Tolerancia del cuadre (decisión de Francisco): < 0.25% Y < $200.
 *   · OC obligatoria SIN excepción (decisión de Francisco): no es omisión tolerable.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
import type {
  ExpedienteCfdi, ExpedienteCheck, ExpedienteCubo, ExpedienteDocTipo, ExpedienteLiga, ExpedienteLigaMetodo,
} from '@megadulces/contracts';
import { folioNumero, parecidoNombre, rfcBienFormado, rfcComparable, UMBRAL_NOMBRE } from './receipt-match';

/** La regla y su versión: sello de cada veredicto (ADR-085). Cambiar un umbral = subir la versión. */
export const REGLA_EXPEDIENTE = 'R-v1';
/** Cuadre: la diferencia tiene que ser MENOR a las dos (decisión de Francisco, 2026-10-06). */
export const TOLERANCIA_PCT = 0.0025;
export const TOLERANCIA_ABS = 200;
/** Un UUID leído con hasta 3 caracteres distintos se corrige si hay UN solo candidato (medido: 22 de 22 sin ambigüedad). */
export const UUID_MAX_DIFERENCIAS = 3;
/** Ventana para buscar candidatos por llave débil (importe), en días. */
export const VENTANA_DIAS = 60;
/** Antes de esto, una factura sin CFDI se espera (ContPAQi sincroniza una vez al día); después, se revisa. */
export const DIAS_ESPERA_CFDI = 3;
/** Un régimen del emisor se acepta si ya lo usó en al menos esta fracción de su historia. */
export const MIN_REGIMEN_HISTORIA = 0.1;
/** El método habitual se exige si el emisor lo usa en al menos esta fracción (y con ≥3 facturas). */
export const MIN_METODO_HABITUAL = 0.9;
/** Parecido de nombre para decir "este proveedor sí factura en ContPAQi" (más estricto que el del cuadre). */
export const UMBRAL_NOMBRE_CONTPAQI = 0.6;
/** Una nota de crédito explica una factura mayor si llega en esta ventana alrededor de la factura (días). */
export const NC_DIAS_ANTES = 5;
export const NC_DIAS_DESPUES = 90;

/** Regímenes válidos por tipo de persona (RFC de 12 = moral, de 13 = física). Catálogo SAT c_RegimenFiscal. */
const REGIMEN_MORAL = new Set(['601', '603', '609', '610', '620', '622', '623', '624', '626']);
const REGIMEN_FISICA = new Set(['605', '606', '607', '608', '611', '612', '614', '615', '616', '621', '625', '626']);

const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;

/** El primer UUID con forma de UUID dentro de un texto (la lectura cruda del OCR). */
export function extraerUuid(texto?: string | null): string | null {
  const m = (texto || '').match(UUID_RE);
  return m ? m[0].toUpperCase() : null;
}

/** Caracteres distintos entre dos UUID de 36. Mayor a 36 si no son comparables. */
export function diferenciasUuid(a: string, b: string): number {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  if (A.length !== 36 || B.length !== 36) return 99;
  let d = 0;
  for (let i = 0; i < 36; i++) if (A[i] !== B[i]) d++;
  return d;
}

const dias = (a?: string | null, b?: string | null): number | null => {
  if (!a || !b) return null;
  const x = Date.parse(a.slice(0, 10));
  const y = Date.parse(b.slice(0, 10));
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((x - y) / 864e5);
};
const igual = (a: number | null | undefined, b: number | null | undefined, tol = 1): boolean =>
  a != null && b != null && Math.abs(a - b) <= tol;

// ═══════════════════════════════════════ 1. La liga ═══════════════════════════════════════

/** Un CFDI candidato: lo de la tabla + su id interno. */
export interface CfdiCandidato extends ExpedienteCfdi { id: string }

/** Las llaves con que se busca. Del papel (lo leído) y de Kepler (la entrada). */
export interface LlavesLiga {
  uuidLeido: string | null;
  folioLeido: string | null;
  rfcLeido: string | null;
  totalLeido: number | null;
  fechaLeida: string | null;
  rfcKepler: string | null;
  montoEntrada: number;
  fechaEntrada: string | null;
  /** CFDI ya confirmado para esta entrada en `fiscal.cfdi_assignments`. Gana sobre todo. */
  asignadoId: string | null;
}

export interface ResultadoLiga {
  cfdi: CfdiCandidato | null;
  liga: ExpedienteLiga | null;
  /** Si ninguna llave dio un candidato ÚNICO, cuántos empataron en la más fuerte que pegó. */
  ambiguos: number;
}

/**
 * Busca el CFDI de la entrada, de la llave más fuerte a la más débil. Se queda con la primera que
 * da **un solo** candidato; con más de uno NO elige (elegir el primero pegaría la factura
 * equivocada del proveedor correcto: un error que se ve bien y nadie audita).
 */
export function ligarCfdi(k: LlavesLiga, candidatos: CfdiCandidato[]): ResultadoLiga {
  const sinLiga: ResultadoLiga = { cfdi: null, liga: null, ambiguos: 0 };
  let ambiguos = 0;
  const unico = (lista: CfdiCandidato[], metodo: ExpedienteLigaMetodo, exacta: boolean): ResultadoLiga | null => {
    if (lista.length === 1) return { cfdi: lista[0], liga: { metodo, exacta, candidatos: 1 }, ambiguos: 0 };
    if (lista.length > 1 && !ambiguos) ambiguos = lista.length;
    return null;
  };

  if (k.asignadoId) {
    const a = candidatos.find((c) => c.id === k.asignadoId);
    if (a) return { cfdi: a, liga: { metodo: 'asignado', exacta: true, candidatos: 1 }, ambiguos: 0 };
  }

  if (k.uuidLeido) {
    const u = k.uuidLeido.toUpperCase();
    const r = unico(candidatos.filter((c) => c.uuid.toUpperCase() === u), 'uuid', true);
    if (r) return r;
    const cerca = candidatos.filter((c) => diferenciasUuid(u, c.uuid) <= UUID_MAX_DIFERENCIAS);
    const r2 = unico(cerca, 'uuid_corregido', true);
    if (r2) return r2;
  }

  const rfcs = [k.rfcLeido, k.rfcKepler].filter((r) => rfcBienFormado(r)).map((r) => rfcComparable(r));
  const deRfc = (c: CfdiCandidato) => rfcs.includes(rfcComparable(c.emisor_rfc));
  const folio = folioNumero(k.folioLeido);
  const deFolio = (c: CfdiCandidato) => !!folio && folioNumero(c.folio) === folio;
  const cercaDeEntrada = (c: CfdiCandidato) => {
    const d = dias(c.fecha, k.fechaEntrada);
    return d == null || Math.abs(d) <= VENTANA_DIAS;
  };

  if (rfcs.length && folio) {
    // Dos llaves impresas en la factura, independientes entre sí (medido: RFC+serie+folio da 25,383
    // combinaciones distintas en 26,490 facturas). Con candidato único cuentan como EXACTA.
    const r = unico(candidatos.filter((c) => deRfc(c) && deFolio(c)), 'rfc_folio', true);
    if (r) return r;
  }
  if (folio && k.totalLeido != null) {
    const r = unico(candidatos.filter((c) => deFolio(c) && igual(c.total, k.totalLeido)), 'folio_total', true);
    if (r) return r;
  }
  // Débiles: RFC + importe compara contra el monto de la MISMA entrada (casi circular) y total + fecha
  // no identifica al emisor. Las dos son SUGERENCIA: las confirma una persona.
  if (rfcs.length) {
    const r = unico(
      candidatos.filter((c) => deRfc(c) && cercaDeEntrada(c) && (igual(c.total, k.totalLeido) || igual(c.total, k.montoEntrada))),
      'rfc_importe', false);
    if (r) return r;
  }
  if (k.totalLeido != null && k.fechaLeida) {
    const r = unico(
      candidatos.filter((c) => igual(c.total, k.totalLeido) && (dias(c.fecha, k.fechaLeida) ?? 99) <= 3 && (dias(c.fecha, k.fechaLeida) ?? -99) >= -3),
      'total_fecha', false);
    if (r) return r;
  }
  return { ...sinLiga, ambiguos };
}

/**
 * `[RE.35.2]` RFC + importe pasa de sugerencia a EXACTA cuando la llave no tiene gemelos de ningún lado:
 * un solo CFDI del emisor con ese importe en la ventana, y una sola entrada del mismo proveedor con ese
 * importe. Medido sobre las 643 entradas con documento: 68 de 69 ligas por RFC + importe cumplen, y en
 * 58 la diferencia es $0. Si el proveedor entregó dos veces lo mismo, hay dos entradas y sigue sugerida.
 */
export function promoverRfcImporte(liga: ExpedienteLiga | null, entradasMismoImporte: number): ExpedienteLiga | null {
  if (!liga || liga.metodo !== 'rfc_importe' || liga.candidatos !== 1 || entradasMismoImporte !== 1) return liga;
  return { ...liga, exacta: true };
}

/**
 * `[RE.35.2]` ¿El proveedor factura en ContPAQi? Si en la ventana no hay NINGÚN CFDI suyo (por RFC de
 * Kepler o por nombre), su papel no tiene CFDI con qué compararse: se revisa como remisión (decisión de
 * Francisco, 2026-10-06). Medido: 178 de 643 entradas con documento son de proveedores así (chicos y
 * personas físicas). ⚠️ El nombre comercial puede no parecerse al fiscal (Cueritos Premium Zacapu factura
 * como su dueño): por eso, si el CFDI aparece después, la entrada vuelve sola a la vía de factura.
 */
export function proveedorEnContpaqi(
  nombre: string | null, rfcKepler: string | null, candidatos: Pick<CfdiCandidato, 'emisor_rfc' | 'emisor_nombre'>[],
): boolean {
  const rfc = rfcBienFormado(rfcKepler) ? rfcComparable(rfcKepler) : null;
  if (rfc && candidatos.some((c) => rfcComparable(c.emisor_rfc) === rfc)) return true;
  // `[RE.35.5]` Se compara contra los NOMBRES DISTINTOS, no contra cada CFDI: en la ventana hay ~4 mil
  // CFDI pero unos cientos de emisores (medido: 1.1 s → la décima parte en 447 entradas).
  const nombres = new Set<string>();
  for (const c of candidatos) if (c.emisor_nombre) nombres.add(c.emisor_nombre);
  for (const n of nombres) if ((parecidoNombre(nombre, n) ?? 0) >= UMBRAL_NOMBRE_CONTPAQI) return true;
  return false;
}

/** Una nota de crédito (CFDI tipo E) del mismo emisor. */
export interface NotaCredito { uuid: string; total: number; fecha: string | null }

/**
 * `[RE.35.2]` Si la factura vino MAYOR que la entrada, ¿una nota de crédito del mismo emisor explica la
 * diferencia? Se queda sólo con la que hace cuadrar (factura − nota contra la entrada) y sólo si es UNA.
 */
export function notaQueExplica(diferencia: number | null, monto: number, fechaFactura: string | null, notas: NotaCredito[]): NotaCredito | null {
  if (diferencia == null || diferencia <= 0 || cuadra(diferencia, monto)) return null;
  const sirven = notas.filter((n) => {
    const d = dias(n.fecha, fechaFactura);
    return (d == null || (d >= -NC_DIAS_ANTES && d <= NC_DIAS_DESPUES)) && cuadra(diferencia - n.total, monto);
  });
  return sirven.length === 1 ? sirven[0] : null;
}

// ═══════════════════════════════════════ 2. El veredicto ═══════════════════════════════════════

export interface EntradaExpediente {
  monto: number;
  oc_folio: string | null;
  fecha_recepcion: string | null;
  fecha_recepcion_usuario: string | null;
  receipt_date: string | null;
  proveedor_nombre: string | null;
  /** El proveedor es la propia empresa (traspaso, o `catalog.suppliers.is_internal`). */
  interno: boolean;
}

/** Cuántas facturas anteriores (uso G01) del mismo emisor usaron cada valor. */
export interface HistorialEmisor {
  regimenes: Record<string, number>;
  metodos: Record<string, number>;
  nombres: Record<string, number>;
}

export interface ContextoFiscal {
  receptorRfc: string | null;
  receptorRegimen: string | null;
  /** Listas del SAT donde aparece el emisor (`fiscal.sat_list_rfcs`). */
  listasSat: { lista: string; situacion: string | null }[];
}

export interface EntradaVeredicto {
  docTipo: ExpedienteDocTipo;
  entrada: EntradaExpediente;
  cfdi: CfdiCandidato | null;
  liga: ExpedienteLiga | null;
  ambiguos: number;
  /** Total leído del papel: el único total disponible en una remisión. */
  totalLeido: number | null;
  /** Fecha de referencia para saber si todavía se espera el CFDI (la del papel o la de la entrada). */
  fechaDocumento: string | null;
  historial: HistorialEmisor | null;
  ctx: ContextoFiscal;
  /** `[RE.35.2]` Nota de crédito que explica una factura mayor (ya elegida por `notaQueExplica`). */
  notaCredito?: NotaCredito | null;
  /** `[RE.35.2]` El proveedor tiene CFDI en ContPAQi (si no, su papel se revisa como remisión). */
  proveedorEnContpaqi?: boolean;
  /** Hoy, `YYYY-MM-DD` (inyectado para que el test no dependa del reloj). */
  hoy: string;
}

export interface Veredicto {
  cubo: ExpedienteCubo;
  motivos: string[];
  checks: ExpedienteCheck[];
  diferencia: number | null;
  /** Con qué reglas se evaluó: la de factura (CFDI) o la de remisión (cuadre, OC y fecha). */
  via: 'factura' | 'remision';
  notaCredito: NotaCredito | null;
}

const total = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + n, 0);
const modal = (r: Record<string, number>): [string, number] | null => {
  const e = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
  return e ? [e[0], e[1]] : null;
};
const fmt = (n: number) => '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ¿La diferencia cabe en la tolerancia? Las DOS condiciones. */
export function cuadra(diferencia: number, monto: number): boolean {
  const d = Math.abs(diferencia);
  return d < TOLERANCIA_ABS && d < TOLERANCIA_PCT * Math.abs(monto);
}

export function veredictoExpediente(v: EntradaVeredicto): Veredicto {
  const checks: ExpedienteCheck[] = [];
  const add = (c: Omit<ExpedienteCheck, 'nota' | 'esperado'> & { nota?: string | null; esperado?: string | null }) =>
    checks.push({ nota: null, esperado: null, ...c });

  // ── Fuera de alcance: el proveedor somos nosotros (traspaso). No genera factura de compra.
  if (v.entrada.interno) {
    return { cubo: 'fuera_de_alcance', motivos: ['El proveedor es la propia empresa: no lleva factura de compra.'], checks, diferencia: null, via: 'factura', notaCredito: null };
  }
  if (v.docTipo === 'ninguno') {
    return { cubo: 'sin_documento', motivos: ['Todavía no se sube la factura o remisión.'], checks, diferencia: null, via: 'factura', notaCredito: null };
  }

  // ── La vía. Una factura sin CFDI cuyo proveedor NO factura en ContPAQi se revisa como remisión
  //    (cuadre con el total del papel, OC y fecha). Si todavía está en espera, se espera primero.
  const espera = dias(v.hoy, v.fechaDocumento ?? v.entrada.receipt_date);
  const enEspera = !v.cfdi && !v.ambiguos && espera != null && espera <= DIAS_ESPERA_CFDI;
  const comoRemision = v.docTipo === 'remision'
    || (v.docTipo === 'factura' && !v.cfdi && !v.ambiguos && !enEspera && v.proveedorEnContpaqi === false);
  const via: 'factura' | 'remision' = comoRemision ? 'remision' : 'factura';

  // ── Contra la entrada (Kepler): aplica a factura y a remisión.
  const totalDoc = via === 'factura' ? (v.cfdi?.total ?? null) : v.totalLeido;
  const diferencia = totalDoc == null ? null : Math.round((totalDoc - v.entrada.monto) * 100) / 100;
  // La nota de crédito sólo vale en la vía de factura (es un CFDI) y sólo si hace cuadrar.
  const nota = via === 'factura' && v.notaCredito && diferencia != null && diferencia > 0
    && !cuadra(diferencia, v.entrada.monto) && cuadra(diferencia - v.notaCredito.total, v.entrada.monto) ? v.notaCredito : null;
  if (diferencia == null) {
    // Sin CFDI en la vía de factura, el motivo lo da I1 (no se repite acá).
    add({ clave: 'E1_cuadre', grupo: 'entrada', etiqueta: 'Total contra la entrada', valor: fmt(v.entrada.monto),
      estado: 'sin_medir', bloquea: true,
      nota: via === 'factura' ? null : 'No se leyó el total del papel.' });
  } else if (nota) {
    add({ clave: 'E1_cuadre', grupo: 'entrada', etiqueta: 'Total contra la entrada',
      valor: `${fmt(totalDoc as number)} − nota ${fmt(nota.total)} contra ${fmt(v.entrada.monto)}`,
      esperado: `diferencia menor a ${(TOLERANCIA_PCT * 100).toFixed(2)}% y a ${fmt(TOLERANCIA_ABS)}`,
      estado: 'ok', bloquea: true,
      nota: `Cuadra descontando la nota de crédito ${nota.uuid} por ${fmt(nota.total)}.` });
  } else {
    const ok = cuadra(diferencia, v.entrada.monto);
    add({ clave: 'E1_cuadre', grupo: 'entrada', etiqueta: 'Total contra la entrada',
      valor: `${fmt(totalDoc as number)} contra ${fmt(v.entrada.monto)}`,
      esperado: `diferencia menor a ${(TOLERANCIA_PCT * 100).toFixed(2)}% y a ${fmt(TOLERANCIA_ABS)}`,
      estado: ok ? 'ok' : 'falla', bloquea: true,
      nota: ok ? null : `La ${via === 'factura' ? 'factura' : 'remisión'} viene ${fmt(Math.abs(diferencia))} ${diferencia > 0 ? 'mayor' : 'menor'} (${(Math.abs(diferencia) / Math.max(1, Math.abs(v.entrada.monto)) * 100).toFixed(2)}%).` });
  }
  add({ clave: 'E2_oc', grupo: 'entrada', etiqueta: 'Orden de compra', valor: v.entrada.oc_folio,
    esperado: 'obligatoria', estado: v.entrada.oc_folio ? 'ok' : 'falla', bloquea: true,
    nota: v.entrada.oc_folio ? null
      : `Entrada sin orden de compra${v.entrada.fecha_recepcion_usuario ? ` · la capturó ${v.entrada.fecha_recepcion_usuario}` : ''}.` });
  add({ clave: 'E3_recepcion', grupo: 'entrada', etiqueta: 'Fecha de recepción', valor: v.entrada.fecha_recepcion,
    estado: v.entrada.fecha_recepcion ? 'ok' : 'sin_medir', bloquea: true,
    nota: v.entrada.fecha_recepcion ? null : 'Kepler no trae la captura del vale (o es Wincaja).' });

  // ── Factura sin CFDI de un proveedor que no factura en ContPAQi: aviso (no bloquea) y vía remisión.
  if (v.docTipo === 'factura' && comoRemision) {
    add({ clave: 'I1_liga', grupo: 'identificacion', etiqueta: 'CFDI de la factura', valor: null,
      estado: 'aviso', bloquea: false,
      nota: 'Este proveedor no tiene CFDI en ContPAQi: se revisa como remisión (cuadre, OC y fecha). Avisar a contabilidad: sin CFDI la compra no es deducible.' });
  }

  // ── Factura: identificación + fiscal.
  if (via === 'factura' && v.docTipo === 'factura') {
    if (!v.cfdi) {
      add({ clave: 'I1_liga', grupo: 'identificacion', etiqueta: 'CFDI de la factura', valor: null,
        estado: enEspera ? 'sin_medir' : 'falla', bloquea: true,
        nota: v.ambiguos ? `${v.ambiguos} facturas posibles: hay que elegir la correcta.`
          : enEspera ? 'ContPAQi sincroniza una vez al día: se vuelve a buscar mañana.'
          : 'No se encontró su CFDI en ContPAQi.' });
      const cubo: ExpedienteCubo = enEspera ? 'sin_cfdi_aun' : 'revisar';
      return { cubo, motivos: motivosDe(checks), checks, diferencia, via, notaCredito: null };
    }
    const c = v.cfdi;
    add({ clave: 'I1_liga', grupo: 'identificacion', etiqueta: 'CFDI de la factura', valor: c.uuid,
      estado: v.liga?.exacta ? 'ok' : 'aviso', bloquea: !v.liga?.exacta,
      nota: v.liga?.exacta ? null : 'Liga sugerida por llaves débiles: confírmala.' });

    add({ clave: 'F1_receptor', grupo: 'fiscal', etiqueta: 'RFC del receptor', valor: c.receptor_rfc, esperado: v.ctx.receptorRfc,
      estado: !v.ctx.receptorRfc ? 'sin_medir' : c.receptor_rfc?.toUpperCase() === v.ctx.receptorRfc.toUpperCase() ? 'ok' : 'falla', bloquea: true,
      nota: !v.ctx.receptorRfc ? 'No hay RFC de la empresa configurado.'
        : c.receptor_rfc?.toUpperCase() === v.ctx.receptorRfc.toUpperCase() ? null : `La factura está a nombre de ${c.receptor_rfc ?? 'otro RFC'}; se esperaba ${v.ctx.receptorRfc}.` });
    add({ clave: 'F2_regimen_receptor', grupo: 'fiscal', etiqueta: 'Régimen del receptor', valor: c.receptor_regimen, esperado: v.ctx.receptorRegimen,
      estado: !v.ctx.receptorRegimen ? 'sin_medir' : c.receptor_regimen === v.ctx.receptorRegimen ? 'ok' : 'falla', bloquea: true,
      nota: !v.ctx.receptorRegimen || c.receptor_regimen === v.ctx.receptorRegimen ? null : `Trae régimen ${c.receptor_regimen ?? '—'}; se esperaba ${v.ctx.receptorRegimen}.` });
    add({ clave: 'F3_uso', grupo: 'fiscal', etiqueta: 'Uso CFDI', valor: c.uso_cfdi, esperado: 'G01 (adquisición de mercancías)',
      estado: c.uso_cfdi === 'G01' ? 'ok' : 'falla', bloquea: true,
      nota: c.uso_cfdi === 'G01' ? null : `Trae uso ${c.uso_cfdi ?? '—'}; se esperaba G01 (adquisición de mercancías).` });

    const len = (c.emisor_rfc || '').replace(/[^A-Z0-9Ñ&]/gi, '').length;
    const coherente = (len === 12 ? REGIMEN_MORAL : len === 13 ? REGIMEN_FISICA : new Set<string>()).has(c.emisor_regimen || '');
    const nReg = v.historial ? total(v.historial.regimenes) : 0;
    const usado = !nReg || ((v.historial?.regimenes[c.emisor_regimen || ''] ?? 0) / nReg) >= MIN_REGIMEN_HISTORIA;
    add({ clave: 'F4_regimen_emisor', grupo: 'fiscal', etiqueta: 'Régimen del emisor', valor: c.emisor_regimen,
      esperado: len === 12 ? 'el de una persona moral, y el que ya usa' : 'el de una persona física, y el que ya usa',
      estado: coherente && usado ? 'ok' : 'falla', bloquea: true,
      nota: !coherente ? 'No corresponde al tipo de persona del RFC.' : !usado ? 'Este emisor no había facturado con este régimen.' : null });

    const pueMal = c.metodo_pago === 'PUE' && c.forma_pago === '99';
    const ppdMal = c.metodo_pago === 'PPD' && c.forma_pago !== '99';
    add({ clave: 'F5_metodo_forma', grupo: 'fiscal', etiqueta: 'Forma de pago', valor: c.forma_pago,
      esperado: c.metodo_pago === 'PPD' ? '99 (por definir)' : 'la forma real del pago, nunca 99',
      estado: pueMal || ppdMal ? 'falla' : 'ok', bloquea: true,
      nota: pueMal ? 'PUE con forma 99: el SAT no lo permite.' : ppdMal ? 'PPD tiene que llevar forma 99.' : null });

    const nMet = v.historial ? total(v.historial.metodos) : 0;
    const hab = v.historial ? modal(v.historial.metodos) : null;
    const habitual = nMet >= 3 && hab && hab[1] / nMet >= MIN_METODO_HABITUAL ? hab[0] : null;
    const metodoOk = habitual ? c.metodo_pago === habitual : (nMet >= 3 ? true : c.metodo_pago === 'PPD');
    add({ clave: 'F6_metodo', grupo: 'fiscal', etiqueta: 'Método de pago', valor: c.metodo_pago,
      esperado: habitual ? `${habitual} (el habitual de este emisor)` : nMet >= 3 ? 'cualquiera (este emisor usa los dos)' : 'PPD (sin historia del emisor)',
      estado: metodoOk ? 'ok' : 'falla', bloquea: true,
      nota: metodoOk ? null : `Su habitual es ${habitual ?? 'PPD'}.` });

    const parecido = parecidoNombre(v.entrada.proveedor_nombre, c.emisor_nombre);
    const nNom = v.historial ? total(v.historial.nombres) : 0;
    const nombreHabitual = nNom >= 3 && ((v.historial?.nombres[c.emisor_nombre || ''] ?? 0) / nNom) >= MIN_METODO_HABITUAL;
    const nombreOk = (parecido != null && parecido >= UMBRAL_NOMBRE) || nombreHabitual;
    add({ clave: 'F7_nombre', grupo: 'fiscal', etiqueta: 'Nombre del emisor', valor: c.emisor_nombre, esperado: v.entrada.proveedor_nombre,
      estado: nombreOk ? 'ok' : 'falla', bloquea: true,
      nota: nombreOk ? (parecido != null && parecido < UMBRAL_NOMBRE ? 'Es el nombre que este RFC usa siempre; Kepler lo tiene distinto.' : null)
        : 'El emisor del CFDI no parece el proveedor de la entrada.' });

    const est = (c.estatus_sat || '').toLowerCase();
    add({ clave: 'F8_estatus', grupo: 'fiscal', etiqueta: 'Estatus en el SAT', valor: est || null,
      estado: est === 'cancelado' ? 'falla' : est === 'vigente' ? 'ok' : 'sin_medir',
      bloquea: est === 'cancelado',
      nota: est === 'cancelado' ? 'La factura está cancelada.' : est === 'vigente' ? null : 'Sin verificar: ContPAQi no trae el estatus de cancelación.' });

    const efos = v.ctx.listasSat.find((l) => /69\s*-?\s*B/i.test(l.lista));
    const lista69 = v.ctx.listasSat.find((l) => !/69\s*-?\s*B/i.test(l.lista));
    add({ clave: 'F9_listas_sat', grupo: 'fiscal', etiqueta: 'Listas del SAT',
      valor: efos ? `69-B · ${efos.situacion ?? ''}`.trim() : lista69 ? `${lista69.lista} · ${lista69.situacion ?? ''}`.trim() : 'No aparece',
      estado: efos ? 'falla' : lista69 ? 'aviso' : 'ok', bloquea: !!efos,
      nota: efos ? 'Emisor en la lista 69-B (operaciones simuladas): no pasa sola nunca.' : lista69 ? 'Aparece en la lista 69: aviso, no bloquea.' : null });

    add({ clave: 'F10_moneda', grupo: 'fiscal', etiqueta: 'Moneda', valor: c.moneda, esperado: 'MXN',
      estado: !c.moneda || c.moneda === 'MXN' ? 'ok' : 'falla', bloquea: true,
      nota: c.moneda && c.moneda !== 'MXN' ? `En ${c.moneda}: revisar el tipo de cambio.` : null });
    add({ clave: 'F11_retenciones', grupo: 'fiscal', etiqueta: 'Retenciones', valor: c.total_retenidos == null ? null : fmt(c.total_retenidos),
      esperado: '$0.00 en mercancía', estado: (c.total_retenidos ?? 0) > 0 ? 'falla' : 'ok', bloquea: true,
      nota: (c.total_retenidos ?? 0) > 0 ? 'Una retención no es normal en una compra de mercancía.' : null });
    add({ clave: 'F12_ieps_cuota', grupo: 'fiscal', etiqueta: 'IEPS',
      valor: c.ieps_trasladado == null ? null : `${fmt(c.ieps_trasladado)}${c.ieps_por_cuota ? ' · por cuota' : ''}`,
      estado: c.ieps_por_cuota ? 'aviso' : 'ok', bloquea: false,
      nota: c.ieps_por_cuota ? 'IEPS por cuota: avisar a contabilidad, se acredita (no va al costo).' : null });
  }

  return { cubo: motivosDe(checks).length ? 'revisar' : 'auto', motivos: motivosDe(checks), checks, diferencia, via, notaCredito: nota };
}

/** Los motivos de revisión: las notas de lo que bloquea y no está en `ok`. */
function motivosDe(checks: ExpedienteCheck[]): string[] {
  return checks
    .filter((c) => c.bloquea && c.estado !== 'ok' && c.estado !== 'no_aplica')
    // Un check sin nota ya está explicado por otro (p. ej. el cuadre sin CFDI lo explica I1): no se repite.
    .flatMap((c) => (c.nota ? [c.nota] : []));
}

// ═══════════════════════════════════════ 3. El hallazgo ═══════════════════════════════════════

/**
 * `[RE.35.5]` Qué hacer y con quién (el «Hallazgo» de costo por compra). Una entrada puede tener
 * varios. Se deriva del veredicto y de los ajustes de Kepler ligados a la entrada.
 *
 * ⚠️ «Entrega incompleta» contra «cobrar nota de crédito» no siempre se puede separar: distinguir
 * precio de cantidad pide el detalle por producto del CFDI, que sólo viene en el 17%. Donde Kepler
 * registró una devolución (ajuste operativo, X-D-40) es entrega incompleta; una factura mayor sin
 * devolución ni nota de crédito se trata como «cobrar nota de crédito».
 */
export type Hallazgo = 'cobrar_nc' | 'mal_emitida' | 'incompleta' | 'sin_oc' | 'nc_aplicada' | 'comercial';

export function hallazgosDe(v: Pick<Veredicto, 'cubo' | 'checks' | 'diferencia' | 'via' | 'notaCredito'>, ajustes: { operativo: number; comercial: number }): Hallazgo[] {
  if (v.cubo === 'fuera_de_alcance' || v.cubo === 'sin_documento') return [];
  const falla = (clave: string) => v.checks.some((c) => c.clave === clave && c.estado === 'falla');
  const out: Hallazgo[] = [];
  if (v.checks.some((c) => c.grupo === 'fiscal' && c.bloquea && c.estado === 'falla')) out.push('mal_emitida');
  if (ajustes.operativo !== 0) out.push('incompleta');
  else if (v.via === 'factura' && falla('E1_cuadre') && (v.diferencia ?? 0) > 0 && !v.notaCredito) out.push('cobrar_nc');
  if (falla('E2_oc')) out.push('sin_oc');
  if (v.notaCredito) out.push('nc_aplicada');
  if (ajustes.comercial !== 0) out.push('comercial');
  return out;
}
