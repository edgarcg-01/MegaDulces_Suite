import { rfcCompatible } from './solicitud-gasto.contract';

/**
 * `[PGP.123]` G.5 — **Cuándo la Suite comprueba un gasto en Kepler (escribe su X-A-10), o por qué no.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md` §5.1. Una sola regla, pura, para los
 * tres que la necesitan: la lista «por comprobar» (lee la X-A-15 del ODS), el escritor (la re-lee en el Kepler vivo
 * dentro de su transacción) y la pantalla (dice el motivo y a quién le toca).
 *
 * ⭐ Comprobar es pasar de la etapa `autorizado` a `ejercido` (GX.39): el vale está `validada` —el expediente de la
 * Suite ya cerró— y su X-A-15 está autorizada (`A`) en Kepler sin gasto. En Kepler el X-A-10 es copia de su
 * solicitud en el 97.9 %: lo que la persona decide es la fecha (DG1) y, si hay factura, que case.
 *
 * ⛔ Lo que no se pudo leer se declara (`sin_medir`, ADR-056): nunca se escribe un gasto a ciegas.
 */

/** Lo que el vale aporta (`finance.expense_proofs`). */
export interface ValeAComprobar {
  /** `status`: sólo `validada` comprueba. */
  status: string;
  sucursal: string | null;
  folio_solicitud: string | null;
  /** El importe del vale. */
  total: number | null;
  /** El CFDI recibido ligado al vale (`cfdi_uuid` → `fiscal.cfdis`), si lo trae. */
  cfdi?: { uuid: string; total: number; emisor_rfc: string; retenciones: number } | null;
  /**
   * El vale trae `cfdi_uuid`. Si es `true` y `cfdi` no llegó, la factura NO se pudo leer (o todavía no está en la
   * Suite): no se sabe si casa con la solicitud. ⛔ Nunca se trata como «no trae factura»: así se escribía un gasto a
   * ciegas (revisión independiente, 2026-11-17).
   */
  cfdi_declarado?: boolean;
  /**
   * `[PGP.123]` DG12 — Lo que la lectura del comprobante dijo cuando NO cuadró con el vale (`monto_ocr`, o el monto
   * del aviso en `revision_nota`: ver `montoLeidoDelVale`). `null` = no hubo lectura o cuadró.
   */
  monto_leido?: number | null;
}

/** La X-A-15 como la ve Kepler: el ODS para la lista, el Kepler vivo al escribir. */
export interface SolicitudAComprobar {
  /** `c43`. */
  estado: string;
  /** `c16`. */
  total: number;
  /** `c42`. */
  saldo: number;
  /** `c15`. */
  retencion: number;
  /** `c9`, `YYYY-MM-DD`. */
  fecha: string;
  /** `kdxd.c10` del acreedor, para casar el RFC de la factura. */
  acreedor_rfc?: string | null;
  /** ¿Hay un X-A-10 vivo que la apunte (`c39`)? */
  gasto_vivo: boolean;
}

export type MotivoSinComprobar =
  | 'rechazado'
  | 'sin_cerrar'
  | 'sin_solicitud'
  | 'sin_medir'
  | 'ya_comprobado'
  | 'cancelada'
  | 'sin_autorizar'
  | 'saldo_parcial'
  | 'retencion'
  | 'total_distinto'
  | 'factura_distinta'
  | 'lectura_distinta'
  | 'fecha_futura'
  | 'fecha_otro_mes';

/**
 * A quién le toca: `nadie` (no hay nada que hacer), la Suite, **la sucursal** (comprueba el gasto en Kepler: el «Alta
 * gasto CFDI»), **Finanzas** (autoriza la solicitud en Kepler) o Contabilidad.
 *
 * ⭐ El proceso, dicho por Francisco el 2026-11-17 (anexo G §14.9): la sucursal pide el gasto → Finanzas lo autoriza →
 * **la sucursal (o quien lo pidió) hace la comprobación** → Finanzas programa el pago en el Calendario → Tesorería
 * aprueba el programa → Caja General lo ejecuta → el analista de egresos registra el pago y guarda su evidencia. Antes
 * esto decía `kepler` = «Finanzas, en Kepler» para todo lo que se hace a mano allá, y mandaba a Finanzas lo que es de
 * la sucursal.
 */
export type QuienResuelve = 'nadie' | 'suite' | 'sucursal' | 'finanzas' | 'contabilidad';

export type Comprobacion =
  | { listo: true; fecha: string }
  | { listo: false; motivo: MotivoSinComprobar; texto: string; quien: QuienResuelve };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const cent = (n: unknown): number => Math.round(Number(n) * 100);
const pesos = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const no = (motivo: MotivoSinComprobar, quien: QuienResuelve, texto: string): Comprobacion => ({ listo: false, motivo, texto, quien });

