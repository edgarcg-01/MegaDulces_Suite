import type { PlanPagoKepler } from './pago-kepler.armador';
import type { MovimientoCuenta } from '../../shared/kepler-contable';

/**
 * `[PGP.105]` **El ensayo contra lo que Tesorería capturó a mano.** Cuando el `X-D-26` que la Suite
 * armaría y el que Tesorería capturó en Kepler coinciden, el armador está listo para escribir solo
 * (F3: dos semanas en verde). Puro: compara el plan con el documento real leído de la réplica.
 *
 * Se comparan los campos que deciden el dinero y la contabilidad: acreedor, importe, cuenta de
 * tesorería, concepto, IVA/IEPS y lo aplicado a cada factura. ⛔ NO se comparan la referencia
 * (`c11`: la Suite pone su folio, Tesorería el suyo), la hora ni el capturista: difieren por diseño.
 */
export interface CapturaKepler {
  folio: string;
  acreedor: string;
  importe: number;
  cuenta: string;
  concepto: string;
  iva: number;
  ieps: number;
  /** `tipo-subtipo-folio` de la factura → lo aplicado (`kdxf.c10`). */
  aplicaciones: Record<string, number>;
  /**
   * `[PGP.106]` La póliza que Kepler asentó a ese documento (`kdc2AAMM`), sumada por cuenta. `null` = la réplica
   * no la trae (NO MEDIDO: no se da por igual); ausente = no se compara.
   */
  poliza?: MovimientoCuenta[] | null;
}

const CENTAVO = 0.01;
const pesos = (n: number) => `$${n.toFixed(2)}`;

export function compararConCaptura(plan: PlanPagoKepler, real: CapturaKepler): { coincide: boolean; diferencias: string[] } {
  const d: string[] = [];
  const k = plan.kdm1;
  const num = (v: unknown) => Number(v ?? 0);
  if (String(k['c10'] ?? '').trim() !== real.acreedor.trim()) d.push(`Acreedor: la Suite ${k['c10']}, Tesorería ${real.acreedor}`);
  if (Math.abs(num(k['c16']) - real.importe) > CENTAVO) d.push(`Importe: la Suite ${pesos(num(k['c16']))}, Tesorería ${pesos(real.importe)}`);
  if (String(k['c45'] ?? '').trim() !== real.cuenta.trim()) d.push(`Cuenta de tesorería: la Suite ${k['c45']}, Tesorería ${real.cuenta}`);
  if (String(k['c12'] ?? '').trim() !== real.concepto.trim()) d.push(`Concepto: la Suite ${k['c12']}, Tesorería ${real.concepto}`);
  if (Math.abs(num(k['c81']) - real.iva) > CENTAVO) d.push(`IVA: la Suite ${pesos(num(k['c81']))}, Tesorería ${pesos(real.iva)}`);
  if (Math.abs(num(k['c84']) - real.ieps) > CENTAVO) d.push(`IEPS: la Suite ${pesos(num(k['c84']))}, Tesorería ${pesos(real.ieps)}`);
  const suite: Record<string, number> = {};
  for (const a of plan.kdxf) suite[`${a['c7']}-${a['c8']}-${a['c9']}`] = num(a['c10']);
  for (const f of new Set([...Object.keys(suite), ...Object.keys(real.aplicaciones)])) {
    const s = suite[f], t = real.aplicaciones[f];
    if (s === undefined) d.push(`Factura ${f}: Tesorería le aplicó ${pesos(t)} y la Suite no la paga`);
    else if (t === undefined) d.push(`Factura ${f}: la Suite le aplica ${pesos(s)} y Tesorería no la pagó en ese documento`);
    else if (Math.abs(s - t) > CENTAVO) d.push(`Factura ${f}: la Suite aplica ${pesos(s)}, Tesorería ${pesos(t)}`);
  }
  if (real.poliza === null) d.push('Póliza de Kepler: la réplica no la trae (NO MEDIDO)');
  else if (real.poliza) {
    const suya = new Map(plan.acumulados.cuentas.map((m) => [m.cuenta, m]));
    for (const cta of new Set([...suya.keys(), ...real.poliza.map((m) => m.cuenta)])) {
      const s = suya.get(cta) ?? { cuenta: cta, cargo: 0, abono: 0 };
      const t = real.poliza.find((m) => m.cuenta === cta) ?? { cuenta: cta, cargo: 0, abono: 0 };
      if (Math.abs(s.cargo - t.cargo) > CENTAVO || Math.abs(s.abono - t.abono) > CENTAVO) {
        d.push(`Póliza, cuenta ${cta}: la Suite cargo ${pesos(s.cargo)} abono ${pesos(s.abono)}, Kepler cargo ${pesos(t.cargo)} abono ${pesos(t.abono)}`);
      }
    }
  }
  return { coincide: d.length === 0, diferencias: d };
}

/** Lo que el adaptador todavía no escribe de las 8 escrituras de un pago (FASE_PGP §4): se declara en cada ensayo. */
export const NO_CUBIERTO_POR_EL_ENSAYO = [
  'kdm5: los renglones del pago (el armador los arma; la réplica no se compara renglón por renglón)',
  'kdxg y kdc126: los acumulados (se suman en el Kepler vivo; el ensayo de la réplica no los ve cambiar)',
] as const;
