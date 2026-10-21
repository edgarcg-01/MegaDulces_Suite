/**
 * `[CGA-A.35]` — Lo que Kepler pasó por la Caja General y el Control no movió: **¿ya está en el
 * libro nuevo?** Funciones PURAS (ADR-070), las cablea `caja-general.service.ts`.
 *
 * ── El problema, medido contra prod el 2026-10-20 ─────────────────────────────────────────────
 *
 * El Cuadre de `/finanzas/caja` enfrenta el Control (el Access) contra la tesorería de Kepler y
 * publica como «solo Kepler» todo documento que el Control no tiene. El Control **dejó de
 * capturarse el 10-oct a las 12:39**: el libro nuevo (`finance.cash_ledger`) abre con el fondo del
 * arqueo `A23641` de las 12:58 de ese día. Desde el 12-oct, entonces, el Control está vacío y
 * **todo** Kepler sale como faltante: 202 documentos, de los que **165 ya estaban capturados en el
 * libro** con su `origen_ref`. La pantalla pedía capturar dinero que ya estaba capturado.
 *
 * Y del otro lado faltaba un universo entero: los **cobros de camioneta** con almacén compuesto
 * (`01-003`, `06-002`…) viven en `analytics.route_collections`, no en
 * `analytics.kepler_bank_movements`. Desde el 12-oct son **58 cobros, $1,048,334.34**, y sólo 25
 * estaban en el libro. La pantalla no los mostraba ni como casados ni como faltantes.
 *
 * ── Qué hace este archivo ─────────────────────────────────────────────────────────────────────
 *
 * 1. `cobroDeRutaComoKepler` pone un cobro de camioneta en la misma forma que un movimiento de la
 *    tesorería, con la llave que usa el libro (`almacen|U-A-5|folio|0011`). Medido: **0 de 134**
 *    cobros de octubre aparecen también en `kepler_bank_movements` con la misma fecha e importe,
 *    así que sumarlos no cuenta nada dos veces.
 * 2. `indexaLibro` + `marcaEnLibro` dicen, de cada «solo Kepler», si el libro ya lo tiene y con
 *    qué folio — **por LLAVE, nunca por importe**:
 *      · `origen_ref` = la llave del documento (vínculo de Kepler), o
 *      · `declared_doc_ref` = la llave, SÓLO si el movimiento vino de CAOS. Es la misma regla
 *        `[CGA-A.10]` que usa la bandeja (`cash-ledger.service.ts`): si la pantalla y la bandeja
 *        dijeran cosas distintas, una de las dos mentiría.
 *
 * ⛔ **Lo que este archivo NO hace, a propósito: casar Control con Kepler entre días distintos.**
 * Hay casos ciertos (cobros de Morelia que el Control anotó 1–2 días después, al centavo), pero
 * como REGLA no aguantó el control placebo: con ventana de días, el mismo cruce sobre un Control
 * corrido 28 días casó más (19 %) que el real (7 %). Un casamiento que el azar hace igual de bien
 * no se publica como hecho. Esos documentos siguen saliendo como pendientes y se declaran en
 * `FASE_CGA_PLAN_IMPLEMENTACION.md` §11.4.3.
 */

import { casarPorImporte, redondea2, type MovCuadre, type ParCasado, type ResultadoCuadre } from './caja-cuadre.engine';

/** Un renglón del libro reducido a lo que decide si un documento de Kepler ya está capturado. */
export interface RenglonLibro {
  folio: string;
  estado: string;
  origen_tipo: string | null;
  origen_ref: string | null;
  declared_doc_ref: string | null;
}

/** Dónde quedó capturado un documento de Kepler en el libro nuevo, y por qué vía se sabe. */
export interface EnLibro {
  folio: string;
  estado: string;
  /** `vinculo` = `origen_ref` (llave puesta al capturar). `declarado` = CAOS declaró el documento. */
  via: 'vinculo' | 'declarado';
}

/**
 * Índice llave-del-documento → renglón del libro. El vínculo gana sobre la declaración: es la
 * llave que puso el sistema, la declaración la puso una persona.
 *
 * El llamador ya filtra borrados y cancelados; acá se vuelve a filtrar `cancelado` porque un
 * renglón anulado NO salda nada, y que eso dependa de que alguien se acuerde del `WHERE` es
 * justo el tipo de cosa que se rompe en silencio.
 */
