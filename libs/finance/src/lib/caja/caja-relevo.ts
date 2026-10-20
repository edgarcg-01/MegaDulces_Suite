import type { Knex } from 'knex';
import { diaDeFecha } from '@megadulces/contracts';
import { casarPorImporte, CUADRE_TOLERANCIA_PESOS } from './caja-cuadre.engine';
import { cobroDeRutaComoKepler, type CobroDeRuta } from './caja-kepler-libro.engine';

/**
 * `[CGA-A.43]` **Desde qué día la caja vive en el libro nuevo**: la fecha del PRIMER corte de
 * `finance.cash_ledger_cuts`. Una sola definición para todo el módulo.
 *
 * ── Por qué es el borde de la cola ───────────────────────────────────────────────────────────
 *
 * El Access Control dejó de capturar el 10-oct 12:39 y el primer corte del libro (`CC-2026-00001`,
 * 12-oct) abre con el fondo del arqueo `A23641` de ese día. Lo anterior a ese corte es de la era
 * Control: medido el 2026-10-20 con el Cuadre de `/finanzas/caja`, de 541 documentos de Kepler
 * del 1 al 11-oct que la cola tenía «pendientes», Control ya había saldado todos salvo 15. Antes de
 * septiembre son 11,404 más. Ninguno de ésos es trabajo del libro.
 *
 * Desde el corte en adelante, en cambio, la cola es exacta: medido ese día, 61 documentos /
 * $779,568.24. Por eso la bandeja deja de necesitar una ventana de días (Edgar, 2026-10-20: «ya
 * sabemos qué movimientos están pendientes»).
 *
 * Sale de los DATOS, no de una constante: si el libro arrancara otro día, o se reiniciara, el borde
 * se mueve solo.
 *
 * @returns `YYYY-MM-DD`, o `null` si todavía no hay ningún corte (y entonces el llamador decide su
 *          ventana de siempre).
 */
export async function primerCorteDelLibro(trx: Knex | Knex.Transaction, tenantId: string): Promise<string | null> {
  const r: { fecha: unknown } | undefined = await trx('finance.cash_ledger_cuts')
    .where('tenant_id', tenantId).orderBy('fecha', 'asc').first('fecha');
  return r ? diaDeFecha(r.fecha) ?? null : null;
}

/** `[CGA-A.44]` El primer día del mes de una fecha `YYYY-MM-DD`. */
export function inicioDelMes(dia: string): string {
  return `${dia.slice(0, 7)}-01`;
}

