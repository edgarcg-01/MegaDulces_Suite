import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * RD.5 — Operación de la ruta: odómetro, $/km y rendimiento.
 *
 * La migración `20260908160000` creó `logistics.route_odometer` y la vista
 * `analytics.v_route_operation_period` (la hoja `OPERACION DE LAS RUTAS` calculada bien),
 * pero **nada las leía**: 187 lecturas cargadas y ningún endpoint. Esto cierra ese hueco.
 *
 * Dos cosas que NO hace, a propósito:
 *
 * 1. **No corrige el odómetro por su cuenta.** 15 de 175 lecturas traen dígitos mal tecleados
 *    en pares que se cancelan (`205095 → 23174` es `223174` con el 2 comido). La tabla no tiene
 *    CHECK de `km_final >= km_inicial` justamente para no perder la lectura, y la vista pone el
 *    veredicto en `km_status`. Poner el dígito que falta sería inventar la lectura: se corrige
 *    a mano desde la pantalla, con `notes` de por qué (decisión de negocio 2026-09-09, §9.7).
 *
 * 2. **No rellena el $/km cuando falta la ficha.** Las rutas 28, 321 y 322 no tienen ficha de
 *    costo fijo en el workbook → `costo_fijo_por_km` sale NULL y `costo_status` dice
 *    `sin_ficha_de_costo`. NULL, nunca cero (§9.6).
 *
 * Permiso: reusa el par `LOGISTICS_ROUTE_EXPENSES_VER/_GESTIONAR`. Es la MISMA superficie
 * operativa —el costo de flota de Ruta Directa, en dos pestañas de una pantalla— y el odómetro
 * es justamente lo que convierte los pesos del gasto en $/km. Un par nuevo obligaría a los 6
 * touch-points del enum más una migración que lo REPARTA (lección LC.6.2) para gatear media
 * pantalla.
 */

export interface OdometroDto {
  route_code: string;
  anio: number;
  period_no: number;
  km_inicial?: number | null;
  km_final?: number | null;
  unidad?: string | null;
  vehicle_id?: string | null;
  notes?: string | null;
}

export interface OperacionQuery {
  anio?: number;
  route_code?: string;
  /** Sólo las filas cuyo odómetro NO es utilizable: lo que hay que ir a corregir. */
  solo_problemas?: boolean;
}

const entero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new BadRequestException('km_inicial y km_final deben ser enteros >= 0 (o vacío)');
  }
  return n;
};

@Injectable()
export class LogisticsRouteOperationService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * La tabla de operación por ruta × quincena, tal como la vista la declara.
   * `km_status` y `costo_status` viajan crudos: la pantalla los muestra, no los traduce a cero.
   */
  async periodos(q: OperacionQuery = {}) {
    const anio = q.anio ? Number(q.anio) : new Date().getFullYear();
    return this.tk.run(async (trx) => {
      const b = trx('analytics.v_route_operation_period').where({ anio });
      if (q.route_code) b.where('route_code', q.route_code);
      if (q.solo_problemas) b.whereNot('km_status', 'ok');
      const rows = await b.orderBy([{ column: 'route_code' }, { column: 'period_no' }]).select('*');

      // El resumen se calcula sobre lo MISMO que se devuelve, y declara qué no pudo medir.
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      const conKm = rows.filter((r: Record<string, unknown>) => num(r['km_recorridos']) !== null);
      const porStatus: Record<string, number> = {};
      for (const r of rows) porStatus[String(r['km_status'])] = (porStatus[String(r['km_status'])] ?? 0) + 1;

      return {
        anio,
        rows,
        total_filas: rows.length,
        // Cobertura EN PANTALLA: sin esto, "no hay problemas" se lee igual que "no se midió".
        con_km_utilizable: conKm.length,
        sin_km_utilizable: rows.length - conKm.length,
        km_status: porStatus,
        sin_ficha_de_costo: rows.filter((r) => r['costo_status'] === 'sin_ficha_de_costo').length,
      };
    });
  }

  /** El catálogo de quincenas, para que la captura no invente el periodo. */
  periodos_catalogo(anio?: number) {
    const a = anio ? Number(anio) : new Date().getFullYear();
    return this.tk.run((trx) =>
      trx('commercial.commission_periods')
        .whereNull('deleted_at')
        .whereRaw('EXTRACT(YEAR FROM date_to) = ?', [a])
        .orderBy('period_no')
        .select('period_no', 'date_from', 'date_to'));
  }

  /**
   * Alta o corrección de una lectura. UPSERT por la llave natural
   * `(tenant, route_code, anio, period_no)` — la misma del índice único parcial, así que
   * recapturar una quincena la corrige en vez de duplicarla.
   */
  async upsert(dto: OdometroDto) {
    if (!dto?.route_code) throw new BadRequestException('route_code es obligatorio');
    const anio = Number(dto.anio);
    const period = Number(dto.period_no);
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new BadRequestException('anio inválido');
    if (!Number.isInteger(period) || period < 1) throw new BadRequestException('period_no inválido');

    const ki = entero(dto.km_inicial);
    const kf = entero(dto.km_final);
    // ⚠️ A propósito NO se rechaza kf < ki: el dato real lo viola y rechazarlo perdería la
    // lectura. El veredicto lo pone `km_status` en la vista. Lo que sí se exige es que quien
    // guarde un retroceso deje dicho por qué — si no, la corrección es indistinguible del error.
    if (ki !== null && kf !== null && kf < ki && !String(dto.notes ?? '').trim()) {
      throw new BadRequestException(
        'km_final es menor que km_inicial. Se puede guardar así (el dato real lo hace), pero hay que escribir en notas por qué — un retroceso sin motivo no se distingue de un error de captura.',
      );
    }

    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.route_odometer')
        .insert({
          tenant_id: tenantId,
          route_code: String(dto.route_code).trim(),
          anio, period_no: period,
          km_inicial: ki, km_final: kf,
          unidad: dto.unidad ?? null,
          vehicle_id: dto.vehicle_id ?? null,
          source: 'captura_web',
          notes: dto.notes ?? null,
          created_by: userId, updated_by: userId,
        })
        .onConflict(trx.raw('(tenant_id, route_code, anio, period_no) WHERE deleted_at IS NULL'))
        .merge({
          km_inicial: ki, km_final: kf,
          unidad: dto.unidad ?? null,
          vehicle_id: dto.vehicle_id ?? null,
          notes: dto.notes ?? null,
          source: 'captura_web',
          updated_at: trx.fn.now(), updated_by: userId,
        })
        .returning('*');
      return row;
    });
  }

  async remove(id: string) {
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const n = await trx('logistics.route_odometer').where({ id }).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: userId });
      if (!n) throw new NotFoundException(`Lectura ${id} no existe`);
      return { id, deleted: true };
    });
  }

  /** Las fichas de costo fijo por ruta (`logistics.config_finance`), para verlas y editarlas. */
  fichas() {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT split_part(key, '.', 2) AS route_code,
                max(value) FILTER (WHERE key LIKE '%.costo_fijo_anual') AS costo_fijo_anual,
                max(value) FILTER (WHERE key LIKE '%.km_base_anual')    AS km_base_anual
           FROM logistics.config_finance
          WHERE category = 'costo_km' AND key LIKE 'RD.%' AND active
          GROUP BY 1 ORDER BY 1`);
      return rows.map((r: Record<string, unknown>) => ({
        ...r,
        costo_fijo_por_km: Number(r['km_base_anual']) > 0
          ? Math.round((Number(r['costo_fijo_anual']) / Number(r['km_base_anual'])) * 1e4) / 1e4
          : null,
      }));
    });
  }
}
