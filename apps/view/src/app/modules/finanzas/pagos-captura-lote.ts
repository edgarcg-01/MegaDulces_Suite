/**
 * `[PC.3]`/`[PC.5]` — **Qué tan seguro está el sistema de a qué pago va cada comprobante.**
 *
 * La captura por lote suelta varios PDFs a la vez; la IA lee cada uno y el servidor
 * (`/finance/supplier-payments/match-pago`) devuelve los pagos de Kepler con ese monto (±$1)
 * cerca de esa fecha (±7 días). Encontrar candidatos NO es darlos por buenos: eso lo decide esta
 * regla, con las **cuatro coincidencias exactas** que pidió el usuario (2026-10-03):
 *
 *  · **Banco**     — la cuenta de origen del comprobante es la cuenta de la que Kepler dice que
 *                    salió el pago (`kdm1.c45` ⋈ `kdb1`, vía `analytics.kepler_bank_movements`).
 *  · **Fecha**     — el mismo día.
 *  · **Monto**     — al centavo.
 *  · **Proveedor** — el beneficiario del comprobante es el proveedor del pago.
 *
 * Con eso cada fila queda:
 *  · **listo**    — exactamente UN pago libre en el que coinciden las cuatro. Viene marcado.
 *  · **revisar**  — hay un pago propuesto, pero algo no coincide (o no se pudo leer), o el pago ya
 *                   tiene comprobante. La pantalla marca qué falla; un clic para confirmar.
 *  · **elegir**   — varios pagos posibles y ninguno se distingue. La persona elige.
 *  · **sin_pago** — ninguno, o el OCR no leyó monto. Búsqueda a mano.
 *
 * ⛔ **Nada se guarda sin el clic de «Guardar».** «listo» sólo significa que viene pre-marcado.
 * ⛔ **Lo que no se pudo leer NO cuenta como coincidencia** (`sin_dato` ≠ `ok`): un comprobante
 * sin cuenta de origen legible nunca sale «listo».
 * ⛔ **Un pago que ya tiene comprobante nunca sale «listo»**: puede ser el mismo papel dos veces.
 */

/** Lo único que la regla necesita saber de un pago candidato. */
export interface CandidatoLote {
  sucursal: string;
  doc_prefix: string;
  folio: string;
  monto: number;
  pago_date: string | null;
  /** El día del pago como `YYYY-MM-DD` (el servidor lo manda como texto para que no se corra). */
  pago_dia?: string | null;
  proveedor_nombre: string | null;
  deposits: number;
  /** Cuenta propia de la que salió el pago, según Kepler (`kdb1.c1`, p. ej. `1463`). */
  clave_banco?: string | null;
  /** La misma cuenta como la conoce Bancos (`finance.bank_accounts.account_label`). */
  account_label?: string | null;
  concepto_match?: boolean;
}

/** Lo que la regla usa de la lectura de la IA. */
export interface LecturaOcr {
  monto: number | null | undefined;
  fecha: string | null | undefined;
  cuenta_origen?: string | null;
  beneficiario?: string | null;
}

export type Chequeo = 'ok' | 'difiere' | 'sin_dato';
export interface Coincidencias { banco: Chequeo; fecha: Chequeo; monto: Chequeo; proveedor: Chequeo }
export const CRITERIOS = ['banco', 'fecha', 'monto', 'proveedor'] as const;

export type Confianza = 'listo' | 'revisar' | 'elegir' | 'sin_pago';

export type MotivoConfianza =
  | 'cuatro_coinciden'
  | 'no_coincide_todo'
  | 'ya_tiene_comprobante'
  | 'varios_pagos'
  | 'sin_monto'
  | 'sin_candidatos';

export interface Clasificacion<C extends CandidatoLote = CandidatoLote> {
  confianza: Confianza;
  /** El pago propuesto; `null` en «elegir» y «sin_pago». */
  propuesto: C | null;
  motivo: MotivoConfianza;
}

