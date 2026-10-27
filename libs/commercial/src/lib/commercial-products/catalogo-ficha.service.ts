import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { aplicarBusquedaCatalogo, razonDeCoincidencia } from './catalogo-busqueda';
import {
  armarConteos,
  armarSucursales,
  armarUnidades,
  descripcionDistinta,
  mostrarValido,
  num,
  ordenarCodigos,
  precioDeRed,
  sucursalValida,
  type CatalogoFila,
  type CatalogoLista,
  type EscaleraCruda,
  type FichaProducto,
  type MostrarCatalogo,
  type PrecioCrudo,
  type SucursalCruda,
} from './catalogo-ficha';
import {
  CODIGOS_SQL,
  ESCALERA_SQL,
  LABEL_POR_SUCURSAL_SQL,
  N_CODIGOS_LATERAL_SQL,
  PRECIOS_RED_SQL,
  PRECIOS_SUCURSAL_SQL,
  PRODUCTO_SQL,
  SIN_PRECIO_LATERAL_SQL,
  SUCURSALES_SQL,
  ULTIMA_ENTRADA_SQL,
  VENTA_MES_SQL,
} from './catalogo-ficha.sql';
import { EXISTENCIA_KEPLER_SQL } from './new-products.sql';
import type { FilaUniverso } from './catalogo-detallado';
import { SIN_PROVEEDOR_EXPR } from './catalogo-detallado.sql';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Escalera = EscaleraCruda & { sku: string };
type Precio = PrecioCrudo & { product_id: string };

/**
 * Compras › Catálogo: la lista (búsqueda + unidades con precio de una sucursal) y la ficha de un producto
 * (precios, red, existencia y venta del mes por sucursal, última entrada). Sólo lectura, todo del ODS.
 */
@Injectable()
export class CatalogoFichaService {
  private readonly logger = new Logger(CatalogoFichaService.name);
  /** Se pregunta una vez por proceso: la columna llega con `[NORM.3]` y no se va. */
  private labelPorSucursal: boolean | null = null;

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Sin grano por sucursal (base sin `[NORM.3]`), la tabla trae UNA fila por producto que es la moda de
   * las plazas: no es el precio de ninguna sucursal en particular. Se declara «sin precio», no se presta.
   */
  private async conPrecioPorSucursal(trx: Knex.Transaction): Promise<boolean> {
    if (this.labelPorSucursal === null) {
      const { rows } = await trx.raw(LABEL_POR_SUCURSAL_SQL);
      this.labelPorSucursal = rows[0]?.por_sucursal === true;
      if (!this.labelPorSucursal) {
        this.logger.warn('commercial.product_label_prices sin columna sucursal: los precios del catálogo viajan como null');
      }
    }
    return this.labelPorSucursal;
  }

