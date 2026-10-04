/**
 * `[CAT-COSTO.5]` — **Trazabilidad del costo de un producto, sucursal por sucursal.**
 *
 * Dos historias en una línea de tiempo, como las pidió Compras (2026-10-04):
 *
 *  · **Costo estándar negociado.** Kepler NO guarda la historia de la ficha (`kdii.c77` sólo tiene el
 *    valor de hoy). Pero cada renglón de venta congela el costo de la ficha de ese momento:
 *    `kdm2.c62 = costo de la unidad base × c58` (VERDAD_ABSOLUTA §4.2, 98.39 % de 691,746 renglones,
 *    mediana 1.0000). La historia se reconstruye de ahí. ⚠️ La fecha es la de la **primera venta** con
 *    el costo nuevo, no la del día exacto en que se editó la ficha; un producto sin venta no deja rastro.
 *  · **Costo de entrada.** Cada línea de orden de entrada (`XA2001`), convertida a la unidad base con
 *    la escalera de la ficha. El cambio se mide contra **la entrada anterior de la misma plaza**.
 *
 * Este archivo es la REGLA, sin base: el servicio trae las muestras, esto arma los eventos.
 */

/** Tolerancia de Compras: hasta 0.5 % es el mismo costo. */
export const TOLERANCIA_HISTORIAL = 0.005;

export interface MuestraEstandar {
  sucursal: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** Mediana del día de `c62 / c58`: el costo estándar por unidad base que congeló la venta. */
  costo: number;
}

export interface EntradaCruda {
  fecha: string;
  /** Sucursal donde se registró el documento (hasta el 30-sep muchas se registraban en 00). */
  sucursal_registro: string;
  /** Plaza que recibió. `null` = no se pudo atribuir (se declara, no se adivina). */
  plaza: string | null;
  folio: string;
  proveedor: string | null;
  unidad: string | null;
  cantidad: number;
  /** Costo por la unidad comprada (`kdm2.c12`). */
  costo: number;
  /** Piezas por la unidad comprada según la escalera. `null` = la unidad no está en la escalera. */
  factor: number | null;
}

export type VeredictoEntrada = 'apegada' | 'arriba' | 'abajo' | 'sin_cargo' | 'no_comparable';

export interface EntradaTrazada extends EntradaCruda {
  /** Costo por unidad base. `null` si la unidad no se resolvió. */
  costo_base: number | null;
  /** Costo base de la entrada anterior de la misma plaza. `undefined` = es la primera. */
  antes: number | null | undefined;
  /** Cambió contra la entrada anterior de la plaza (más allá de la tolerancia). */
  cambio: boolean;
  cambio_pct: number | null;
  /** El estándar que tenía la plaza ese día, según la última venta previa. */
  estandar_vigente: number | null;
  vs_estandar_pct: number | null;
  veredicto: VeredictoEntrada;
  /** Por qué no se pudo comparar, cuando `veredicto = no_comparable`. */
  motivo: 'sin_plaza' | 'unidad_sin_resolver' | 'sin_estandar_previo' | null;
}

