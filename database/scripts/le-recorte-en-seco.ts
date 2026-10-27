/**
 * `[LE.5.3]` — Rehace en seco TODOS los cortes de Caja General con el motor del libro (sólo lectura).
 *
 * Por cada corte B con su corte anterior A contado por pieza:
 *   esperado(B) = cierre contado de A + lo que el MOTOR dice que movió el cajón en B
 * y se compara contra el cierre contado de B, denominación por denominación. Cada día empieza de
 * un conteo físico, así que un error de un día no se arrastra al siguiente. El «esperado» del
 * sistema viejo NO se usa: mezcla dinero que nunca pasó por el cajón (depósitos de ruta a CAOS).
 *
 * Lo que queda es la diferencia REAL — o un movimiento de CAOS sin ligar del mismo día. Para eso se
 * busca el subconjunto de esos movimientos cuyo efecto en el cajón cuadra la diferencia EXACTO en
 * todas las denominaciones (un monto que cuadra por casualidad no basta: tienen que cuadrar las piezas).
 *
 *   npx esbuild database/scripts/le-recorte-en-seco.ts --bundle --platform=node \
 *     --external:pg --outfile=<scratchpad>/le-recorte.js
 *   node -e "require('dotenv').config(); require('<scratchpad>/le-recorte.js')"
 */
