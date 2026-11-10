/**
 * `[CB.62]` C0 — **La sombra: lo que la Suite capturaría en Kepler con la descarga del banco, contra lo que
 * Finanzas capturó a mano.** SÓLO LECTURA (la base de prod con el rol de desarrollo, `dev_ro`).
 *
 *   npx esbuild ops/prod/sombra-comisiones-kepler/sombra.ts --bundle --platform=node \
 *     --tsconfig=tsconfig.base.json --external:pg --outfile=<scratchpad>/sombra.cjs
 *   NODE_PATH=node_modules DATABASE_URL=<url de sólo lectura> node <scratchpad>/sombra.cjs
 *
 * Corre el armador REAL (`comisiones-kepler.armador.ts`) sobre `finance.bank_statement_lines`:
 *   1. bloques depósito → comisión → IVA;
 *   2. cada depósito contra su `U-A-5` en Kepler (misma cuenta, importe exacto, ±3 días): sucursal y día de venta;
 *   3. plantilla del último gasto y pago de comisiones de esa sucursal y banco;
 *   4. el armado.
 * Y lo compara, cargo por cargo, con el `X-D-26` que Finanzas capturó (misma cuenta, importe, ±3 días) y el
 * gasto al que lo aplicó (`kdxf`): ¿misma sucursal?, ¿mismo día de venta?, ¿el gasto armado es el mismo
 * conjunto de cargos y el mismo total? Línea base: el día de venta ingenuo (día del cargo − 1).
 */
import { Client } from 'pg';
import {
  armarComisionesKepler, bloquesDeTarjeta, diaDeVentaDelTexto, gruposPorDiaDeVenta,
  type BloqueTarjeta, type PlantillaComisiones, type RenglonDescarga,
} from '../../../libs/finance/src/lib/bank/comisiones-kepler/comisiones-kepler.armador';

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
/** La póliza vive en una tabla por mes: `kdc2AAMM`. El nombre sale de una fecha validada, no de texto libre. */
const tablaPoliza = (d: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`fecha inválida para la póliza: ${d}`);
  return `kepler_ods.kdc2${d.slice(2, 4)}${d.slice(5, 7)}`;
};
/** Los renglones de una póliza como multiconjunto «cuenta|C/A|centavos», para comparar dos implementaciones. */
const huella = (rs: { c3: unknown; c4: unknown; c5: unknown }[]): string =>
  rs.map((r) => `${String(r.c3).trim()}|${String(r.c4).trim()}|${Math.round(Number(r.c5) * 100)}`).sort().join(' ');
