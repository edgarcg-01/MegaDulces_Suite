import type { Knex } from 'knex';
import {
  armarComisionesKepler, bloquesDeTarjeta, cruzarConKepler, gruposPorDiaDeVenta, resolverBloque,
  type CargoTarjeta, type DepositoKepler, type PagoKeplerCapturado, type PlanComisionesKepler, type PlantillaComisiones, type RenglonDescarga,
} from './comisiones-kepler.armador';

/**
 * `[CB.62]` C2 (sólo lectura) — **La propuesta del día: qué comisiones de la descarga del banco irían a Kepler.**
 *
 * La misma consulta la usan el servicio (`GET finance/bank/comisiones-kepler`) y la sombra
 * (`ops/prod/sombra-comisiones-kepler`), para que lo que se mide contra prod sea lo que corre. NO escribe.
 *
 * Cada día de venta sale en uno de cuatro estados:
 *  - `lista`: armada y ningún cargo suyo tiene pago en Kepler;
 *  - `ya_en_kepler`: Finanzas ya capturó todos sus pagos a mano (el candado: no se escribe);
 *  - `parcial`: Finanzas capturó una parte: no se escribe, se revisa;
 *  - `rechazada`: el armador dice por qué no (IVA que no es el 16 %, plantilla incompleta…).
 * Y aparte, lo que no llega a un día: los bloques sin su depósito en Kepler y los cargos huérfanos.
 *
 * Sin ODS (CI, desarrollo) no hay Kepler que leer: `medido: false` con su motivo, nunca una lista vacía que
 * parezca «no hay comisiones» (ADR-056).
 */

export type EstadoDia = 'lista' | 'ya_en_kepler' | 'parcial' | 'rechazada';

export interface CargoPropuesta {
  id: string;
  cuenta: string;
  fecha: string;
  importe: number;
  tipo: 'comision' | 'iva';
  /** El `X-D-26` que Finanzas ya capturó para este cargo, si lo hay, y en qué sucursal. */
  kepler_pago: string | null;
  kepler_sucursal: string | null;
}

export interface DiaPropuesta {
  sucursal: string;
  dia_venta: string;
  acreedor: string;
  estado: EstadoDia;
  motivos: string[];
  total: number;
  iva: number;
  cargos: CargoPropuesta[];
  /** Lo que se escribiría: sólo cuando está `lista` (o, para medir, con `armarTodo`). */
  plan: PlanComisionesKepler | null;
}

export interface BloquePorRevisar {
  deposito: { id: string; cuenta: string; fecha: string; importe: number };
  cargos: CargoPropuesta[];
  motivo: string;
}

export interface PropuestaComisiones {
  medido: boolean;
  motivo: string | null;
  desde: string;
  hasta: string;
  dias: DiaPropuesta[];
  por_revisar: BloquePorRevisar[];
  huerfanos: CargoPropuesta[];
  resumen: { cargos: number; listos: number; ya_en_kepler: number; por_revisar: number; monto_listo: number };
}

type Db = Knex | Knex.Transaction;

/** La póliza vive en una tabla por mes (`kdc2AAMM`); el nombre sale de una fecha validada, no de texto libre. */
export function tablaPoliza(fecha: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`fecha inválida para la póliza: ${fecha}`);
  return `kepler_ods.kdc2${fecha.slice(2, 4)}${fecha.slice(5, 7)}`;
}

const t = (v: unknown): string => String(v ?? '').trim();
const cent = (n: number): number => Math.round(n * 100);

