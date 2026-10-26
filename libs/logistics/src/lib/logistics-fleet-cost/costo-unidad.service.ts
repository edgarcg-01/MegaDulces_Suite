import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  CENTROS_DE_LOGISTICA, CONCEPTOS_DE_FLOTA, LINEA_CLAVE_RE, normalizarAlias, RUBROS_COSTO_UNIDAD, rubroDeLinea,
  type AreaFlota, type AsignacionGasto, type CambiosFicha, type CeldaPresupuesto, type DetalleUnidadCosto, type EstadoLineaFlota,
  type FichaUnidad, type GuiaDeUnidad, type KmDeUnidad, type LecturaOdometro, type LineaGastoFlota, type MetodoReparto,
  type NominaAdministrativaMes, type PeriodoCosto, type PresupuestoAnio, type Propiedad, type ResumenCostoUnidad, type RubroCodigo,
  type UnidadCosto,
} from '@megadulces/contracts';
import { comisionPorGuia } from '../logistics-trip-closure/trip-closure.service';
import type { RutaSuite } from '../logistics-erp-shipments/nuevo-embarque.logic';
import { armarUnidad, hoyMx, mesesDelPeriodo, periodoDe, repartoDeNomina, type DatosUnidad } from './costo-unidad.logic';

/**
 * `[FCU.2]` Costo por unidad — lo que hacía la hoja «TRANSPORTES 2026», leído en vivo:
 *  · el gasto real sale de Kepler (`analytics.v_fleet_expense_lines`, la unidad sugerida por el texto
 *    o confirmada por una persona);
 *  · los km, del GPS (`logistics.vehicle_day_summary`) o de la lectura de odómetro;
 *  · las comisiones, de las guías de la unidad a la tarifa de su ruta (la misma regla de Pagos de viaje);
 *  · lo que no está en ninguna fuente (salario, nómina administrativa, depreciación, presupuesto) se
 *    captura en sus pantallas.
 *
 * Quién la usa: Logística › Costos y reportes › Costo por unidad. Leer con
 * `LOGISTICS_COSTO_UNIDAD_VER`; escribir —y ver salarios y nómina administrativa— con `_GESTIONAR`.
 */

export interface Actor {
  userId: string | null;
}

type Paradas = Parameters<typeof comisionPorGuia>[0];

interface FilaVehiculo {
  id: string; plate: string; kepler_code: string | null; economic_number: string | null; display_name: string | null;
  vin: string | null; year: number | null; brand: string | null; model: string | null; fleet_area: string | null;
  ownership: string | null; purchase_value: string | null; purchase_date: string | null; useful_life_years: string | null;
  residual_value: string | null; insurance_carrier: string | null; insurance_policy: string | null; insurance_premium: string | null;
  insurance_expires_on: string | null; driver_monthly_salary: string | null; budget_km_year: number | null;
  kepler_aliases: string[] | null; notes: string | null; plate_kepler: string | null; tiene_gps: boolean;
}

