import type { Knex } from 'knex';
import {
  armarComisionesKepler, bloquesDeTarjeta, cruzarConGastos, cruzarConKepler, gruposPorDiaDeVenta, resolverBloque, CUENTA_COMISION, MOTIVO_SIN_DEPOSITO,
  type CargoTarjeta, type DepositoKepler, type PagoKeplerCapturado, type PlanComisionesKepler, type PlantillaComisiones, type RenglonDescarga, type RenglonGastoCapturado,
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
  /** El texto ORIGINAL del renglón en la descarga del banco (el libro lo reescribe; éste no). */
  concepto: string;
  fecha: string;
  importe: number;
  tipo: 'comision' | 'iva';
  /** El `X-D-26` que Finanzas ya capturó para este cargo, si lo hay, y en qué sucursal. */
  kepler_pago: string | null;
  kepler_sucursal: string | null;
  /** Cuántos centavos capturó Finanzas de más (+) o de menos (−) contra el banco; 0 = exacto, null = sin pago. */
  kepler_ajuste_centavos: number | null;
  /** La solicitud o el gasto de Finanzas donde ya está esta comisión como renglón 611-003, si lo hay. */
  kepler_gasto: string | null;
}

export interface DiaPropuesta {
  sucursal: string;
  dia_venta: string;
  acreedor: string;
  /** El banco de la cuenta de sus cargos, por nombre (`finance.bank_accounts.bank`), no el código del acreedor. */
  banco: string;
  estado: EstadoDia;
  motivos: string[];
  total: number;
  iva: number;
  cargos: CargoPropuesta[];
  /** Lo que se escribiría: sólo cuando está `lista` (o, para medir, con `armarTodo`). */
  plan: PlanComisionesKepler | null;
}

export interface BloquePorRevisar {
  deposito: { id: string; cuenta: string; banco: string; fecha: string; importe: number };
  cargos: CargoPropuesta[];
  motivo: string;
  /**
   * La sucursal todavía no captura el depósito y es reciente (≤ `DIAS_DE_ESPERA`): no es un problema, es una
   * espera. Medido en octubre: la sucursal captura su `U-A-5` con una mediana de 0 a 5 días según la sucursal
   * (el 90 % dentro de 1 a 10). Pasado eso, sí se revisa.
   */
  espera: boolean;
}

/** Hasta cuántos días un depósito sin capturar se espera en vez de revisarse (p90 de la sucursal más lenta). */
export const DIAS_DE_ESPERA = 10;

export interface PropuestaComisiones {
  medido: boolean;
  motivo: string | null;
  desde: string;
  hasta: string;
  /** La edad del dato: hasta qué día trae la descarga y cuándo se subió el último archivo. */
  descarga: { hasta: string | null; subida_en: string | null };
  dias: DiaPropuesta[];
  por_revisar: BloquePorRevisar[];
  huerfanos: CargoPropuesta[];
  /**
   * Cinco montones que no se enciman y suman `cargos`: listos · con su pago ya en Kepler · en un día cuyo gasto
   * Finanzas ya capturó pero sin este pago · esperando a la sucursal · por revisar.
   */
  resumen: {
    cargos: number; listos: number; ya_en_kepler: number; gasto_capturado_sin_pago: number;
    esperando_sucursal: number; por_revisar: number; monto_listo: number;
  };
}

type Db = Knex | Knex.Transaction;

/**
 * ⛔ **Los tres candados contra duplicados, en orden.** Un día sólo puede quedar `lista` si los tres lo dejan pasar;
 * si no, se dice por qué y NO se escribe. Pura, para probarla sola.
 *   1. todos sus cargos tienen su `X-D-26` capturado → `ya_en_kepler`;
 *   2. alguno tiene su pago, o alguna comisión ya es renglón 611-003 de una solicitud o gasto de Finanzas → `parcial`;
 *   3. Finanzas tiene CUALQUIER solicitud o gasto a un banco de esa sucursal fechado ese día, aunque no case → `parcial`.
 * `null` = ningún candado lo frena.
 */