/** Plantilla de cada sucursal × banco: su último gasto de comisiones (con renglón 611-003) y su último pago. */
async function plantillas(db: Db, pares: { sucursal: string; acreedor: string }[], hasta: string): Promise<Map<string, PlantillaComisiones>> {
  const out = new Map<string, PlantillaComisiones>();
  for (const { sucursal, acreedor } of pares) {
    const gas = (await db.raw(`
      SELECT m.c6, to_char(m.c9, 'YYYY-MM-DD') AS fecha, m.c11, m.c30, d.c13, d.c16
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm6 d ON d.sucursal = m.sucursal AND d.c2 = m.c2 AND d.c3 = m.c3 AND d.c4 = m.c4 AND d.c5 = m.c5 AND d.c6 = m.c6
       WHERE m.sucursal = ? AND m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 10 AND m.c43 <> 'C' AND btrim(m.c10) = ?
         AND m.c9 >= ?::date - 120 AND btrim(d.c8) = '611-003'
       ORDER BY m.c9 DESC, m.c6 DESC LIMIT 1`, [sucursal, acreedor, hasta])).rows[0];
    const pag = (await db.raw(`
      SELECT c12, c32, c33, c34, c35, c48 FROM kepler_ods.kdm1
       WHERE sucursal = ? AND c2 = 'X' AND c3 = 'D' AND c4 = 26 AND c43 <> 'C' AND btrim(c10) = ? AND c9 >= ?::date - 120
       ORDER BY c9 DESC, c6 DESC LIMIT 1`, [sucursal, acreedor, hasta])).rows[0];
    if (!gas || !pag) continue;
    let cuentaAcreedor = '';
    // La tabla del mes puede no existir en un ODS que no la replica: sin ella, la plantilla queda incompleta
    // y el armador lo dice; no se inventa la cuenta.
    if ((await db.raw('SELECT to_regclass(?) AS r', [tablaPoliza(gas.fecha)])).rows[0]?.r) {
      cuentaAcreedor = t((await db.raw(`SELECT btrim(c3) AS c3 FROM ${tablaPoliza(gas.fecha)}
        WHERE sucursal = ? AND btrim(c15) = 'X' AND btrim(c16) = 'A' AND c17 = 10 AND btrim(c19) = ? AND btrim(c4) = 'A' LIMIT 1`, [sucursal, t(gas.c6)])).rows[0]?.c3);
    }
    out.set(`${sucursal}|${acreedor}`, {
      acreedor, nombre: t(pag.c32), domicilio: [t(pag.c33), t(pag.c34), t(pag.c35)], referenciaGasto: t(gas.c11), areaGasto: t(gas.c30),
      proyecto: t(gas.c13), departamento: t(gas.c16), conceptoPago: t(pag.c12), sucursalTexto: t(pag.c48), sucursalNombre: t(pag.c48), cuentaAcreedor,
    });
  }
  return out;
}

/**
 * `armarTodo` es para la sombra: arma también los días que Finanzas ya capturó (sin cambiarles el estado) para
 * compararlos con lo que capturó. El servicio no lo usa.
 */