interface FilaLinea {
  linea_clave: string; sucursal: string; folio: string; renglon: number; fecha: string; concepto: string; importe: string;
  centro: string | null; cabecera: string; texto: string; proveedor: string; estado: EstadoLineaFlota;
  vehicle_id: string | null; sugerido_vehicle_id: string | null; candidatos: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RUBROS = new Set<string>(RUBROS_COSTO_UNIDAD.map((r) => r.codigo));
const AREAS: readonly AreaFlota[] = ['transportes', 'reparto', 'telemarketing', 'ventas', 'administracion', 'otra'];

/** Las columnas de la ficha (con la placa que trae Kepler y si tiene GPS ligado). */
const SELECT_FICHA = `
  v.id, v.plate, v.kepler_code, v.economic_number, v.display_name, v.vin, v.year, v.brand, v.model, v.fleet_area,
  v.ownership, v.purchase_value, v.purchase_date::text AS purchase_date, v.useful_life_years, v.residual_value,
  v.insurance_carrier, v.insurance_policy, v.insurance_premium, v.insurance_expires_on::text AS insurance_expires_on,
  v.driver_monthly_salary, v.budget_km_year, v.kepler_aliases, v.notes,
  (SELECT k.placas FROM analytics.v_kepler_transporte k WHERE k.clave_kepler = v.kepler_code ORDER BY k.sucursal LIMIT 1) AS plate_kepler,
  EXISTS (SELECT 1 FROM logistics.trackers t WHERE t.vehicle_id = v.id AND t.deleted_at IS NULL) AS tiene_gps`;

function aFicha(v: FilaVehiculo, verSalarios: boolean): FichaUnidad {
  return {
    vehicle_id: v.id, economic_number: v.economic_number, display_name: v.display_name, plate: v.plate,
    plate_kepler: v.plate_kepler && v.plate_kepler !== v.plate ? v.plate_kepler : null, kepler_code: v.kepler_code,
    vin: v.vin, year: v.year, brand: v.brand || null, model: v.model || null,
    fleet_area: (v.fleet_area as AreaFlota | null) ?? null, ownership: (v.ownership as Propiedad | null) ?? null,
    purchase_value: num(v.purchase_value), purchase_date: v.purchase_date, useful_life_years: num(v.useful_life_years),
    residual_value: num(v.residual_value), insurance_carrier: v.insurance_carrier, insurance_policy: v.insurance_policy,
    insurance_premium: num(v.insurance_premium), insurance_expires_on: v.insurance_expires_on,
    driver_monthly_salary: verSalarios ? num(v.driver_monthly_salary) : null, salario_visible: verSalarios,
    budget_km_year: v.budget_km_year, kepler_aliases: v.kepler_aliases ?? [], tiene_gps: !!v.tiene_gps, notes: v.notes,
  };
}

function aLinea(l: FilaLinea): LineaGastoFlota {
  return {
    linea_clave: l.linea_clave, sucursal: l.sucursal, folio: l.folio, renglon: Number(l.renglon), fecha: String(l.fecha).slice(0, 10),
    concepto: l.concepto, rubro: rubroDeLinea(l.concepto, `${l.cabecera} ${l.texto}`, l.proveedor), importe: Number(l.importe),
    centro: l.centro, cabecera: l.cabecera, texto: l.texto, proveedor: l.proveedor, estado: l.estado,
    vehicle_id: l.vehicle_id, sugerido_vehicle_id: l.sugerido_vehicle_id, candidatos: Number(l.candidatos ?? 0),
  };
}

@Injectable()
export class CostoUnidadService {
  private readonly logger = new Logger(CostoUnidadService.name);

  constructor(private readonly tk: TenantKnexService) {}

  // ── Lectura ─────────────────────────────────────────────────────────────────────────────

  /** El tablero: cada unidad de Transportes con presupuesto contra real en el periodo. */
  async resumen(desde: string | undefined, hasta: string | undefined, verSalarios: boolean): Promise<ResumenCostoUnidad> {
    const hoy = hoyMx();
    const p = periodoDe(desde, hasta, hoy);
    const t0 = Date.now();
    const c = await this.calcular(p, hoy, verSalarios, null);
    this.logger.log(`resumen ${p.desde}→${p.hasta}: ${c.unidades.length} unidades en ${Date.now() - t0} ms`);
    return { periodo: p, unidades: c.unidades, pendientes: c.pendientes, meses_sin_nomina: c.mesesSinNomina, leido_at: new Date().toISOString() };
  }

  /** Una unidad, rubro por rubro, con los renglones de Kepler, las guías y sus km por mes. */
  async detalle(vehicleId: string, desde: string | undefined, hasta: string | undefined, verSalarios: boolean): Promise<DetalleUnidadCosto> {
    if (!UUID.test(vehicleId)) throw new BadRequestException('Unidad inválida.');
    const hoy = hoyMx();
    const p = periodoDe(desde, hasta, hoy);
    const c = await this.calcular(p, hoy, verSalarios, vehicleId);
    const unidad = c.unidades.find((u) => u.vehicle_id === vehicleId);
    const ficha = c.fichas.get(vehicleId);
    if (!unidad || !ficha) throw new NotFoundException('La unidad no existe.');
    const lecturas = await this.tk.run((trx) => this.lecturasDe(trx, vehicleId));
    return {
      ficha, unidad, periodo: p, leido_at: new Date().toISOString(), lecturas,
      lineas: c.lineas.filter((l) => l.vehicle_id === vehicleId).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.importe - a.importe),
      guias: c.guias.get(vehicleId) ?? [],
      km_por_mes: [...(c.kmPorMes.entries())].map(([mes, m]) => ({ mes, km: Math.round((m.get(vehicleId) ?? 0) * 10) / 10, fuente: c.fuenteKm.get(vehicleId) ?? 'gps' }))
        .filter((x) => x.km > 0),
    };
  }