export interface CambioEstandar {
  sucursal: string;
  fecha: string;
  antes: number;
  despues: number;
  cambio_pct: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const distinto = (a: number, b: number, tol: number) => Math.abs(b / a - 1) > tol;

/**
 * Quita picos de un solo día: `A, B, A` es casi siempre un renglón contradicho (1.27 % lo son), no
 * dos ediciones de la ficha en días seguidos. Sin esto la historia inventaría cambios que no hubo.
 */
export function limpiarPicos(serie: MuestraEstandar[], tol = TOLERANCIA_HISTORIAL): MuestraEstandar[] {
  return serie.filter((m, i) => {
    const prev = serie[i - 1];
    const next = serie[i + 1];
    if (!prev || !next) return true;
    const esPico = !distinto(prev.costo, next.costo, tol) && distinto(prev.costo, m.costo, tol);
    return !esPico;
  });
}

/** Los cambios del estándar por sucursal, en orden de fecha. */
export function cambiosEstandar(muestras: MuestraEstandar[], tol = TOLERANCIA_HISTORIAL): CambioEstandar[] {
  const porSucursal = new Map<string, MuestraEstandar[]>();
  for (const m of muestras) {
    if (!(m.costo > 0)) continue;
    const lista = porSucursal.get(m.sucursal) ?? [];
    lista.push(m);
    porSucursal.set(m.sucursal, lista);
  }
  const cambios: CambioEstandar[] = [];
  for (const [sucursal, lista] of porSucursal) {
    const serie = limpiarPicos([...lista].sort((a, b) => a.fecha.localeCompare(b.fecha)), tol);
    for (let i = 1; i < serie.length; i++) {
      const a = serie[i - 1].costo;
      const b = serie[i].costo;
      if (distinto(a, b, tol)) {
        cambios.push({ sucursal, fecha: serie[i].fecha, antes: r2(a), despues: r2(b), cambio_pct: r2((b / a - 1) * 100) });
      }
    }
  }
  return cambios.sort((x, y) => x.fecha.localeCompare(y.fecha) || x.sucursal.localeCompare(y.sucursal));
}

/** El estándar de la plaza en una fecha: el de la última venta en o antes de ese día. */
export function estandarEn(muestras: MuestraEstandar[], sucursal: string, fecha: string, tol = TOLERANCIA_HISTORIAL): number | null {
  const serie = limpiarPicos(
    muestras.filter((m) => m.sucursal === sucursal && m.costo > 0).sort((a, b) => a.fecha.localeCompare(b.fecha)),
    tol,
  );
  let v: number | null = null;
  for (const m of serie) {
    if (m.fecha > fecha) break;
    v = m.costo;
  }
  return v === null ? null : r2(v);
}

export function trazarEntradas(
  entradas: EntradaCruda[],
  muestras: MuestraEstandar[],
  tol = TOLERANCIA_HISTORIAL,
): EntradaTrazada[] {
  const ultimaPorPlaza = new Map<string, number | null>();
  const orden = [...entradas].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.folio.localeCompare(b.folio));

  return orden.map((e) => {
    const costoBase = e.factor && e.factor > 0 ? r2(e.costo / e.factor) : e.costo === 0 ? 0 : null;
    const clave = e.plaza ?? `?${e.sucursal_registro}`;
    const antes = ultimaPorPlaza.has(clave) ? ultimaPorPlaza.get(clave) : undefined;
    const cambio =
      costoBase !== null && antes !== undefined && antes !== null && antes > 0 && costoBase > 0
        ? distinto(antes, costoBase, tol)
        : antes === undefined;
    // Una entrada sin cargo no es un precio: no se vuelve la referencia de la siguiente.
    if (costoBase !== null && costoBase > 0) ultimaPorPlaza.set(clave, costoBase);

    const estandar = e.plaza ? estandarEn(muestras, e.plaza, e.fecha, tol) : null;

    let veredicto: VeredictoEntrada;
    let motivo: EntradaTrazada['motivo'] = null;
    let vs: number | null = null;
    if (e.costo === 0) {
      veredicto = 'sin_cargo';
    } else if (!e.plaza) {
      veredicto = 'no_comparable';
      motivo = 'sin_plaza';
    } else if (costoBase === null) {
      veredicto = 'no_comparable';
      motivo = 'unidad_sin_resolver';
    } else if (estandar === null) {
      veredicto = 'no_comparable';
      motivo = 'sin_estandar_previo';
    } else {
      vs = r2((costoBase / estandar - 1) * 100);
      veredicto = Math.abs(vs) <= tol * 100 ? 'apegada' : vs > 0 ? 'arriba' : 'abajo';
    }

    return {
      ...e,
      costo_base: costoBase,
      antes,
      cambio,
      cambio_pct: antes && costoBase ? r2((costoBase / antes - 1) * 100) : null,
      estandar_vigente: estandar,
      vs_estandar_pct: vs,
      veredicto,
      motivo,
    };
  });
}