export function indexaLibro(rows: RenglonLibro[]): Map<string, EnLibro> {
  const idx = new Map<string, EnLibro>();
  const vivos = rows.filter((r) => r.estado !== 'cancelado');
  for (const r of vivos) {
    if (r.origen_ref && !idx.has(r.origen_ref)) idx.set(r.origen_ref, { folio: r.folio, estado: r.estado, via: 'vinculo' });
  }
  for (const r of vivos) {
    // `[CGA-A.10]`: la declaración sólo cuenta para lo capturado desde CAOS. Un movimiento con
    // vínculo de Kepler ya se identifica por `origen_ref`, que es exacto.
    if (r.origen_tipo === 'caos' && r.declared_doc_ref && !idx.has(r.declared_doc_ref)) {
      idx.set(r.declared_doc_ref, { folio: r.folio, estado: r.estado, via: 'declarado' });
    }
  }
  return idx;
}

/** Le pega a cada documento «solo Kepler» su renglón del libro, o `null` si de verdad falta. */
export function marcaEnLibro<T extends { key: string }>(solos: T[], idx: Map<string, EnLibro>): (T & { en_libro: EnLibro | null })[] {
  return solos.map((s) => ({ ...s, en_libro: idx.get(s.key) ?? null }));
}

/** Los «solo Kepler» partidos en lo que ya está en el libro y lo que de verdad falta. */
export function resumeEnLibro(solos: { importe: number; en_libro: EnLibro | null }[]): {
  en_libro_n: number; en_libro_monto: number; pendiente_n: number; pendiente_monto: number;
} {
  const suma = (xs: { importe: number }[]) => Math.round(xs.reduce((s, x) => s + (Number(x.importe) || 0), 0) * 100) / 100;
  const en = solos.filter((s) => s.en_libro), pend = solos.filter((s) => !s.en_libro);
  return { en_libro_n: en.length, en_libro_monto: suma(en), pendiente_n: pend.length, pendiente_monto: suma(pend) };
}

/** Un cobro de camioneta tal como lo agrupa la cola (`almacen`, `cobro_folio`, `fecha`). */
export interface CobroDeRuta {
  almacen: string;
  cobro_folio: string;
  fecha: unknown;
  importe: number | string;
  truck: string | null;
  concepto: string | null;
}

/**
 * Un cobro de camioneta con la MISMA forma que un renglón de `kepler_bank_movements`, para que el
 * Cuadre lo trate igual. La llave sale de `sucursal|doc_tipo|folio|clave_banco`, y con estos
 * valores da `almacen|U-A-5|folio|0011`: idéntica al `origen_ref` del libro y de la cola.
 */
export function cobroDeRutaComoKepler(r: CobroDeRuta): {
  sucursal: string; clave_banco: string; folio: string; fecha: unknown; concepto: string | null;
  beneficiario: string; doc_tipo: string; importe: number; signo: number;
} {
  return {
    sucursal: r.almacen,
    clave_banco: '0011',
    folio: r.cobro_folio,
    fecha: r.fecha,
    concepto: r.concepto,
    // La cola escribe 'CONTADO'; acá se le suma la unidad, que es lo único que distingue dos
    // cobros con el mismo folio (el folio es consecutivo POR unidad — GOTCHAS §86).
    beneficiario: r.truck ? `CONTADO · ${r.truck}` : 'CONTADO',
    doc_tipo: 'U-A-5',
    importe: Number(r.importe) || 0,
    signo: 1,
  };
}

/**
 * `[CGA-A.39]` La llave de Kepler que el libro le pone a un movimiento: el vínculo de Kepler
 * (`origen_ref` de un `cobro` / `pago_proveedor`), o lo que CAOS declaró (`declared_doc_ref`),
 * con la misma regla `[CGA-A.10]` que `indexaLibro`. Sin ninguna de las dos, `null`: ese
 * movimiento se casa por importe, que es lo único que queda.
 */
export function llaveKeplerDelLibro(r: { origen_tipo: string | null; origen_ref: string | null; declared_doc_ref: string | null }): string | null {
  if ((r.origen_tipo === 'cobro' || r.origen_tipo === 'pago_proveedor') && r.origen_ref) return r.origen_ref;
  if (r.origen_tipo === 'caos' && r.declared_doc_ref) return r.declared_doc_ref;
  return null;
}

/** Un par del Cuadre que salió de una LLAVE (no de un parecido de importe). */
export type ParLibro<T extends MovCuadre> = ParCasado<T> & { identidad?: boolean };

