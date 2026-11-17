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
 *    (`c51`–`c62` / `c75`–`c86`) que suma lo mismo salvo los renglones de las notas de crédito `X-D-55` y de las
 *    pólizas manuales con `c23` vacío. Los asientos de un pago (`c23 = '0'`) y los de un gasto `X-A-10` van a los
 *    DOS, **aunque su `c23` esté vacío** (`[PGP.123]`, re-medido el 2026-11-15: 117 de 117 cuentas con gastos de
 *    referencia vacía; la regla anterior, «excluye todo `c23` vacío», acertaba 259 de 429 renglones de octubre).
 *    La subcuenta (`611-003`) suma además a su mayor (`611`): ver `filasKdc126`.
 *  - **`kdxg`**, una fila por acreedor: abonos del mes en `c35`–`c46` y cargos (los gastos) en `c47`–`c58`; `c4` la
 *    fecha del último movimiento (324 de 324), `c6` la del último cargo (283 de 285) y `c7` la del último pago
 *    `X-D-25`/`26` (317 de 324). `c5` NO se deriva (casa en 42 %): no se toca.
 *  - **`kdcn26`**, el ejercido por centro de costo (`[PGP.123]`): `c7 += cargo − abono` por (concepto, departamento,
 *    proyecto, `AAMM`), con sumas `*` y los departamentos padre que existen en `kdc3`. Ver `movimientosKdcn26`.
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

/** La columna de `kdxg` con los cargos (los gastos `X-A-10`) del acreedor en ese mes: `c47`–`c58`. */
export function columnaCargoKdxg(mes: number): string {
  return `c${46 + mesValido(mes)}`;
}

/**
 * Las filas de `kdc126` que mueve un asiento a esa cuenta: la cuenta y, si es subcuenta (`611-003`), su mayor
 * (el primer segmento: `611`). Una cuenta sin guion (`201`) se asienta directo y no lleva mayor aparte. La póliza
 * nunca asienta al mayor: lo suma quien escribe. Medido (oct–nov 2026, las 9 réplicas): mayor = Σ de sus subcuentas
 * en 280 de 293; fallan la `102` (recibe también asientos directos) y la `114`.
 */
export function filasKdc126(cuenta: string): string[] {
  const c = String(cuenta ?? '').trim();
  if (!c) return [];
  const mayor = c.split('-')[0];
  return mayor && mayor !== c ? [c, mayor] : [c];
}

/** Lo que una póliza suma a `kdc126`, por fila (la cuenta y su mayor), a centavos. Los dos juegos llevan lo mismo. */
export function movimientosKdc126(p: PolizaKepler): MovimientoCuenta[] {
  const por = new Map<string, { cargo: number; abono: number }>();
  for (const m of movimientosDePoliza(p)) {
    for (const fila of filasKdc126(m.cuenta)) {
      const t = por.get(fila) ?? { cargo: 0, abono: 0 };
      t.cargo += Math.round(m.cargo * 100);
      t.abono += Math.round(m.abono * 100);
      por.set(fila, t);
    }
  }
  return [...por.entries()].map(([cuenta, t]) => ({ cuenta, cargo: t.cargo / 100, abono: t.abono / 100 }))
    .sort((a, b) => (a.cuenta < b.cuenta ? -1 : a.cuenta > b.cuenta ? 1 : 0));
}

/** El periodo de `kdcn26` (`c4`, `AAMM`) de esa fecha: `2026-11-13` → `2611`. `null` si no es `YYYY-MM-DD`. */
export function periodoKdcn26(fecha: string): string | null {
  const t = tablaPolizaDelMes(fecha);
  return t ? t.slice(4) : null;
}

/**
 * Los departamentos padre que acumulan en `kdcn26`: cada prefijo por segmentos del departamento (`1-02` de
 * `1-02-32`) que EXISTE en `kdc3` del servidor. Medido (X-A-10 de oct–nov): 194 de 194 prefijos que están en
 * `kdc3` tienen su fila; 0 de 3,238 que no están.
 */
export function padresDelDepartamento(departamento: string, kdc3: ReadonlySet<string>): string[] {
  const seg = String(departamento ?? '').trim().split('-');
  const padres: string[] = [];
  for (let i = 1; i < seg.length; i++) {
    const p = seg.slice(0, i).join('-');
    if (p && kdc3.has(p)) padres.push(p);
  }
  return padres;
}

/** Una celda de `kdcn26`: lo que sube su `c7` (cargo − abono). */
export interface MovimientoCentroDeCosto { concepto: string; departamento: string; proyecto: string; periodo: string; importe: number }

/**
 * Lo que una póliza suma a `kdcn26` (`c7 += cargo − abono`). Cada renglón va a (concepto `c20`; departamento `c13`,
 * sus padres en `kdc3` y `*`; proyecto `c21` y `*`): `(2 + padres) × 2` celdas. Un renglón sin segmentos (el abono
 * al acreedor, el IVA) va igual, a (`''`; `''` y `*`; `''` y `*`): medido en 00, 05 y 07, noviembre, las 4 celdas
 * traen el mismo importe, que es el de TODOS los renglones sin segmentos del mes (de cualquier documento).
 */
export function movimientosKdcn26(p: PolizaKepler, kdc3: ReadonlySet<string>): MovimientoCentroDeCosto[] {
  const periodo = periodoKdcn26(p.fecha);
  if (!periodo) throw new Error(`Fecha de póliza inválida: ${p.fecha}`);
  const por = new Map<string, number>();
  for (const r of p.renglones) {
    const importe = Math.round(Number(r['c5'] ?? 0) * 100) * (r['c4'] === 'C' ? 1 : r['c4'] === 'A' ? -1 : 0);
    if (!importe) continue;
    const concepto = String(r['c20'] ?? '').trim();
    const depto = String(r['c13'] ?? '').trim();
    const proyecto = String(r['c21'] ?? '').trim();
    for (const d of [depto, ...padresDelDepartamento(depto, kdc3), '*']) {
      for (const pr of [proyecto, '*']) {
        const k = `${concepto}\u0000${d}\u0000${pr}`;
        por.set(k, (por.get(k) ?? 0) + importe);
      }
    }
  }
  return [...por.entries()].map(([k, c]) => {
    const [concepto, departamento, proyecto] = k.split('\u0000');
    return { concepto, departamento, proyecto, periodo, importe: c / 100 };
  }).sort((a, b) => (`${a.concepto}|${a.departamento}|${a.proyecto}` < `${b.concepto}|${b.departamento}|${b.proyecto}` ? -1 : 1));
}
