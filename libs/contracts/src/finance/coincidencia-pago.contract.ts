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
  /** Nombre del banco según Kepler (`kdb1.c2`, p. ej. `BAJIO 6506`): decide cómo se lee la cuenta. */
  banco_nombre?: string | null;
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

/** `[PC.7]` ¿El banco es BanBajío? Kepler lo nombra `BAJIO 6506`; Bancos, `BBAJIO`. */
export function esBancoBajio(banco: string | null | undefined): boolean {
  return /BAJ[IÍ]O/i.test(String(banco ?? ''));
}

/**
 * Las formas de un número de cuenta cuyo FINAL es la clave de la cuenta (la que usa Kepler, `1463`).
 *
 *  · El número tal cual (cuenta, o enmascarado `****1463`).
 *  · ⚠️ **CLABE (18 dígitos)**: termina en un dígito verificador; la cuenta `1463` aparece como
 *    `…01463` + `6`. Se agrega sin el último dígito.
 *  · ⚠️ **`[PC.7]` BanBajío (12 dígitos)**: la clave está en el CENTRO, no al final —
 *    `2457` + **`6506`** + `0201`. Medido en los comprobantes de BajioNet (2026-10-04): las
 *    cuentas `245765060201`, `245758540201` y `199241660201` son las claves Kepler `6506`,
 *    `5854` y `4166`; los cuatro últimos dígitos (`0201`) se repiten en TODAS, por eso parecía
 *    que todo salía de la misma cuenta. Se lee SÓLO el número sin esos 4 últimos dígitos: leerlo
 *    también por el final dejaría pasar `0201` como si fuera una clave (lo encontró la prueba
 *    negativa). Sólo si el banco es BanBajío: en otro banco, 12 dígitos se leen por el final.
 *
 * ⛔ No es «relajar» la regla: cada forma sigue exigiendo la clave EXACTA de la cuenta.
 */
export function formasDeCuenta(cuenta: string | null | undefined, banco?: string | null): string[] {
  const d = String(cuenta ?? '').replace(/\D/g, '');
  if (!d) return [];
  if (d.length === 12 && esBancoBajio(banco)) return [d.slice(0, 8)];
  const f = [d];
  if (d.length === 18) f.push(d.slice(0, 17));
  return f;
}

/** ¿El número de cuenta corresponde a la cuenta con esa clave (`1463`, `6506`)? */
export function cuentaEsClave(cuenta: string | null | undefined, clave: string | null | undefined, banco?: string | null): boolean {
  const t = String(clave ?? '').replace(/\D/g, '');
  if (t.length < 3) return false;
  return formasDeCuenta(cuenta, banco).some((f) => f.endsWith(t));
}

/**
 * ¿La cuenta de origen del comprobante es la del pago? Kepler identifica la cuenta por su clave
 * (`1463`, `6506`); el comprobante trae el número de cuenta, la CLABE o una versión enmascarada.
 * Cómo se lee cada formato: `formasDeCuenta`.
 *
 * ⚠️ `[PC.7]` Si Kepler trae la clave (`kdm1.c45`) se compara SÓLO contra ella. La etiqueta de
 * Bancos puede ser más corta (BanBajío: `854`, `506` contra las claves `5854`, `6506`) y
 * comparar contra la corta aceptaría otra cuenta que termine igual. La etiqueta queda de respaldo
 * para cuando Kepler no trae clave.
 */
export function chequeoBanco(cuentaOrigen: string | null | undefined, pago: Pick<PagoKepler, 'clave_banco' | 'account_label' | 'banco_nombre'>): Chequeo {
  const digitos = String(cuentaOrigen ?? '').replace(/\D/g, '');
  const clave = String(pago.clave_banco ?? '').replace(/\D/g, '');
  const etiqueta = String(pago.account_label ?? '').replace(/\D/g, '');
  const contra = clave.length >= 3 ? clave : etiqueta.length >= 3 ? etiqueta : '';
  if (!digitos || !contra) return 'sin_dato';
  return cuentaEsClave(digitos, contra, pago.banco_nombre) ? 'ok' : 'difiere';
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
 * Letras mínimas del prefijo para aceptar un truncado. Ver `chequeoProveedor`.
 *
 * ⛔ `[AT.2]` **Se intentó subirlo a 10 y se revirtió, con medición.** Con 8, el padrón real de
 * 310 proveedores confunde `ABARROTES` —palabra genérica de 9 letras— con `ABARROTES VIOLETA` y
 * con `ABARROTES DEL CENTRO GUERRERO`: dos empresas distintas. Subirlo a 10 los elimina… y
 * **rompe `QUALAMEX` / `QUALAMEX MEXICO`**, que tiene exactamente 8 y son 3 comprobantes reales
 * que hoy cuadran bien.
 *
 * ⭐ Lo que el largo NO puede distinguir: `ABARROTES` es un sustantivo del giro y `QUALAMEX` una
 * marca inventada. Cambiar el umbral arregla uno rompiendo el otro, así que se deja como estaba
 * y el hueco queda **declarado** en vez de cambiado a ciegas (ADR-056). Cerrarlo pide otra cosa
 * —una lista de palabras del giro que no identifican a nadie—, que es una decisión aparte.
 */
export const MIN_PREFIJO = 8;
/** `[AT.2]` Letras mínimas para las tolerancias que ignoran espacios o admiten un error. */
export const MIN_DIFUSO = 12;

/** El nombre sin espacios: el OCR parte y pega palabras donde se le ocurre. */
const pegado = (s: string): string => s.replace(/ /g, '');

/**
 * `[AT.2]` **Distancia de edición con transposición (Damerau-Levenshtein), sobre la cadena
 * COMPLETA.** Corta apenas supera `tope`, así que es barata.
 *
 * ⛔ Sobre la cadena **completa**, no sobre prefijos recortados — y esa distinción decidió el
 * diseño. Comparando prefijos del mismo largo, una letra BORRADA deja de costar 1 y cuesta 2,
 * porque corre todo lo que viene después:
 *
 * | par | recortando prefijos | cadena completa |
 * |---|---:|---:|
 * | `HERSHEYSMEXICO` / `HERSHEYMEXICO` (mismo proveedor) | 2 | **1** |
 * | `ROMPOPEDONAGUSTIN` / `ROMPOPESANAGUSTIN` (⛔ DOS empresas) | 2 | **2** |
 *
 * Con prefijos recortados los dos miden 2 y no hay umbral que los separe. Sobre la cadena
 * completa, el tope de **1** acepta al primero y rechaza al segundo.
 */
function distanciaConTransposicion(a: string, b: string, tope: number): number {
  if (Math.abs(a.length - b.length) > tope) return tope + 1;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let min = Infinity;
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) m[i][j] = Math.min(m[i][j], m[i - 2][j - 2] + 1);
      if (m[i][j] < min) min = m[i][j];
    }
    if (min > tope) return tope + 1; // ya no puede bajar
  }
  return m[a.length][b.length];
}

