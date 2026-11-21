import { importeConLetra } from './importe-con-letra';

/**
 * `[PGP.165]` **El cheque impreso: dónde va cada dato, en milímetros, y cómo se escribe.**
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 * Hoy el cheque se llena a mano y el importe se saca con calculadora: 3 de 14 cheques cobrados en noviembre llevaban
 * un importe distinto al del Calendario, y un cheque cuya letra no coincide con el número lo devuelve el banco. La
 * Suite imprime el cheque con el importe del pago, al centavo, y su letra (`importeConLetra`).
 *
 * ── El papel (anexo CH, DCH1) ───────────────────────────────────────────────────────────────
 * Chequera de libro, 3 cheques por hoja; se desprende la hoja y después el cheque, que entra **suelto y centrado** en
 * la impresora. Las medidas salen de las fotos con regla que mandó Francisco (2026-11-20): **≈ 160 × 70 mm**. Las
 * posiciones son una medición de foto (±1–3 mm), no una calibración: por eso cada plantilla dice `calibrada: false`
 * hasta que una **hoja de prueba** impresa y puesta sobre un cheque real la confirme, y el desplazamiento de cada
 * impresora (`dx`, `dy`) se corrige aparte.
 *
 * Sólo BanBajío: es la cuenta de TODOS los cheques del Calendario (39 de 39 con número, `BB 4166`, medido 2026-11-20).
 * Santander 2169 (nómina y gasto) entra con el cheque suelto, `[PGP.172]`.
 */

/** Un renglón del cheque donde la Suite escribe. Medidas en mm desde la esquina de arriba a la izquierda del cheque. */
export interface ZonaCheque {
  /** Borde izquierdo del espacio para escribir. */
  x: number;
  /** Ancho del espacio para escribir: el texto nunca pasa de aquí (se achica, se parte o se comprime; nunca se corta). */
  ancho: number;
  /** Línea base del texto (donde se apoyan las letras), desde el borde de arriba. Con dos renglones, la del segundo. */
  base: number;
  /** Tamaño de letra (alto del cuerpo, en mm) con el que se intenta primero, y el mínimo antes de partir o comprimir. */
  letraMax: number;
  letraMin: number;
  alinear: 'izquierda' | 'centro' | 'derecha';
  /** La cantidad con letra puede ir en dos renglones; lo demás, en uno. */
  renglones: 1 | 2;
  /** De base a base cuando va en dos renglones. */
  interlinea: number;
  /** Tamaño con el que se intenta cuando va en dos renglones (más chico: el de arriba no debe pisar el rótulo impreso). */
  letraDosRenglones: number;
}

/** Proporciones de la letra mayúscula de una sans (Arial y sus parientes): cuánto sube y cuánto baja de la base. */
export const ALTO_MAYUSCULA = 0.74;
export const BAJA_DE_LA_BASE = 0.22;

/**
 * La caja que ocupa lo escrito en una zona, en mm (`y` arriba, `y2` abajo), para comprobar que no pisa nada: con dos
 * renglones, desde el de arriba hasta el de abajo. Es la regla que usan las pruebas; la impresión la respeta porque
 * nunca escribe más ancho que `ancho` ni más grande que `letraMax` (o `letraDosRenglones`).
 */
export function cajaDeZona(z: ZonaCheque, dosRenglones = false): { x: number; x2: number; y: number; y2: number } {
  const letra = dosRenglones ? z.letraDosRenglones : z.letraMax;
  const arriba = dosRenglones ? z.base - z.interlinea : z.base;
  return { x: z.x, x2: z.x + z.ancho, y: arriba - letra * ALTO_MAYUSCULA, y2: z.base + letra * BAJA_DE_LA_BASE };
}

