/**
 * `[CB.62]` C0 — **La sombra: lo que la Suite capturaría en Kepler con la descarga del banco, contra lo que
 * Finanzas capturó a mano.** SÓLO LECTURA (la base de prod con el rol de desarrollo, `dev_ro`).
 *
 *   npx esbuild ops/prod/sombra-comisiones-kepler/sombra.ts --bundle --platform=node \
 *     --tsconfig=tsconfig.base.json --external:pg --external:knex --outfile=<scratchpad>/sombra.cjs
 *   NODE_PATH=node_modules DATABASE_URL=<url de sólo lectura> node <scratchpad>/sombra.cjs [desde] [hasta]
 *
 * Corre `leerPropuesta` —la MISMA consulta que el servicio `GET finance/bank/comisiones-kepler`— con
 * `armarTodo` (arma también lo que Finanzas ya capturó) y la compara, cargo por cargo, con el `X-D-26` que
 * Finanzas capturó y el gasto al que lo aplicó (`kdxf`):
 *   · ¿misma sucursal?, ¿mismo día de venta? (línea base: el día del cargo − 1);
 *   · ¿el gasto armado es el mismo conjunto de cargos y el mismo total?;
 *   · de los idénticos: ¿la póliza del gasto y la de cada pago son iguales renglón por renglón a las de Kepler?,
 *     ¿el saldo del gasto en `kdxe` está en 0?
 * Y mide cuánto tarda la consulta del servicio.
 */
import knexFactory from 'knex';
import { leerPropuesta, tablaPoliza } from '../../../libs/finance/src/lib/bank/comisiones-kepler/comisiones-kepler.query';

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const menosUno = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
/** Los renglones de una póliza como multiconjunto «cuenta|C/A|centavos», para comparar dos implementaciones. */
const huella = (rs: { c3?: unknown; c4?: unknown; c5?: unknown }[]): string =>
  rs.map((r) => `${String(r.c3).trim()}|${String(r.c4).trim()}|${Math.round(Number(r.c5) * 100)}`).sort().join(' ');