/** Llave de un pago: el folio NO es único entre doctypes (transferencia/cheque/anticipo). */
export function llavePago(c: Pick<CandidatoLote, 'sucursal' | 'doc_prefix' | 'folio'>): string {
  return `${c.doc_prefix} ${c.sucursal}/${c.folio}`;
}

/** Días entre dos fechas `YYYY-MM-DD…` (ignora la hora). `null` si alguna no se puede leer. */
export function diasEntre(a: string | null | undefined, b: string | null | undefined): number | null {
  const da = soloFecha(a);
  const db = soloFecha(b);
  if (da == null || db == null) return null;
  return Math.round(Math.abs(da - db) / 86_400_000);
}

function soloFecha(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ── las cuatro comparaciones ────────────────────────────────────────────────

export function chequeoMonto(ocr: number | null | undefined, pago: number | null | undefined): Chequeo {
  if (ocr == null || pago == null || !isFinite(Number(ocr)) || !isFinite(Number(pago))) return 'sin_dato';
  // Al centavo: se compara en centavos enteros para no pelear con el punto flotante.
  return Math.round(Number(ocr) * 100) === Math.round(Number(pago) * 100) ? 'ok' : 'difiere';
}

export function chequeoFecha(ocr: string | null | undefined, pago: string | null | undefined): Chequeo {
  const d = diasEntre(ocr, pago);
  if (d == null) return 'sin_dato';
  return d === 0 ? 'ok' : 'difiere';
}

/**
 * ¿La cuenta de origen del comprobante es la del pago? Kepler identifica la cuenta por sus últimos
 * dígitos (`1463`); el comprobante trae el número de cuenta, la CLABE o una versión enmascarada
 * (`****1463`).
 *
 * ⚠️ **La CLABE (18 dígitos) termina en un dígito verificador**: la cuenta `1463` aparece como
 * `…01463` + `6`. Por eso, si son 18 dígitos, también se compara sin el último.
 */
export function chequeoBanco(cuentaOrigen: string | null | undefined, c: Pick<CandidatoLote, 'clave_banco' | 'account_label'>): Chequeo {
  const digitos = String(cuentaOrigen ?? '').replace(/\D/g, '');
  const colas = [c.account_label, c.clave_banco]
    .map((t) => String(t ?? '').replace(/\D/g, ''))
    .filter((t) => t.length >= 3);
  if (!digitos || !colas.length) return 'sin_dato';
  const formas = digitos.length === 18 ? [digitos, digitos.slice(0, 17)] : [digitos];
  return colas.some((t) => formas.some((f) => f.endsWith(t))) ? 'ok' : 'difiere';
}

/** Sufijos societarios que no distinguen a un proveedor de otro. */
const SUFIJOS = new Set(['SA', 'DE', 'CV', 'S', 'RL', 'SAPI', 'SAB', 'SC', 'AC', 'SPR', 'MI', 'SAS', 'Y', 'LA', 'EL']);

/** Nombre comparable: sin acentos, sin puntuación, sin sufijos societarios, en mayúsculas. */
export function normalizarProveedor(v: string | null | undefined): string {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    // El punto se QUITA (no se vuelve espacio): `S.A. DE C.V.` → `SA DE CV`, no `S A DE C V`.
    .replace(/\./g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !SUFIJOS.has(t))
    .join(' ');
}

/**
 * ¿El beneficiario del comprobante es el proveedor del pago? Igualdad del nombre normalizado.
 *
 * ⚠️ Única tolerancia: el SPEI **trunca** el beneficiario (~40 caracteres). Si uno es el principio
 * del otro y el corto tiene al menos 8 letras, cuenta como el mismo. No hay parecidos «difusos»:
 * `DULCES DE LA ROSA` y `DULCES LA ROSITA` difieren.
 */
export function chequeoProveedor(beneficiario: string | null | undefined, proveedor: string | null | undefined): Chequeo {
  const a = normalizarProveedor(beneficiario);
  const b = normalizarProveedor(proveedor);
  if (!a || !b) return 'sin_dato';
  if (a === b) return 'ok';
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 8 && largo.startsWith(corto) ? 'ok' : 'difiere';
}

export function coincidencias(ocr: LecturaOcr, c: CandidatoLote): Coincidencias {
  return {
    banco: chequeoBanco(ocr.cuenta_origen, c),
    fecha: chequeoFecha(ocr.fecha, c.pago_dia ?? c.pago_date),
    monto: chequeoMonto(ocr.monto, c.monto),
    proveedor: chequeoProveedor(ocr.beneficiario, c.proveedor_nombre),
  };
}

const perfecto = (k: Coincidencias) => CRITERIOS.every((x) => k[x] === 'ok');
const puntos = (k: Coincidencias) => CRITERIOS.filter((x) => k[x] === 'ok').length;

// ── la decisión ─────────────────────────────────────────────────────────────

export function clasificar<C extends CandidatoLote>(ocr: LecturaOcr, candidatos: readonly C[]): Clasificacion<C> {
  if (ocr.monto == null || !isFinite(Number(ocr.monto)) || Number(ocr.monto) <= 0) {
    return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_monto' };
  }
  if (!candidatos.length) return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_candidatos' };

  const libres = candidatos.filter((c) => !(c.deposits > 0));
  const conPuntos = libres.map((c) => ({ c, k: coincidencias(ocr, c) }));

  const perfectos = conPuntos.filter((x) => perfecto(x.k));
  if (perfectos.length === 1) return { confianza: 'listo', propuesto: perfectos[0].c, motivo: 'cuatro_coinciden' };
  if (perfectos.length > 1) return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };

  if (conPuntos.length === 1) return { confianza: 'revisar', propuesto: conPuntos[0].c, motivo: 'no_coincide_todo' };
  if (conPuntos.length > 1) {
    // Se propone el que más coincide, sólo si se distingue de los demás. Si empatan, elige la persona.
    const orden = [...conPuntos].sort((a, b) => puntos(b.k) - puntos(a.k));
    if (puntos(orden[0].k) > puntos(orden[1].k)) return { confianza: 'revisar', propuesto: orden[0].c, motivo: 'no_coincide_todo' };
    return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
  }

  // Todos los candidatos ya tienen comprobante.
  if (candidatos.length === 1) return { confianza: 'revisar', propuesto: candidatos[0], motivo: 'ya_tiene_comprobante' };
  return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
}