export async function leerPropuesta(db: Db, tenantId: string, desde: string, hasta: string, opciones: { armarTodo?: boolean } = {}): Promise<PropuestaComisiones> {
  const vacia = (medido: boolean, motivo: string | null): PropuestaComisiones => ({
    medido, motivo, desde, hasta, dias: [], por_revisar: [], huerfanos: [], resumen: { cargos: 0, listos: 0, ya_en_kepler: 0, por_revisar: 0, monto_listo: 0 },
  });
  const ods = (await db.raw(`SELECT to_regclass('kepler_ods.kdm1') AS kdm1, to_regclass('kepler_ods.kdm6') AS kdm6, to_regclass('analytics.kepler_bank_movements') AS kbm`)).rows[0];
  if (!ods?.kdm1 || !ods?.kdm6 || !ods?.kbm) return vacia(false, 'Sin el ODS de Kepler en esta base: no se puede saber qué está capturado.');

  const lineas: RenglonDescarga[] = (await db.raw(`
    SELECT l.id::text AS id, ba.account_label AS cuenta, to_char(l.movement_date, 'YYYY-MM-DD') AS fecha, l.seq,
           l.concept AS concepto, l.amount_in::float AS entra, l.amount_out::float AS sale
      FROM finance.bank_statement_lines l JOIN finance.bank_accounts ba ON ba.id = l.bank_account_id
     WHERE l.tenant_id = ? AND l.movement_date BETWEEN ?::date AND ?::date AND ba.account_label IS NOT NULL`, [tenantId, desde, hasta])).rows
    .map((r: RenglonDescarga) => ({ ...r, seq: Number(r.seq), entra: Number(r.entra), sale: Number(r.sale) }));
  const { bloques, huerfanos } = bloquesDeTarjeta(lineas);
  const todos: CargoTarjeta[] = [...bloques.flatMap((b) => b.cargos), ...huerfanos];
  if (!todos.length) return vacia(true, null);

  const cuentas = [...new Set(todos.map((c) => c.cuenta))];
  const fechas = todos.map((c) => c.fecha).sort();
  const [f0, f1] = [fechas[0], fechas[fechas.length - 1]];

  // El banco como acreedor de cada cuenta de tesorería: voto de sus X-D-26 a bancos de los últimos 120 días.
  const acreedorDe = new Map<string, string>((await db.raw(`
    SELECT DISTINCT ON (cta) cta, acr FROM (
      SELECT btrim(c45) AS cta, btrim(c10) AS acr, count(*) AS n FROM kepler_ods.kdm1
       WHERE c2 = 'X' AND c3 = 'D' AND c4 = 26 AND c43 <> 'C' AND btrim(c10) LIKE 'GB%' AND btrim(c45) = ANY(?) AND c9 >= ?::date - 120
       GROUP BY 1, 2) x ORDER BY cta, n DESC`, [cuentas, f1])).rows.map((r: { cta: string; acr: string }) => [r.cta, r.acr]));

  const depositos: DepositoKepler[] = (await db.raw(`
    SELECT sucursal, folio, account_label AS cuenta, importe::float AS importe, to_char(fecha_valor, 'YYYY-MM-DD') AS fecha, coalesce(concepto, '') AS concepto
      FROM analytics.kepler_bank_movements
     WHERE doc_tipo = 'U-A-5' AND signo > 0 AND account_label = ANY(?) AND fecha_valor BETWEEN ?::date - 3 AND ?::date + 3`, [cuentas, f0, f1])).rows
    .map((r: DepositoKepler) => ({ ...r, importe: Number(r.importe) }));

  const pagos: PagoKeplerCapturado[] = (await db.raw(`
    SELECT sucursal, btrim(c6) AS folio, btrim(c45) AS cuenta, c16::float AS importe, to_char(c9, 'YYYY-MM-DD') AS fecha
      FROM kepler_ods.kdm1
     WHERE c2 = 'X' AND c3 = 'D' AND c4 = 26 AND c43 <> 'C' AND btrim(c10) LIKE 'GB%' AND btrim(c45) = ANY(?)
       AND c9 BETWEEN ?::date - 3 AND ?::date + 3`, [cuentas, f0, f1])).rows
    .map((r: PagoKeplerCapturado) => ({ ...r, importe: Number(r.importe) }));

  const { grupos, sinResolver } = gruposPorDiaDeVenta(bloques, (b) => resolverBloque(b, depositos, acreedorDe));
  const sucursalDe = new Map<string, string>();
  for (const g of grupos) for (const c of g.cargos) sucursalDe.set(c.id, g.sucursal);
  const enKepler = cruzarConKepler(todos.map((c) => ({ ...c, sucursal: sucursalDe.get(c.id) })), pagos);
  const vista = (c: CargoTarjeta): CargoPropuesta => ({ id: c.id, cuenta: c.cuenta, fecha: c.fecha, importe: c.importe, tipo: c.tipo, kepler_pago: enKepler.get(c.id)?.folio ?? null, kepler_sucursal: enKepler.get(c.id)?.sucursal ?? null });

  const pl = await plantillas(db, [...new Map(grupos.map((g) => [`${g.sucursal}|${g.acreedor}`, { sucursal: g.sucursal, acreedor: g.acreedor }])).values()], hasta);
  const dias: DiaPropuesta[] = grupos.map((g) => {
    const cargos = g.cargos.map(vista);
    const capturados = cargos.filter((c) => c.kepler_pago).length;
    const suma = (tipo?: 'iva') => cargos.filter((c) => !tipo || c.tipo === tipo).reduce((s, c) => s + cent(c.importe), 0) / 100;
    const base: Omit<DiaPropuesta, 'estado' | 'motivos' | 'plan'> = { sucursal: g.sucursal, dia_venta: g.diaVenta, acreedor: g.acreedor, total: suma(), iva: suma('iva'), cargos };
    const p = pl.get(`${g.sucursal}|${g.acreedor}`);
    const paraMedir = (): PlanComisionesKepler | null => {
      if (!opciones.armarTodo || !p) return null;
      const r = armarComisionesKepler(g, p);
      return r.ok ? r.plan : null;
    };
    if (capturados === cargos.length) return { ...base, estado: 'ya_en_kepler', motivos: ['Finanzas ya capturó estos pagos en Kepler'], plan: paraMedir() };
    if (capturados > 0) return { ...base, estado: 'parcial', motivos: [`Finanzas capturó ${capturados} de ${cargos.length} pagos: no se escribe encima`], plan: paraMedir() };
    if (!p) return { ...base, estado: 'rechazada', motivos: ['Sin un gasto de comisiones anterior de esta sucursal y banco del cual copiar la plantilla'], plan: null };
    const r = armarComisionesKepler(g, p);
    return r.ok ? { ...base, estado: 'lista', motivos: [], plan: r.plan } : { ...base, estado: 'rechazada', motivos: r.motivos, plan: null };
  });
  const por_revisar: BloquePorRevisar[] = sinResolver.map(({ bloque, motivo }) => ({
    deposito: { id: bloque.deposito.id, cuenta: bloque.deposito.cuenta, fecha: bloque.deposito.fecha, importe: bloque.deposito.importe },
    cargos: bloque.cargos.map(vista), motivo,
  }));
  const listos = dias.filter((d) => d.estado === 'lista');
  // Tres montones que no se enciman y suman el total: un día `lista` no tiene ningún cargo capturado.
  const nListos = listos.reduce((s, d) => s + d.cargos.length, 0);
  const nKepler = todos.filter((c) => enKepler.has(c.id)).length;
  return {
    medido: true, motivo: null, desde, hasta, dias, por_revisar, huerfanos: huerfanos.map(vista),
    resumen: {
      cargos: todos.length, listos: nListos, ya_en_kepler: nKepler, por_revisar: todos.length - nListos - nKepler,
      monto_listo: listos.reduce((s, d) => s + cent(d.total), 0) / 100,
    },
  };
}
