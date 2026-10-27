import type { CuentaPagoFaltante, CuentasPagoFaltantesResponse } from '@megadulces/contracts';

/**
 * `[PGP.1]` El reparto de «a quién le falta cuenta» — **lógica pura, sin knex**.
 *
 * Vive aparte del servicio por una razón medida en este repo: *un doble de Knex no ejecuta SQL*,
 * así que una prueba con doble no dice nada del `WHERE`. Lo que SÍ se puede probar sin base es
 * esto: el denominador, el acumulado y el corte. El SQL se ejerce contra prod con el guión de
 * sólo lectura (`scratchpad/verify-pgp1.js`), que lo **lee del servicio** en vez de copiarlo.
 */

/** Redondeo a centavos. El dinero se publica al centavo, no con la cola binaria del `double`. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * La más reciente de un montón de fechas, en ISO — o `null` si no hay ninguna utilizable.
 * Acepta `Date` y `string` porque el driver devuelve una u otra según el tipo de la columna,
 * y descarta lo que no parsea en vez de propagar un `Invalid Date` que se pinta como texto.
 */
export function maxFecha(valores: (string | Date | null | undefined)[]): string | null {
  let mejor: number | null = null;
  for (const v of valores) {
    if (v == null) continue;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    if (!Number.isFinite(t)) continue;
    if (mejor === null || t > mejor) mejor = t;
  }
  return mejor === null ? null : new Date(mejor).toISOString();
}

/** Una fila cruda: un proveedor al que se le pagó por banco en la ventana. */
export interface FilaPagoPorBanco {
  proveedor_code: string;
  nombre: string | null;
  monto: string | number;
  pagos: string | number;
  ultimo_pago_date: string;
  ultimo_pago_monto: string | number;
  /** `null` = su clave de Kepler no resuelve a `catalog.suppliers`. */
  supplier_id: string | null;
  tiene_cuenta: boolean;
  /** Cuándo se recalculó el espejo del ERP para este proveedor. Alimenta `universo.data_as_of`. */
  computed_at?: string | Date | null;
}

/**
 * ⭐ **El denominador es el total de TODOS los que cobran por banco**, no el de los faltantes.
 * Con el denominador recortado, los porcentajes quedarían clavados en 100 % y el avance sería
 * invisible: lo que mide el progreso es que `pct_monto_cubierto` suba conforme se siembran.
 *
 * ⭐ **Y el acumulado arranca en la cobertura ya lograda**, no en cero: `corte_80pct` responde
 * «cuántas cuentas MÁS hay que dar de alta para cubrir el 80 % del dinero», que es la pregunta
 * que tiene quien va a capturarlas. Si arrancara en cero diría que falta más de lo que falta.
 */
export function repartirFaltantes(
  rows: FilaPagoPorBanco[],
  rango: { dias: number; desde: string; hasta: string },
): CuentasPagoFaltantesResponse {
  const montoTotal = rows.reduce((a, x) => a + Number(x.monto), 0);
  const sinCatalogo = rows.filter((x) => x.supplier_id == null);
  const conCuenta = rows.filter((x) => x.tiene_cuenta && x.supplier_id != null);
  const montoCubierto = conCuenta.reduce((a, x) => a + Number(x.monto), 0);
  const pctCubierto = montoTotal > 0 ? r2((montoCubierto / montoTotal) * 100) : 0;

  const pendientes = rows.filter((x) => x.supplier_id != null && !x.tiene_cuenta);

  let acum = pctCubierto;
  let corte: number | null = null;
  const faltantes: CuentaPagoFaltante[] = pendientes.map((x, i) => {
    const pct = montoTotal > 0 ? (Number(x.monto) / montoTotal) * 100 : 0;
    acum += pct;
    if (corte === null && acum >= 80) corte = i + 1;
    return {
      supplier_id: x.supplier_id as string,
      codigo: String(x.proveedor_code ?? '').trim(),
      nombre: x.nombre ?? '',
      pagos: Number(x.pagos),
      monto: r2(Number(x.monto)),
      pct_del_total: r2(pct),
      acumulado_pct: r2(acum),
      ultimo_pago_date: String(x.ultimo_pago_date).slice(0, 10),
      ultimo_pago_monto: r2(Number(x.ultimo_pago_monto)),
    };
  });

  return {
    universo: {
      dias: rango.dias,
      desde: rango.desde,
      hasta: rango.hasta,
      proveedores_total: rows.length,
      monto_total: r2(montoTotal),
      proveedores_con_cuenta: conCuenta.length,
      monto_cubierto: r2(montoCubierto),
      pct_monto_cubierto: pctCubierto,
      // ⚠️ `null` cuando no hay nada que medir — distinto de «ya está cubierto» (que da `null`
      // igual, pero con `pct_monto_cubierto` en 100: el par se lee junto, nunca el corte solo).
      corte_80pct: rows.length ? corte : null,
      proveedores_sin_catalogo: sinCatalogo.length,
      monto_sin_catalogo: r2(sinCatalogo.reduce((a, x) => a + Number(x.monto), 0)),
      // ⛔ Sin filas con fecha no se inventa «ahora»: se devuelve null y la pantalla lo dice.
      data_as_of: maxFecha(rows.map((x) => x.computed_at)),
    },
    faltantes,
  };
}