  /**
   * La lista. Mostrar (todos | varios_codigos | sin_codigo | sin_precio) se filtra AQUÍ, no en el navegador:
   * la lista es paginada. Los conteos son de la búsqueda entera, sin importar qué se muestra.
   */
  async lista(q: { search?: string; sucursal?: string; page?: number; pageSize?: number; mostrar?: string }): Promise<CatalogoLista> {
    const sucursal = sucursalValida(q.sucursal);
    const pageSize = Math.min(Math.max(Math.trunc(Number(q.pageSize)) || 50, 1), 200);
    const page = Math.max(Math.trunc(Number(q.page)) || 1, 1);
    const texto = (q.search ?? '').trim();

    return this.tk.run(async (trx) => {
      const conPrecio = await this.conPrecioPorSucursal(trx);
      const mostrar: MostrarCatalogo = mostrarValido(q.mostrar, conPrecio);
      const buscado = this.buscado(trx, texto, sucursal, conPrecio);

      const base = buscado.clone();
      if (mostrar === 'varios_codigos') base.where('cc.n_codigos', '>=', 2);
      else if (mostrar === 'sin_codigo') base.where('cc.n_codigos', 0);
      else if (mostrar === 'sin_precio') base.whereRaw('sp.sin_precio');

      const [crudos, conteo, filas] = await Promise.all([
        buscado
          .clone()
          .clearSelect()
          .clearOrder()
          .select(
            trx.raw('count(*) AS todos'),
            trx.raw('count(*) FILTER (WHERE cc.n_codigos >= 2) AS varios'),
            trx.raw('count(*) FILTER (WHERE cc.n_codigos = 0) AS sin_codigo'),
            trx.raw(conPrecio ? 'count(*) FILTER (WHERE sp.sin_precio) AS sin_precio' : 'NULL::int AS sin_precio'),
          )
          .first() as Promise<{ todos: string; varios: string; sin_codigo: string; sin_precio: string | null } | undefined>,
        // Con «todos» el total ES el conteo de la búsqueda: no se paga otra pasada.
        mostrar === 'todos'
          ? Promise.resolve(undefined)
          : (base.clone().clearSelect().clearOrder().count({ n: '*' }).first() as Promise<{ n: string | number } | undefined>),
        base
          .clone()
          .select(
            trx.raw('p.id::text AS id'),
            'p.sku',
            'p.nombre',
            'p.description',
            'p.barcode',
            trx.raw('s.id::text AS proveedor_id'),
            's.name as proveedor',
            'cc.n_codigos',
          )
          .orderBy('p.nombre')
          .orderBy('p.id')
          .limit(pageSize)
          .offset((page - 1) * pageSize) as Promise<Array<{
            id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
            proveedor_id: string | null; proveedor: string | null; n_codigos: number | string | null;
          }>>,
      ]);
      const conteos = armarConteos(crudos, conPrecio);
      const out = await this.armarFilas(trx, filas, texto, sucursal, conPrecio);

      return {
        sucursal,
        total: mostrar === 'todos' ? conteos.todos : Number(conteo?.n ?? 0),
        filas: out,
        calculado_al: new Date().toISOString(),
        conteos,
        mostrar,
      };
    });
  }

  /**
   * La búsqueda de la lista sobre los productos activos, con el proveedor (`s`), el número de códigos (`cc`) y,
   * si la base tiene precio por sucursal, «sin precio» (`sp`). Una sola definición para Sencillo y Detallado.
   */
  private buscado(trx: Knex.Transaction, texto: string, sucursal: string, conPrecio: boolean): Knex.QueryBuilder {
    const q = aplicarBusquedaCatalogo(
      trx
        .from('catalog.products as p')
        .leftJoin('catalog.suppliers as s', function () {
          this.on('s.id', '=', 'p.supplier_id').andOn('s.tenant_id', '=', 'p.tenant_id');
        })
        .whereRaw('p.tenant_id = public.current_tenant_id()')
        .whereNull('p.deleted_at')
        .where('p.activo', true),
      texto,
      { conProveedor: true },
    ).joinRaw(N_CODIGOS_LATERAL_SQL);
    // Sin precio por sucursal no se puede medir «sin precio»: ni se une ni se cuenta.
    if (conPrecio) q.joinRaw(SIN_PRECIO_LATERAL_SQL, [sucursal, sucursal]);
    return q;
  }

  /**
   * Detallado: TODOS los productos de la búsqueda (sin paginar) con lo que hace falta para contar, filtrar,
   * ordenar y pintar en el servidor. Mismo buscador y mismos laterales que la lista de Sencillo.
   */
  async universo(q: { search?: string; sucursal?: string }): Promise<{ sucursal: string; texto: string; conPrecio: boolean; filas: FilaUniverso[] }> {
    const sucursal = sucursalValida(q.sucursal);
    const texto = (q.search ?? '').trim();
    return this.tk.run(async (trx) => {
      const conPrecio = await this.conPrecioPorSucursal(trx);
      const filas = (await this.buscado(trx, texto, sucursal, conPrecio).select(
        trx.raw('p.id::text AS id'),
        'p.sku',
        'p.nombre',
        'p.description',
        'p.barcode',
        trx.raw('s.id::text AS proveedor_id'),
        's.name as proveedor',
        'cc.n_codigos',
        trx.raw(conPrecio ? 'sp.sin_precio' : 'NULL::boolean AS sin_precio'),
        trx.raw(`${SIN_PROVEEDOR_EXPR} AS sin_proveedor`),
      )) as FilaUniverso[];
      return { sucursal, texto, conPrecio, filas };
    });
  }