/** Texto corto que explica a la persona POR QUÉ la fila quedó como quedó. */
export function textoMotivo(m: MotivoConfianza): string {
  switch (m) {
    case 'cuatro_coinciden': return 'Coinciden banco, fecha, monto y proveedor';
    case 'no_coincide_todo': return 'No coincide todo — revisa lo marcado';
    case 'ya_tiene_comprobante': return 'Ese pago ya tiene comprobante — confirma';
    case 'varios_pagos': return 'Varios pagos posibles — elige';
    case 'sin_monto': return 'No se leyó el monto';
    case 'sin_candidatos': return 'Ningún pago de Kepler con ese monto cerca de esa fecha';
  }
}

export const ETIQUETA_CRITERIO: Record<(typeof CRITERIOS)[number], string> = {
  banco: 'Banco', fecha: 'Fecha', monto: 'Monto', proveedor: 'Proveedor',
};

/**
 * Pagos a los que apunta MÁS DE UNA fila del lote. Si dos comprobantes del mismo lote van al
 * mismo pago, ninguno de los dos puede guardarse sin que la persona lo resuelva.
 */
export function pagosRepetidos(llaves: readonly (string | null)[]): Set<string> {
  const vistos = new Set<string>();
  const rep = new Set<string>();
  for (const k of llaves) {
    if (!k) continue;
    if (vistos.has(k)) rep.add(k);
    else vistos.add(k);
  }
  return rep;
}
