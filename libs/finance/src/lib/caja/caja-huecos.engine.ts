/**
 * `[LE.CU.2]` — **Los huecos de Caja General**: cada peso que todavía no tiene explicación, con su
 * dueño, su certeza y lo que se hace. Funciones PURAS (ADR-070); las alimenta el servicio del Cuadre.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────────────────────
 * El Cuadre publicaba «el día no cuadra» y eso mezclaba siete causas con siete dueños distintos
 * (§36, `FASE_LE_ANEXO_CUADRE.md` paso 3). Un rojo que significa siete cosas no le dice a nadie qué
 * hacer. Este motor parte el rojo en **huecos con nombre**: qué testigos lo vieron, cuánto es, de
 * quién es y qué acción lo cierra.
 *
 * ── Las tres reglas que no se negocian ────────────────────────────────────────────────────────
 * 1. **La certeza sale del MÉTODO, no del monto.** Un par que casó sólo por importe es
 *    `por_confirmar` aunque coincida al centavo: el importe no se distingue del placebo (§36.7, §36.9).
 * 2. **Un peso, un hueco.** Si la misma llave llega por dos caminos, gana el tipo que primero puede
 *    cerrarlo (`PRIORIDAD`); el otro se descarta, no se suma dos veces.
 * 3. **Lo que no es dinero faltante no se suma a «falta explicar».** Lo capturado sin su documento
 *    ligado ya está explicado (falta la liga); el bulto sin contar no se sabe si falta: se declaran
 *    aparte, con su propio total.
 */
import { redondea2 } from './caja-cuadre.engine';

export type TipoHueco =
  | 'captura_doble'
  | 'captura_distinta'
  | 'kepler_sin_libro'
  | 'libro_sin_kepler'
  | 'cuenta_no_caja'
  | 'venta_sin_cobro'
  | 'corte_sin_cobro'
  | 'salida_sin_documento'
  | 'libro_sin_ligar'
  | 'bulto_sin_contar'
  | 'sin_direccion';

/** Quién lo cierra. La pantalla los agrupa: caja · Kepler y sucursales · rutas · Dirección · conteo. */
export type Dueno = 'caja' | 'kepler' | 'sucursal' | 'ruta' | 'direccion' | 'conteo' | 'desarrollo';
export type Certeza = 'alta' | 'media' | 'por_confirmar';
export type Accion = 'capturar' | 'ligar' | 'corregir' | 'pedir_kepler' | 'pedir_sucursal' | 'pedir_ruta' | 'contar' | 'revisar' | 'ninguna';
/** `si` lo vio · `no` no lo tiene · `difiere` lo tiene con otro importe · `na` no aplica a este hueco. */
export type Testigo = 'si' | 'no' | 'difiere' | 'na';
export type Testigos = Record<'venta' | 'corte' | 'cobro' | 'boveda' | 'libro' | 'control', Testigo>;

/** El orden en que un tipo gana sobre otro cuando la misma llave llega dos veces (regla 2). */
export const PRIORIDAD: readonly TipoHueco[] = [
  'captura_doble', 'captura_distinta', 'kepler_sin_libro', 'libro_sin_kepler', 'cuenta_no_caja',
  'venta_sin_cobro', 'corte_sin_cobro', 'salida_sin_documento', 'libro_sin_ligar', 'bulto_sin_contar', 'sin_direccion',
];

export interface HuecoEntrada {
  tipo: TipoHueco;
  /** `YYYY-MM-DD` del hecho (el documento, la venta, el corte). */
  fecha: string;
  monto: number;
  /** Llave única del dinero (el documento de Kepler, el folio del libro, la ruta y el día…). */
  ref: string;
  /** Lo que la persona lee: «Cobro de Morelia sin captura · U-A-5 0000224». */
  etiqueta: string;
  testigos?: Partial<Testigos>;
  /** Cómo se ligó lo que se ligó. `importe` = sin llave ni identidad. */
  via?: 'llave' | 'identidad' | 'importe';
  /** Sólo `corte_sin_cobro`: días desde el corte y el atraso normal (p90) de su sucursal. */
  atraso_dias?: number;
  atraso_p90?: number;
}

export interface Hueco extends HuecoEntrada {
  testigos: Testigos;
  dueno: Dueno;
  certeza: Certeza;
  accion: Accion;
  /** `true` = cuenta en «falta explicar». `false` = se declara aparte (regla 3). */
  falta: boolean;
}

const SIN_TESTIGOS: Testigos = { venta: 'na', corte: 'na', cobro: 'na', boveda: 'na', libro: 'na', control: 'na' };