/**
 * ¿Se puede comprobar ya este vale? `hoy` es la fecha de México (`YYYY-MM-DD`). El primer motivo gana, en el orden
 * en que una persona lo arreglaría. `listo` trae la fecha del gasto: la de la solicitud (DG1), siempre del mes en curso.
 */
export function comprobacionDelVale(v: ValeAComprobar, s: SolicitudAComprobar | null | undefined, hoy: string): Comprobacion {
  if (v.status === 'rechazada') return no('rechazado', 'nadie', 'El vale se rechazó en la Suite: no se comprueba');
  if (v.status !== 'validada') return no('sin_cerrar', 'suite', 'El vale todavía no se valida en la Suite');
  if (!String(v.sucursal ?? '').trim() || !String(v.folio_solicitud ?? '').trim()) {
    return no('sin_solicitud', 'suite', 'El vale no está ligado a una solicitud de Kepler (sucursal y folio)');
  }
  if (!s) return no('sin_medir', 'nadie', 'No se pudo leer la solicitud en Kepler: no se sabe si se puede comprobar');

  if (s.gasto_vivo) return no('ya_comprobado', 'nadie', 'Ya tiene su gasto en Kepler');
  if (s.estado === 'C') return no('cancelada', 'finanzas', 'La solicitud está cancelada en Kepler');
  if (s.estado === 'F') return no('ya_comprobado', 'nadie', 'La solicitud ya está aplicada en Kepler (F)');
  if (s.estado !== 'A') return no('sin_autorizar', 'finanzas', 'Falta que autoricen la solicitud en Kepler');
  if (cent(s.saldo) !== cent(s.total)) {
    return no('saldo_parcial', 'sucursal', `La solicitud ya usó parte de su saldo (le quedan ${pesos(cent(s.saldo))} de ${pesos(cent(s.total))}): se comprueba en Kepler`);
  }
  if (cent(s.retencion) !== 0) return no('retencion', 'contabilidad', 'La solicitud trae retención: se comprueba en Kepler');
  if (cent(v.total) !== cent(s.total)) {
    return no('total_distinto', 'sucursal', `El vale es por ${pesos(cent(v.total))} y la solicitud por ${pesos(cent(s.total))}: se comprueba en Kepler`);
  }
  if (v.cfdi_declarado && !v.cfdi) {
    return no('sin_medir', 'nadie', 'El vale trae factura y la Suite no la pudo leer: no se sabe si casa con la solicitud');
  }
  if (v.cfdi) {
    if (cent(v.cfdi.retenciones) > 0) return no('retencion', 'contabilidad', 'La factura trae retenciones: se comprueba en Kepler');
    if (cent(v.cfdi.total) !== cent(s.total)) {
      return no('factura_distinta', 'sucursal', `La factura es por ${pesos(cent(v.cfdi.total))} y la solicitud por ${pesos(cent(s.total))}`);
    }
    if (!rfcCompatible(s.acreedor_rfc, v.cfdi.emisor_rfc)) {
      return no('factura_distinta', 'sucursal', `La factura es de otro RFC (${v.cfdi.emisor_rfc}) que el del acreedor en Kepler`);
    }
  }
  // DG12 (Edgar, 2026-11-20): si la lectura del comprobante dijo otro monto, una persona compara antes; la Suite no lo
  // escribe por el monto de la solicitud. Misma tolerancia que el lector ($1 o 1 %, redondeo e IVA).
  const leido = v.monto_leido == null ? null : Number(v.monto_leido);
  if (leido != null && Number.isFinite(leido) && Math.abs(leido - Number(s.total)) > Math.max(1, Math.abs(Number(s.total)) * 0.01)) {
    return no('lectura_distinta', 'sucursal', `La lectura del comprobante dice ${pesos(cent(leido))} y la solicitud ${pesos(cent(s.total))}: compáralo y compruébalo en Kepler`);
  }
  if (!FECHA.test(s.fecha ?? '') || !FECHA.test(hoy ?? '')) return no('sin_medir', 'nadie', 'La fecha de la solicitud no se pudo leer');
  if (s.fecha > hoy) return no('fecha_futura', 'sucursal', `La solicitud tiene fecha futura (${s.fecha})`);
  if (s.fecha.slice(0, 7) !== hoy.slice(0, 7)) {
    const mes = MESES[Number(s.fecha.slice(5, 7)) - 1] ?? s.fecha.slice(0, 7);
    return no('fecha_otro_mes', 'contabilidad', `La solicitud es de ${mes}: la póliza caería en un mes anterior, se comprueba en Kepler`);
  }
  return { listo: true, fecha: s.fecha };
}