export function candadosDelDia(
  cargos: readonly Pick<CargoPropuesta, 'tipo' | 'kepler_pago' | 'kepler_gasto'>[], capturasDelDia: readonly string[],
): { estado: 'ya_en_kepler' | 'parcial'; motivos: string[] } | null {
  const capturados = cargos.filter((c) => c.kepler_pago).length;
  const comisiones = cargos.filter((c) => c.tipo === 'comision');
  const enGasto = comisiones.filter((c) => c.kepler_gasto).length;
  if (cargos.length && capturados === cargos.length) return { estado: 'ya_en_kepler', motivos: ['Finanzas ya capturó estos pagos en Kepler'] };
  if (capturados > 0 || enGasto > 0) {
    const folios = [...new Set(comisiones.map((c) => c.kepler_gasto).filter(Boolean))].join(', ');
    return {
      estado: 'parcial',
      motivos: [
        ...(enGasto ? [`Finanzas ya capturó ${enGasto} de ${comisiones.length} comisiones en Kepler (${folios})`] : []),
        `${capturados ? `${capturados} de ${cargos.length} pagos capturados` : 'ningún pago capturado todavía'}: no se escribe encima`,
      ],
    };
  }
  if (capturasDelDia.length) {
    return { estado: 'parcial', motivos: [`Finanzas ya tiene de ese día ${capturasDelDia.join(', ')} con otros importes: se revisa, no se escribe encima`] };
  }
  return null;
}

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
  const vacia = (medido: boolean, motivo: string | null, descarga: PropuestaComisiones['descarga'] = { hasta: null, subida_en: null }): PropuestaComisiones => ({
    medido, motivo, desde, hasta, descarga, dias: [], por_revisar: [], huerfanos: [], resumen: { cargos: 0, listos: 0, ya_en_kepler: 0, gasto_capturado_sin_pago: 0, esperando_sucursal: 0, por_revisar: 0, monto_listo: 0 },
  });
  const ods = (await db.raw(`SELECT to_regclass('kepler_ods.kdm1') AS kdm1, to_regclass('kepler_ods.kdm6') AS kdm6, to_regclass('analytics.kepler_bank_movements') AS kbm`)).rows[0];
  if (!ods?.kdm1 || !ods?.kdm6 || !ods?.kbm) return vacia(false, 'Sin el ODS de Kepler en esta base: no se puede saber qué está capturado.');

  const filas: (RenglonDescarga & { banco: string })[] = (await db.raw(`
    SELECT l.id::text AS id, ba.account_label AS cuenta, ba.bank AS banco, to_char(l.movement_date, 'YYYY-MM-DD') AS fecha, l.seq,
           l.concept AS concepto, l.amount_in::float AS entra, l.amount_out::float AS sale
      FROM finance.bank_statement_lines l JOIN finance.bank_accounts ba ON ba.id = l.bank_account_id
     WHERE l.tenant_id = ? AND l.movement_date BETWEEN ?::date AND ?::date AND ba.account_label IS NOT NULL`, [tenantId, desde, hasta])).rows
    .map((r: RenglonDescarga & { banco: string }) => ({ ...r, seq: Number(r.seq), entra: Number(r.entra), sale: Number(r.sale) }));
  const lineas: RenglonDescarga[] = filas;
  const bancoDe = new Map(filas.map((r) => [r.cuenta, t(r.banco) || r.cuenta]));
  const conceptoDe = new Map(filas.map((r) => [r.id, t(r.concepto)]));
  const subida = (await db.raw(`SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS en FROM finance.bank_statement_files WHERE tenant_id = ?`, [tenantId])).rows[0]?.en ?? null;
  const descarga = { hasta: filas.length ? filas.map((r) => r.fecha).sort().at(-1)! : null, subida_en: subida };
  const { bloques, huerfanos } = bloquesDeTarjeta(lineas);
  const todos: CargoTarjeta[] = [...bloques.flatMap((b) => b.cargos), ...huerfanos];
  if (!todos.length) return vacia(true, null, descarga);

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

  // El segundo candado: las comisiones que Finanzas ya puso como renglón 611-003 de una solicitud o un gasto de esa
  // sucursal, aunque todavía no capture sus pagos. Y el tercero: CUALQUIER solicitud o gasto a un banco de esa
  // sucursal fechado ese día de venta, aunque sus importes no casen (Yurécuaro 4-nov: la Suite suma $17.83 y
  // Finanzas tiene un gasto de ese día por $17.32) o el ODS no traiga sus renglones (`kdm6`): se revisa, no se escribe.
  const diasVenta = grupos.map((g) => g.diaVenta).sort();
  const capturas: { sucursal: string; folio: string; fecha: string; total: number; cuenta: string | null; importe: number | null }[] = !grupos.length ? [] : (await db.raw(`
    SELECT m.sucursal, (CASE m.c4 WHEN 10 THEN 'gasto ' ELSE 'solicitud ' END) || btrim(m.c6) AS folio,
           to_char(m.c9, 'YYYY-MM-DD') AS fecha, m.c16::float AS total, btrim(d.c8) AS cuenta, d.c11::float AS importe
      FROM kepler_ods.kdm1 m
      LEFT JOIN kepler_ods.kdm6 d ON d.sucursal = m.sucursal AND d.c2 = m.c2 AND d.c3 = m.c3 AND d.c4 = m.c4 AND d.c5 = m.c5 AND d.c6 = m.c6
     WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 IN (10, 15) AND m.c43 <> 'C' AND btrim(m.c10) LIKE 'GB%'
       AND m.sucursal = ANY(?) AND m.c9 BETWEEN ?::date - 7 AND ?::date + 7`,
  [[...new Set(grupos.map((g) => g.sucursal))], diasVenta[0], diasVenta[diasVenta.length - 1]])).rows;
  const renglones: RenglonGastoCapturado[] = capturas.filter((r) => r.cuenta === CUENTA_COMISION)
    .map((r) => ({ sucursal: r.sucursal, folio: r.folio, fecha: r.fecha, importe: Number(r.importe) }));
  const delDia = new Map<string, Set<string>>();
  for (const r of capturas) {
    const k = `${r.sucursal}|${r.fecha}`;
    (delDia.get(k) ?? delDia.set(k, new Set()).get(k)!).add(`${r.folio} ($${Number(r.total).toFixed(2)})`);
  }
  // Primero los gastos y luego las solicitudes: que una comisión quede ligada al gasto si existe.
  renglones.sort((a, b) => Number(b.folio.startsWith('gasto')) - Number(a.folio.startsWith('gasto')));
  const enGasto = cruzarConGastos(grupos.flatMap((g) => g.cargos.filter((c) => c.tipo === 'comision')
    .map((c) => ({ id: c.id, importe: c.importe, sucursal: g.sucursal, diaVenta: g.diaVenta }))), renglones);

  const vista = (c: CargoTarjeta): CargoPropuesta => ({
    id: c.id, cuenta: c.cuenta, concepto: conceptoDe.get(c.id) ?? '', fecha: c.fecha, importe: c.importe, tipo: c.tipo,
    kepler_pago: enKepler.get(c.id)?.folio ?? null, kepler_sucursal: enKepler.get(c.id)?.sucursal ?? null, kepler_ajuste_centavos: enKepler.get(c.id)?.ajusteCentavos ?? null, kepler_gasto: enGasto.get(c.id)?.folio ?? null,
  });

  const pl = await plantillas(db, [...new Map(grupos.map((g) => [`${g.sucursal}|${g.acreedor}`, { sucursal: g.sucursal, acreedor: g.acreedor }])).values()], hasta);
  const dias: DiaPropuesta[] = grupos.map((g) => {
    const cargos = g.cargos.map(vista);
    const capturados = cargos.filter((c) => c.kepler_pago).length;
    const suma = (tipo?: 'iva') => cargos.filter((c) => !tipo || c.tipo === tipo).reduce((s, c) => s + cent(c.importe), 0) / 100;
    const base: Omit<DiaPropuesta, 'estado' | 'motivos' | 'plan'> = { sucursal: g.sucursal, dia_venta: g.diaVenta, acreedor: g.acreedor, banco: bancoDe.get(g.cargos[0]?.cuenta ?? '') ?? g.acreedor, total: suma(), iva: suma('iva'), cargos };
    const p = pl.get(`${g.sucursal}|${g.acreedor}`);
    const paraMedir = (): PlanComisionesKepler | null => {
      if (!opciones.armarTodo || !p) return null;
      const r = armarComisionesKepler(g, p);
      return r.ok ? r.plan : null;
    };
    const candado = candadosDelDia(cargos, [...(delDia.get(`${g.sucursal}|${g.diaVenta}`) ?? [])]);
    if (candado) return { ...base, ...candado, plan: paraMedir() };
    if (!p) return { ...base, estado: 'rechazada', motivos: ['Sin un gasto de comisiones anterior de esta sucursal y banco del cual copiar la plantilla'], plan: null };
    const r = armarComisionesKepler(g, p);
    return r.ok ? { ...base, estado: 'lista', motivos: [], plan: r.plan } : { ...base, estado: 'rechazada', motivos: r.motivos, plan: null };
  });
  const antiguedad = (f: string): number => (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000;
  const por_revisar: BloquePorRevisar[] = sinResolver.map(({ bloque, motivo }) => {
    const cargos = bloque.cargos.map(vista);
    const espera = motivo === MOTIVO_SIN_DEPOSITO && antiguedad(bloque.deposito.fecha) <= DIAS_DE_ESPERA && !cargos.some((c) => c.kepler_pago);
    return {
      deposito: { id: bloque.deposito.id, cuenta: bloque.deposito.cuenta, banco: bancoDe.get(bloque.deposito.cuenta) ?? bloque.deposito.cuenta, fecha: bloque.deposito.fecha, importe: bloque.deposito.importe },
      cargos, espera,
      motivo: espera ? 'la sucursal aún no captura este depósito en Kepler (suele tardar de 0 a 5 días)'
        : motivo === MOTIVO_SIN_DEPOSITO ? `${motivo} después de ${Math.round(antiguedad(bloque.deposito.fecha))} días` : motivo,
    };
  });
  const listos = dias.filter((d) => d.estado === 'lista');
  // Cinco montones que no se enciman y suman el total: un día `lista` no tiene ningún cargo capturado (ni pago
  // ni renglón de gasto), y un bloque en espera tampoco.
  const nListos = listos.reduce((s, d) => s + d.cargos.length, 0);
  const nKepler = todos.filter((c) => enKepler.has(c.id)).length;
  const nGastoSinPago = dias.filter((d) => d.cargos.some((c) => c.kepler_gasto)).reduce((s, d) => s + d.cargos.filter((c) => !c.kepler_pago).length, 0);
  const nEspera = por_revisar.filter((b) => b.espera).reduce((s, b) => s + b.cargos.length, 0);
  return {
    medido: true, motivo: null, desde, hasta, descarga, dias, por_revisar, huerfanos: huerfanos.map(vista),
    resumen: {
      cargos: todos.length, listos: nListos, ya_en_kepler: nKepler, gasto_capturado_sin_pago: nGastoSinPago, esperando_sucursal: nEspera,
      por_revisar: todos.length - nListos - nKepler - nGastoSinPago - nEspera,
      monto_listo: listos.reduce((s, d) => s + cent(d.total), 0) / 100,
    },
  };
}
