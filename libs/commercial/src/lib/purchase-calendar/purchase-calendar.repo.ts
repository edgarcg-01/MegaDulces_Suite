import type { Knex } from 'knex';
import {
  ordenDelEmbudo, sumarDias, validarFueraDeCiclo, validarMarca, validarRegla, VENTANA_REZAGO_DIAS,
  type CalendarioCompras, type FueraDeCicloDto, type GuardarReglaDto, type GuardarReglaRespuesta, type MarcaVista,
  type MarcarRevisionDto, type PropuestaDiaFijo, type PropuestasCalendario, type PropuestaSinRegla,
} from '@megadulces/contracts';
import {
  armarCalendario, armarEmbudo, desdeEntradas, diasFijosPorProveedor, nombreDelAlcance, repartirPropuestas, reglaEnAlcance,
  type AlmacenPedido, type CompraDoceMeses, type FilaActividad, type ReglaLeida, type SucursalZona,
} from './purchase-calendar.domain';
import { SQL_ACTIVIDAD_KEPLER, SQL_COMPRA_DOCE_MESES, SQL_SUCURSALES_Y_ZONAS } from './purchase-calendar.sql';

/**
 * `[PQ.3.4]` Calendario de compras — el acceso a la base. Cada función recibe la transacción con el
 * tenant ya puesto (`TenantKnexService.run`), así la RLS de producción aplica igual aquí que en la prueba
 * `database/tests/test-newdb-pq3-4-calendario-api.js`, que carga ESTE archivo con ts-node.
 *
 * Tablas: `commercial.purchase_review_rules` / `_marks` (migración 20261120130156). Quién escribió se
 * guarda por **id de usuario** (no por username: un username se puede renombrar, AU.34).
 */

export interface Quien {
  readonly userId: string;
  readonly username: string | null;
  /**
   * `[PQ.3.6]` Las sucursales donde puede ESCRIBIR (`ScopeService`, área `compras`, `mode_write`); `null` =
   * todas. Obligatorio: una escritura sin alcance no se adivina, se rechaza (fail-closed).
   */
  readonly escribe: readonly string[] | null;
}

export class CalendarioError extends Error {
  constructor(readonly tipo: 'no_encontrada' | 'invalida' | 'conflicto' | 'fuera_de_alcance', mensaje: string) {
    super(mensaje);
  }
}

type AlcanceRegla = { scope: 'corporate' | 'zone' | 'branch'; zone_code: string | null; branch_code: string | null };

/**
 * `[PQ.3.6]` Una escritura sólo sobre reglas que caben COMPLETAS en las sucursales de quien escribe (la misma
 * regla con que se le muestran, `reglaEnAlcance`). La sucursal marca las suyas; la corporativa, sólo quien
 * escribe en todas.
 */
async function exigirAlcance(trx: Knex.Transaction, quien: Quien, r: AlcanceRegla): Promise<void> {
  if (quien.escribe === undefined) throw new Error('[PQ.3.6] escritura sin alcance: quien llama debe decir dónde puede escribir');
  if (quien.escribe === null) return;
  const sucursales = await leerSucursales(trx);
  if (!reglaEnAlcance(r, sucursales, quien.escribe)) {
    throw new CalendarioError('fuera_de_alcance',
      `La regla es de ${nombreDelAlcance(r, sucursales)} y tu alcance no la incluye: la revisa quien tiene esas sucursales.`);
  }
}

const HOY_MX = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const RULES = 'commercial.purchase_review_rules';
const MARKS = 'commercial.purchase_review_marks';

export async function hoyMx(trx: Knex | Knex.Transaction): Promise<string> {
  const { rows } = await trx.raw(`SELECT to_char(${HOY_MX}, 'YYYY-MM-DD') AS d`);
  return rows[0].d;
}

export async function leerSucursales(trx: Knex.Transaction): Promise<SucursalZona[]> {
  return (await trx.raw(SQL_SUCURSALES_Y_ZONAS)).rows;
}