/**
 * `[PGP.123]` **El total del vale para la regla G.5.** Al casar una captura de campo con su solicitud (GX.9), `importe`
 * pasa a ser el total de Kepler y lo que declaró la persona queda en `capture_meta.importe_declarado`: comparar
 * `importe` contra la solicitud SIEMPRE daba igual. Si lo declarado difiere, manda lo declarado (§5.1-3: un gasto
 * distinto se queda en Kepler). Revisión independiente, 2026-11-17; en prod ese día: 0 vales validados así.
 */
export function totalParaComprobar(importe: unknown, captureMeta: unknown): number | null {
  const base = importe == null || importe === '' || !Number.isFinite(Number(importe)) ? null : Number(importe);
  let meta: Record<string, unknown> = {};
  try {
    meta = (typeof captureMeta === 'string' ? JSON.parse(captureMeta || '{}') : captureMeta ?? {}) as Record<string, unknown>;
  } catch { meta = {}; }
  const d = meta && typeof meta === 'object' ? meta['importe_declarado'] : undefined;
  const declarado = d == null || d === '' || !Number.isFinite(Number(d)) ? null : Number(d);
  if (declarado != null && (base == null || Math.round(declarado * 100) !== Math.round(base * 100))) return declarado;
  return base;
}

/**
 * `[PGP.123]` DG12 — **El monto que leyó el comprobante, cuando no cuadró.** El lector (GX.33) deja su aviso en
 * `revision_nota` («⚠ El comprobante dice $6,032.48 y la solicitud $150.81 …») y, desde DG12, también el monto en
 * `monto_ocr`. Manda `monto_ocr`; si no está (vales anteriores), se toma del aviso. ⛔ Validar desde la revisión borra
 * `revision_nota`: lo que se validó así antes de DG12 perdió su aviso y no se puede recuperar.
 */
export function montoLeidoDelVale(montoOcr: unknown, revisionNota: unknown): number | null {
  if (montoOcr != null && montoOcr !== '' && Number.isFinite(Number(montoOcr))) return Number(montoOcr);
  return montoDelAviso(revisionNota);
}

/** El monto de «El comprobante dice $X» en el aviso del lector, o `null`. */
export function montoDelAviso(texto: unknown): number | null {
  const m = /El comprobante dice \$(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(String(texto ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * `[PGP.123]` G.8 — Cómo va la escritura del gasto (X-A-10) de un vale: lo que guarda la Suite en
 * `finance.expense_proofs.kepler_expense_*` y devuelve la API al validar, al reintentar y en la cola.
 * `status`: `pending` · `writing` · `written` · `seen_in_ods` · `retry` · `stuck` · `rejected_by_kepler` · `in_doubt` ·
 * `cancelled` (Kepler canceló el gasto); `null` = la Suite todavía no lo ha intentado.
 */
export interface EstadoKeplerDelGasto {
  id: string;
  status: string | null;
  /** El folio del X-A-10 (7 dígitos), de la Suite o de quien lo capturó en Kepler. */
  folio: string | null;
  /** `kdc2AAMM/D/<n>`: la póliza que escribió la Suite. */
  poliza: string | null;
  /** `c9` del gasto (DG1), `YYYY-MM-DD`. */
  fecha: string | null;
  nota: string | null;
  intentos: number;
  siguiente: string | null;
}

/** A quién le toca, en llano (la cola y el panel lo dicen al lado del motivo). */
export const QUIEN_RESUELVE_TEXTO: Readonly<Record<QuienResuelve, string>> = {
  nadie: 'nadie', suite: 'la Suite', sucursal: 'la sucursal, en Kepler', finanzas: 'Finanzas, en Kepler', contabilidad: 'Contabilidad',
};

/**
 * `[PGP.123]` G.9 — ¿La Suite escribe HOY el gasto en esa base? `motivo` en llano para la pantalla; `detalle` para
 * Sistemas (qué candado está cerrado: el escritor, la bandera, DG7, el interruptor o la conexión).
 */
export interface EscrituraDelGastoEnLaBase {
  abierta: boolean;
  motivo: string | null;
  detalle: string | null;
}

/**
 * `[PGP.123]` G.9 — Lo que «Esperan a Kepler» dice del gasto de un vale validado que no lo tiene (anexo G §14):
 * la regla G.5 (se comprueba solo, o el motivo y a quién le toca), cómo va el X-A-10 que escribe la Suite, y si en esa
 * base la escritura está abierta. Lo calcula el servidor en lote; la pantalla sólo lo pinta.
 */
export interface ComprobacionEnLaCola {
  comprobacion: Comprobacion;
  /** `null` = la Suite todavía no lo ha intentado. */
  gasto: EstadoKeplerDelGasto | null;
  escritura: EscrituraDelGastoEnLaBase;
}