/* eslint-disable @nx/enforce-module-boundaries */
import { hechoDeCaptura, type CapturaVieja, type PiezaCapturada } from '../../libs/finance/src/lib/cashbook/captura';
import { piezasQueEntranALaMaquina, type MovimientoCaos } from '../../libs/finance/src/lib/cashbook/identidad';
import type { Contexto } from '../../libs/finance/src/lib/cashbook/reglas';
import { valorDePiezas } from '../../libs/contracts/src/money/centavos';
/* eslint-enable @nx/enforce-module-boundaries */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const PROD_ID = '7688376744939610156';
const CTX: Contexto = { actor: { kind: 'servicio', service: 'recorte-en-seco' }, valueAt: '2026-10-27T00:00:00-06:00' };
type Vec = Map<string, bigint>;
const suma = (a: Vec, b: Record<string, string> | Vec, s = 1n): void => {
  for (const [k, v] of b instanceof Map ? b : Object.entries(b)) a.set(k, (a.get(k) ?? 0n) + s * BigInt(v));
};
const valor = (v: Vec): bigint => valorDePiezas(Object.fromEntries([...v].filter(([, n]) => n !== 0n).map(([k, n]) => [k, Number(n)])));
/** Billetes se comparan pieza por pieza; las monedas junto con la morralla (son las mismas monedas, sin desglose). */
const BILLETES = new Set(['1000', '500', '200', '100', '50', '20']);
const parte = (v: Vec, billetes: boolean): Vec => new Map([...v].filter(([k]) => BILLETES.has(k) === billetes));
const pesos = (c: bigint): string => `$${(Number(c) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
const limpio = (v: Vec): Record<string, string> => Object.fromEntries([...v].filter(([, n]) => n !== 0n).map(([k, n]) => [k, n.toString()]));
const iguales = (a: Vec, b: Vec): boolean => [...new Set([...a.keys(), ...b.keys()])].every((k) => (a.get(k) ?? 0n) === (b.get(k) ?? 0n));

(async () => {
  const c = new Client({ connectionString: process.env['PROD_DB_URL'] });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    if ((await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id !== PROD_ID) throw new Error('no es prod');
    await c.query(`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-00000000d01c', true)`);

    const cortes = (await c.query(`
      SELECT c.id, c.folio, c.fecha::text, coalesce(c.morralla, 0)::text AS morralla, c.contado::text, c.esperado::text, c.diferencia::text,
             coalesce(json_object_agg(d.denom_key, d.piezas) FILTER (WHERE d.denom_key IS NOT NULL), '{}') AS piezas
        FROM finance.cash_ledger_cuts c
        LEFT JOIN finance.cash_ledger_cut_denominations d ON d.cut_id = c.id AND d.momento = 'cierre'
       GROUP BY c.id ORDER BY c.fecha, c.folio`)).rows as { id: string; folio: string; fecha: string; morralla: string; contado: string | null;
        esperado: string | null; diferencia: string | null; piezas: Record<string, number> }[];

    const capturas = (await c.query(`
      SELECT l.id, l.folio, l.tipo, l.origen_tipo, l.origen_ref, l.origen_efectivo, l.estado, l.monto::text, l.morralla::text,
             coalesce(l.kepler_concepto_nombre, l.glosa) AS concepto, l.corte_id, l.fecha::text,
             coalesce((SELECT json_agg(json_build_object('denom_key', d.denom_key, 'flujo', d.flujo, 'piezas', d.piezas))
                         FROM finance.cash_ledger_denominations d WHERE d.cash_ledger_id = l.id), '[]') AS piezas,
             EXISTS (SELECT 1 FROM finance.caos_cash_links k WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL) AS ligada_a_caos,
             (SELECT regexp_replace(min(r.truck), '^ruta_0*', '') FROM analytics.route_collections r
               WHERE r.almacen || '|U-A-5|' || r.cobro_folio || '|' || r.cuenta = l.origen_ref) AS ruta,
             split_part(l.origen_ref, '|', 1) AS almacen
        FROM finance.cash_ledger l WHERE l.deleted_at IS NULL`)).rows as (Omit<CapturaVieja, 'sucursal'> & { corte_id: string | null; fecha: string; almacen: string })[];

    const caos = (await c.query(`
      SELECT m.device, m.external_id::text, m.type_id, m.type_label, m.occurred_at, m.total::text, m.ref, m.user_external,
             (m.occurred_at AT TIME ZONE 'America/Mexico_City')::date::text AS dia,
             EXISTS (SELECT 1 FROM finance.caos_cash_links k WHERE k.caos_external_id = m.external_id AND k.deleted_at IS NULL) AS ligado,
             coalesce(json_agg(json_build_object('denom', d.denom::text, 'pieza_tipo', d.pieza_tipo, 'quantity', d.quantity::text))
                      FILTER (WHERE d.movement_id IS NOT NULL), '[]') AS piezas
        FROM analytics.caos_cash_movements m LEFT JOIN analytics.caos_cash_denominations d ON d.movement_id = m.id
       WHERE m.type_id <> 2 GROUP BY m.id ORDER BY m.external_id`)).rows as (MovimientoCaos & { dia: string; ligado: boolean })[];

    let totalReal = 0n;
    console.log('corte          fecha       contado        esperado(motor)  diferencia(motor)  dif. sistema viejo   explicación');
    for (let i = 1; i < cortes.length; i++) {
      const A = cortes[i - 1];
      const B = cortes[i];
      if (!Object.keys(A.piezas).length || !Object.keys(B.piezas).length) {
        console.log(`${B.folio}  ${B.fecha}  NO MEDIDO: ${!Object.keys(A.piezas).length ? A.folio : B.folio} no tiene conteo por pieza`);
        continue;
      }
      const esperado: Vec = new Map();
      suma(esperado, Object.fromEntries(Object.entries(A.piezas).map(([k, n]) => [k, String(n)])));
      let morralla = BigInt(Math.round(Number(A.morralla) * 100));
      const fuera: string[] = [];
      const cola: string[] = [];
      const delCorte = capturas.filter((x) => x.corte_id === B.id);
      for (const x of delCorte) {
        const d = hechoDeCaptura({ ...x, piezas: x.piezas as PiezaCapturada[], sucursal: x.ruta ? null : x.almacen }, CTX);
        if (d.destino === 'fuera') { fuera.push(`${x.folio} ${x.monto} (${d.motivo})`); continue; }
        if (d.destino === 'cola') { cola.push(`${x.folio} ${x.monto} (${d.motivo})`); continue; }
        for (const l of d.propuesta.asiento.lines) {
          if (l.account === 'CAJA_MXN' && l.pieces) suma(esperado, l.pieces);
          if (l.account === 'MORRALLA_MXN') morralla += BigInt(l.amount_minor);
        }
      }
      // HIPÓTESIS (la de las cajeras, por medir): lo que sale de CAOS SIN ligar a una captura (Dispensar,
      // Vaciar, Cambio) pasa por el cajón, y un Dotar sale del cajón. Los depósitos sin ligar son de ruta: no.
      const hipotesis = process.env['LE_RECORTE_CAOS_AL_CAJON'] === '1';
      if (hipotesis) {
        for (const m of caos.filter((x) => x.dia === B.fecha && !x.ligado && x.type_id !== 0)) {
          const p = piezasQueEntranALaMaquina(m);
          if (p) suma(esperado, p, -1n);
        }
      }
      const contado: Vec = new Map();
      suma(contado, Object.fromEntries(Object.entries(B.piezas).map(([k, n]) => [k, String(n)])));
      const residuo: Vec = new Map(contado);
      suma(residuo, esperado, -1n);
      const morrallaContada = BigInt(Math.round(Number(B.morralla) * 100));
      const difMorralla = morrallaContada - morralla;

      // ¿Lo explica la máquina? Movimientos de CAOS SIN ligar del día; efecto en el cajón = −(lo que entra a la máquina).
      const sueltos = caos.filter((m) => m.dia === B.fecha && !m.ligado).map((m) => {
        const p = piezasQueEntranALaMaquina(m);
        const v: Vec = new Map();
        if (p) suma(v, p, -1n);
        return { m, v };
      }).filter((s) => s.v.size > 0);
      let explicacion = '';
      if (valor(residuo) !== 0n && sueltos.length && sueltos.length <= 16) {
        for (let mask = 1; mask < 1 << sueltos.length; mask++) {
          const acum: Vec = new Map();
          const usados: string[] = [];
          sueltos.forEach((s, j) => { if (mask & (1 << j)) { suma(acum, s.v); usados.push(`#${s.m.external_id} ${s.m.type_label}`); } });
          if (iguales(acum, residuo)) { explicacion = `= CAOS sin ligar: ${usados.join(' + ')}`; break; }
        }
      }
      const dif = valor(residuo) + difMorralla;
      if (!explicacion) totalReal += dif < 0n ? -dif : dif;
      console.log(`${B.folio}  ${B.fecha}  ${pesos(valor(contado) + morrallaContada).padStart(13)}  ${pesos(valor(esperado) + morralla).padStart(15)}  ${pesos(dif).padStart(17)}  ${(B.diferencia ? pesos(BigInt(Math.round(Number(B.diferencia) * 100))) : '—').padStart(18)}   ${explicacion || (dif === 0n ? 'cuadra al centavo' : 'DIFERENCIA REAL')}`);
      const difBilletes = valor(parte(residuo, true));
      const difMonedas = valor(parte(residuo, false)) + difMorralla;
      console.log(`      billetes: ${pesos(difBilletes)} ${JSON.stringify(limpio(parte(residuo, true)))} · monedas + morralla: ${pesos(difMonedas)}`);
      console.log(`      capturas del corte: ${delCorte.length} · fuera ${fuera.length} · cola ${cola.length} · CAOS sin ligar del día ${sueltos.length}`);
      for (const q of cola) console.log(`        cola: ${q}`);
      if (!explicacion && valor(residuo) !== 0n) for (const s of sueltos) console.log(`        CAOS #${s.m.external_id} ${s.m.type_label} ${s.m.total} «${s.m.ref ?? ''}» cajón ${JSON.stringify(limpio(s.v))}`);
    }
    console.log(`\nSuma de |diferencias reales| sin explicación: ${pesos(totalReal)}`);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
})().catch((e) => { console.error('✗', (e as Error).message); process.exit(1); });