/** Los almacenes de Pedido de las sucursales (código de dos dígitos), para «Abrir en Pedido». */
export async function leerAlmacenes(trx: Knex.Transaction, tenant: string): Promise<AlmacenPedido[]> {
  return trx('commercial.warehouses').where({ tenant_id: tenant, active: true }).whereNull('deleted_at')
    .whereRaw(`code ~ '^[0-9]{2}$'`).select('id', 'code');
}

const num = (xs: unknown): number[] | null => (Array.isArray(xs) ? xs.map(Number) : null);

/** Las reglas vivas del tenant, con el nombre del proveedor (la ficha viva primero) y de quien la definió. */
export async function leerReglas(trx: Knex.Transaction, tenant: string): Promise<ReglaLeida[]> {
  const { rows } = await trx.raw(`
    SELECT r.id, r.supplier_code, r.scope, r.zone_code, r.branch_code, r.pattern, r.weekdays, r.month_days,
           r.month_last_day, r.every_n_days, r.weekend_shift, r.reviewer_user_id,
           to_char(r.out_of_cycle_until, 'YYYY-MM-DD') AS out_of_cycle_until, r.out_of_cycle_reason,
           s.name AS supplier_name, rv.nombre AS reviewer_name, def.nombre AS definida_por,
           to_char(r.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS definida_el,
           to_char(r.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS vigente_desde,
           r.note, ps.id AS pedido_supplier_id
      FROM ${RULES} r
      LEFT JOIN LATERAL (
        SELECT x.name FROM catalog.suppliers x
         WHERE x.tenant_id = r.tenant_id AND x.code = r.supplier_code
         ORDER BY (x.deleted_at IS NULL) DESC, x.updated_at DESC LIMIT 1) s ON true
      -- [PQ.3.5] «Abrir en Pedido»: la ficha con esta clave que TIENE productos en Pedido (la misma
      -- lista de proveedores que su filtro: política de reorden → producto → proveedor, también una ficha
      -- borrada). Sin ninguna, NULL: R5, los productos de esa clave están en otra ficha.
      LEFT JOIN LATERAL (
        SELECT x.id FROM catalog.suppliers x
         WHERE x.tenant_id = r.tenant_id AND x.code = r.supplier_code
           AND EXISTS (SELECT 1 FROM catalog.products pr
                         JOIN commercial.reorder_policy rp ON rp.tenant_id = pr.tenant_id AND rp.product_id = pr.id
                        WHERE pr.tenant_id = x.tenant_id AND pr.supplier_id = x.id)
         ORDER BY (x.deleted_at IS NULL) DESC, x.updated_at DESC LIMIT 1) ps ON true
      LEFT JOIN identity.users rv ON rv.id = r.reviewer_user_id
      LEFT JOIN identity.users def ON def.id::text = r.created_by
     WHERE r.tenant_id = ? AND r.deleted_at IS NULL`, [tenant]);
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    weekdays: num(r['weekdays']),
    month_days: num(r['month_days']),
    every_n_days: r['every_n_days'] == null ? null : Number(r['every_n_days']),
  })) as ReglaLeida[];
}

/** Las marcas desde `desde` (las que pesan en el rezago de hoy), con quién marcó. */
export async function leerMarcas(trx: Knex.Transaction, tenant: string, desde: string): Promise<(MarcaVista & { rule_id: string })[]> {
  const { rows } = await trx.raw(`
    SELECT m.rule_id, to_char(m.review_date, 'YYYY-MM-DD') AS review_date, m.outcome, m.skip_reason,
           to_char(m.postponed_to, 'YYYY-MM-DD') AS postponed_to, m.note, u.nombre AS marcada_por,
           to_char(m.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS marcada_el
      FROM ${MARKS} m
      LEFT JOIN identity.users u ON u.id::text = COALESCE(m.updated_by, m.created_by)
     WHERE m.tenant_id = ? AND (m.review_date >= ? OR m.postponed_to >= ?)
     ORDER BY m.review_date`, [tenant, desde, desde]);
  return rows;
}

