import type { Knex } from 'knex';
import {
  CAMBIOS_POR_REGLA, OCASIONAL_CADA_N_DIAS, OCASIONAL_FUERA_DE_CICLO_DIAS, OCASIONAL_MOTIVO, ordenDelEmbudo, reglasDeLaCaptura, sumarDias, validarCaptura,
  validarFueraDeCiclo, validarMarca, validarOcasionales, VENTANA_REZAGO_DIAS, type DefinirOcasionalesDto, type DefinirOcasionalesRespuesta,
  type CalendarioCompras, type CambioDeRegla, type FueraDeCicloDto, type GuardarReglaDto, type GuardarReglaRespuesta, type MarcaVista,
  type MarcarRevisionDto, type PropuestaDiaFijo, type PropuestasCalendario, type PropuestaSinRegla,
} from '@megadulces/contracts';
import {
  armarCalendario, armarEmbudo, desdeEntradas, diasFijosPorProveedor, nombreDelAlcance, repartirPropuestas, reglaEnAlcance,
  type AlmacenPedido, type CompraDoceMeses, type FilaActividad, type HistorialLeido, type ReglaLeida, type SucursalZona,
} from './purchase-calendar.domain';
import { SQL_ACTIVIDAD_KEPLER, SQL_COMPRA_DOCE_MESES, SQL_SUCURSALES_Y_ZONAS } from './purchase-calendar.sql';
import { isPlatformAdminRole, permisoEfectivoSql } from '@megadulces/platform-core';

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
           r.week_interval, to_char(r.week_anchor, 'YYYY-MM-DD') AS week_anchor, r.month_week,
           to_char(r.out_of_cycle_until, 'YYYY-MM-DD') AS out_of_cycle_until, r.out_of_cycle_reason,
           s.name AS supplier_name, rv.nombre AS reviewer_name, def.nombre AS definida_por,
           to_char(r.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS definida_el,
           to_char(r.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS vigente_desde,
           -- [PQ.3.17] El último cambio después de crearla (un alta deja created_at = updated_at: la misma transacción).
           (r.updated_at > r.created_at + interval '1 second') AS fue_cambiada, upd.nombre AS cambiada_por,
           to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cambiada_el,
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
      LEFT JOIN identity.users upd ON upd.id::text = r.updated_by
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
  const historial = await leerCambios(trx, tenant, reglas.map((r) => r.id));
  return armarCalendario(hoy, reglas, actividad, marcas, sucursales, await leerAlmacenes(trx, tenant), lee, historial);
}

/** `[PQ.3.17]` El log compartido (VP.3.1) y el disparador que le suma las reglas (migración 20261124231747). */
const HISTORIAL = 'analytics.master_data_history';
const DISPARADOR = 'trg_master_data_history';

/**
 * `[PQ.3.17]` Los cambios de las reglas que se ven (anexo C §10.9, DC25), de `analytics.master_data_history`: los
 * `CAMBIOS_POR_REGLA` más nuevos de cada una, con quién (`actor` = el usuario que declaró la escritura) y los
 * nombres de los responsables que aparecen. En un SAVEPOINT: sin el disparador activo, o si la lectura falla, el
 * historial se DECLARA no medido y el calendario se entrega igual (nunca «sin cambios» por defecto).
 *
 * Lo escrito en la MISMA transacción que el alta es parte del alta, no un cambio: la misma regla que `fue_cambiada`
 * (`updated_at > created_at + 1 s`). Sin eso, «Sacar del ciclo a los N» (que define y luego saca del ciclo, en una
 * transacción) mostraba «Cambios» sin «Último cambio». La fila se queda en el historial; sólo no se cuenta aquí.
 */
export async function leerCambios(trx: Knex.Transaction, tenant: string, ids: readonly string[]): Promise<HistorialLeido> {
  try {
    return await trx.transaction(async (sp) => {
      const activo = (await sp.raw(`
        SELECT EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgrelid = to_regclass(?) AND tgname = ? AND tgenabled <> 'D' AND NOT tgisinternal) AS si`,
      [RULES, DISPARADOR])).rows[0].si;
      if (!activo) {
        return { measured: false, note: 'El historial de cambios de las reglas no está activo en esta base: se sabe quién hizo el último cambio y cuándo, no de qué a qué.', por: new Map() };
      }
      if (!ids.length) return { measured: true, note: null, por: new Map() };
      const { rows } = await sp.raw(`
        SELECT x.pk, x.el, x.dia, x.por, x.diff, x.total FROM (
          SELECT h.pk, to_char(h.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS el,
                 to_char(h.changed_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia,
                 -- null SÓLO si la escritura no declaró quién; un usuario sin nombre no es «fuera de la Suite».
                 CASE WHEN nullif(h.actor, '') IS NULL THEN NULL ELSE coalesce(u.nombre, 'sin nombre registrado') END AS por,
                 h.diff, h.changed_at, h.id,
                 count(*) OVER (PARTITION BY h.pk)::int AS total,
                 row_number() OVER (PARTITION BY h.pk ORDER BY h.changed_at DESC, h.id DESC) AS n
            FROM ${HISTORIAL} h
            JOIN ${RULES} r ON r.id::text = h.pk AND r.tenant_id = h.tenant_id
            LEFT JOIN identity.users u ON u.id::text = h.actor
           WHERE h.tenant_id = ? AND h.tabla = ? AND h.pk = ANY(?::text[])
             AND h.changed_at > r.created_at + interval '1 second') x
         WHERE x.n <= ?
         ORDER BY x.pk, x.changed_at DESC, x.id DESC`, [tenant, RULES, [...ids], CAMBIOS_POR_REGLA]);
      // Los responsables que aparecen en los cambios, por nombre (el diff guarda el id).
      const deResponsable = (d: unknown): string[] => {
        const c = (d as Record<string, { antes?: unknown; despues?: unknown }> | null)?.['reviewer_user_id'];
        return c ? [c.antes, c.despues].filter((v): v is string => typeof v === 'string') : [];
      };
      const idsResp = [...new Set((rows as { diff: unknown }[]).flatMap((r) => deResponsable(r.diff)))];
      const nombres = new Map<string, string>(idsResp.length
        ? (await sp.raw(`SELECT id::text AS id, nombre FROM identity.users WHERE id::text = ANY(?::text[])`, [idsResp])).rows
          .map((u: { id: string; nombre: string | null }) => [u.id, u.nombre ?? 'sin nombre registrado'] as const)
        : []);
      const por = new Map<string, { cambios: CambioDeRegla[]; total: number }>();
      for (const r of rows as { pk: string; el: string; dia: string; por: string | null; diff: Record<string, { antes: unknown; despues: unknown }>; total: number }[]) {
        const de = por.get(r.pk) ?? { cambios: [], total: Number(r.total) };
        const suyos = Object.fromEntries(deResponsable(r.diff).map((id) => [id, nombres.get(id) ?? 'sin nombre registrado']));
        de.cambios.push({ el: r.el, dia: r.dia, por: r.por, campos: r.diff, nombres: suyos });
        por.set(r.pk, de);
      }
      return { measured: true, note: null, por };
    });
  } catch {
    return { measured: false, note: 'No se pudo leer el historial de cambios de las reglas: se sabe quién hizo el último cambio y cuándo, no de qué a qué.', por: new Map() };
  }
}

/**
 * `[PQ.3.17]` Quién escribe, para el historial: el disparador de `analytics.master_data_history` lo lee de
 * `app.actor` (VP.3.2). Local a la transacción (`set_config(…, true)`): no se hereda a otra petición.
 */
async function declararActor(trx: Knex.Transaction, quien: Quien): Promise<void> {
  await trx.raw(`SELECT set_config('app.actor', ?, true)`, [quien.userId]);
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

const PATRON_VACIO = {
  weekdays: null, month_days: null, month_last_day: false, every_n_days: null, week_interval: null, week_anchor: null, month_week: null,
};

/** `[PQ.3.22]` La llave de quien puede MARCAR: la que se le pide al responsable de una regla (DC30). */
const LLAVE_MARCAR = 'COMPRAS_CALENDARIO_GESTIONAR';

/**
 * `[PQ.3.22]` El alcance del responsable, resuelto por el servicio ANTES de la transacción (`ScopeService` usa su
 * propia conexión). `escribe` = las sucursales donde escribe en Compras; `null` = todas.
 */
export interface ResponsableResuelto {
  readonly userId: string;
  readonly escribe: readonly string[] | null;
}

/**
 * `POST /compras/calendario/reglas`. Una regla viva por proveedor y alcance: si ya hay una, se REEMPLAZA su
 * patrón (la gerencia redefine el ciclo, DC8) y conserva su id y sus marcas.
 *
 * `[PQ.3.21]` Con varias zonas o sucursales (DC28) se guarda UNA regla por lugar, con el mismo patrón, en la
 * transacción de quien llama: si una falla (alcance, conflicto), no queda ninguna.
 * `[PQ.3.22]` El responsable (DC30) tiene que estar activo, tener la llave de marcar y escribir en TODAS las
 * sucursales de cada regla: así siempre ve y puede atender la suya.
 */
export async function guardarRegla(
  trx: Knex.Transaction, tenant: string, quien: Quien, dto: GuardarReglaDto, responsable?: ResponsableResuelto,
): Promise<GuardarReglaRespuesta> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién define la regla: vuelve a entrar.');
  const sucursales = await leerSucursales(trx);
  const zonas = [...new Set(sucursales.map((s) => s.zona_code).filter((z): z is string => !!z))];
  const motivo = validarCaptura(dto, zonas, sucursales.map((s) => s.branch_code));
  if (motivo) throw new CalendarioError('invalida', motivo);
  const code = dto.supplier_code.trim();
  const existe = (await trx.raw(`
    SELECT EXISTS (SELECT 1 FROM catalog.suppliers WHERE tenant_id = ? AND code = ?)
        OR EXISTS (SELECT 1 FROM analytics.erp_purchase_orders WHERE tenant_id = ? AND proveedor_code = ?) AS ok`,
  [tenant, code, tenant, code])).rows[0].ok;
  if (!existe) throw new CalendarioError('invalida', `No encontramos al proveedor ${code} ni en el catálogo ni en las órdenes de Kepler.`);
  const capturas = reglasDeLaCaptura({ ...dto, supplier_code: code });
  // Antes de escribir la primera: que quien define alcance TODOS los lugares (no depender del rollback para no dejar media captura).
  for (const c of capturas) await exigirAlcance(trx, quien, alcanceDe(c));
  if (dto.reviewer_user_id) await exigirResponsable(trx, tenant, dto.reviewer_user_id, responsable, capturas, sucursales);
  const reglas: { lugar: string | null; id: string; accion: 'creada' | 'actualizada' }[] = [];
  for (const c of capturas) reglas.push({ lugar: c.zone_code ?? c.branch_code ?? null, ...(await guardarUna(trx, tenant, quien, code, c)) });
  return { id: reglas[0].id, accion: reglas[0].accion, reglas };
}

/** El alcance de UNA regla de la captura (su zona o su sucursal sola). */
const alcanceDe = (r: GuardarReglaDto): AlcanceRegla => ({
  scope: r.scope, zone_code: r.scope === 'zone' ? r.zone_code ?? null : null, branch_code: r.scope === 'branch' ? r.branch_code ?? null : null,
});

/** `[PQ.3.22]` El responsable puede serlo de TODAS las reglas de la captura; si no, se dice quién y dónde no. */
async function exigirResponsable(
  trx: Knex.Transaction, tenant: string, userId: string, resuelto: ResponsableResuelto | undefined,
  reglas: readonly GuardarReglaDto[], sucursales: readonly SucursalZona[],
): Promise<void> {
  const { rows } = await trx.raw(`
    SELECT u.nombre, u.role_name, (${permisoEfectivoSql('u')}) AS puede
      FROM identity.users u
     WHERE u.tenant_id = ? AND u.id = ? AND u.activo AND u.deleted_at IS NULL`, [LLAVE_MARCAR, LLAVE_MARCAR, tenant, userId]);
  const u = rows[0] as { nombre: string | null; role_name: string | null; puede: boolean } | undefined;
  if (!u) throw new CalendarioError('invalida', 'La persona responsable no existe o ya no está activa.');
  const nombre = u.nombre ?? 'Esa persona';
  if (!u.puede) throw new CalendarioError('invalida', `${nombre} no tiene permiso de marcar revisiones del calendario: elige a otra persona.`);
  // Fail-closed: sin el alcance resuelto por el servicio no se supone «todas».
  if (!resuelto || resuelto.userId !== userId) throw new Error('[PQ.3.22] responsable sin alcance resuelto: quien llama debe resolverlo');
  for (const r of reglas) {
    const alcance = alcanceDe(r);
    if (!reglaEnAlcance(alcance, sucursales, resuelto.escribe)) {
      throw new CalendarioError('invalida', `${nombre} no ve ${nombreDelAlcance(alcance, sucursales)}: elige a quien sí, o deja la regla sin responsable.`);
    }
  }
}

/**
 * `[PQ.3.22]` Quién puede ser responsable (DC30): personas activas con la llave EFECTIVA de marcar (rol, complementos
 * y ajuste por persona, como el JWT). Sin el god-mode (`superadmin`/`admin`): son cuentas de sistema, como en
 * `receipt-devueltas`. Dónde escribe cada una lo agrega el servicio (`ScopeService`).
 */
export async function leerPosiblesResponsables(trx: Knex.Transaction, tenant: string): Promise<{ user_id: string; nombre: string; role_name: string }[]> {
  const filas: { user_id: string; nombre: string | null; role_name: string | null }[] = await trx('identity.users as u')
    .where('u.tenant_id', tenant).andWhere('u.activo', true).whereNull('u.deleted_at')
    .whereRaw(permisoEfectivoSql('u'), [LLAVE_MARCAR, LLAVE_MARCAR])
    .select('u.id as user_id', 'u.nombre', 'u.role_name')
    .orderBy('u.nombre');
  return filas.filter((f) => !isPlatformAdminRole(f.role_name)).map((f) => ({ user_id: f.user_id, nombre: f.nombre ?? '(sin nombre)', role_name: f.role_name ?? '' }));
}

/** Guarda UNA regla (un lugar): reemplaza la viva de ese proveedor en ese alcance, o crea una nueva. */
async function guardarUna(
  trx: Knex.Transaction, tenant: string, quien: Quien, code: string, dto: GuardarReglaDto,
): Promise<{ id: string; accion: 'creada' | 'actualizada' }> {
  const patron = {
    ...PATRON_VACIO,
    pattern: dto.pattern,
    ...(dto.pattern === 'weekdays' ? {
      weekdays: [...new Set(dto.weekdays ?? [])].sort((a, b) => a - b),
      // `[PQ.3.15]` La cadencia (DC29): la ancla sólo viaja con «cada N semanas».
      week_interval: dto.week_interval ?? null,
      week_anchor: dto.week_interval ? dto.week_anchor ?? null : null,
      month_week: dto.month_week ?? null,
    } : {}),
    ...(dto.pattern === 'month_days' ? {
      month_days: dto.month_days && dto.month_days.length ? [...new Set(dto.month_days)].sort((a, b) => a - b) : null,
      month_last_day: !!dto.month_last_day,
    } : {}),
    ...(dto.pattern === 'every_n_days' ? { every_n_days: dto.every_n_days } : {}),
    weekend_shift: dto.weekend_shift ?? 'friday',
    reviewer_user_id: dto.reviewer_user_id ?? null,
    note: dto.note?.trim() || null,
  };
  const alcance = alcanceDe(dto);
  await exigirAlcance(trx, quien, alcance);
  const viva = await trx(RULES)
    .where({ tenant_id: tenant, supplier_code: code, scope: alcance.scope })
    .andWhereRaw('COALESCE(zone_code, \'\') = ? AND COALESCE(branch_code, \'\') = ?', [alcance.zone_code ?? '', alcance.branch_code ?? ''])
    .whereNull('deleted_at').forUpdate().first('id');
  if (viva) {
    await declararActor(trx, quien);
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

/**
 * `[PQ.3.18]` (c) `POST /compras/calendario/reglas/ocasionales` (DC27): los ocasionales en bloque. De las claves que mandó
 * la pantalla, sólo toca las que HOY son ocasionales sin regla (escalón 3 de `leerPropuestas`, la misma cuenta que la
 * pantalla): a cada una, regla corporativa «cada 180 días» y fuera de ciclo 26 semanas, con motivo. Las demás se
 * devuelven como omitidas con su motivo. Corporativa = sólo quien escribe en todas las sucursales. Todo en la
 * transacción de quien llama: o entran todas o ninguna.
 */
export async function definirOcasionales(
  trx: Knex.Transaction, tenant: string, quien: Quien, dto: DefinirOcasionalesDto,
): Promise<DefinirOcasionalesRespuesta> {
  if (!quien.userId) throw new CalendarioError('invalida', 'No sabemos quién lo pide: vuelve a entrar.');
  const motivo = validarOcasionales(dto);
  if (motivo) throw new CalendarioError('invalida', motivo);
  await exigirAlcance(trx, quien, { scope: 'corporate', zone_code: null, branch_code: null });
  const prop = await leerPropuestas(trx, tenant);
  if (!prop.embudo.measured) {
    throw new CalendarioError('invalida', 'No se pudo medir quién es ocasional (la compra de 12 meses no se leyó): no se definen en bloque a ciegas.');
  }
  const ocasionales = new Set(prop.sin_regla.filter((p) => p.peso?.escalon === 3).map((p) => p.supplier_code));
  const hasta = sumarDias(prop.hoy, OCASIONAL_FUERA_DE_CICLO_DIAS);
  const omitidas: { supplier_code: string; motivo: string }[] = [];
  let definidas = 0;
  for (const code of [...new Set(dto.supplier_codes.map((c) => c.trim()))]) {
    if (!ocasionales.has(code)) {
      omitidas.push({ supplier_code: code, motivo: 'Ya no es un ocasional sin regla (tiene regla o dejó de ser ocasional).' });
      continue;
    }
    const r = await guardarRegla(trx, tenant, quien, {
      supplier_code: code, scope: 'corporate', pattern: 'every_n_days', every_n_days: OCASIONAL_CADA_N_DIAS, note: OCASIONAL_MOTIVO,
    });
    await fueraDeCiclo(trx, tenant, quien, r.id, { hasta, motivo: OCASIONAL_MOTIVO });
    definidas++;
  }
  return { definidas, hasta, omitidas };
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
  await declararActor(trx, quien);
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
  await declararActor(trx, quien);
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