/** `[CGA-A.44]` El día anterior a una fecha `YYYY-MM-DD` (aritmética de calendario, sin zona). */
export function diaAnterior(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Un movimiento reducido a lo que el casamiento del Cuadre necesita, con su día y dirección. */
export interface MovDelDia { key: string; importe: number; fecha: string; dir: 'in' | 'out' }

/**
 * `[CGA-A.44]` **Qué documentos de Kepler ya saldó el Control**, con el MISMO casamiento que el
 * Cuadre de `/finanzas/caja`: por día y por dirección, `casarPorImporte` con ±$5. Devuelve las
 * llaves de Kepler (`sucursal|doc|folio|clave`) que casaron. Función pura: los datos los trae
 * `saldadosPorControl`.
 *
 * ⚠️ Es por DÍA, igual que el Cuadre: un cobro que el Control anotó días después NO se da por
 * saldado aquí (no aguantó el placebo como regla — `[CGA-A.35]`). Así que lo que la cola muestre
 * de la era Control es un TECHO de lo que falta, no la cifra exacta, y la pantalla lo dice.
 */
export function casadosPorControl(control: MovDelDia[], kepler: MovDelDia[], tolerancia = CUADRE_TOLERANCIA_PESOS): Set<string> {
  const out = new Set<string>();
  const llave = (m: MovDelDia) => `${m.fecha}|${m.dir}`;
  const kPor = new Map<string, MovDelDia[]>();
  for (const k of kepler) { const g = kPor.get(llave(k)); if (g) g.push(k); else kPor.set(llave(k), [k]); }
  const cPor = new Map<string, MovDelDia[]>();
  for (const c of control) { const g = cPor.get(llave(c)); if (g) g.push(c); else cPor.set(llave(c), [c]); }
  for (const [g, cs] of cPor) {
    const ks = kPor.get(g);
    if (!ks) continue;
    for (const p of casarPorImporte(cs, ks, tolerancia).pares) out.add(p.otro.key);
  }
  return out;
}

/**
 * `[CGA-A.44]` Lee el Control y la Caja General de Kepler (tesorería + cobros de camioneta) de un
 * rango de la era Control y devuelve las llaves que el Control ya saldó. Las mismas fuentes que usa
 * el Cuadre (`kepler_bank_movements` con `account_label='CG'` y `route_collections` cuenta 0011),
 * para que la cola y el Cuadre no puedan decir cosas distintas.
 *
 * ⚠️ Los cobros de camioneta van en SAVEPOINT (se leen por FDW): si fallan, se devuelve
 * `ruta_disponible: false` y esos cobros NO se dan por saldados — quedan visibles en la cola. Es
 * el lado seguro: mostrar de más se corrige mirando; esconder no se ve.
 */
export async function saldadosPorControl(trx: Knex.Transaction, tenantId: string, from: string, to: string): Promise<{ llaves: Set<string>; ruta_disponible: boolean }> {
  const n = (x: unknown) => Number(x) || 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const ctl: Array<{ tipo_dto: unknown; mov_id: unknown; fecha: unknown; ingreso: unknown; gasto: unknown }> = await trx('analytics.caja_general_movimientos')
    .where('tenant_id', tenantId).whereBetween('fecha', [from, to])
    .select('tipo_dto', 'mov_id', 'fecha', 'ingreso', 'gasto');
  // ⚠️ `mv_caja_movimientos` (materializada) y no `kepler_bank_movements` (la vista viva que lee el
  // Cuadre): la viva tardó 3.0–3.4 s para 10 días y esto corre en cada carga de la cola. Medido el
  // 2026-10-20 del 1-sep al 20-oct: 2,073 documentos en las dos, CERO diferencias en llave, fecha,
  // importe y signo. Si algún día divergen, la cola y el Cuadre dejarían de coincidir: el control es
  // comparar las dos con EXCEPT, como se hizo aquí.
  const tes: Array<{ sucursal: string; doc_tipo: string; folio: string; clave_banco: string; fecha: unknown; importe: unknown; signo: unknown }> = await trx('analytics.mv_caja_movimientos')
    .where('tenant_id', tenantId).andWhere('clave_banco', '0011')
    .andWhere('fecha_valor', '>=', from).andWhere('fecha_valor', '<=', to)
    .select('sucursal', 'doc_tipo', 'folio', 'clave_banco', 'fecha_valor as fecha', 'importe', 'signo');
  let ruta: ReturnType<typeof cobroDeRutaComoKepler>[] = [];
  let ruta_disponible = true;
  await trx.raw('SAVEPOINT cga_a44_ruta');
  try {
    const rc: CobroDeRuta[] = await trx('analytics.route_collections')
      .where('tenant_id', tenantId).andWhere('cuenta', '0011')
      .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
      .groupBy('almacen', 'cobro_folio', 'fecha')
      .select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'),
        trx.raw(`string_agg(DISTINCT truck, ' · ') AS truck`), trx.raw(`string_agg(DISTINCT COALESCE(referencia, folio_corte), ' · ') AS concepto`));
    await trx.raw('RELEASE SAVEPOINT cga_a44_ruta');
    ruta = rc.map(cobroDeRutaComoKepler);
  } catch {
    await trx.raw('ROLLBACK TO SAVEPOINT cga_a44_ruta').catch(() => undefined);
    ruta_disponible = false;
  }
  const control: MovDelDia[] = [];
  for (const r of ctl) {
    const fecha = diaDeFecha(r.fecha) ?? '';
    const key = `${String(r.tipo_dto)}|${String(r.mov_id)}`;
    if (n(r.ingreso) > 0) control.push({ key, fecha, dir: 'in', importe: r2(n(r.ingreso)) });
    if (n(r.gasto) > 0) control.push({ key, fecha, dir: 'out', importe: r2(n(r.gasto)) });
  }
  const kepler: MovDelDia[] = [...tes, ...ruta].map((r) => ({
    key: `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`,
    fecha: diaDeFecha(r.fecha) ?? '',
    dir: n(r.signo) > 0 ? 'in' as const : 'out' as const,
    importe: r2(n(r.importe)),
  }));
  return { llaves: casadosPorControl(control, kepler), ruta_disponible };
}