/** Lo que el banco ya imprimió y la Suite NUNCA tapa: la banda magnética, la firma, el titular, el logo. */
export interface ZonaReservada {
  nombre: string;
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

/** Una línea impresa de fábrica (para la hoja de prueba y para comprobar que cada dato cae sobre su línea). */
export interface GuiaCheque {
  nombre: 'fecha' | 'beneficiario' | 'letra' | 'firma';
  x1: number;
  x2: number;
  y: number;
}

export type ClavePlantillaCheque = 'bajio-conecta';

export interface PlantillaCheque {
  clave: ClavePlantillaCheque;
  /** `finance.bank_accounts.bank` de las cuentas que usan este papel. */
  banco: string;
  nombre: string;
  anchoMm: number;
  altoMm: number;
  /** De dónde salen las medidas; se dice en la hoja de prueba. */
  medicion: string;
  /** `false` mientras una hoja de prueba puesta sobre un cheque real no confirme las posiciones. */
  calibrada: boolean;
  zonas: { fecha: ZonaCheque; beneficiario: ZonaCheque; importe: ZonaCheque; letra: ZonaCheque; leyenda: ZonaCheque };
  /** El recuadro del importe, impreso de fábrica (el `$` va fuera, a su izquierda). */
  cajaImporte: { x: number; y: number; ancho: number; alto: number };
  guias: GuiaCheque[];
  reservadas: ZonaReservada[];
}

/**
 * **BanBajío · «Conecta»** (cuenta 4166). Medido sobre la foto frontal con regla (alto 70 mm contra la regla, ancho
 * 160 mm contra la regla de la otra foto) y llevado a mm por proporción con las cuatro esquinas del cheque.
 *
 * Lo que dicen las líneas impresas, de arriba abajo: «FECHA» (rótulo encima, a la izquierda de su línea) · la línea de
 * «PÁGUESE ESTE CHEQUE A LA ORDEN DE:» (el rótulo va DEBAJO de la línea: se escribe encima) · el recuadro del importe
 * con el `$` impreso · la línea de «LA CANTIDAD DE:» (también con el rótulo debajo) · titular, firma y banda magnética.
 */
export const PLANTILLA_CHEQUE_BAJIO: PlantillaCheque = {
  clave: 'bajio-conecta',
  banco: 'BBAJIO',
  nombre: 'BanBajío · Conecta',
  anchoMm: 160,
  altoMm: 70,
  medicion: 'foto con regla y perfil de oscuridad de la foto, 2026-11-20 (líneas a ±0.5 mm)',
  calibrada: false,
  zonas: {
    fecha: { x: 77.5, ancho: 38, base: 20.6, letraMax: 3, letraMin: 2.2, alinear: 'izquierda', renglones: 1, interlinea: 0, letraDosRenglones: 0 },
    beneficiario: { x: 8, ancho: 106, base: 27.7, letraMax: 3.2, letraMin: 2.2, alinear: 'izquierda', renglones: 1, interlinea: 0, letraDosRenglones: 0 },
    importe: { x: 124.5, ancho: 27, base: 30.2, letraMax: 3.6, letraMin: 2.6, alinear: 'centro', renglones: 1, interlinea: 0, letraDosRenglones: 0 },
    // Entre el rótulo «PÁGUESE…» (termina en 30.5) y la línea de la cantidad (38.1) hay ~7 mm sin nada impreso: caben
    // dos renglones. Uno no baja de 2.4 mm: antes se parte en dos de 2.7 (dos legibles valen más que uno diminuto).
    letra: { x: 8, ancho: 107, base: 37.1, letraMax: 3, letraMin: 2.4, alinear: 'izquierda', renglones: 2, interlinea: 3.2, letraDosRenglones: 2.7 },
    // DCH8 (por firmar): «PARA ABONO EN CUENTA DEL BENEFICIARIO». La zona existe; la leyenda sólo sale si se pide.
    leyenda: { x: 98, ancho: 54, base: 10.5, letraMax: 2.4, letraMin: 1.8, alinear: 'derecha', renglones: 1, interlinea: 0, letraDosRenglones: 0 },
  },
  // La parte clara del recuadro (donde se escribe); el marco lila sigue arriba (23.2) y abajo (34.5).
  cajaImporte: { x: 123.5, y: 25.8, ancho: 29, alto: 6.2 },
  // Las líneas bajan ~0.6 mm de izquierda a derecha en la foto (los bordes del cheque no): el valor es el del centro, y
  // cada base queda ≥0.5 mm arriba de su línea en el punto más alto de ésta.
  guias: [
    { nombre: 'fecha', x1: 68, x2: 116.5, y: 21.35 },
    { nombre: 'beneficiario', x1: 5.3, x2: 116, y: 28.6 },
    { nombre: 'letra', x1: 5.3, x2: 117, y: 38.1 },
    { nombre: 'firma', x1: 105, x2: 158, y: 47.2 },
  ],
  reservadas: [
    { nombre: 'logo', x: 3, y: 2, ancho: 37, alto: 15 },
    { nombre: '«CONECTA»', x: 68, y: 3.5, ancho: 30, alto: 5 },
    { nombre: 'rótulo «FECHA»', x: 69, y: 19.2, ancho: 7.6, alto: 2 },
    { nombre: 'rótulo «PÁGUESE…»', x: 5, y: 28.9, ancho: 56, alto: 1.6 },
    { nombre: '$', x: 120, y: 26.2, ancho: 3.3, alto: 4.4 },
    { nombre: 'MONEDA NACIONAL', x: 125, y: 34.8, ancho: 26, alto: 1.7 },
    { nombre: 'rótulo «LA CANTIDAD DE:»', x: 5, y: 38.4, ancho: 21, alto: 1.3 },
    { nombre: 'nombre del banco', x: 60, y: 39, ancho: 57.5, alto: 1.5 },
    { nombre: 'titular y cuenta', x: 5, y: 41.6, ancho: 75, alto: 11.5 },
    { nombre: 'firma', x: 105, y: 38.5, ancho: 53, alto: 9.5 },
    { nombre: 'banda magnética', x: 0, y: 53, ancho: 160, alto: 17 },
  ],
};

export const PLANTILLAS_CHEQUE: readonly PlantillaCheque[] = [PLANTILLA_CHEQUE_BAJIO];

/** La plantilla del papel de una cuenta (`finance.bank_accounts.bank`); null = esa chequera todavía no se mide. */
export function plantillaDeCheque(banco: string | null | undefined): PlantillaCheque | null {
  const b = String(banco ?? '').trim().toUpperCase();
  return PLANTILLAS_CHEQUE.find((p) => p.banco === b) ?? null;
}

/** Lo que va escrito en el cheque, ya en su forma final. */
export interface CamposDelCheque {
  /** `20 DE NOVIEMBRE DE 2026`: el mes con letra no se confunde (20/11 y 11/20). */
  fecha: string;
  beneficiario: string;
  /** `**107,446.93**`: los asteriscos impiden agregar cifras; el `$` ya viene impreso. */
  importe: string;
  /** `(CIENTO SIETE MIL CUATROCIENTOS CUARENTA Y SEIS PESOS 93/100 M.N.)`. */
  letra: string;
  leyenda: string | null;
}

export interface DatosDelCheque {
  /** El día del Calendario (`YYYY-MM-DD`): «toma la fecha del calendario» (Francisco, 2026-11-19). */
  fecha: string;
  beneficiario: string;
  /** Centavos enteros (`centavosExactos`). */
  centavos: number;
  /** DCH8. Null mientras no se firme. */
  leyenda?: string | null;
}

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/**
 * `2026-11-20` → `20 DE NOVIEMBRE DE 2026`. ⛔ Se lee el texto, no se construye un `Date`: `new Date('2026-11-20')` es
 * UTC y en `America/Mexico_City` sería el día anterior.
 */
export function fechaDelCheque(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim().slice(0, 10));
  const mes = m ? Number(m[2]) : 0;
  const dia = m ? Number(m[3]) : 0;
  if (!m || mes < 1 || mes > 12 || dia < 1 || dia > 31) throw new RangeError(`fecha inválida para un cheque: «${iso}»`);
  return `${dia} DE ${MESES[mes - 1]} DE ${m[1]}`;
}

