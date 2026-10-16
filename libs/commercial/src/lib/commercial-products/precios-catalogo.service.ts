import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ScopeService, TenantKnexService } from '@megadulces/platform-core';
import type {
  CampoSinClasificar,
  ConsultaListaPrecios,
  ConsultaSinClasificar,
  FilaSinClasificar,
  OrdenListaPrecios,
  RespuestaHistoriaPrecio,
  RespuestaListaPrecios,
  RespuestaSinClasificar,
} from '@megadulces/contracts';
import { ajustePct, armarFila, cambiosDelDia, coincide, opciones, ordenar, type CambioCrudo, type FichaPrecio } from './precios-catalogo';
import {
  BITACORA_HASTA_SQL,
  BITACORA_MESES_SQL,
  CAMBIOS_DIA_SQL,
  HISTORIA_PRECIO_SQL,
  LISTA_PRECIOS_SQL,
} from './precios-catalogo.sql';
import { SIN_CLASIFICAR_SQL } from './ficha-sucursales.sql';

/** `[ZN.8]` El proyecto desde el que se pregunta el alcance: estas pantallas viven en Compras. */
const AREA = 'compras';
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ORDENES: OrdenListaPrecios[] = ['articulo', 'linea', 'tipo', 'grupo'];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/**
 * Filtro de clasificación: `undefined` = no filtra; `_` = «sin asignar» (código vacío). Un parámetro
 * vacío no viaja por la URL, así que «sin asignar» necesita un valor propio.
 */
const filtroCodigo = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v === '_' ? '' : v);

/**
 * `[CAT-PRECIO.2]`–`[CAT-PRECIO.5]` Compras › Catálogo › **Precios** (el catálogo de una sucursal, sus
 * cambios del día y la historia de cada precio) y Mantenimiento › **Sin clasificar**.
 *
 * Medido contra prod el 2026-10-16 (sucursal 03): la lista completa (9,679 productos) 0.3 s, los
 * cambios de un día 10 ms, la historia de un precio 72 ms, sin clasificar (toda la red) 0.65 s.
 */