/**
 * `[CGA-A.39]` El Cuadre de un día del LIBRO NUEVO contra Kepler (la decisión de Edgar del
 * 2026-10-20: el libro se acomoda por la fecha del DOCUMENTO, la misma que usa Kepler).
 *
 * El Control no tenía llave hacia Kepler y por eso se casaba por importe ±$5 —un atributo débil
 * (medido: 25.8 % de los movimientos con más de un candidato). **El libro sí la tiene**, y casar
 * por importe teniéndola sería tirar la llave y adivinar. Entonces, en orden:
 *
 *   1. **Por llave**: el movimiento del libro trae su documento → par de IDENTIDAD, no ambiguo.
 *      Si el documento cae en OTRO día (medido: 8 de 222 difieren en un día), igual se casa con
 *      el que llega en `fuera` — es el mismo documento, y dejarlo «solo libro» sería mentir.
 *   2. **Por importe**, con el motor de siempre, SÓLO lo que quedó sin llave (las capturas de
 *      CAOS que no declararon documento). Ésas conservan su `ambiguo` y su `delta`.
 *
 * Un documento de Kepler que el día trae y que ya casó por llave no puede volver a casar por
 * importe con otro movimiento: se consume.
 */
export function casarLibroConKepler<T extends MovCuadre & { ref?: string | null }>(
  libro: T[],
  kep: T[],
  tolerancia: number,
  fuera: Map<string, T> = new Map(),
): ResultadoCuadre<T> & { pares: ParLibro<T>[]; identidad_n: number } {
  const porLlave = new Map(kep.map((k) => [k.key, k] as const));
  const usados = new Set<string>();
  const ident: ParLibro<T>[] = [];
  const sinPar: T[] = [];
  for (const l of libro) {
    const k = l.ref ? (porLlave.get(l.ref) ?? fuera.get(l.ref)) : undefined;
    if (k && !usados.has(k.key)) {
      usados.add(k.key);
      ident.push({ caja: l, otro: k, delta: redondea2(Number(l.importe) - Number(k.importe)), candidatos: 1, ambiguo: false, identidad: true });
    } else {
      sinPar.push(l);
    }
  }
  const resto = casarPorImporte(sinPar, kep.filter((k) => !usados.has(k.key)), tolerancia);
  const suma = (rows: { importe: number }[]) => redondea2(rows.reduce((s, r) => s + (Number(r.importe) || 0), 0));
  const pares: ParLibro<T>[] = [...ident, ...resto.pares];
  const caja_total = suma(libro), otro_total = suma(kep);
  return {
    pares,
    caja_solos: resto.caja_solos,
    otro_solos: resto.otro_solos,
    caja_total,
    otro_total,
    delta: redondea2(caja_total - otro_total),
    casados_n: pares.length,
    casados_monto: suma(pares.map((p) => p.caja)),
    caja_solos_monto: resto.caja_solos_monto,
    otro_solos_monto: resto.otro_solos_monto,
    ambiguos_n: resto.ambiguos_n,
    inexactos_n: pares.filter((p) => p.delta !== 0).length,
    tolerancia: resto.tolerancia,
    identidad_n: ident.length,
  };
}

/**
 * `[CGA-A.39]` Junta dos resultados del Cuadre de la misma dirección: el tramo del Control
 * (antes del relevo) y el del libro (desde el relevo), cuando un rango cruza el corte. Los totales
 * se SUMAN porque los dos tramos no se traslapan: cada día es de una sola fuente.
 */
export function juntaCuadres<T extends MovCuadre>(
  a: ResultadoCuadre<T> & { identidad_n?: number },
  b: ResultadoCuadre<T> & { identidad_n?: number },
): ResultadoCuadre<T> & { pares: ParLibro<T>[]; identidad_n: number } {
  return {
    pares: [...a.pares, ...b.pares],
    caja_solos: [...a.caja_solos, ...b.caja_solos],
    otro_solos: [...a.otro_solos, ...b.otro_solos],
    caja_total: redondea2(a.caja_total + b.caja_total),
    otro_total: redondea2(a.otro_total + b.otro_total),
    delta: redondea2(a.delta + b.delta),
    casados_n: a.casados_n + b.casados_n,
    casados_monto: redondea2(a.casados_monto + b.casados_monto),
    caja_solos_monto: redondea2(a.caja_solos_monto + b.caja_solos_monto),
    otro_solos_monto: redondea2(a.otro_solos_monto + b.otro_solos_monto),
    ambiguos_n: a.ambiguos_n + b.ambiguos_n,
    inexactos_n: a.inexactos_n + b.inexactos_n,
    tolerancia: a.tolerancia,
    identidad_n: (a.identidad_n ?? 0) + (b.identidad_n ?? 0),
  };
}