export async function leerActividad(
  trx: Knex.Transaction, p: { hoy: string; desde: string; desde_entradas: string; codes: readonly string[] },
): Promise<FilaActividad[]> {
  if (!p.codes.length) return [];
  return (await trx.raw(SQL_ACTIVIDAD_KEPLER, { ...p, codes: [...p.codes] })).rows;
}

/** `GET /compras/calendario`: las reglas con su estado de hoy. */
/**
 * `GET /compras/calendario`: las reglas con su estado de hoy. `[PQ.3.6]` `lee` = las sucursales de quien
 * pregunta (`null` = todas): sólo ve las reglas que caben en ellas, y Kepler se lee sólo para esas.
 */
export async function leerCalendario(trx: Knex.Transaction, tenant: string, lee: readonly string[] | null): Promise<CalendarioCompras> {
  if (lee === undefined) throw new Error('[PQ.3.6] calendario sin alcance: quien llama debe decir qué sucursales ve');
  const hoy = await hoyMx(trx);
  const desde = sumarDias(hoy, -VENTANA_REZAGO_DIAS);
  const [todas, sucursales, marcas] = [await leerReglas(trx, tenant), await leerSucursales(trx), await leerMarcas(trx, tenant, desde)];
  const reglas = todas.filter((r) => reglaEnAlcance(r, sucursales, lee));
  const codes = [...new Set(reglas.map((r) => r.supplier_code))];
  const actividad = await leerActividad(trx, { hoy, desde, desde_entradas: desdeEntradas(hoy, reglas), codes });
  return armarCalendario(hoy, reglas, actividad, marcas, sucursales, await leerAlmacenes(trx, tenant), lee);
}

/**
 * `GET /compras/calendario/propuestas`: lo que Kepler propone para los proveedores SIN regla viva. `[PQ.3.14]` Y el
 * día fijo por sucursal de TODOS los proveedores con compra, menos las sucursales que ya tienen su regla de
 * sucursal: definir primero la corporativa no debe borrar la propuesta de la sucursal (§10.1: las reglas no se suman).
 */