  /** La bandeja: gastos de flota del periodo que nadie ha confirmado (o todos, si se pide). */
  async pendientes(desde: string | undefined, hasta: string | undefined, alcance: 'logistica' | 'todos'): Promise<{
    periodo: PeriodoCosto; lineas: LineaGastoFlota[]; unidades: Array<{ vehicle_id: string; nombre: string; plate: string; economic_number: string | null }>;
  }> {
    const p = periodoDe(desde, hasta, hoyMx());
    return this.tk.run(async (trx) => {
      const filas = await this.lineasDe(trx, p);
      const unidades = await this.unidadesDeFlota(trx, null);
      const deTransportes = new Set(unidades.map((u) => u.id));
      const lineas = filas.map(aLinea).filter((l) => alcance === 'todos'
        ? l.estado !== 'no_es_flota'
        : l.estado === 'ambiguo'
          || (l.estado === 'sugerido' && !!l.vehicle_id && deTransportes.has(l.vehicle_id))
          || (l.estado === 'sin_unidad' && !!l.centro && CENTROS_DE_LOGISTICA.includes(l.centro)));
      return {
        periodo: p,
        lineas: lineas.sort((a, b) => b.importe - a.importe),
        unidades: unidades.map((u) => ({ vehicle_id: u.id, nombre: u.display_name || u.plate, plate: u.plate, economic_number: u.economic_number })),
      };
    });
  }