const menosUno = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env['DATABASE_URL'] });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  const q = async <T = any>(sql: string, p: unknown[] = []): Promise<T[]> => (await db.query(sql, p)).rows as T[];

  const lineas: RenglonDescarga[] = (await q(`
    SELECT l.id::text, ba.account_label AS cuenta, l.movement_date AS fecha, l.seq, l.concept AS concepto,
           l.amount_in::float AS entra, l.amount_out::float AS sale
      FROM finance.bank_statement_lines l JOIN finance.bank_accounts ba ON ba.id = l.bank_account_id
     WHERE ba.account_label IS NOT NULL`)).map((r) => ({ ...r, fecha: iso(r.fecha), seq: Number(r.seq) }));
  const { bloques, huerfanos } = bloquesDeTarjeta(lineas);
  const cargos = bloques.flatMap((b) => b.cargos);
  const dias = [...new Set(lineas.map((l) => l.fecha))].sort();
  const cuentas = [...new Set(lineas.map((l) => l.cuenta))];

  // Kepler: el banco como acreedor por cuenta de tesorería (voto de sus X-D-26 GB*).
  const acreedorDe = new Map((await q(`
    SELECT DISTINCT ON (cta) cta, acr FROM (
      SELECT btrim(c45) cta, btrim(c10) acr, count(*) n FROM kepler_ods.kdm1
       WHERE c2='X' AND c3='D' AND c4=26 AND c43<>'C' AND btrim(c10) ~ '^GB' AND c9 >= now() - interval '120 days'
       GROUP BY 1,2) x ORDER BY cta, n DESC`)).map((r) => [r.cta, r.acr]));

  // Kepler: los depósitos U-A-5 de esas cuentas y días.
  const ua5 = await q(`
    SELECT sucursal, folio, account_label, importe::float, fecha_valor, concepto FROM analytics.kepler_bank_movements
     WHERE doc_tipo='U-A-5' AND signo > 0 AND account_label = ANY($1) AND fecha_valor BETWEEN $2::date - 3 AND $3::date + 3`,
    [cuentas, dias[0], dias[dias.length - 1]]);
  const motivosDonde: Record<string, number> = {};
  const donde = (b: BloqueTarjeta): { sucursal: string; diaVenta: string; acreedor: string } | { motivo: string } => {
    const m = ua5.filter((u) => u.account_label === b.deposito.cuenta && Math.abs(u.importe - b.deposito.importe) < 0.005
      && Math.abs(Date.parse(iso(u.fecha_valor)) - Date.parse(b.deposito.fecha)) <= 3 * 86_400_000);
    const r: { sucursal: string; diaVenta: string; acreedor: string } | { motivo: string } = m.length === 0 ? { motivo: 'el depósito no está en Kepler (U-A-5)' }
      : new Set(m.map((u) => `${u.sucursal}|${u.concepto}`)).size > 1 ? { motivo: 'dos U-A-5 con el mismo importe' }
        : !acreedorDe.get(b.deposito.cuenta) ? { motivo: 'la cuenta no tiene acreedor GB en Kepler' }
          : (() => {
            const dia = diaDeVentaDelTexto(m[0].concepto, b.deposito.fecha);
            return dia ? { sucursal: m[0].sucursal, diaVenta: dia, acreedor: acreedorDe.get(b.deposito.cuenta)! }
              : { motivo: `el U-A-5 no dice el día de venta («${m[0].concepto}»)` };
          })();
    if ('motivo' in r) motivosDonde[r.motivo] = (motivosDonde[r.motivo] ?? 0) + 1;
    return r;
  };
  const { grupos, sinResolver } = gruposPorDiaDeVenta(bloques, donde);

  // Plantillas: último gasto (cabecera + renglón) y último pago de comisiones de cada sucursal × banco.
  const plantillas = new Map<string, PlantillaComisiones>();
  for (const g of grupos) {
    const k = `${g.sucursal}|${g.acreedor}`;
    if (plantillas.has(k)) continue;
    const [gas] = await q(`SELECT m.c6, m.c9, m.c11, m.c30, d.c13, d.c16 FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm6 d ON d.sucursal=m.sucursal AND d.c2=m.c2 AND d.c3=m.c3 AND d.c4=m.c4 AND d.c5=m.c5 AND d.c6=m.c6
      WHERE m.sucursal=$1 AND m.c2='X' AND m.c3='A' AND m.c4=10 AND m.c43<>'C' AND btrim(m.c10)=$2 AND btrim(d.c8)='611-003' ORDER BY m.c9 DESC, m.c6 DESC LIMIT 1`, [g.sucursal, g.acreedor]);
    const [pag] = await q(`SELECT c12, c32, c33, c34, c35, c48 FROM kepler_ods.kdm1 WHERE sucursal=$1 AND c2='X' AND c3='D' AND c4=26 AND c43<>'C' AND btrim(c10)=$2 ORDER BY c9 DESC, c6 DESC LIMIT 1`, [g.sucursal, g.acreedor]);
    if (!gas || !pag) continue;
    const t = (v: unknown) => String(v ?? '').trim();
    // El abono del acreedor, de la póliza de ese mismo gasto (201 en las sucursales de TPV).
    const [abono] = await q(`SELECT btrim(c3) c3 FROM ${tablaPoliza(iso(gas.c9))} WHERE sucursal=$1 AND btrim(c15)='X' AND btrim(c16)='A' AND c17=10 AND btrim(c19)=$2 AND btrim(c4)='A' LIMIT 1`, [g.sucursal, t(gas.c6)]);
    plantillas.set(k, {
      acreedor: g.acreedor, nombre: t(pag.c32), domicilio: [t(pag.c33), t(pag.c34), t(pag.c35)], referenciaGasto: t(gas.c11), areaGasto: t(gas.c30),
      proyecto: t(gas.c13), departamento: t(gas.c16), conceptoPago: t(pag.c12), sucursalTexto: t(pag.c48), sucursalNombre: t(pag.c48),
      cuentaAcreedor: t(abono?.c3),
    });
  }

  // La verdad: el X-D-26 de Finanzas por cargo y el gasto al que lo aplicó.
  const kp = await q(`
    SELECT p.sucursal, p.c6 AS pago, btrim(p.c45) cta, p.c16::float importe, p.c9 fecha, x.c9 AS gasto, g.c9 AS dia_gasto, g.c16::float total_gasto
      FROM kepler_ods.kdm1 p
      LEFT JOIN kepler_ods.kdxf x ON x.sucursal=p.sucursal AND x.c4=26 AND x.c5=p.c5 AND x.c6=p.c6 AND x.c7=10
      LEFT JOIN kepler_ods.kdm1 g ON g.sucursal=x.sucursal AND g.c2='X' AND g.c3='A' AND g.c4=10 AND g.c5=x.c8 AND g.c6=x.c9 AND g.c43<>'C'
     WHERE p.c2='X' AND p.c3='D' AND p.c4=26 AND p.c43<>'C' AND btrim(p.c10) ~ '^GB' AND btrim(p.c45) = ANY($1)
       AND p.c9 BETWEEN $2::date - 3 AND $3::date + 3`, [cuentas, dias[0], dias[dias.length - 1]]);
  const enGrupo = new Map<string, { sucursal: string; dia: string }>();
  for (const g of grupos) for (const c of g.cargos) enGrupo.set(c.id, { sucursal: g.sucursal, dia: g.diaVenta });
  // Un IVA de $10.91 puede estar en dos sucursales el mismo día: entre importes iguales se desempata por la
  // sucursal que dijo el depósito y luego por cercanía de fecha. Sólo desempata; no crea pareos.
  const usados = new Set<number>();
  const verdad = new Map<string, any>();
  const dist = (k: any, f: string) => Math.abs(Date.parse(iso(k.fecha)) - Date.parse(f));
  for (const c of [...cargos, ...huerfanos]) {
    const suc = enGrupo.get(c.id)?.sucursal;
    const cand = kp.map((k, j) => ({ k, j })).filter(({ k, j }) => !usados.has(j) && k.cta === c.cuenta && Math.abs(k.importe - c.importe) < 0.005 && dist(k, c.fecha) <= 3 * 86_400_000)
      .sort((a, b) => Number(b.k.sucursal === suc) - Number(a.k.sucursal === suc) || dist(a.k, c.fecha) - dist(b.k, c.fecha));
    if (cand.length) { usados.add(cand[0].j); verdad.set(c.id, cand[0].k); }
  }
  // Lo que Finanzas pagó en esos días y cuentas y el detector no vio (recall).
  const kpDentro = kp.filter((k) => dias.includes(iso(k.fecha)));
  const noVistos = kpDentro.filter((k) => !usados.has(kp.indexOf(k)));

  // Por cargo: sucursal y día de venta, la cadena contra la línea base ingenua.
  let conVerdad = 0, mismaSuc = 0, mismoDia = 0, baseDia = 0, asignados = 0;
  for (const c of cargos) {
    const v = verdad.get(c.id); const s = enGrupo.get(c.id);
    if (!v || !v.dia_gasto) continue;
    conVerdad++;
    if (iso(v.dia_gasto) === menosUno(c.fecha)) baseDia++;
    if (!s) continue;
    asignados++;
    if (s.sucursal === v.sucursal) mismaSuc++;
    if (s.dia === iso(v.dia_gasto)) mismoDia++;
  }

  // Por grupo: ¿el gasto armado es exactamente un gasto de Finanzas (mismos cargos, mismo total)?
  let armados = 0, identicos = 0; const rechazos: Record<string, number> = {}; const difieren: string[] = [];
  const clase: Record<string, number> = {};
  const contar = (k: string) => { clase[k] = (clase[k] ?? 0) + 1; };
  let polizasGasto = 0, saldoCero = 0, pagosComparados = 0, polizasPago = 0;
  for (const g of grupos) {
    const p = plantillas.get(`${g.sucursal}|${g.acreedor}`);
    if (!p) { rechazos['sin plantilla'] = (rechazos['sin plantilla'] ?? 0) + 1; continue; }
    const r = armarComisionesKepler(g, p);
    if (!r.ok) { for (const m of r.motivos) rechazos[m.replace(/[\d.,]+/g, '#')] = (rechazos[m.replace(/[\d.,]+/g, '#')] ?? 0) + 1; continue; }
    armados++;
    const gastosK = new Set(g.cargos.map((c) => verdad.get(c.id)?.gasto ?? '¿?'));
    const unico = gastosK.size === 1 && !gastosK.has('¿?');
    const v = verdad.get(g.cargos.find((c) => verdad.get(c.id)?.gasto)?.id ?? '');
    // Los cargos de ese gasto de Kepler que la Suite NO puso en este día (Finanzas agrupó distinto).
    const ajenos = v ? kp.filter((k) => k.sucursal === v.sucursal && k.gasto === v.gasto).length - g.cargos.filter((c) => verdad.get(c.id)?.gasto === v.gasto).length : 0;
    const dc = v ? Math.round((v.total_gasto - r.plan.total) * 100) : null;
    const ok = unico && v && dc === 0 && iso(v.dia_gasto) === g.diaVenta && v.sucursal === g.sucursal && ajenos === 0;
    if (gastosK.size === 1 && gastosK.has('¿?')) contar('Finanzas aún no captura ese día');
    else if (ok) contar('idéntico al gasto de Finanzas');
    else if (v && iso(v.dia_gasto) === g.diaVenta && v.sucursal === g.sucursal && ajenos === 0 && dc !== null && Math.abs(dc) <= g.cargos.length) contar('mismo gasto, difiere en centavos (Finanzas ajustó un pago)');
    else contar('Finanzas agrupó distinto o un cargo falta de un lado');
    if (ok) {
      // Dos implementaciones de la misma póliza: la que armaría la Suite contra la que generó Kepler, renglón
      // por renglón (cuenta, cargo/abono, centavos); lo mismo para cada pago; y el saldo del gasto en kdxe.
      const kpol = await q(`SELECT c3, c4, c5 FROM ${tablaPoliza(g.diaVenta)} WHERE sucursal=$1 AND btrim(c15)='X' AND btrim(c16)='A' AND c17=10 AND btrim(c19)=$2`, [g.sucursal, String(v.gasto).trim()]);
      if (huella(kpol) === huella(r.plan.gasto.poliza.renglones as any)) polizasGasto++;
      else difieren.push(`póliza del gasto ${g.sucursal} ${v.gasto}: Suite [${huella(r.plan.gasto.poliza.renglones as any)}] · Kepler [${huella(kpol)}]`);
      const [sx] = await q(`SELECT c20::float c20 FROM kepler_ods.kdxe WHERE sucursal=$1 AND btrim(c2)=$2 AND c3='A' AND c4=10 AND btrim(c6)=$3`, [g.sucursal, g.acreedor, String(v.gasto).trim()]);
      if (sx && Math.abs(Number(sx.c20)) < 0.005) saldoCero++;
      for (const pg of r.plan.pagos) {
        const vk = verdad.get(pg.cargo);
        const kp2 = await q(`SELECT c3, c4, c5 FROM ${tablaPoliza(pg.poliza.fecha)} WHERE sucursal=$1 AND btrim(c15)='X' AND btrim(c16)='D' AND c17=26 AND btrim(c19)=$2`, [g.sucursal, String(vk.pago).trim()]);
        pagosComparados++;
        if (huella(kp2) === huella(pg.poliza.renglones as any)) polizasPago++;
      }
    }
    if (ok) identicos++;
    else difieren.push(`${g.sucursal} ${g.acreedor} venta ${g.diaVenta}: Suite $${r.plan.total.toFixed(2)} en ${g.cargos.length} cargos · Kepler ${[...gastosK].join('/')} ${v ? `$${Number(v.total_gasto).toFixed(2)} del ${iso(v.dia_gasto)}` : ''}`);
  }

  const out = {
    descarga: { renglones: lineas.length, dias, cuentas },
    deteccion: { cargos_en_bloque: cargos.length, huerfanos: huerfanos.length, pagos_de_Finanzas_en_esos_dias: kpDentro.length, pagos_que_el_detector_no_vio: noVistos.length,
      no_vistos: noVistos.slice(0, 20).map((k) => `${k.cta} ${iso(k.fecha)} $${k.importe}`) },
    dia_de_venta: { bloques: bloques.filter((b) => b.cargos.length).length, sin_resolver: sinResolver.length, motivos: motivosDonde },
    contra_Finanzas_por_cargo: { cargos_con_su_pago_en_Kepler: conVerdad, la_suite_les_asigno_dia: asignados, misma_sucursal: mismaSuc, mismo_dia_de_venta: mismoDia, linea_base_dia_menos_uno: baseDia },
    gastos: { grupos: grupos.length, armados, identicos_a_un_gasto_de_Finanzas: identicos, por_clase: clase,
      de_los_identicos: { poliza_del_gasto_igual_a_Kepler: polizasGasto, saldo_kdxe_en_cero: saldoCero, pagos: pagosComparados, poliza_del_pago_igual_a_Kepler: polizasPago }, rechazos, difieren: difieren.slice(0, 20) },
  };
  console.log(JSON.stringify(out, null, 2));
  if (process.env['SOMBRA_DETALLE']) {
    // Un renglón por cargo: el bloque, lo que dijo su U-A-5 y lo que hizo Finanzas.
    for (const b of bloques) for (const c of b.cargos) {
      const s = enGrupo.get(c.id); const v = verdad.get(c.id);
      const u = ua5.filter((x) => x.account_label === b.deposito.cuenta && Math.abs(x.importe - b.deposito.importe) < 0.005);
      console.log([c.cuenta, c.fecha, c.seq, c.tipo, c.importe, `dep ${b.deposito.importe}`, u.map((x) => `${x.sucursal}:${x.concepto}`).join(' | ') || '—',
        s ? `SUITE ${s.sucursal} ${s.dia}` : 'SUITE —', v ? `KEPLER ${v.sucursal} ${v.gasto ?? '¿?'} ${v.dia_gasto ? iso(v.dia_gasto) : ''}` : 'KEPLER —'].join(' · '));
    }
  }
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