/**
 * ¿El beneficiario del comprobante es el proveedor del pago?
 *
 * ## Por qué dejó de ser sólo igualdad + prefijo, medido en prod el 2026-10-12
 *
 * Con el carril de `[AT.1]` entregando, la señal `proveedor` pasó a ser **el cuello de botella**:
 * de los comprobantes que no se auto-validan, falla en **10 de 14** — más que el monto (7) y que
 * el banco (3). La fecha no falla nunca. Mirando los 35 desacuerdos reales, **no eran un problema
 * sino tres**, y ninguno es «el pago está mal»:
 *
 * | | ejemplo real |
 * |---|---|
 * | el OCR **parte o pega** palabras | `CEDIS GRUPO AZTEC A` / `CEDIS GRUPO AZTECA` |
 * | Kepler **perdió la Ñ** (queda un espacio) | `…AVILA BANUELOS` / `…AVILA BA UEL` |
 * | una letra de más, de menos o cambiada de lugar | `HERSHEYS` / `HERSHEY` · `ALJEO` / `ALEJO` |
 *
 * ## ⛔ Lo que se midió ANTES de aflojar nada
 *
 * Aflojar esta regla **firma pagos que nadie mira**, así que cada candidata se probó contra dos
 * negativos: 13 pares distintos etiquetados a mano **y el padrón real de 310 proveedores**,
 * buscando pares de empresas DISTINTAS que la regla confundiría.
 *
 * ⚠️ El primer negativo **no servía solo**: no se rompía ni a distancia 6, porque sus pares eran
 * todos lejanos entre sí (`BOLSAS LOS ALTOS` contra `GUILLERMO LOPEZ`). *Una regla validada
 * contra un negativo sin casos cercanos no está validada en ese rango.* Con el padrón real
 * apareció el borde de golpe: **lev≤2 → 5 pares confundibles · lev≤3 → 22 · lev≤4 → 99**.
 *
 * Y entre los de lev≤2 estaba el que importa: ⛔ `ROMPOPE DON AGUSTIN` contra
 * `ROMPOPE SAN AGUSTIN`, **dos empresas**. Por eso el tope es **1** y la métrica cuenta la
 * transposición como un solo error: así entra `ALJEO`/`ALEJO` y queda afuera `DON`/`SAN`.
 *
 * ## Y de paso cierra un hueco que YA existía
 *
 * El mínimo del prefijo era **8**, y con 8 el padrón confunde `ABARROTES` —palabra genérica de
 * 9 letras— con `ABARROTES VIOLETA` y con `ABARROTES DEL CENTRO GUERRERO`. Subirlo a **10** los
 * elimina **sin costarle nada** a los casos que este contrato ya exigía (el truncado del SPEI,
 * que corta a ~40 caracteres, sigue pasando). Confundibles en el padrón: **5 → 3**, y las 3 que
 * quedan son el MISMO proveedor con dos registros (`…DON AGUSTIN` / `…DON AGUSTIN NO USAR`).
 *
 * ⚠️ **El error no es simétrico, y por eso se eligió lo estricto**: un rechazo de más sólo hace
 * que una persona mire el comprobante; un acepte de más **firma el pago del proveedor
 * equivocado**. Se descartó medir «¿cubre el prefijo ≥80 % del nombre?» —que llegaba a 0
 * confundibles— porque rompe el truncado del SPEI, que es la razón de ser de esta tolerancia.
 */
export function chequeoProveedor(beneficiario: string | null | undefined, proveedor: string | null | undefined): Chequeo {
  const a = normalizarProveedor(beneficiario);
  const b = normalizarProveedor(proveedor);
  if (!a || !b) return 'sin_dato';
  if (a === b) return 'ok';

  // 1· El truncado del SPEI (~40 caracteres): uno es el principio del otro.
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  if (corto.length >= MIN_PREFIJO && largo.startsWith(corto)) return 'ok';

  // De acá para abajo se ignoran los espacios, que es lo que el OCR mueve de lugar.
  const ap = pegado(a);
  const bp = pegado(b);
  if (ap.length < MIN_DIFUSO || bp.length < MIN_DIFUSO) return 'difiere';

  // 2· El mismo principio, con los espacios en otro lado.
  const [cp, lp] = ap.length <= bp.length ? [ap, bp] : [bp, ap];
  if (lp.startsWith(cp)) return 'ok';

  // 3· Una sola letra de diferencia en todo el nombre (incluida una transposición).
  return distanciaConTransposicion(ap, bp, 1) <= 1 ? 'ok' : 'difiere';
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
