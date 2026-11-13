/**
 * **La contabilidad interna de Kepler, en un solo lugar.** Kepler asienta cada documento en una póliza del mes
 * (`kdc2AAMM`) y suma esos asientos a dos acumulados: el de la cuenta (`kdc126`) y el del acreedor (`kdxg`). No
 * hay disparadores en `md`: lo escribe el programa cliente, así que quien escriba un documento en Kepler tiene
 * que escribir también esto. Lo usan el pago a proveedor (`[PGP.106]`) y las comisiones bancarias (`[CB.62]`):
 * un solo modelo de póliza (ADR-056).
 *
 * Medido en `kepler_ods`, oficinas (`00`), octubre y noviembre de 2026 (FASE_PGP §«El cierre contable del pago»):
 *  - **Póliza `kdc2AAMM`** (una tabla por mes, 51 columnas en las 24 tablas de 2025-2026): `c1` número (`MAX+1`
 *    por mes y tipo), `c2` fecha, `c3` cuenta, `c4` `C`/`A`, `c5` importe (y `c9`, el mismo con 4 decimales),
 *    `c6` nombre, `c7` referencia, `c8` tipo de póliza, `c10` renglón, `c14` sucursal, `c15`–`c19` el documento.
 *  - **`kdc126`**, una fila por cuenta: cargos del mes en `c27`–`c38` y abonos en `c63`–`c74`, con un segundo juego
 *    (`c51`–`c62` / `c75`–`c86`) que suma lo mismo salvo los renglones con `c23` vacío (las notas de crédito
 *    `X-D-55`: octubre, $1,451,411.81 al centavo). Los asientos de un pago traen `c23 = '0'`: van a los DOS.
 *    Cuadra al centavo en `102` y `201`, octubre y noviembre.
 *  - **`kdxg`**, una fila por acreedor: abonos del mes en `c35`–`c46`; `c4` la fecha del último movimiento
 *    (324 de 324) y `c7` la del último pago `X-D-25`/`26` (317 de 324). `c5` NO se deriva (casa en 42 %): no se toca.
 */

type Valor = string | number;

/**
 * Una póliza `kdc2AAMM`: tipo (`c8`), fecha (`c2`) y renglones. El número (`c1`), la sucursal (`c14`) y el
 * documento (`c15`–`c19`) los pone quien escribe, en el Kepler vivo.
 */
export interface PolizaKepler { tipo: 'D' | 'E'; fecha: string; renglones: Record<string, Valor>[] }

/** La tabla de pólizas del mes de esa fecha: `2026-11-09` → `kdc22611`. `null` si la fecha no es `YYYY-MM-DD`. */
export function tablaPolizaDelMes(fecha: string): string | null {
  const m = /^(\d{2})(\d{2})-(\d{2})-\d{2}$/.exec(fecha ?? '');
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 12) return null;
  return `kdc2${m[2]}${m[3]}`;
}

/** Lo que una póliza suma a cada cuenta: cargos y abonos, a centavos. */
export interface MovimientoCuenta { cuenta: string; cargo: number; abono: number }

/** Los renglones de la póliza, sumados por cuenta (`c3`) y naturaleza (`c4`). */
export function movimientosDePoliza(p: PolizaKepler): MovimientoCuenta[] {
  const por = new Map<string, MovimientoCuenta>();
  for (const r of p.renglones) {
    const cuenta = String(r['c3'] ?? '').trim();
    const m = por.get(cuenta) ?? { cuenta, cargo: 0, abono: 0 };
    const importe = Math.round(Number(r['c5'] ?? 0) * 100);
    if (r['c4'] === 'C') m.cargo += importe; else if (r['c4'] === 'A') m.abono += importe;
    por.set(cuenta, m);
  }
  return [...por.values()].map((m) => ({ cuenta: m.cuenta, cargo: m.cargo / 100, abono: m.abono / 100 }))
    .sort((a, b) => (a.cuenta < b.cuenta ? -1 : a.cuenta > b.cuenta ? 1 : 0));
}

const mesValido = (mes: number): number => {
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new Error(`Mes inválido: ${mes}`);
  return mes;
};

/** Las columnas de `kdc126` que suben con un cargo o un abono de ese mes (los dos juegos). */
export function columnasKdc126(mes: number): { cargo: [string, string]; abono: [string, string] } {
  const m = mesValido(mes);
  return { cargo: [`c${26 + m}`, `c${50 + m}`], abono: [`c${62 + m}`, `c${74 + m}`] };
}

/** La columna de `kdxg` con los abonos (pagos) del acreedor en ese mes. */
export function columnaAbonoKdxg(mes: number): string {
  return `c${34 + mesValido(mes)}`;
}