  async presupuesto(anio: number): Promise<PresupuestoAnio> {
    if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) throw new BadRequestException('Año inválido.');
    return this.tk.run(async (trx) => {
      const unidades = await this.unidadesDeFlota(trx, null);
      const filas = await trx('logistics.fleet_cost_budget').whereNull('deleted_at').where({ anio })
        .select('vehicle_id', 'rubro', 'amount') as Array<{ vehicle_id: string; rubro: RubroCodigo; amount: string }>;
      return {
        anio,
        unidades: unidades.map((u) => {
          const montos: Partial<Record<RubroCodigo, number>> = {};
          for (const f of filas.filter((x) => x.vehicle_id === u.id)) montos[f.rubro] = Number(f.amount);
          return { vehicle_id: u.id, economic_number: u.economic_number, nombre: u.display_name || u.plate, montos,
            total: Math.round(Object.values(montos).reduce((a, x) => a + Number(x), 0) * 100) / 100 };
        }),
      };
    });
  }

  async nomina(anio: number): Promise<NominaAdministrativaMes[]> {
    if (!Number.isInteger(anio)) throw new BadRequestException('Año inválido.');
    return this.tk.run(async (trx) => (await trx('logistics.fleet_admin_payroll').whereNull('deleted_at')
      .where('year_month', 'like', `${anio}-%`).orderBy('year_month')
      .select('year_month', 'sueldos_admin', 'gastos_directos', 'metodo', 'notes') as Array<Record<string, string | null>>)
      .map((r) => ({ year_month: String(r.year_month), sueldos_admin: Number(r.sueldos_admin), gastos_directos: Number(r.gastos_directos),
        metodo: r.metodo as MetodoReparto, notes: r.notes ?? null })));
  }

  // ── Escritura ───────────────────────────────────────────────────────────────────────────

  /** Confirmar la unidad de uno o varios renglones de Kepler, marcarlos «no es de flota» o deshacerlo. */
  async asignar(items: AsignacionGasto[], actor: Actor): Promise<{ guardadas: number }> {
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('No hay renglones que guardar.');
    if (items.length > 500) throw new BadRequestException('Máximo 500 renglones por vez.');
    for (const it of items) {
      if (!LINEA_CLAVE_RE.test(String(it?.linea_clave ?? ''))) throw new BadRequestException(`Renglón inválido: ${it?.linea_clave}`);
      if (!['unidad', 'no_es_flota', 'quitar'].includes(it.decision)) throw new BadRequestException('Decisión inválida.');
      if (it.decision === 'unidad' && !UUID.test(String(it.vehicle_id ?? ''))) throw new BadRequestException('Falta la unidad.');
    }
    return this.tk.run(async (trx) => {
      const ids = [...new Set(items.filter((i) => i.decision === 'unidad').map((i) => String(i.vehicle_id)))];
      if (ids.length) {
        const vivos = await trx('logistics.vehicles').whereNull('deleted_at').whereIn('id', ids).pluck('id') as string[];
        const faltan = ids.filter((i) => !vivos.includes(i));
        if (faltan.length) throw new NotFoundException('Una de las unidades no existe.');
      }
      let guardadas = 0;
      for (const it of items) {
        const vigente = await trx('logistics.fleet_expense_assignments').whereNull('deleted_at').where({ linea_clave: it.linea_clave }).first('id');
        if (it.decision === 'quitar') {
          if (vigente) {
            await trx('logistics.fleet_expense_assignments').where({ id: vigente.id })
              .update({ deleted_at: trx.fn.now(), deleted_by: actor.userId, updated_at: trx.fn.now(), updated_by: actor.userId });
            guardadas++;
          }
          continue;
        }
        const datos = { decision: it.decision, vehicle_id: it.decision === 'unidad' ? it.vehicle_id : null, updated_at: trx.fn.now(), updated_by: actor.userId };
        if (vigente) await trx('logistics.fleet_expense_assignments').where({ id: vigente.id }).update(datos);
        else await trx('logistics.fleet_expense_assignments').insert({ ...datos, tenant_id: trx.raw('public.current_tenant_id()'), linea_clave: it.linea_clave, created_by: actor.userId });
        guardadas++;
      }
      return { guardadas };
    });
  }

  /** Guardar la ficha de una unidad (sólo los campos que se mandan). */
  async guardarFicha(vehicleId: string, cambios: CambiosFicha, actor: Actor): Promise<FichaUnidad> {
    if (!UUID.test(vehicleId)) throw new BadRequestException('Unidad inválida.');
    const patch = validarFicha(cambios ?? {});
    return this.tk.run(async (trx) => {
      const n = await trx('logistics.vehicles').whereNull('deleted_at').where({ id: vehicleId })
        .update({ ...patch, updated_at: trx.fn.now(), updated_by: actor.userId });
      if (!n) throw new NotFoundException('La unidad no existe.');
      const [v] = (await trx.raw<{ rows: FilaVehiculo[] }>(`SELECT ${SELECT_FICHA} FROM logistics.vehicles v WHERE v.id = ?`, [vehicleId])).rows;
      return aFicha(v, true);
    });
  }

  /** Guardar celdas del presupuesto de un año (`amount: null` = quitar la celda). */
  async guardarPresupuesto(anio: number, celdas: CeldaPresupuesto[], actor: Actor): Promise<PresupuestoAnio> {
    if (!Number.isInteger(anio) || anio < 2020 || anio > 2100) throw new BadRequestException('Año inválido.');
    if (!Array.isArray(celdas) || !celdas.length || celdas.length > 1000) throw new BadRequestException('Celdas inválidas.');
    for (const c of celdas) {
      if (!UUID.test(String(c?.vehicle_id ?? ''))) throw new BadRequestException('Unidad inválida.');
      if (!RUBROS.has(String(c.rubro))) throw new BadRequestException(`Rubro inválido: ${c.rubro}`);
      if (c.amount != null && !(Number.isFinite(Number(c.amount)) && Number(c.amount) >= 0)) throw new BadRequestException('El monto va en pesos, cero o más.');
    }
    await this.tk.run(async (trx) => {
      for (const c of celdas) {
        const vigente = await trx('logistics.fleet_cost_budget').whereNull('deleted_at').where({ vehicle_id: c.vehicle_id, anio, rubro: c.rubro }).first('id');
        if (c.amount == null) {
          if (vigente) await trx('logistics.fleet_cost_budget').where({ id: vigente.id }).update({ deleted_at: trx.fn.now(), deleted_by: actor.userId });
        } else if (vigente) {
          await trx('logistics.fleet_cost_budget').where({ id: vigente.id })
            .update({ amount: Math.round(Number(c.amount) * 100) / 100, source: 'captura', updated_at: trx.fn.now(), updated_by: actor.userId });
        } else {
          await trx('logistics.fleet_cost_budget').insert({ tenant_id: trx.raw('public.current_tenant_id()'), vehicle_id: c.vehicle_id, anio,
            rubro: c.rubro, amount: Math.round(Number(c.amount) * 100) / 100, source: 'captura', created_by: actor.userId, updated_by: actor.userId });
        }
      }
    });
    return this.presupuesto(anio);
  }

  async guardarNomina(mes: NominaAdministrativaMes, actor: Actor): Promise<NominaAdministrativaMes[]> {
    if (!MES.test(String(mes?.year_month ?? ''))) throw new BadRequestException('El mes va como AAAA-MM.');
    for (const k of ['sueldos_admin', 'gastos_directos'] as const) {
      if (!(Number.isFinite(Number(mes[k])) && Number(mes[k]) >= 0)) throw new BadRequestException('Los montos van en pesos, cero o más.');
    }
    if (!['km', 'partes_iguales'].includes(mes.metodo)) throw new BadRequestException('Método de reparto inválido.');
    await this.tk.run(async (trx) => {
      const datos = { sueldos_admin: Number(mes.sueldos_admin), gastos_directos: Number(mes.gastos_directos), metodo: mes.metodo,
        notes: mes.notes ? String(mes.notes).slice(0, 500) : null, updated_at: trx.fn.now(), updated_by: actor.userId };
      const vigente = await trx('logistics.fleet_admin_payroll').whereNull('deleted_at').where({ year_month: mes.year_month }).first('id');
      if (vigente) await trx('logistics.fleet_admin_payroll').where({ id: vigente.id }).update(datos);
      else await trx('logistics.fleet_admin_payroll').insert({ ...datos, tenant_id: trx.raw('public.current_tenant_id()'), year_month: mes.year_month, created_by: actor.userId });
    });
    return this.nomina(Number(mes.year_month.slice(0, 4)));
  }

  async registrarLectura(vehicleId: string, l: { read_on: string; odometer_km: number; notes?: string | null }, actor: Actor): Promise<LecturaOdometro[]> {
    if (!UUID.test(vehicleId)) throw new BadRequestException('Unidad inválida.');
    if (!FECHA.test(String(l?.read_on ?? ''))) throw new BadRequestException('La fecha va como AAAA-MM-DD.');
    if (!(Number.isInteger(Number(l.odometer_km)) && Number(l.odometer_km) >= 0)) throw new BadRequestException('El odómetro va en km enteros.');
    return this.tk.run(async (trx) => {
      const v = await trx('logistics.vehicles').whereNull('deleted_at').where({ id: vehicleId }).first('id');
      if (!v) throw new NotFoundException('La unidad no existe.');
      const vigente = await trx('logistics.vehicle_odometer_readings').whereNull('deleted_at').where({ vehicle_id: vehicleId, read_on: l.read_on }).first('id');
      const datos = { odometer_km: Number(l.odometer_km), notes: l.notes ? String(l.notes).slice(0, 300) : null, updated_at: trx.fn.now(), updated_by: actor.userId };
      if (vigente) await trx('logistics.vehicle_odometer_readings').where({ id: vigente.id }).update(datos);
      else await trx('logistics.vehicle_odometer_readings').insert({ ...datos, tenant_id: trx.raw('public.current_tenant_id()'), vehicle_id: vehicleId, read_on: l.read_on, created_by: actor.userId });
      return this.lecturasDe(trx, vehicleId);
    });
  }

  async borrarLectura(vehicleId: string, lecturaId: string, actor: Actor): Promise<LecturaOdometro[]> {
    if (!UUID.test(vehicleId) || !UUID.test(lecturaId)) throw new BadRequestException('Lectura inválida.');
    return this.tk.run(async (trx) => {
      const n = await trx('logistics.vehicle_odometer_readings').whereNull('deleted_at').where({ id: lecturaId, vehicle_id: vehicleId })
        .update({ deleted_at: trx.fn.now(), deleted_by: actor.userId });
      if (!n) throw new NotFoundException('La lectura no existe.');
      return this.lecturasDe(trx, vehicleId);
    });
  }

  // ── Lo de adentro ───────────────────────────────────────────────────────────────────────

  private async lecturasDe(trx: Knex.Transaction, vehicleId: string): Promise<LecturaOdometro[]> {
    const rows = await trx('logistics.vehicle_odometer_readings').whereNull('deleted_at').where({ vehicle_id: vehicleId })
      .orderBy('read_on', 'desc').limit(60).select('id', trx.raw('read_on::text AS read_on'), 'odometer_km', 'notes') as Array<{ id: string; read_on: string; odometer_km: number; notes: string | null }>;
    return rows.map((r) => ({ id: r.id, read_on: r.read_on, odometer_km: Number(r.odometer_km), notes: r.notes }));
  }

  /** Las unidades de Transportes (y la pedida, aunque sea de otra área). */
  private async unidadesDeFlota(trx: Knex.Transaction, incluir: string | null): Promise<FilaVehiculo[]> {
    const { rows } = await trx.raw<{ rows: FilaVehiculo[] }>(
      `SELECT ${SELECT_FICHA} FROM logistics.vehicles v
        WHERE v.deleted_at IS NULL AND (v.fleet_area = 'transportes' OR v.id = ?::uuid)
        ORDER BY nullif(regexp_replace(coalesce(v.economic_number, ''), '[^0-9]', '', 'g'), '')::int NULLS LAST, v.plate`,
      [incluir ?? '00000000-0000-0000-0000-000000000000']);
    return rows;
  }

  private async lineasDe(trx: Knex.Transaction, p: PeriodoCosto): Promise<FilaLinea[]> {
    const { rows } = await trx.raw<{ rows: FilaLinea[] }>(
      `SELECT linea_clave, sucursal, folio, renglon, fecha::text AS fecha, concepto, importe, centro, cabecera, texto, proveedor,
              estado, vehicle_id, sugerido_vehicle_id, candidatos
         FROM analytics.v_fleet_expense_lines
        WHERE fecha BETWEEN ?::date AND ?::date AND concepto = ANY(?::text[])`,
      [p.desde, p.hasta, [...CONCEPTOS_DE_FLOTA]]);
    return rows;
  }

  /** Todo lo que necesita el tablero y el detalle, en lecturas en paralelo (cada una en su transacción). */
  private async calcular(p: PeriodoCosto, hoy: string, verSalarios: boolean, incluir: string | null) {
    const anios: [number, number] = [Number(p.desde.slice(0, 4)), Number(p.hasta.slice(0, 4))];
    const [base, filasLineas, guiasYparadas] = await Promise.all([
      this.tk.run(async (trx) => {
        const vehiculos = await this.unidadesDeFlota(trx, incluir);
        const ids = vehiculos.map((v) => v.id);
        const gps = (await trx.raw<{ rows: Array<{ vehicle_id: string; mes: string; km: string; dias: number }> }>(
          `SELECT vehicle_id, to_char(day, 'YYYY-MM') AS mes, sum(km_driven) AS km, count(*)::int AS dias
             FROM logistics.vehicle_day_summary
            WHERE vehicle_id = ANY(?::uuid[]) AND day BETWEEN ?::date AND ?::date
            GROUP BY 1, 2`, [ids, p.desde, p.hasta])).rows;
        const odometro = (await trx.raw<{ rows: Array<{ vehicle_id: string; read_on: string; odometer_km: number }> }>(
          `SELECT vehicle_id, read_on::text AS read_on, odometer_km FROM logistics.vehicle_odometer_readings
            WHERE deleted_at IS NULL AND vehicle_id = ANY(?::uuid[]) AND read_on BETWEEN ?::date AND ?::date
            ORDER BY vehicle_id, read_on`, [ids, p.desde, p.hasta])).rows;
        const presupuesto = await trx('logistics.fleet_cost_budget').whereNull('deleted_at').whereIn('vehicle_id', ids)
          .whereBetween('anio', anios).select('vehicle_id', 'anio', 'rubro', 'amount') as Array<{ vehicle_id: string; anio: number; rubro: RubroCodigo; amount: string }>;
        const nomina = await trx('logistics.fleet_admin_payroll').whereNull('deleted_at')
          .whereBetween('year_month', [p.desde.slice(0, 7), p.hasta.slice(0, 7)])
          .select('year_month', 'sueldos_admin', 'gastos_directos', 'metodo') as Array<{ year_month: string; sueldos_admin: string; gastos_directos: string; metodo: MetodoReparto }>;
        const rutas = await (trx('logistics.routes').whereNull('deleted_at').where('active', true)
          .select('id', 'name', 'kepler_code', 'driver_commission', 'helper_commission', 'sin_comision') as Promise<RutaSuite[]>);
        return { vehiculos, gps, odometro, presupuesto, nomina, rutas };
      }),
      this.tk.run((trx) => this.lineasDe(trx, p)),
      this.tk.run(async (trx) => {
        // Las guías de la unidad (Kepler U-D-41) y las rutas de sus paradas, para la comisión por tarifa.
        const viajes = await trx('analytics.erp_shipment_trips').where('tenant_id', trx.raw('public.current_tenant_id()'))
          .whereBetween('fecha', [p.desde, p.hasta]).whereNotNull('vehicle_id')
          .select('sucursal', 'guia_embarque', trx.raw('fecha::text AS fecha'), 'vehicle_id') as Array<{ sucursal: string; guia_embarque: string; fecha: string; vehicle_id: string }>;
        if (!viajes.length) return { viajes, paradas: [] as Paradas };
        const paradas = await trx('analytics.erp_shipment_stops').where('tenant_id', trx.raw('public.current_tenant_id()'))
          .whereBetween('fecha', [p.desde, p.hasta])
          .whereRaw('guia_embarque = ANY(?::text[])', [[...new Set(viajes.map((v) => v.guia_embarque))]])
          .select('sucursal', 'guia_embarque', 'serie', 'folio', 'cliente_code', 'destino_nombre', 'ruta_clave', 'ruta_nombre') as Paradas;
        return { viajes, paradas };
      }),
    ]);

    const fichas = new Map(base.vehiculos.map((v) => [v.id, aFicha(v, verSalarios)]));
    const ids = new Set(fichas.keys());
    const lineas = filasLineas.map(aLinea);
    const deLaUnidad = (id: string) => lineas.filter((l) => l.vehicle_id === id && (l.estado === 'confirmado' || l.estado === 'sugerido'));

    // Km: GPS primero; si no hay, odómetro (última − primera lectura del periodo).
    const kmPorMes = new Map<string, Map<string, number>>();
    const kmGps = new Map<string, { km: number; dias: number }>();
    for (const g of base.gps) {
      const k = kmGps.get(g.vehicle_id) ?? { km: 0, dias: 0 };
      k.km += Number(g.km); k.dias += Number(g.dias); kmGps.set(g.vehicle_id, k);
      if (!kmPorMes.has(g.mes)) kmPorMes.set(g.mes, new Map());
      kmPorMes.get(g.mes)!.set(g.vehicle_id, (kmPorMes.get(g.mes)!.get(g.vehicle_id) ?? 0) + Number(g.km));
    }
    const fuenteKm = new Map<string, 'gps' | 'odometro'>();
    const km = new Map<string, KmDeUnidad>();
    for (const id of ids) {
      const g = kmGps.get(id);
      if (g && g.km > 0) { km.set(id, { km: Math.round(g.km * 10) / 10, fuente: 'gps', dias_gps: g.dias }); fuenteKm.set(id, 'gps'); continue; }
      const lect = base.odometro.filter((o) => o.vehicle_id === id);
      const dif = lect.length >= 2 ? Number(lect[lect.length - 1].odometer_km) - Number(lect[0].odometer_km) : null;
      if (dif != null && dif > 0) {
        km.set(id, { km: dif, fuente: 'odometro', dias_gps: 0 }); fuenteKm.set(id, 'odometro');
        const mes = lect[lect.length - 1].read_on.slice(0, 7);
        if (!kmPorMes.has(mes)) kmPorMes.set(mes, new Map());
        kmPorMes.get(mes)!.set(id, dif);
      } else km.set(id, { km: null, fuente: null, dias_gps: g?.dias ?? 0 });
    }

    // Comisión de cada guía por la tarifa de su ruta (la regla de Pagos de viaje).
    const comision = comisionPorGuia(guiasYparadas.paradas, base.rutas);
    const guias = new Map<string, GuiaDeUnidad[]>();
    for (const v of guiasYparadas.viajes) {
      if (!ids.has(v.vehicle_id)) continue;
      const c = comision.get(`${v.sucursal}|${v.guia_embarque}`);
      const lista = guias.get(v.vehicle_id) ?? [];
      lista.push({ sucursal: v.sucursal, guia: v.guia_embarque, fecha: String(v.fecha).slice(0, 10), ruta: c?.ruta ?? null, comision_chofer: c?.chofer ?? null });
      guias.set(v.vehicle_id, lista);
    }

    // Presupuesto por unidad, rubro y año.
    const presupuesto = new Map<string, Map<RubroCodigo, Map<number, number>>>();
    for (const b of base.presupuesto) {
      if (!presupuesto.has(b.vehicle_id)) presupuesto.set(b.vehicle_id, new Map());
      const porRubro = presupuesto.get(b.vehicle_id)!;
      if (!porRubro.has(b.rubro)) porRubro.set(b.rubro, new Map());
      porRubro.get(b.rubro)!.set(Number(b.anio), Number(b.amount));
    }

    // Nómina administrativa: se reparte entre las unidades de TRANSPORTES (no la pedida de otra área).
    const transportes = base.vehiculos.filter((v) => v.fleet_area === 'transportes').map((v) => v.id);
    const nominaMes = new Map(base.nomina.map((n) => [String(n.year_month), { sueldos_admin: Number(n.sueldos_admin), gastos_directos: Number(n.gastos_directos), metodo: n.metodo }]));
    const reparto = repartoDeNomina(mesesDelPeriodo(p), nominaMes, kmPorMes, transportes);

    const unidades: UnidadCosto[] = base.vehiculos.map((v) => {
      const datos: DatosUnidad = {
        ficha: fichas.get(v.id)!,
        lineas: deLaUnidad(v.id),
        presupuesto: presupuesto.get(v.id) ?? new Map(),
        km: km.get(v.id)!,
        comisiones: (guias.get(v.id) ?? []).map((g) => g.comision_chofer),
        nomina: reparto.porUnidad.get(v.id) ?? null,
      };
      return armarUnidad(datos, p, hoy, verSalarios);
    });

    // La bandeja, contada como la ve Logística por defecto.
    const pendientes = { sugerido: { renglones: 0, importe: 0 }, ambiguo: { renglones: 0, importe: 0 }, sin_unidad: { renglones: 0, importe: 0 } };
    for (const l of lineas) {
      const cuenta = l.estado === 'ambiguo'
        || (l.estado === 'sugerido' && !!l.vehicle_id && transportes.includes(l.vehicle_id))
        || (l.estado === 'sin_unidad' && !!l.centro && CENTROS_DE_LOGISTICA.includes(l.centro));
      if (!cuenta || l.estado === 'confirmado' || l.estado === 'no_es_flota') continue;
      const e = pendientes[l.estado];
      e.renglones++;
      e.importe = Math.round((e.importe + l.importe) * 100) / 100;
    }

    return { unidades, fichas, lineas, guias, kmPorMes, fuenteKm, pendientes, mesesSinNomina: reparto.mesesSinNomina };
  }
}