export async function leerPropuestas(
  trx: Knex.Transaction, tenant: string, alFallar: (e: unknown, que: 'dia_fijo' | 'compra') => void = () => undefined,
): Promise<PropuestasCalendario> {
  const hoy = await hoyMx(trx);
  const { rows } = await trx.raw(`
    SELECT v.supplier_code, v.supplier_name, v.supplier_record, v.proposal_status, v.cycle_days_proposed,
           to_char(v.next_date_proposed, 'YYYY-MM-DD') AS next_date_proposed, v.rounds_12m,
           to_char(v.last_order_date, 'YYYY-MM-DD') AS last_order_date, v.branches_12m,
           (SELECT count(*) FROM ${RULES} r WHERE r.tenant_id = ? AND r.supplier_code = v.supplier_code AND r.deleted_at IS NULL)::int AS reglas_vivas,
           COALESCE((SELECT array_agg(r.branch_code) FROM ${RULES} r
                      WHERE r.tenant_id = ? AND r.supplier_code = v.supplier_code AND r.deleted_at IS NULL AND r.scope = 'branch'), '{}') AS con_regla_de_sucursal
      FROM commercial.v_purchase_calendar_proposal v
     ORDER BY v.next_date_proposed NULLS LAST, v.supplier_name`, [tenant, tenant]);
  const todos = rows.map((r: Record<string, unknown>) => ({
    supplier_code: r['supplier_code'], supplier_name: r['supplier_name'], supplier_record: r['supplier_record'],
    proposal_status: r['proposal_status'],
    cycle_days_proposed: r['cycle_days_proposed'] == null ? null : Number(r['cycle_days_proposed']),
    next_date_proposed: r['next_date_proposed'], rounds_12m: Number(r['rounds_12m']),
    last_order_date: r['last_order_date'], branches_12m: r['branches_12m'],
    reglas_vivas: Number(r['reglas_vivas']),
    con_regla_de_sucursal: r['con_regla_de_sucursal'] as string[],
  })) as (Omit<PropuestaSinRegla, 'dias_fijos' | 'peso'> & { con_regla_de_sucursal: string[] })[];
  const codes = todos.map((p) => p.supplier_code);
  const dia = await leerDiasFijos(trx, hoy, codes, (e) => alFallar(e, 'dia_fijo'));
  // `[PQ.3.18]` El embudo: el escalón es del proveedor (con o sin regla), así que se arma sobre TODOS. El día fijo
  // cuenta aunque su sucursal ya tenga regla: quien tiene día fijo no es «ocasional».
  const compra = await leerCompraDoceMeses(trx, hoy, codes, (e) => alFallar(e, 'compra'));
  const { peso, embudo } = armarEmbudo(todos.map((p) => ({
    supplier_code: p.supplier_code, proposal_status: p.proposal_status, reglas_vivas: p.reglas_vivas,
    con_dia_fijo: (dia.por.get(p.supplier_code) ?? []).length > 0,
  })), compra);
  const { sin_regla, dia_fijo_pendiente } = repartirPropuestas(todos.map((p) => ({ ...p, peso: peso.get(p.supplier_code) ?? null })), dia.por);
  // Por escalón y peso; sin peso medido, `sort` es estable y deja el orden de Kepler (la siguiente fecha).
  return {
    hoy, sin_regla: sin_regla.sort(ordenDelEmbudo), dia_fijo_pendiente: dia_fijo_pendiente.sort(ordenDelEmbudo),
    con_regla: rows.length - sin_regla.length, dia_fijo: dia.estado, embudo,
  };
}

/**
 * `[PQ.3.18]` La compra de 12 meses por proveedor (monto y OC vivas), en un SAVEPOINT: si falla, el peso se DECLARA
 * no medido (`embudo.measured: false`) y las propuestas se entregan igual, en el orden de Kepler.
 */
async function leerCompraDoceMeses(
  trx: Knex.Transaction, hoy: string, codes: readonly string[], alFallar: (e: unknown) => void,
): Promise<Map<string, CompraDoceMeses> | null> {
  if (!codes.length) return new Map();
  try {
    const { rows } = await trx.transaction((sp) => sp.raw(SQL_COMPRA_DOCE_MESES, { hoy, codes: [...codes] }));
    return new Map(rows.map((r: { supplier_code: string; monto: number | string; ocs: number | string }) =>
      [r.supplier_code, { monto: Number(r.monto) || 0, ocs: Number(r.ocs) || 0 }] as const));
  } catch (e) {
    alFallar(e);
    return null;
  }
}

/**
 * `[PQ.3.14]` El día fijo por sucursal de los proveedores con compra: la MISMA consulta de actividad del calendario
 * (`SQL_ACTIVIDAD_KEPLER`: OC también canceladas + entradas, por plaza), leída 12 meses. Medido en prod el
 * 2026-11-21: 1.2 s con las 340 claves (dos corridas). Va en un SAVEPOINT: si falla (una base sin el ODS de
 * Kepler, un tiempo agotado), el día fijo se DECLARA no medido y la propuesta por ciclo se entrega igual.
 */
async function leerDiasFijos(
  trx: Knex.Transaction, hoy: string, codes: readonly string[], alFallar: (e: unknown) => void,
): Promise<{ por: Map<string, PropuestaDiaFijo[]>; estado: PropuestasCalendario['dia_fijo'] }> {
  if (!codes.length) return { por: new Map(), estado: { measured: true, note: null } };
  const desde = sumarDias(hoy, -364);
  try {
    const [filas, sucursales] = await trx.transaction(async (sp) =>
      [await leerActividad(sp, { hoy, desde, desde_entradas: desde, codes }), await leerSucursales(sp)] as const);
    return { por: diasFijosPorProveedor(filas, sucursales, hoy), estado: { measured: true, note: null } };
  } catch (e) {
    alFallar(e);
    return {
      por: new Map(),
      estado: { measured: false, note: 'No se pudo leer la actividad de Kepler de 12 meses: el día fijo por sucursal no se midió.' },
    };
  }
}