async function main(): Promise<void> {
  const db = knexFactory({ client: 'pg', connection: process.env['DATABASE_URL'], pool: { min: 1, max: 1, afterCreate: (c: any, done: any) => c.query('SET default_transaction_read_only = on', (e: unknown) => done(e, c)) } });
  const desde = process.argv[2] ?? '2026-10-01';
  const hasta = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  const q = async (sql: string, p: readonly (string | number | null)[] = []): Promise<any[]> => (await db.raw(sql, p as (string | number | null)[])).rows;

  const t0 = Date.now();
  const prop = await leerPropuesta(db, TENANT, desde, hasta, { armarTodo: true });
  const ms = Date.now() - t0;
  const tSvc = Date.now();
  await leerPropuesta(db, TENANT, desde, hasta);
  const msSvc = Date.now() - tSvc;

  // La verdad: cada pago de Finanzas pareado → el gasto al que lo aplicó.
  const pares = prop.dias.flatMap((d) => d.cargos).concat(prop.por_revisar.flatMap((b) => b.cargos), prop.huerfanos).filter((c) => c.kepler_pago);
  const verdad = new Map<string, { gasto: string | null; dia: string | null; total: number | null; sucursal: string; pago: string }>();
  for (const c of pares) {
    const [r] = await q(`SELECT btrim(x.c9) AS gasto, to_char(g.c9, 'YYYY-MM-DD') AS dia, g.c16::float AS total
        FROM kepler_ods.kdxf x JOIN kepler_ods.kdm1 g ON g.sucursal = x.sucursal AND g.c2 = 'X' AND g.c3 = 'A' AND g.c4 = 10 AND g.c5 = x.c8 AND g.c6 = x.c9 AND g.c43 <> 'C'
       WHERE x.sucursal = ? AND x.c4 = 26 AND x.c5 = 1 AND btrim(x.c6) = ? AND x.c7 = 10 LIMIT 1`, [c.kepler_sucursal, c.kepler_pago]);
    verdad.set(c.id, { gasto: r?.gasto ?? null, dia: r?.dia ?? null, total: r?.total ?? null, sucursal: c.kepler_sucursal!, pago: c.kepler_pago! });
  }

  let conVerdad = 0, asignados = 0, mismaSuc = 0, mismoDia = 0, baseDia = 0;
  for (const d of prop.dias) for (const c of d.cargos) {
    const v = verdad.get(c.id);
    if (!v?.dia) continue;
    conVerdad++; asignados++;
    if (v.dia === menosUno(c.fecha)) baseDia++;
    if (v.sucursal === d.sucursal) mismaSuc++;
    if (v.dia === d.dia_venta) mismoDia++;
  }
  for (const c of prop.por_revisar.flatMap((b) => b.cargos).concat(prop.huerfanos)) {
    const v = verdad.get(c.id);
    if (!v?.dia) continue;
    conVerdad++;
    if (v.dia === menosUno(c.fecha)) baseDia++;
  }

  const clase: Record<string, number> = {};
  const contar = (k: string) => { clase[k] = (clase[k] ?? 0) + 1; };
  const difieren: string[] = [];
  let identicos = 0, polizasGasto = 0, saldoCero = 0, pagosComparados = 0, polizasPago = 0;
  for (const d of prop.dias) {
    const gastos = new Set(d.cargos.map((c) => verdad.get(c.id)?.gasto ?? '¿?'));
    const v = d.cargos.map((c) => verdad.get(c.id)).find((x) => x?.gasto);
    if (!d.plan) { contar(`sin armar (${d.estado}: ${d.motivos[0] ?? ''})`); continue; }
    if (!v) { contar('Finanzas aún no captura ese día'); continue; }
    // Los pagos vivos aplicados a ese gasto que la Suite no puso en este día (un pago cancelado deja su kdxf).
    const ajenos = (await q(`SELECT count(*)::int AS n FROM kepler_ods.kdxf x
        JOIN kepler_ods.kdm1 p ON p.sucursal = x.sucursal AND p.c2 = 'X' AND p.c3 = 'D' AND p.c4 = 26 AND p.c5 = x.c5 AND p.c6 = x.c6 AND p.c43 <> 'C'
       WHERE x.sucursal = ? AND x.c4 = 26 AND x.c7 = 10 AND btrim(x.c9) = ?`, [v.sucursal, v.gasto]))[0].n
      - d.cargos.filter((c) => verdad.get(c.id)?.gasto === v.gasto).length;
    const dc = Math.round(((v.total ?? 0) - d.plan.total) * 100);
    const mismo = gastos.size === 1 && !gastos.has('¿?') && v.dia === d.dia_venta && v.sucursal === d.sucursal && ajenos === 0;
    if (mismo && dc === 0) {
      contar('idéntico al gasto de Finanzas'); identicos++;
      const kpol = await q(`SELECT c3, c4, c5 FROM ${tablaPoliza(d.dia_venta)} WHERE sucursal = ? AND btrim(c15) = 'X' AND btrim(c16) = 'A' AND c17 = 10 AND btrim(c19) = ?`, [d.sucursal, v.gasto]);
      if (huella(kpol) === huella(d.plan.gasto.poliza.renglones)) polizasGasto++;
      else difieren.push(`póliza del gasto ${d.sucursal} ${v.gasto}: Suite [${huella(d.plan.gasto.poliza.renglones)}] · Kepler [${huella(kpol)}]`);
      const [sx] = await q(`SELECT c20::float AS c20 FROM kepler_ods.kdxe WHERE sucursal = ? AND btrim(c2) = ? AND c3 = 'A' AND c4 = 10 AND btrim(c6) = ?`, [d.sucursal, d.acreedor, v.gasto]);
      if (sx && Math.abs(Number(sx.c20)) < 0.005) saldoCero++;
      for (const pg of d.plan.pagos) {
        const vk = verdad.get(pg.cargo)!;
        const kp2 = await q(`SELECT c3, c4, c5 FROM ${tablaPoliza(pg.poliza.fecha)} WHERE sucursal = ? AND btrim(c15) = 'X' AND btrim(c16) = 'D' AND c17 = 26 AND btrim(c19) = ?`, [d.sucursal, vk.pago]);
        pagosComparados++;
        if (huella(kp2) === huella(pg.poliza.renglones)) polizasPago++;
      }
      continue;
    }
    if (mismo && Math.abs(dc) <= d.cargos.length) contar('mismo gasto, difiere en centavos (Finanzas ajustó un pago)');
    else contar('Finanzas agrupó distinto o un cargo falta de un lado');
    difieren.push(`${d.sucursal} ${d.acreedor} venta ${d.dia_venta}: Suite $${d.plan.total.toFixed(2)} en ${d.cargos.length} cargos · Kepler ${[...gastos].join('/')} $${(v.total ?? 0).toFixed(2)} del ${v.dia}`);
  }

  console.log(JSON.stringify({
    rango: { desde, hasta }, consulta_del_servicio_ms: msSvc, con_armarTodo_ms: ms,
    resumen_del_servicio: prop.resumen,
    por_revisar: Object.entries(prop.por_revisar.reduce<Record<string, number>>((a, b) => ({ ...a, [b.motivo]: (a[b.motivo] ?? 0) + 1 }), {})),
    estados: prop.dias.reduce<Record<string, number>>((a, d) => ({ ...a, [d.estado]: (a[d.estado] ?? 0) + 1 }), {}),
    contra_Finanzas_por_cargo: { cargos_con_su_gasto_en_Kepler: conVerdad, la_suite_les_asigno_dia: asignados, misma_sucursal: mismaSuc, mismo_dia_de_venta: mismoDia, linea_base_dia_menos_uno: baseDia },
    gastos: { dias: prop.dias.length, identicos_a_un_gasto_de_Finanzas: identicos, por_clase: clase,
      de_los_identicos: { poliza_del_gasto_igual_a_Kepler: polizasGasto, saldo_kdxe_en_cero: saldoCero, pagos: pagosComparados, poliza_del_pago_igual_a_Kepler: polizasPago },
      difieren: difieren.slice(0, 20) },
  }, null, 2));
  await db.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