/** `10744693` → `107,446.93`, con aritmética entera (nunca un `toFixed` sobre un flotante). */
export function importeConComas(centavos: number): string {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new RangeError(`importe inválido (se esperan centavos enteros): ${centavos}`);
  const entero = String(Math.floor(centavos / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${entero}.${String(centavos % 100).padStart(2, '0')}`;
}

/**
 * Los campos del cheque, ya escritos. ⛔ Lanza con un importe en cero o negativo, sin beneficiario o con una fecha
 * ilegible: un cheque con un dato dudoso no se imprime.
 */
export function camposDelCheque(d: DatosDelCheque): CamposDelCheque {
  if (!Number.isSafeInteger(d.centavos) || d.centavos <= 0) throw new RangeError(`un cheque no se imprime por ${d.centavos} centavos`);
  const beneficiario = String(d.beneficiario ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-MX');
  if (!beneficiario) throw new RangeError('un cheque sin beneficiario no se imprime');
  const leyenda = String(d.leyenda ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-MX') || null;
  return {
    fecha: fechaDelCheque(d.fecha),
    beneficiario,
    importe: `**${importeConComas(d.centavos)}**`,
    letra: `(${importeConLetra(d.centavos).toLocaleUpperCase('es-MX')})`,
    leyenda,
  };
}

/**
 * Los datos de la hoja de prueba cuando no se imprime un pago: nombre y cantidad **largos a propósito** — lo que hay
 * que comprobar es que lo difícil cabe sin pisar nada (la cantidad sale en dos renglones).
 */
export function datosDeChequeDePrueba(fecha: string): DatosDelCheque {
  return { fecha, beneficiario: 'NOMBRE DEL BENEFICIARIO COMO VIENE EN SU FACTURA, SOCIEDAD ANÓNIMA DE CAPITAL VARIABLE', centavos: 177_777_777 };
}

/** El folio que la persona escribió en «Preparar» (la misma regla que `SQL_ES_CHEQUE_EMITIDO` de `[PGP.173]`). */
export function folioDelCheque(referencia: string | null | undefined): string | null {
  return /[0-9]{3,}/.exec(String(referencia ?? ''))?.[0] ?? null;
}

export type MotivoSinCheque =
  | 'no_es_cheque' | 'sin_cuenta' | 'sin_plantilla' | 'sin_numero' | 'no_cuadra' | 'importe_invalido'
  | 'sin_beneficiario' | 'varios_beneficiarios';

/** Lo que la impresión le pide a un pago del Calendario. Estructural: lo arma el servicio con lo que ya lee. */
export interface PagoParaCheque {
  payment_method: string | null;
  reference_text: string | null;
  amount_assigned: number | string;
  /** `finance.bank_accounts.bank` de la cuenta de origen; null si el pago no tiene cuenta. */
  banco: string | null;
  /** Cada factura con lo aplicado y el beneficiario con el que el Calendario la muestra. */
  items: ReadonlyArray<{ applied_amount: number | string; beneficiary?: string | null }>;
}

export type DictamenCheque =
  | { ok: true; plantilla: PlantillaCheque; folio: string; centavos: number; beneficiario: string }
  | { ok: false; motivo: MotivoSinCheque; texto: string };

const TEXTO_SIN_CHEQUE: Record<MotivoSinCheque, string> = {
  no_es_cheque: 'Este pago no es con cheque: cámbialo en «Preparar» si así sale.',
  sin_cuenta: 'El pago no tiene cuenta de origen: elige la cuenta del cheque en «Preparar».',
  sin_plantilla: 'Esa chequera todavía no está medida para imprimir: por ahora sólo BanBajío.',
  sin_numero: 'Falta el número del cheque: escribe en «Preparar» el que trae el cheque que vas a meter a la impresora.',
  no_cuadra: 'El importe del pago no es la suma de sus facturas: revísalo antes de imprimir.',
  importe_invalido: 'El importe del pago no se puede escribir en un cheque (cero, negativo o con más de dos decimales).',
  sin_beneficiario: 'El pago no tiene a nombre de quién: no se imprime un cheque sin beneficiario.',
  varios_beneficiarios: 'El pago junta facturas a nombre de distintos beneficiarios: un cheque lleva un solo nombre.',
};

/**
 * El nombre como se compara: mayúsculas, espacios simples. «Dulces  del  Bajío» y «DULCES DEL BAJÍO» son el mismo.
 * Sin una sola letra o dígito no es un nombre: el Calendario pinta «—» cuando la factura no tiene etiqueta.
 */
function nombreNormal(s: string | null | undefined): string {
  const n = String(s ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('es-MX');
  return /[\p{L}\p{N}]/u.test(n) ? n : '';
}

/** `107446.93` (número o texto de un `numeric`) → centavos, o null si no es un importe de cheque. Sin redondear. */
function centavosDe(v: number | string): number | null {
  const t = String(v ?? '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m || /[1-9]/.test((m[2] ?? '').slice(2))) return null;
  const c = Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
  return Number.isSafeInteger(c) ? c : null;
}

/**
 * **¿Este pago puede salir en un cheque impreso?** El importe es el del pago (lo pone el servidor; la pantalla no
 * manda ninguno) y debe ser, al centavo, la suma de lo aplicado a sus facturas — medido el 2026-11-20: 34 de 34 pagos
 * con cheque cuadran, así que la regla no frena a nadie hoy y sí frena al primero que se descuadre.
 *
 * ⛔ No exige la autorización de la Suite: de 29 pagos con cheque numerado vigentes sólo 1 la tenía, y los 13 pagados
 * salieron sin ella (2026-11-20). La autorización de un cheque es **la firma de Dirección General en el papel**.
 *
 * El beneficiario es el nombre con el que el Calendario muestra las facturas del pago: el mismo que hoy se escribe a
 * mano. DCH8 (por firmar) lo cambiaría por el del CFDI; mientras tanto, un pago con dos nombres distintos no se imprime.
 */
export function dictamenCheque(p: PagoParaCheque): DictamenCheque {
  const no = (motivo: MotivoSinCheque, detalle = ''): DictamenCheque => ({ ok: false, motivo, texto: TEXTO_SIN_CHEQUE[motivo] + detalle });
  if (p.payment_method !== 'cheque') return no('no_es_cheque');
  if (!p.banco) return no('sin_cuenta');
  const plantilla = plantillaDeCheque(p.banco);
  if (!plantilla) return no('sin_plantilla');
  const folio = folioDelCheque(p.reference_text);
  if (!folio) return no('sin_numero');
  const centavos = centavosDe(p.amount_assigned);
  if (centavos === null || centavos <= 0) return no('importe_invalido');
  let suma = 0;
  for (const it of p.items) {
    const c = centavosDe(it.applied_amount);
    if (c === null) return no('no_cuadra');
    suma += c;
  }
  if (suma !== centavos) return no('no_cuadra');
  const nombres = [...new Set(p.items.map((it) => nombreNormal(it.beneficiary)).filter((n) => !!n))];
  if (!nombres.length) return no('sin_beneficiario');
  if (nombres.length > 1) return no('varios_beneficiarios', ` (${nombres.join(' · ')})`);
  return { ok: true, plantilla, folio, centavos, beneficiario: nombres[0] };
}