const PATRON_VACIO = { weekdays: null, month_days: null, month_last_day: false, every_n_days: null };

/**
 * `POST /compras/calendario/reglas`. Una regla viva por proveedor y alcance: si ya hay una, se REEMPLAZA su
 * patrón (la gerencia redefine el ciclo, DC8) y conserva su id y sus marcas.
 */
export async function guardarRegla(trx: Knex.Transaction, tenant: string, quien: Quien, dto: GuardarReglaDto): Promise<GuardarReglaRespuesta> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién define la regla: vuelve a entrar.');
  const sucursales = await leerSucursales(trx);
  const zonas = [...new Set(sucursales.map((s) => s.zona_code).filter((z): z is string => !!z))];
  const motivo = validarRegla(dto, zonas, sucursales.map((s) => s.branch_code));
  if (motivo) throw new CalendarioError('invalida', motivo);
  const code = dto.supplier_code.trim();
  const existe = (await trx.raw(`
    SELECT EXISTS (SELECT 1 FROM catalog.suppliers WHERE tenant_id = ? AND code = ?)
        OR EXISTS (SELECT 1 FROM analytics.erp_purchase_orders WHERE tenant_id = ? AND proveedor_code = ?) AS ok`,
  [tenant, code, tenant, code])).rows[0].ok;
  if (!existe) throw new CalendarioError('invalida', `No encontramos al proveedor ${code} ni en el catálogo ni en las órdenes de Kepler.`);
  if (dto.reviewer_user_id) {
    const u = await trx('identity.users').where({ id: dto.reviewer_user_id, tenant_id: tenant }).first('id');
    if (!u) throw new CalendarioError('invalida', 'La persona que revisa no existe en esta empresa.');
  }
  const patron = {
    ...PATRON_VACIO,
    pattern: dto.pattern,
    ...(dto.pattern === 'weekdays' ? { weekdays: [...new Set(dto.weekdays ?? [])].sort((a, b) => a - b) } : {}),
    ...(dto.pattern === 'month_days' ? {
      month_days: dto.month_days && dto.month_days.length ? [...new Set(dto.month_days)].sort((a, b) => a - b) : null,
      month_last_day: !!dto.month_last_day,
    } : {}),
    ...(dto.pattern === 'every_n_days' ? { every_n_days: dto.every_n_days } : {}),
    weekend_shift: dto.weekend_shift ?? 'friday',
    reviewer_user_id: dto.reviewer_user_id ?? null,
    note: dto.note?.trim() || null,
  };
  const alcance: AlcanceRegla = {
    scope: dto.scope, zone_code: dto.scope === 'zone' ? dto.zone_code ?? null : null, branch_code: dto.scope === 'branch' ? dto.branch_code ?? null : null,
  };
  await exigirAlcance(trx, quien, alcance);
  const viva = await trx(RULES)
    .where({ tenant_id: tenant, supplier_code: code, scope: alcance.scope })
    .andWhereRaw('COALESCE(zone_code, \'\') = ? AND COALESCE(branch_code, \'\') = ?', [alcance.zone_code ?? '', alcance.branch_code ?? ''])
    .whereNull('deleted_at').forUpdate().first('id');
  if (viva) {
    await trx(RULES).where({ id: viva.id, tenant_id: tenant })
      .update({ ...patron, updated_by: quien.userId, updated_at: trx.fn.now() });
    return { id: viva.id, accion: 'actualizada' };
  }
  try {
    const [fila] = await trx(RULES).insert({
      tenant_id: tenant, supplier_code: code, ...alcance, ...patron,
      created_by: quien.userId, updated_by: quien.userId,
    }).returning('id');
    return { id: fila.id ?? fila, accion: 'creada' };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new CalendarioError('conflicto', 'Alguien más acaba de definir esa regla. Recarga y revísala.');
    throw e;
  }
}