@Injectable()
export class PreciosCatalogoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Las sucursales que esta persona puede consultar: las que venden al público, recortadas a su
   * alcance. Se resuelve FUERA de `tk.run` porque `ScopeService` usa su propia conexión.
   */
  private async sucursalesPermitidas(): Promise<{ codigo: string; nombre: string }[]> {
    // El área la declara el servicio (`[ZN.8]`): sin ella sólo se aplican las reglas '*' y cualquier
    // regla de alcance escrita para Compras se ignoraría en silencio.
    const visibles = this.scope.intersect(await this.scope.current(AREA), 'warehouse', null);
    const todas = await this.tk.run(async (trx) =>
      trx
        .from('commercial.warehouses')
        .whereNull('deleted_at')
        .where('sells_to_public', true)
        .whereNotNull('kepler_code')
        .select('kepler_code')
        .min({ nombre: 'name' })
        .groupBy('kepler_code')
        .orderBy('kepler_code'),
    );
    return (todas as { kepler_code: string; nombre: string | null }[])
      .filter((s) => visibles === null || visibles.includes(s.kepler_code))
      .map((s) => ({ codigo: s.kepler_code, nombre: s.nombre ?? s.kepler_code }));
  }

  /** La sucursal pedida tiene que estar en su alcance. Sin pedir y con una sola, es ésa. */
  private elegir(permitidas: { codigo: string; nombre: string }[], pedida?: string) {
    const p = pedida?.trim();
    if (p) {
      const s = permitidas.find((x) => x.codigo === p);
      if (!s) throw new ForbiddenException(`La sucursal ${p} no está en tu alcance.`);
      return s;
    }
    return permitidas.length === 1 ? permitidas[0] : null;
  }

  async lista(c: ConsultaListaPrecios = {}): Promise<RespuestaListaPrecios> {
    if (c.cambio_fecha && !FECHA.test(c.cambio_fecha)) throw new BadRequestException('cambio_fecha debe ser YYYY-MM-DD');
    const permitidas = await this.sucursalesPermitidas();
    const sucursal = this.elegir(permitidas, c.sucursal);
    const vacia: RespuestaListaPrecios = {
      sucursal, sucursales: permitidas, sucursal_fija: permitidas.length === 1,
      ficha_al: null, bitacora_hasta: null, lineas: [], tipos: [], grupos: [],
      cambios_centavo_ocultos: 0, cambios_resumen: null, total: 0, filas: [],
    };
    // Varias sucursales y ninguna elegida: no hay lista. Mezclar plazas daría precios que no existen.
    if (!sucursal) return vacia;

    const limite = c.todo ? Number.MAX_SAFE_INTEGER : Math.min(Math.max(Number(c.limite) || 100, 1), 500);
    const desplazamiento = c.todo ? 0 : Math.max(Number(c.desplazamiento) || 0, 0);
    const orden = ORDENES.includes(c.orden as OrdenListaPrecios) ? (c.orden as OrdenListaPrecios) : 'articulo';

    return this.tk.run(async (trx) => {
      const [fichas, hasta, sync, cambiosCrudos] = await Promise.all([
        trx.raw(LISTA_PRECIOS_SQL, { suc: sucursal.codigo }),
        trx.raw(BITACORA_HASTA_SQL, { suc: sucursal.codigo }),
        trx.from('kepler_ods._sync_status').where('table_name', 'kdii').first('last_push_at'),
        c.cambio_fecha ? trx.raw(CAMBIOS_DIA_SQL, { suc: sucursal.codigo, fecha: c.cambio_fecha }) : null,
      ]);
      const { porClave, ocultos } = cambiosDelDia(((cambiosCrudos?.rows ?? []) as CambioCrudo[]));
      const todas = ((fichas.rows ?? []) as FichaPrecio[]).map((f) => armarFila(f, porClave));

      const [linea, tipo, grupo] = [filtroCodigo(c.linea), filtroCodigo(c.tipo), filtroCodigo(c.grupo)];
      const filtradas = ordenar(
        todas.filter(
          (f) =>
            coincide(f, c.q) &&
            (linea === undefined || (f.linea.codigo ?? '') === linea) &&
            (tipo === undefined || (f.tipo.codigo ?? '') === tipo) &&
            (grupo === undefined || (f.grupo.codigo ?? '') === grupo) &&
            (!c.cambio_fecha || f.unidades.some((u) => u.cambio !== null)),
        ),
        orden,
      );
      const al = (sync as { last_push_at: Date | string | null } | undefined)?.last_push_at ?? null;
      return {
        ...vacia,
        ficha_al: al === null ? null : new Date(al).toISOString(),
        bitacora_hasta: (hasta.rows?.[0]?.hasta as string | null) ?? null,
        lineas: opciones(todas, 'linea'),
        tipos: opciones(todas, 'tipo'),
        grupos: opciones(todas, 'grupo'),
        cambios_centavo_ocultos: ocultos,
        cambios_resumen: c.cambio_fecha
          ? filtradas.reduce(
              (r, f) => {
                for (const u of f.unidades) {
                  if (!u.cambio) continue;
                  if (u.cambio.nuevo > u.cambio.anterior) r.suben++;
                  else r.bajan++;
                }
                return r;
              },
              { suben: 0, bajan: 0 },
            )
          : null,
        total: filtradas.length,
        filas: filtradas.slice(desplazamiento, desplazamiento + limite),
      };
    });
  }

  async historia(sku: string, sucursalPedida: string, unidad: string): Promise<RespuestaHistoriaPrecio> {
    const s = (sku ?? '').trim();
    const u = (unidad ?? '').trim().toUpperCase();
    if (!s || !u) throw new BadRequestException('sku y unidad son obligatorios');
    const sucursal = this.elegir(await this.sucursalesPermitidas(), sucursalPedida);
    if (!sucursal) throw new BadRequestException('Elige una sucursal');

    return this.tk.run(async (trx) => {
      const [cambios, meses, ficha] = await Promise.all([
        trx.raw(HISTORIA_PRECIO_SQL, { suc: sucursal.codigo, sku: s, unidad: u }),
        trx.raw(BITACORA_MESES_SQL, { suc: sucursal.codigo }),
        trx.raw(LISTA_PRECIOS_SQL + ' AND btrim(i.c1) = :sku', { suc: sucursal.codigo, sku: s }),
      ]);
      const f = (ficha.rows?.[0] as FichaPrecio | undefined) ?? null;
      const fila = f ? armarFila(f) : null;
      const actual = fila?.unidades.find((x) => x.unidad === u)?.precio ?? null;
      const ms = (meses.rows ?? []) as { mes: string; filas: number }[];
      return {
        sku: s,
        nombre: fila?.nombre ?? null,
        sucursal,
        unidad: u,
        precio_actual: actual,
        cambios: ((cambios.rows ?? []) as Record<string, unknown>[]).map((r) => {
          const anterior = num(r.precio_anterior);
          const nuevo = num(r.precio_nuevo);
          return {
            fecha: String(r.fecha),
            hora: (r.hora as string | null) ?? null,
            anterior,
            nuevo,
            ajuste_pct: ajustePct(anterior, nuevo),
            es_baja: r.es_baja === true,
          };
        }),
        bitacora_desde: ms[0]?.mes ?? null,
        meses_sin_registro: ms.filter((m) => Number(m.filas) === 0).map((m) => m.mes),
      };
    });
  }

  async sinClasificar(c: ConsultaSinClasificar = {}): Promise<RespuestaSinClasificar> {
    const limite = Math.min(Math.max(Number(c.limite) || 100, 1), 500);
    const desplazamiento = Math.max(Number(c.desplazamiento) || 0, 0);
    const CAMPOS: CampoSinClasificar[] = ['linea', 'tipo', 'grupo'];
    const falta = CAMPOS.includes(c.falta as CampoSinClasificar) ? (c.falta as CampoSinClasificar) : undefined;

    return this.tk.run(async (trx) => {
      const [crudo, sync] = await Promise.all([
        trx.raw(SIN_CLASIFICAR_SQL),
        trx.from('kepler_ods._sync_status').where('table_name', 'kdii').first('last_push_at'),
      ]);
      const palabras = norm((c.q ?? '').trim()).split(/\s+/).filter(Boolean);
      const todas: FilaSinClasificar[] = ((crudo.rows ?? []) as Record<string, unknown>[]).map((r) => ({
        sku: String(r.sku),
        nombre: String(r.nombre ?? r.sku),
        plazas: Number(r.plazas) || 0,
        linea: { codigo: (r.linea as string | null) ?? null, nombre: (r.linea_nombre as string | null) ?? null },
        falta: CAMPOS.filter((k) => r[`sin_${k}`] === true),
        venta_30d: num(r.venta_30d),
      }));
      // El universo del resumen: búsqueda y venta. Los chips SON el selector de `falta`.
      const universo = todas.filter(
        (f) =>
          (!c.con_venta || f.venta_30d > 0) &&
          (palabras.length === 0 || palabras.every((p) => norm(`${f.sku} ${f.nombre}`).includes(p))),
      );
      const resumen = { linea: 0, tipo: 0, grupo: 0 } as Record<CampoSinClasificar, number>;
      for (const f of universo) for (const k of f.falta) resumen[k]++;

      const lineas = new Map<string, { codigo: string; nombre: string; productos: number }>();
      for (const f of universo) {
        const k = f.linea.codigo ?? '';
        const o = lineas.get(k) ?? { codigo: k, nombre: k ? (f.linea.nombre ?? k) : 'Sin línea', productos: 0 };
        o.productos++;
        lineas.set(k, o);
      }

      const linea = filtroCodigo(c.linea);
      const visibles = universo
        .filter((f) => (!falta || f.falta.includes(falta)) && (linea === undefined || (f.linea.codigo ?? '') === linea))
        .sort((a, b) => b.venta_30d - a.venta_30d || a.nombre.localeCompare(b.nombre, 'es'));
      const al = (sync as { last_push_at: Date | string | null } | undefined)?.last_push_at ?? null;
      return {
        ficha_al: al === null ? null : new Date(al).toISOString(),
        resumen,
        con_falta: universo.length,
        lineas: [...lineas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
        total: visibles.length,
        filas: visibles.slice(desplazamiento, desplazamiento + limite),
      };
    });
  }
}