const REGLAS: Record<TipoHueco, { dueno: Dueno; accion: Accion; falta: boolean }> = {
  captura_doble: { dueno: 'caja', accion: 'corregir', falta: true },
  captura_distinta: { dueno: 'caja', accion: 'corregir', falta: true },
  kepler_sin_libro: { dueno: 'caja', accion: 'capturar', falta: true },
  libro_sin_kepler: { dueno: 'kepler', accion: 'pedir_kepler', falta: true },
  cuenta_no_caja: { dueno: 'kepler', accion: 'pedir_kepler', falta: true },
  venta_sin_cobro: { dueno: 'ruta', accion: 'pedir_ruta', falta: true },
  corte_sin_cobro: { dueno: 'sucursal', accion: 'pedir_sucursal', falta: true },
  salida_sin_documento: { dueno: 'direccion', accion: 'revisar', falta: true },
  libro_sin_ligar: { dueno: 'caja', accion: 'ligar', falta: false },
  bulto_sin_contar: { dueno: 'conteo', accion: 'contar', falta: false },
  sin_direccion: { dueno: 'desarrollo', accion: 'ninguna', falta: false },
};

/** La certeza que el MÉTODO permite (regla 1). */
function certezaDe(e: HuecoEntrada, t: Testigos): Certeza {
  if (e.via === 'importe') return 'por_confirmar';
  switch (e.tipo) {
    case 'bulto_sin_contar':
    case 'sin_direccion':
      return 'por_confirmar';
    // Una salida que sólo anota Control es alta SÓLO si la bóveda la vio salir (el mismo minuto).
    case 'salida_sin_documento':
      return t.boveda === 'si' ? 'alta' : 'por_confirmar';
    // Corregir una captura exige que DOS testigos digan lo mismo contra el libro.
    case 'captura_distinta': {
      const coinciden = (['cobro', 'boveda', 'control', 'corte'] as const).filter((k) => t[k] === 'si').length;
      return t.libro === 'difiere' && coinciden >= 2 ? 'alta' : 'media';
    }
    case 'libro_sin_ligar':
      return e.via === 'identidad' || e.via === 'llave' ? 'alta' : 'media';
    default:
      return 'alta';
  }
}

/**
 * Un hueco con su dueño, su certeza y su acción. `null` = no es hueco: un corte sin cobro dentro
 * del atraso normal de su sucursal todavía no falta (se mide, `[LE.CU.1]`: p90 de 3 a 10 días).
 */
export function clasificaHueco(e: HuecoEntrada): Hueco | null {
  if (e.tipo === 'corte_sin_cobro' && (e.atraso_dias == null || e.atraso_p90 == null || e.atraso_dias <= e.atraso_p90)) return null;
  if (!(Number(e.monto) > 0)) return null;
  const testigos: Testigos = { ...SIN_TESTIGOS, ...(e.testigos ?? {}) };
  const r = REGLAS[e.tipo];
  return { ...e, monto: redondea2(Number(e.monto)), testigos, dueno: r.dueno, accion: r.accion, falta: r.falta, certeza: certezaDe(e, testigos) };
}

/** Clasifica, deja UN hueco por llave (regla 2) y ordena lo más nuevo primero, el más grande antes. */
export function armaHuecos(entradas: HuecoEntrada[]): Hueco[] {
  const prio = (t: TipoHueco) => PRIORIDAD.indexOf(t);
  const porRef = new Map<string, Hueco>();
  for (const e of entradas) {
    const h = clasificaHueco(e);
    if (!h) continue;
    const ya = porRef.get(h.ref);
    if (!ya || prio(h.tipo) < prio(ya.tipo)) porRef.set(h.ref, h);
  }
  return [...porRef.values()].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.monto - a.monto || a.ref.localeCompare(b.ref));
}

export interface ResumenHuecos {
  falta: { n: number; monto: number };
  por_dueno: Record<Dueno, { n: number; monto: number }>;
  /** Lo explicado que sólo espera su liga (no suma a `falta`). */
  por_ligar: { n: number; monto: number };
  /** Lo declarado sin contar (no suma a `falta`: no se sabe si falta). */
  sin_contar: { n: number; monto: number };
  /** Cuántos de los que faltan no tienen certeza alta. */
  por_confirmar_n: number;
}

export function resumeHuecos(hs: Hueco[]): ResumenHuecos {
  const cero = () => ({ n: 0, monto: 0 });
  const por_dueno = { caja: cero(), kepler: cero(), sucursal: cero(), ruta: cero(), direccion: cero(), conteo: cero(), desarrollo: cero() } as Record<Dueno, { n: number; monto: number }>;
  const falta = cero(), por_ligar = cero(), sin_contar = cero();
  let por_confirmar_n = 0;
  const suma = (acc: { n: number; monto: number }, h: Hueco) => { acc.n += 1; acc.monto = redondea2(acc.monto + h.monto); };
  for (const h of hs) {
    if (h.falta) {
      suma(falta, h);
      suma(por_dueno[h.dueno], h);
      if (h.certeza !== 'alta') por_confirmar_n += 1;
    } else if (h.tipo === 'libro_sin_ligar') suma(por_ligar, h);
    else if (h.tipo === 'bulto_sin_contar') suma(sin_contar, h);
  }
  return { falta, por_dueno, por_ligar, sin_contar, por_confirmar_n };
}