/** La regla viva, bloqueada, y SÓLO si cabe en el alcance de escritura de quien la toca (`[PQ.3.6]`). */
async function reglaViva(trx: Knex.Transaction, tenant: string, id: string, quien: Quien): Promise<{ id: string }> {
  const r = await trx(RULES).where({ id, tenant_id: tenant }).whereNull('deleted_at').forUpdate()
    .first('id', 'scope', 'zone_code', 'branch_code');
  if (!r) throw new CalendarioError('no_encontrada', 'Esa regla ya no existe (¿la dieron de baja?).');
  await exigirAlcance(trx, quien, r);
  return r;
}

/** `POST /compras/calendario/reglas/:id/baja`: nunca DELETE; la regla queda con quién y cuándo. */
export async function darDeBaja(trx: Knex.Transaction, tenant: string, quien: Quien, id: string): Promise<{ id: string }> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién da de baja: vuelve a entrar.');
  await reglaViva(trx, tenant, id, quien);
  await trx(RULES).where({ id, tenant_id: tenant })
    .update({ deleted_at: trx.fn.now(), deleted_by: quien.userId, updated_by: quien.userId, updated_at: trx.fn.now() });
  return { id };
}

/** `POST /compras/calendario/reglas/:id/fuera-de-ciclo`: sale del ciclo hasta una fecha (con motivo) o regresa. */
export async function fueraDeCiclo(trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: FueraDeCicloDto): Promise<{ id: string }> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién lo pide: vuelve a entrar.');
  const motivo = validarFueraDeCiclo(dto, await hoyMx(trx));
  if (motivo) throw new CalendarioError('invalida', motivo);
  await reglaViva(trx, tenant, id, quien);
  await trx(RULES).where({ id, tenant_id: tenant }).update({
    out_of_cycle_until: dto.hasta, out_of_cycle_reason: dto.hasta ? (dto.motivo ?? '').trim() : null,
    updated_by: quien.userId, updated_at: trx.fn.now(),
  });
  return { id };
}

/**
 * `POST /compras/calendario/reglas/:id/marcas`: lo que quien revisa dice de una fecha. Una por regla y
 * fecha: si ya había, se CORRIGE (no se borra ni se duplica).
 */
export async function marcar(
  trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: MarcarRevisionDto,
): Promise<{ id: string; accion: 'creada' | 'corregida' }> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién marca: vuelve a entrar.');
  const motivo = validarMarca(dto, await hoyMx(trx));
  if (motivo) throw new CalendarioError('invalida', motivo);
  await reglaViva(trx, tenant, id, quien);
  const valores = {
    outcome: dto.outcome,
    skip_reason: dto.outcome === 'skipped' ? dto.skip_reason ?? null : null,
    postponed_to: dto.outcome === 'skipped' ? dto.postponed_to ?? null : null,
    note: dto.note?.trim() || null,
  };
  const { rows } = await trx.raw(`
    INSERT INTO ${MARKS} (tenant_id, rule_id, review_date, outcome, skip_reason, postponed_to, note, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, rule_id, review_date) DO UPDATE
       SET outcome = EXCLUDED.outcome, skip_reason = EXCLUDED.skip_reason, postponed_to = EXCLUDED.postponed_to,
           note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id, (xmax = 0) AS creada`,
  [tenant, id, dto.review_date, valores.outcome, valores.skip_reason, valores.postponed_to, valores.note, quien.userId, quien.userId]);
  return { id: rows[0].id, accion: rows[0].creada ? 'creada' : 'corregida' };
}
