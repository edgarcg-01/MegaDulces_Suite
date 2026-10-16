import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  CAMPOS_FICHA,
  type CampoFicha,
  type ConsultaFichaSucursales,
  type FilaFichaSucursales,
  type RespuestaFichaSucursales,
} from '@megadulces/contracts';
import { coincideBusqueda, compararFicha, pasaFiltros, type FichaPlaza } from './ficha-sucursales';
import { FICHA_SUCURSALES_SQL, FICHA_SUCURSALES_UNIVERSO_SQL } from './ficha-sucursales.sql';

interface FilaCruda {
  sku: string;
  venta_30d: string | number | null;
  celdas: FichaPlaza[] | string;
}

/**
 * `[CAT-PRECIO.1]` Precios › **Diferencias entre sucursales**: la ficha de venta de Kepler, campo
 * por campo, contra la mayoría de las plazas (referencia provisional mientras el Concentrador no
 * llega al ODS — ver `precios-sucursales.contract.ts`).
 *
 * Reemplaza en pantalla a `[CAT.3]` (`price-discrepancies`), que sólo comparaba pieza y mayoreo y
 * devolvía como mucho 300 filas sin decir cuántas había: el contador de la pantalla se quedaba en
 * 300 con ~1,000 reales. Aquí `total` es el conteo real y la paginación va aparte.
 *
 * Medido contra prod el 2026-10-16: 9,684 productos comparados, 1,422 con algún campo distinto,
 * ~3 s la consulta completa (la ficha ~1.5 s, la bitácora ~0.5 s por su índice parcial).
 */
@Injectable()
export class FichaSucursalesService {
  constructor(private readonly tk: TenantKnexService) {}

  async diferencias(c: ConsultaFichaSucursales = {}): Promise<RespuestaFichaSucursales> {
    const limite = Math.min(Math.max(Number(c.limite) || 100, 1), 500);
    const desplazamiento = Math.max(Number(c.desplazamiento) || 0, 0);
    const campo = CAMPOS_FICHA.some((x) => x.campo === c.campo) ? c.campo : undefined;
    const sucursal = c.sucursal?.trim() || undefined;

    return this.tk.run(async (trx) => {
      const [crudo, universo, sucs, sync] = await Promise.all([
        trx.raw(FICHA_SUCURSALES_SQL),
        trx.raw(FICHA_SUCURSALES_UNIVERSO_SQL),
        trx
          .from('commercial.warehouses')
          .whereNull('deleted_at')
          .where('sells_to_public', true)
          .whereNotNull('kepler_code')
          .select('kepler_code')
          .min({ nombre: 'name' })
          .groupBy('kepler_code')
          .orderBy('kepler_code'),
        trx.from('kepler_ods._sync_status').where('table_name', 'kdii').first('last_push_at'),
      ]);
      const fichaAl = (sync as { last_push_at: Date | string | null } | undefined)?.last_push_at ?? null;

      // Una fila puede pasar el filtro de la consulta y quedar sin campos aquí: p. ej. un factor
      // capturado en una unidad sin rótulo, que la regla descarta como basura. Esas coinciden.
      const todas: { fila: FilaFichaSucursales; fichas: FichaPlaza[] }[] = [];
      for (const r of (crudo.rows ?? []) as FilaCruda[]) {
        const fichas = (typeof r.celdas === 'string' ? JSON.parse(r.celdas) : r.celdas) as FichaPlaza[];
        const fila = compararFicha(r.sku, fichas, Number(r.venta_30d) || 0);
        if (fila.campos.length) todas.push({ fila, fichas });
      }

      const buscadas = todas.filter((x) => coincideBusqueda(x.fila, x.fichas, c.q)).map((x) => x.fila);

      // El resumen mira el mismo universo que la tabla salvo campo y plaza: los chips SON el
      // selector y tienen que seguir mostrando el reparto completo (mismo criterio que Costos).
      const resumen = Object.fromEntries(CAMPOS_FICHA.map((x) => [x.campo, 0])) as Record<CampoFicha, number>;
      for (const f of buscadas) for (const x of f.campos) resumen[x.campo]++;

      const visibles = buscadas
        .filter((f) => pasaFiltros(f, { campo, sucursal }))
        .sort((a, b) => b.venta_30d - a.venta_30d || b.campos.length - a.campos.length || a.sku.localeCompare(b.sku));

      return {
        referencia: 'mayoria',
        ficha_al: fichaAl === null ? null : new Date(fichaAl).toISOString(),
        sucursales: (sucs as { kepler_code: string; nombre: string | null }[]).map((s) => ({
          codigo: s.kepler_code,
          nombre: s.nombre ?? s.kepler_code,
        })),
        productos_comparados: Number(universo.rows?.[0]?.productos) || 0,
        resumen,
        con_diferencias: buscadas.length,
        total: visibles.length,
        filas: visibles.slice(desplazamiento, desplazamiento + limite),
      };
    });
  }
}
