/**
 * `[PC.5]`/`[PC.6]` — **Las cuatro coincidencias exactas entre un comprobante de pago y su pago
 * de Kepler: banco · fecha · monto · proveedor.**
 *
 * Vive en `libs/contracts` porque la leen DOS lados con consecuencias distintas:
 *  · la pantalla, para pre-marcar la fila y mostrar las cuatro marcas;
 *  · el servidor, que con las cuatro en verde **valida el comprobante solo** (`[PC.6]`, decisión
 *    del usuario 2026-10-03). Si la regla viviera copiada en cada lado, la pantalla podría decir
 *    «coincide» de algo que el servidor no valida, o al revés.
 *
 * ⛔ **Lo que no se pudo leer NO cuenta como coincidencia** (`sin_dato` ≠ `ok`). Un comprobante sin
 * cuenta de origen legible, o un pago sin banco en Kepler, nunca pasa solo.
 */

export type Chequeo = 'ok' | 'difiere' | 'sin_dato';
export const CRITERIOS_PAGO = ['banco', 'fecha', 'monto', 'proveedor'] as const;
export type CriterioPago = (typeof CRITERIOS_PAGO)[number];
export type CoincidenciasPago = Record<CriterioPago, Chequeo>;

export const ETIQUETA_CRITERIO_PAGO: Record<CriterioPago, string> = {
  banco: 'Banco', fecha: 'Fecha', monto: 'Monto', proveedor: 'Proveedor',
};

/** Lo que se usa de la lectura de la IA. */
export interface LecturaComprobante {
  monto: number | string | null | undefined;
  fecha: string | null | undefined;
  cuenta_origen?: string | null;
  beneficiario?: string | null;
}

/** Lo que se usa del pago de Kepler. */
export interface PagoKepler {
  monto: number | string | null | undefined;
  /** El día del pago `YYYY-MM-DD…`. Mandarlo como TEXTO: un `date` de pg serializado se corre. */
  pago_dia?: string | null;
  pago_date?: string | null;
  proveedor_nombre?: string | null;
  /** Cuenta propia de la que salió el pago, según Kepler (`kdm1.c45` → `kdb1.c1`, p. ej. `1463`). */
  clave_banco?: string | null;
  /** La misma cuenta como la conoce Bancos (`finance.bank_accounts.account_label`). */
  account_label?: string | null;
}

/** El día `YYYY-MM-DD` de una fecha en texto. `null` si no empieza así. */
export function diaDe(s: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s ?? ''));
  return m ? m[1] : null;
}

export function chequeoMonto(ocr: LecturaComprobante['monto'], pago: PagoKepler['monto']): Chequeo {
  if (ocr == null || pago == null || ocr === '' || pago === '') return 'sin_dato';
  const a = Number(ocr);
  const b = Number(pago);
  if (!isFinite(a) || !isFinite(b)) return 'sin_dato';
  // Al centavo: en centavos enteros, para no pelear con el punto flotante.
  return Math.round(a * 100) === Math.round(b * 100) ? 'ok' : 'difiere';
}

export function chequeoFecha(ocr: string | null | undefined, pago: string | null | undefined): Chequeo {
  const a = diaDe(ocr);
  const b = diaDe(pago);
  if (!a || !b) return 'sin_dato';
  return a === b ? 'ok' : 'difiere';
}

/**
 * ¿La cuenta de origen del comprobante es la del pago? Kepler identifica la cuenta por sus últimos
 * dígitos (`1463`); el comprobante trae el número de cuenta, la CLABE o una versión enmascarada.
 *
 * ⚠️ **La CLABE (18 dígitos) termina en un dígito verificador**: la cuenta `1463` aparece como
 * `…01463` + `6`. Si son 18 dígitos, también se compara sin el último.
 */
export function chequeoBanco(cuentaOrigen: string | null | undefined, pago: Pick<PagoKepler, 'clave_banco' | 'account_label'>): Chequeo {
  const digitos = String(cuentaOrigen ?? '').replace(/\D/g, '');
  const colas = [pago.account_label, pago.clave_banco]
    .map((t) => String(t ?? '').replace(/\D/g, ''))
    .filter((t) => t.length >= 3);
  if (!digitos || !colas.length) return 'sin_dato';
  const formas = digitos.length === 18 ? [digitos, digitos.slice(0, 17)] : [digitos];
  return colas.some((t) => formas.some((f) => f.endsWith(t))) ? 'ok' : 'difiere';
}

/** Sufijos societarios y artículos que no distinguen a un proveedor de otro. */
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
 * del otro y el corto tiene al menos 8 letras, cuenta como el mismo. Nada de parecidos difusos.
 */
export function chequeoProveedor(beneficiario: string | null | undefined, proveedor: string | null | undefined): Chequeo {
  const a = normalizarProveedor(beneficiario);
  const b = normalizarProveedor(proveedor);
  if (!a || !b) return 'sin_dato';
  if (a === b) return 'ok';
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 8 && largo.startsWith(corto) ? 'ok' : 'difiere';
}

export function coincidenciasPago(ocr: LecturaComprobante, pago: PagoKepler): CoincidenciasPago {
  return {
    banco: chequeoBanco(ocr.cuenta_origen, pago),
    fecha: chequeoFecha(ocr.fecha, pago.pago_dia ?? pago.pago_date),
    monto: chequeoMonto(ocr.monto, pago.monto),
    proveedor: chequeoProveedor(ocr.beneficiario, pago.proveedor_nombre),
  };
}

export function coincidenTodas(k: CoincidenciasPago | null | undefined): boolean {
  return !!k && CRITERIOS_PAGO.every((c) => k[c] === 'ok');
}

export function puntosCoincidencia(k: CoincidenciasPago): number {
  return CRITERIOS_PAGO.filter((c) => k[c] === 'ok').length;
}

/** Los criterios que NO coinciden (o no se pudieron leer), en orden. */
export function diferenciasPago(k: CoincidenciasPago | null | undefined): CriterioPago[] {
  if (!k) return [...CRITERIOS_PAGO];
  return CRITERIOS_PAGO.filter((c) => k[c] !== 'ok');
}
