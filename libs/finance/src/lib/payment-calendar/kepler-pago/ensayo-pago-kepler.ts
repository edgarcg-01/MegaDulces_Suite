import type { PlanPagoKepler } from './pago-kepler.armador';

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
  return { coincide: d.length === 0, diferencias: d };
}

/** Lo que el adaptador todavía no escribe de las 8 escrituras de un pago (FASE_PGP §4): se declara en cada ensayo. */
export const NO_CUBIERTO_POR_EL_ENSAYO = [
  'kdm5: un renglón por factura',
  'kdxg: el acumulado del acreedor por mes',
  'kdc2AAMM: la póliza del mes en Kepler',
  'kdc126: los acumulados contables de la cuenta',
] as const;