  /** Detallado: los renglones de una página (unidades con su precio y «Coincide por…»), igual que Sencillo. */
  async filasDe(filas: FilaUniverso[], texto: string, sucursal: string): Promise<CatalogoFila[]> {
    if (!filas.length) return [];
    return this.tk.run(async (trx) => this.armarFilas(trx, filas, texto, sucursal, await this.conPrecioPorSucursal(trx)));
  }

  /** Unidades con el precio de la sucursal y la razón de la coincidencia, para los renglones dados. */
  private async armarFilas(
    trx: Knex.Transaction,
    filas: Array<{
      id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
      proveedor_id: string | null; proveedor: string | null; n_codigos: number | string | null;
    }>,
    texto: string,
    sucursal: string,
    conPrecio: boolean,
  ): Promise<CatalogoFila[]> {
    const ids = filas.map((f) => f.id);
    const skus = [...new Set(filas.map((f) => f.sku).filter((s): s is string => !!s))];
    const [precios, escaleras, codigos] = await Promise.all([
      conPrecio && ids.length ? trx.raw(PRECIOS_SUCURSAL_SQL, [ids, sucursal]).then((r) => r.rows as Precio[]) : Promise.resolve([] as Precio[]),
      skus.length ? trx.raw(ESCALERA_SQL, [skus, sucursal]).then((r) => r.rows as Escalera[]) : Promise.resolve([] as Escalera[]),
      texto && skus.length
        ? trx.raw(CODIGOS_SQL, [skus]).then((r) => r.rows as { sku: string; barcode: string }[])
        : Promise.resolve([] as { sku: string; barcode: string }[]),
    ]);
    const precioDe = new Map(precios.map((p) => [p.product_id, p]));
    const escaleraDe = new Map(escaleras.map((e) => [e.sku, e]));
    const codigosDe = new Map<string, string[]>();
    for (const c of codigos) codigosDe.set(c.sku, [...(codigosDe.get(c.sku) ?? []), c.barcode]);

    const out: CatalogoFila[] = filas.map((f) => {
      const unidades = armarUnidades((f.sku && escaleraDe.get(f.sku)) || null, precioDe.get(f.id) ?? null);
      return {
        id: f.id,
        sku: f.sku,
        nombre: f.nombre,
        proveedor: f.proveedor_id ? { id: f.proveedor_id, nombre: f.proveedor ?? '' } : null,
        unidades,
        nCodigos: num(f.n_codigos) ?? 0,
        razon: texto
          ? razonDeCoincidencia(
              {
                nombre: f.nombre,
                sku: f.sku,
                descripcion: f.description,
                codigos: ordenarCodigos(f.barcode, (f.sku && codigosDe.get(f.sku)) || []),
                codigoPrincipal: f.barcode,
                proveedor: f.proveedor,
                // La búsqueda compara contra u1/u2/u3 crudos de la escalera: se le pasan los mismos.
                unidades: [escaleraDe.get(f.sku ?? '')?.u1_label, escaleraDe.get(f.sku ?? '')?.u2_label, escaleraDe.get(f.sku ?? '')?.u3_label]
                  .filter((x): x is string => !!x),
              },
              texto,
            )
          : null,
      };
    });
    return out;
  }

  async ficha(id: string, q: { sucursal?: string; puedeVerCosto: boolean }): Promise<FichaProducto> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id de producto inválido');
    const sucursal = sucursalValida(q.sucursal);

