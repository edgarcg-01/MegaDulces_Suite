import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_PLATFORM } from '../platform-db/platform-db.constants';
import { pgRaw } from '../platform-db/pg-raw.util';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(@Inject(KNEX_PLATFORM) private readonly db: Knex) {}

  async getResumen() {
    const hoy = new Date();
    const anio = hoy.getFullYear();
    const mesActual = `${anio}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;

    try {
      // Ventas totales año en curso (kepler_ods.kdm2)
      const kpAnual = await pgRaw<any>(this.db, `
        SELECT
          ROUND(SUM(c13::numeric), 2)       AS venta_anual,
          ROUND(SUM(CASE WHEN TO_CHAR(c32::timestamp,'YYYY-MM') = $1
                    THEN c13::numeric ELSE 0 END), 2) AS venta_mes,
          COUNT(DISTINCT sucursal)           AS num_sucursales
        FROM kepler_ods.kdm2
        WHERE EXTRACT(YEAR FROM c32::timestamp) = $2
      `, [mesActual, anio]);

      // Top 3 sucursales del mes
      const topSuc = await pgRaw<any>(this.db, `
        SELECT sucursal AS suc,
               ROUND(SUM(c13::numeric), 2) AS total
        FROM kepler_ods.kdm2
        WHERE TO_CHAR(c32::timestamp,'YYYY-MM') = $1
        GROUP BY sucursal
        ORDER BY total DESC
        LIMIT 3
      `, [mesActual]);

      // Comparativa mes actual vs mes anterior
      const mesAnterior = hoy.getMonth() === 0
        ? `${anio - 1}-12`
        : `${anio}-${String(hoy.getMonth()).padStart(2, '0')}`;

      const compMes = await pgRaw<any>(this.db, `
        SELECT
          TO_CHAR(c32::timestamp,'YYYY-MM')  AS mes,
          ROUND(SUM(c13::numeric), 2)         AS total
        FROM kepler_ods.kdm2
        WHERE TO_CHAR(c32::timestamp,'YYYY-MM') IN ($1, $2)
        GROUP BY TO_CHAR(c32::timestamp,'YYYY-MM')
      `, [mesActual, mesAnterior]);

      return {
        generado: new Date().toISOString(),
        kp: {
          ventaAnual:     kpAnual[0]?.venta_anual    ?? 0,
          ventaMes:       kpAnual[0]?.venta_mes      ?? 0,
          numSucursales:  kpAnual[0]?.num_sucursales ?? 0,
          topSucursales:  topSuc,
          comparativaMes: compMes,
        },
      };
    } catch (e: any) {
      this.logger.error('Dashboard error: ' + e.message);
      return { error: e.message };
    }
  }
}