/** Lo que se acepta de la ficha: tipos, rangos y alias normalizados. */
export function validarFicha(c: CambiosFicha): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const texto = (k: keyof CambiosFicha, max: number) => {
    if (!(k in c)) return;
    const v = c[k];
    if (v == null || String(v).trim() === '') { out[k] = null; return; }
    if (String(v).length > max) throw new BadRequestException(`«${k}» es muy largo (máx. ${max}).`);
    out[k] = String(v).trim();
  };
  const pesos = (k: keyof CambiosFicha) => {
    if (!(k in c)) return;
    const v = c[k];
    if (v == null || v === '') { out[k] = null; return; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`«${k}» va en pesos, cero o más.`);
    out[k] = Math.round(n * 100) / 100;
  };
  const fecha = (k: keyof CambiosFicha) => {
    if (!(k in c)) return;
    const v = c[k];
    if (v == null || v === '') { out[k] = null; return; }
    if (!FECHA.test(String(v))) throw new BadRequestException(`«${k}» va como AAAA-MM-DD.`);
    out[k] = String(v);
  };
  texto('economic_number', 30); texto('display_name', 80); texto('vin', 30); texto('insurance_carrier', 200); texto('insurance_policy', 50);
  pesos('purchase_value'); pesos('residual_value'); pesos('insurance_premium'); pesos('driver_monthly_salary');
  fecha('purchase_date'); fecha('insurance_expires_on');
  if ('year' in c) {
    if (c.year == null) out.year = null;
    else if (!Number.isInteger(Number(c.year)) || Number(c.year) < 1950 || Number(c.year) > 2100) throw new BadRequestException('Año del modelo inválido.');
    else out.year = Number(c.year);
  }
  if ('budget_km_year' in c) {
    if (c.budget_km_year == null) out.budget_km_year = null;
    else if (!Number.isInteger(Number(c.budget_km_year)) || Number(c.budget_km_year) < 0) throw new BadRequestException('Los km por año van enteros.');
    else out.budget_km_year = Number(c.budget_km_year);
  }
  if ('useful_life_years' in c) {
    if (c.useful_life_years == null) out.useful_life_years = null;
    else if (!(Number(c.useful_life_years) > 0 && Number(c.useful_life_years) <= 50)) throw new BadRequestException('La vida útil va en años (más de 0).');
    else out.useful_life_years = Number(c.useful_life_years);
  }
  if ('fleet_area' in c) {
    if (c.fleet_area != null && !AREAS.includes(c.fleet_area)) throw new BadRequestException('Área inválida.');
    out.fleet_area = c.fleet_area ?? null;
  }
  if ('ownership' in c) {
    if (c.ownership != null && !['propia', 'arrendada'].includes(c.ownership)) throw new BadRequestException('Propiedad inválida.');
    out.ownership = c.ownership ?? null;
  }
  if ('kepler_aliases' in c) {
    if (!Array.isArray(c.kepler_aliases)) throw new BadRequestException('Los alias van en lista.');
    const alias = [...new Set(c.kepler_aliases.map(normalizarAlias).filter((a) => a.length >= 3))];
    if (alias.length > 20) throw new BadRequestException('Máximo 20 alias.');
    out.kepler_aliases = alias;
  }
  if (!Object.keys(out).length) throw new BadRequestException('No hay nada que guardar.');
  return out;
}