    return this.tk.run(async (trx) => {
      const prod = (await trx.raw(PRODUCTO_SQL, [id])).rows[0] as
        | {
            id: string; sku: string | null; nombre: string; description: string | null; barcode: string | null;
            activo: boolean; proveedor_id: string | null; proveedor: string | null;
          }
        | undefined;
      if (!prod) throw new NotFoundException('Producto no encontrado');
      const sku = prod.sku?.trim() || null;
      const conPrecio = await this.conPrecioPorSucursal(trx);

      const [precio, red, escalera, codigos, sucs, venta, existencia, entrada] = await Promise.all([
        conPrecio ? trx.raw(PRECIOS_SUCURSAL_SQL, [[id], sucursal]).then((r) => (r.rows[0] as Precio | undefined) ?? null) : Promise.resolve(null),
        conPrecio ? trx.raw(PRECIOS_RED_SQL, [id]).then((r) => r.rows as { piece_price: string | null }[]) : Promise.resolve([]),
        sku ? trx.raw(ESCALERA_SQL, [[sku], sucursal]).then((r) => (r.rows[0] as Escalera | undefined) ?? null) : Promise.resolve(null),
        sku ? trx.raw(CODIGOS_SQL, [[sku]]).then((r) => (r.rows as { barcode: string }[]).map((x) => x.barcode)) : Promise.resolve([]),
        trx.raw(SUCURSALES_SQL).then((r) => r.rows as SucursalCruda[]),
        trx
          .raw(VENTA_MES_SQL, [id])
          .then((r) => r.rows as { sucursal: string; monto: string; unidades: string; ultima: string | null }[]),
        sku
          ? trx.raw(EXISTENCIA_KEPLER_SQL, [[sku], [id]]).then((r) => r.rows as { sucursal: string; cantidad: string }[])
          : Promise.resolve([]),
        sku
          ? trx.raw(ULTIMA_ENTRADA_SQL, [sku]).then((r) => (r.rows[0] as {
              sucursal: string; fecha: string; unidad: string; cantidad: string; costo: string | null;
            } | undefined) ?? null)
          : Promise.resolve(null),
      ]);

      const sucursales = armarSucursales(
        sucs,
        new Map(venta.map((v) => [v.sucursal, { monto: v.monto, unidades: v.unidades }])),
        new Map(existencia.map((e) => [e.sucursal, e.cantidad])),
      );
      const ultimas = venta.map((v) => v.ultima).filter((x): x is string => !!x).sort();
      const unidades = armarUnidades(escalera, precio);
      const nombreDe = new Map(sucs.map((s) => [s.codigo, s.nombre]));
      let nombreEntrada: string | null = null;
      if (entrada) {
        nombreEntrada = nombreDe.get(entrada.sucursal) ?? null;
        if (nombreEntrada === null) {
          const w = (await trx.raw(
            `SELECT min(name) AS name FROM commercial.warehouses
              WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL AND kepler_code = ?`,
            [entrada.sucursal],
          )).rows[0] as { name: string | null } | undefined;
          nombreEntrada = w?.name ?? null;
        }
      }

      return {
        id: prod.id,
        sku: prod.sku,
        nombre: prod.nombre,
        descripcion: descripcionDistinta(prod.nombre, prod.description),
        activo: prod.activo === true,
        proveedor: prod.proveedor_id ? { id: prod.proveedor_id, nombre: prod.proveedor ?? '' } : null,
        codigos: ordenarCodigos(prod.barcode, codigos),
        unidadBase: unidades[0]?.unidad ?? null,
        unidades,
        precioRed: precioDeRed(red.map((r) => r.piece_price)),
        sucursales,
        corteVenta: ultimas.length ? ultimas[ultimas.length - 1] : null,
        ultimaEntrada: entrada
          ? {
              sucursal: entrada.sucursal,
              nombreSucursal: nombreEntrada,
              fecha: entrada.fecha,
              cantidad: num(entrada.cantidad) ?? 0,
              unidad: entrada.unidad,
              costo: q.puedeVerCosto ? num(entrada.costo) : null,
            }
          : null,
        costo_visible: q.puedeVerCosto,
        calculado_al: new Date().toISOString(),
      };
    });
  }
}
