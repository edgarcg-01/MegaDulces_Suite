import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import * as fs from 'fs';
import { join } from 'path';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { pgRaw } from '../kp-concentrada/pg-raw.util';

/**
 * Catálogo de productos de KP_CONCENTRADA con existencias y precios por sucursal.
 *
 * Fuentes (esquema kp, una fila por sucursal en todas las tablas):
 *   kdii → catálogo: código, nombre, clasificación, costo, impuestos, precio (c90)
 *   kdik → existencias por almacén: c2=código, c5=existencia, c8=valor, c13=último mov.
 *   kdie / kdif / kdig → nombres de familia / subfamilia / marca
 *   kdms → nombres de las sucursales
 *   sync_control → hasta cuándo están frescos los datos
 */

// Sucursal canónica para resolver nombres de clasificación: los códigos de
// kdie/kdif/kdig son idénticos en las 6 sucursales (verificado) y la 03 es la
// que tiene el catálogo más completo.
const SUC_CANONICA = '03';

// c77 (costo) es texto en kdii → castear con guarda para no reventar en basura.
// {0,1} en vez de `?`: equivalente en POSIX/Postgres, pero un `?` literal
// aquí colisiona con el escaneo de placeholders de knex.raw() — ver
// kp-concentrada/pg-raw.util.ts.
const COSTO = `CASE WHEN TRIM(i.c77) ~ '^-{0,1}[0-9]+(\\.[0-9]+){0,1}$' THEN i.c77::numeric ELSE 0 END`;

// Los códigos casan exactamente con TRIM (no usar LPAD: hay 6 códigos de 6
// dígitos que LPAD(...,5) truncaría). El padding es sólo para mostrar.
const COD_DISPLAY = (col: string) =>
  `CASE WHEN LENGTH(TRIM(${col})) < 5 THEN LPAD(TRIM(${col}), 5, '0') ELSE TRIM(${col}) END`;

// Kepler usa 1800-01-01 como "sin fecha".
const SIN_FECHA = `NULLIF(c13, '1800-01-01'::timestamp)`;

// kdii mezcla 14 pseudo-productos contables (unidad 'SER'): "VENTAS AL 0 %",
// "DEVOLUCIONES 16%", "COMISION BANCARIA"... No son mercancía y traen
// existencias absurdas (uno solo aporta 96 millones de "unidades" en CEDIS),
// así que se excluyen del catálogo salvo que se pidan explícitamente.
const FILTRO_SERVICIOS = `TRIM(i.c11) <> 'SER'`;

export interface Sucursal {
  codigo:    string;
  nombre:    string;
  direccion: string;
  ciudad:    string;
  almacenes: string[];
  datos_al:  string | null;
}

export interface CatalogoQuery {
  sucursal?:   string;  // '00'..'05' o 'TODAS'
  q?:          string;  // busca en código, nombre y código de barras
  familia?:    string;  // código kdie.c1
  subfamilia?: string;  // código kdif.c1
  marca?:      string;  // código kdig.c1
  stock?:      string;  // 'con' | 'sin' | 'todos'
  servicios?:  string;  // 'incluir' para ver los pseudo-productos contables
  orden?:      string;  // 'nombre' | 'codigo' | 'existencia' | 'precio' | 'valor'
  dir?:        string;  // 'asc' | 'desc'
  page?:       string;
  limit?:      string;
}

const ORDEN_SQL: Record<string, string> = {
  nombre:     'nombre',
  codigo:     'codigo',
  existencia: 'existencia',
  precio:     'precio_venta',
  valor:      'valor_inventario',
};

@Injectable()
export class CatalogoService {
  private readonly logger = new Logger(CatalogoService.name);

  constructor(@Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex) {}

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  private static iso(v: any): string | null {
    return v ? new Date(v).toISOString() : null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sucursales y frescura de datos
  // ───────────────────────────────────────────────────────────────────────────

  async getSucursales(): Promise<Sucursal[]> {
    const rows = await this.q<any>(`
      SELECT s.sucursal      AS codigo,
             TRIM(s.c2)      AS nombre,
             TRIM(s.c4)      AS direccion,
             TRIM(s.c5)      AS ciudad,
             (SELECT ARRAY_AGG(DISTINCT TRIM(k.c1))
                FROM kp.kdik k WHERE k.sucursal = s.sucursal) AS almacenes,
             (SELECT MAX(sc.last_run_at) FROM kp.sync_control sc
                WHERE sc.sucursal = s.sucursal
                  AND sc.table_name IN ('kdii','kdik'))       AS datos_al
      FROM kp.kdms s
      ORDER BY s.sucursal
    `);
    return rows.map(r => ({
      codigo:    r.codigo,
      nombre:    r.nombre || `Sucursal ${r.codigo}`,
      direccion: r.direccion || '',
      ciudad:    r.ciudad || '',
      almacenes: (r.almacenes || []).sort(),
      datos_al:  CatalogoService.iso(r.datos_al),
    }));
  }

  /**
   * Frescura del pipeline. La API lee KP_CONCENTRADA en vivo, pero
   * KP_CONCENTRADA se llena por sincronización: la frescura real es la de ese
   * proceso, no la del momento de la consulta.
   */
  async getEstado() {
    const rows = await this.q<any>(`
      SELECT table_name, sucursal, last_run_at, rows_total, mode
      FROM kp.sync_control
      WHERE table_name IN ('kdii','kdik','kdil')
      ORDER BY table_name, sucursal
    `);

    const ultimo = rows.reduce<string | null>((max, r) => {
      const t = CatalogoService.iso(r.last_run_at);
      return t && (!max || t > max) ? t : max;
    }, null);

    return {
      consultado:       new Date().toISOString(),
      datos_al:         ultimo,
      antiguedad_horas: ultimo
        ? Math.round((Date.now() - new Date(ultimo).getTime()) / 3_600_000)
        : null,
      detalle: rows.map(r => ({
        tabla:       r.table_name,
        sucursal:    r.sucursal,
        ultimo_sync: CatalogoService.iso(r.last_run_at),
        filas:       Number(r.rows_total ?? 0),
        modo:        r.mode,
      })),
    };
  }

  /**
   * Códigos que tienen foto en public/img/productos.
   * Se lee del disco en cada llamada (con caché de 5 min) para que al agregar
   * fotos nuevas aparezcan sin recompilar ni reiniciar.
   *
   * OJO al portar rutas relativas a __dirname: el proyecto origen compilaba
   * con `nest build` (un .js por módulo, `dist/catalogo/catalogo.service.js`),
   * así que `../../public` desde ahí llegaba a la raíz del proyecto. Este
   * monorepo empaqueta todo en un solo `main.js` (`dist/apps/catalogo-kp/`),
   * donde `public/` ya es hermano directo — mismo ajuste que en main.ts (CV.0).
   */
  private cacheImgs: { codigos: string[]; ts: number } | null = null;

  getImagenes(): { total: number; codigos: string[] } {
    const VIGENCIA = 5 * 60 * 1000;
    if (this.cacheImgs && Date.now() - this.cacheImgs.ts < VIGENCIA) {
      return { total: this.cacheImgs.codigos.length, codigos: this.cacheImgs.codigos };
    }

    const dir = join(__dirname, 'public', 'img', 'productos');
    let codigos: string[] = [];
    try {
      codigos = fs.readdirSync(dir)
        .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
        .map(f => f.replace(/\.[^.]+$/, ''));
    } catch (e: any) {
      this.logger.warn(`No se pudo leer ${dir}: ${e.message}`);
    }

    this.cacheImgs = { codigos, ts: Date.now() };
    return { total: codigos.length, codigos };
  }

  async getFiltros() {
    const opciones = (tabla: string) =>
      this.q(`SELECT TRIM(c1) AS codigo, TRIM(c2) AS nombre FROM kp.${tabla}
              WHERE sucursal = $1 AND TRIM(c2) <> '' ORDER BY TRIM(c2)`, [SUC_CANONICA]);

    const [familias, subfamilias, marcas] = await Promise.all([
      opciones('kdie'), opciones('kdif'), opciones('kdig'),
    ]);
    return { familias, subfamilias, marcas };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Catálogo
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param interno true sólo si la petición trae una sesión válida.
   *   Con false se omiten costo, margen y valor de inventario: la tienda usa
   *   este mismo endpoint y esos datos no deben salir del servidor.
   */
  async getCatalogo(qy: CatalogoQuery, interno = false) {
    const sucursal = (qy.sucursal || 'TODAS').toUpperCase();
    const esTodas  = sucursal === 'TODAS';
    const page     = Math.max(1, Number(qy.page) || 1);
    const limit    = Math.min(200, Math.max(1, Number(qy.limit) || 50));
    const offset   = (page - 1) * limit;
    const ordenCol = ORDEN_SQL[(qy.orden || '').toLowerCase()] || 'nombre';
    const ordenDir = (qy.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const stock    = (qy.stock || 'todos').toLowerCase();

    // Parámetros: nunca se interpolan valores en el SQL.
    const params: any[] = [];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };

    // ── CTE de existencias (antes del WHERE para fijar el orden de $n) ──────
    const exiCte = esTodas
      ? `exi AS (
           SELECT TRIM(c2)         AS cod,
                  SUM(c5)::numeric AS existencia,
                  SUM(c8::numeric) AS valor,
                  MAX(${SIN_FECHA}) AS ultimo_mov,
                  STRING_AGG(DISTINCT sucursal || ':' || TRIM(c1), ' ') AS almacenes
           FROM kp.kdik
           GROUP BY TRIM(c2)
         )`
      : `exi AS (
           SELECT TRIM(c2)         AS cod,
                  SUM(c5)::numeric AS existencia,
                  SUM(c8::numeric) AS valor,
                  MAX(${SIN_FECHA}) AS ultimo_mov,
                  STRING_AGG(DISTINCT TRIM(c1), '/') AS almacenes
           FROM kp.kdik
           WHERE sucursal = ${p(sucursal)}
           GROUP BY TRIM(c2)
         )`;

    // ── Filtros del catálogo ────────────────────────────────────────────────
    const incluyeServicios = (qy.servicios || '').toLowerCase() === 'incluir';
    const where: string[] = [];
    if (!esTodas)          where.push(`i.sucursal = ${p(sucursal)}`);
    if (!incluyeServicios) where.push(FILTRO_SERVICIOS);

    if (qy.q && qy.q.trim()) {
      const like = `%${qy.q.trim().toUpperCase()}%`;
      const ph   = p(like);
      where.push(`(UPPER(i.c2) LIKE ${ph} OR UPPER(TRIM(i.c1)) LIKE ${ph} OR UPPER(TRIM(i.c93)) LIKE ${ph})`);
    }
    if (qy.familia)    where.push(`TRIM(i.c4) = ${p(qy.familia.trim())}`);
    if (qy.subfamilia) where.push(`TRIM(i.c5) = ${p(qy.subfamilia.trim())}`);
    if (qy.marca)      where.push(`TRIM(i.c3) = ${p(qy.marca.trim())}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // En consolidado hay un renglón por código; por sucursal ya es único.
    const catCte = esTodas
      ? `cat AS (
           SELECT TRIM(i.c1)                  AS cod,
                  MAX(${COD_DISPLAY('i.c1')}) AS codigo,
                  MAX(TRIM(i.c2))             AS nombre,
                  MAX(TRIM(i.c11))            AS unidad,
                  MAX(TRIM(i.c4))             AS familia_cod,
                  MAX(TRIM(i.c5))             AS subfamilia_cod,
                  MAX(TRIM(i.c3))             AS marca_cod,
                  MAX(TRIM(i.c93))            AS codigo_barras,
                  MAX(${COSTO})               AS costo,
                  MAX(i.c87)                  AS margen_pct,
                  MAX(ABS(i.c18))             AS iva_pct,
                  MAX(ABS(i.c19))             AS ieps_pct,
                  MAX(i.c90)                  AS precio_venta,
                  MIN(i.c90)                  AS precio_min,
                  MAX(i.c90)                  AS precio_max,
                  MAX(i.c92)                  AS precio_bulto,
                  MAX(i.c84)                  AS pzas_bulto,
                  MAX(TRIM(i.c83))            AS unidad_bulto,
                  COUNT(*)                    AS sucursales_en_catalogo
           FROM kp.kdii i
           ${whereSql}
           GROUP BY TRIM(i.c1)
         )`
      : `cat AS (
           SELECT TRIM(i.c1)              AS cod,
                  ${COD_DISPLAY('i.c1')}  AS codigo,
                  TRIM(i.c2)              AS nombre,
                  TRIM(i.c11)             AS unidad,
                  TRIM(i.c4)              AS familia_cod,
                  TRIM(i.c5)              AS subfamilia_cod,
                  TRIM(i.c3)              AS marca_cod,
                  TRIM(i.c93)             AS codigo_barras,
                  ${COSTO}                AS costo,
                  i.c87                   AS margen_pct,
                  ABS(i.c18)              AS iva_pct,
                  ABS(i.c19)              AS ieps_pct,
                  i.c90                   AS precio_venta,
                  i.c90                   AS precio_min,
                  i.c90                   AS precio_max,
                  i.c92                   AS precio_bulto,
                  i.c84                   AS pzas_bulto,
                  TRIM(i.c83)             AS unidad_bulto,
                  1                       AS sucursales_en_catalogo
           FROM kp.kdii i
           ${whereSql}
         )`;

    const stockSql =
      stock === 'con' ? `WHERE COALESCE(x.existencia, 0) > 0`  :
      stock === 'sin' ? `WHERE COALESCE(x.existencia, 0) <= 0` : '';

    const conjunto = `
      WITH ${exiCte},
      ${catCte},
      unido AS (
        SELECT c.*,
               COALESCE(x.existencia, 0) AS existencia,
               COALESCE(x.valor, 0)      AS valor_inventario,
               x.ultimo_mov,
               x.almacenes
        FROM cat c
        LEFT JOIN exi x ON x.cod = c.cod
        ${stockSql}
      )`;

    // Resumen sobre TODO el conjunto filtrado (no sólo la página).
    // No usa los últimos 5 params (3× canónica, limit, offset).
    const resumenSql = `${conjunto}
      SELECT COUNT(*)                                              AS productos,
             COUNT(*) FILTER (WHERE existencia > 0)                AS con_existencia,
             COUNT(*) FILTER (WHERE existencia <= 0)               AS sin_existencia,
             ROUND(COALESCE(SUM(existencia), 0), 2)                AS existencia_total,
             ROUND(COALESCE(SUM(valor_inventario), 0), 2)          AS valor_inventario,
             ROUND(COALESCE(SUM(existencia * precio_venta), 0), 2) AS valor_a_precio_venta
      FROM unido`;
    const paramsResumen = [...params];

    const listaSql = `${conjunto}
      SELECT u.*,
             TRIM(e.c2) AS familia,
             TRIM(f.c2) AS subfamilia,
             TRIM(g.c2) AS marca
      FROM unido u
      LEFT JOIN kp.kdie e ON e.sucursal = ${p(SUC_CANONICA)} AND TRIM(e.c1) = u.familia_cod
      LEFT JOIN kp.kdif f ON f.sucursal = ${p(SUC_CANONICA)} AND TRIM(f.c1) = u.subfamilia_cod
      LEFT JOIN kp.kdig g ON g.sucursal = ${p(SUC_CANONICA)} AND TRIM(g.c1) = u.marca_cod
      ORDER BY ${ordenCol} ${ordenDir} NULLS LAST, codigo ASC
      LIMIT ${p(limit)} OFFSET ${p(offset)}`;

    const [resumenRows, lista, sucursales, estado] = await Promise.all([
      this.q(resumenSql, paramsResumen),
      this.q(listaSql, params),
      this.getSucursales(),
      this.getEstado(),
    ]);

    const resumen = resumenRows[0] ?? {};
    const total   = Number(resumen.productos ?? 0);

    // Desglose por sucursal de los productos de esta página: es lo que responde
    // "con qué cuenta cada una" sin una consulta por sucursal.
    const porSucursal = lista.length
      ? await this.getDesgloseSucursales(lista.map((r: any) => r.cod))
      : {};

    // Campos que sólo ve quien inició sesión
    const soloInterno = <T>(v: T): T | undefined => (interno ? v : undefined);

    return {
      generado:         new Date().toISOString(),
      datos_al:         estado.datos_al,
      antiguedad_horas: estado.antiguedad_horas,
      interno,
      sucursal,
      filtros: {
        q:      qy.q ?? '',
        familia: qy.familia ?? '', subfamilia: qy.subfamilia ?? '', marca: qy.marca ?? '',
        stock,  orden: ordenCol,  dir: ordenDir.toLowerCase(),
        servicios: incluyeServicios ? 'incluir' : 'excluir',
      },
      paginacion: { page, limit, total, paginas: Math.max(1, Math.ceil(total / limit)) },
      resumen: {
        productos:            total,
        con_existencia:       Number(resumen.con_existencia ?? 0),
        sin_existencia:       Number(resumen.sin_existencia ?? 0),
        existencia_total:     Number(resumen.existencia_total ?? 0),
        valor_inventario:     soloInterno(Number(resumen.valor_inventario ?? 0)),
        valor_a_precio_venta: soloInterno(Number(resumen.valor_a_precio_venta ?? 0)),
      },
      sucursales,
      productos: lista.map((r: any) => ({
        codigo:           r.codigo,
        nombre:           r.nombre || '',
        unidad:           r.unidad || '',
        familia:          r.familia || '',
        familia_cod:      r.familia_cod || '',
        subfamilia:       r.subfamilia || '',
        subfamilia_cod:   r.subfamilia_cod || '',
        marca:            r.marca || '',
        marca_cod:        r.marca_cod || '',
        codigo_barras:    r.codigo_barras || '',
        costo:            soloInterno(Number(r.costo ?? 0)),
        margen_pct:       soloInterno(Number(r.margen_pct ?? 0)),
        iva_pct:          Number(r.iva_pct ?? 0),
        ieps_pct:         Number(r.ieps_pct ?? 0),
        precio_venta:     Number(r.precio_venta ?? 0),
        precio_min:       Number(r.precio_min ?? 0),
        precio_max:       Number(r.precio_max ?? 0),
        precio_varia:     Number(r.precio_min ?? 0) !== Number(r.precio_max ?? 0),
        // Precio de caja/bulto (c92, margen de mayoreo c89). Sólo ~1,600 productos
        // lo tienen; cuando existe, el unitario sale más barato que el de pieza.
        precio_bulto:     Number(r.precio_bulto ?? 0),
        pzas_bulto:       Number(r.pzas_bulto ?? 0),
        unidad_bulto:     r.unidad_bulto || '',
        existencia:       Number(r.existencia ?? 0),
        valor_inventario: soloInterno(Number(r.valor_inventario ?? 0)),
        ultimo_mov:       CatalogoService.iso(r.ultimo_mov),
        almacenes:        r.almacenes || '',
        por_sucursal:     porSucursal[r.cod] ?? {},
      })),
    };
  }

  /** Existencia y precio de cada código en cada sucursal (para la página actual). */
  private async getDesgloseSucursales(codigos: string[]) {
    const [exi, precios] = await Promise.all([
      this.q<any>(`
        SELECT TRIM(c2) AS cod, sucursal,
               SUM(c5)::numeric  AS existencia,
               MAX(${SIN_FECHA}) AS ultimo_mov
        FROM kp.kdik
        WHERE TRIM(c2) = ANY($1)
        GROUP BY TRIM(c2), sucursal`, [codigos]),
      this.q<any>(`
        SELECT TRIM(c1) AS cod, sucursal, c90 AS precio
        FROM kp.kdii
        WHERE TRIM(c1) = ANY($1)`, [codigos]),
    ]);

    type Celda = { existencia: number; precio: number | null; ultimo_mov: string | null };
    const out: Record<string, Record<string, Celda>> = {};

    const celda = (cod: string, suc: string): Celda => {
      out[cod] ??= {};
      out[cod][suc] ??= { existencia: 0, precio: null, ultimo_mov: null };
      return out[cod][suc];
    };

    for (const r of precios) celda(r.cod, r.sucursal).precio = Number(r.precio ?? 0);
    for (const r of exi) {
      const c = celda(r.cod, r.sucursal);
      c.existencia = Number(r.existencia ?? 0);
      c.ultimo_mov = CatalogoService.iso(r.ultimo_mov);
    }
    return out;
  }

  /** Ficha de un producto: precio y existencia por sucursal y almacén. */
  async getProducto(codigo: string, interno = false) {
    const cod = codigo.trim();
    // Un código puede venir con o sin ceros a la izquierda.
    const variantes = Array.from(new Set([
      cod, cod.replace(/^0+/, '') || '0', cod.padStart(5, '0'),
    ]));

    const ficha = await this.q<any>(`
      SELECT i.sucursal,
             ${COD_DISPLAY('i.c1')} AS codigo,
             TRIM(i.c2)  AS nombre,
             TRIM(i.c11) AS unidad,
             TRIM(i.c93) AS codigo_barras,
             TRIM(i.c4)  AS familia_cod,    TRIM(e.c2) AS familia,
             TRIM(i.c5)  AS subfamilia_cod, TRIM(f.c2) AS subfamilia,
             TRIM(i.c3)  AS marca_cod,      TRIM(g.c2) AS marca,
             ${COSTO}    AS costo,
             i.c87 AS margen_pct, ABS(i.c18) AS iva_pct, ABS(i.c19) AS ieps_pct,
             i.c90 AS precio_venta, i.c92 AS precio_bulto,
             i.c84 AS pzas_bulto, TRIM(i.c83) AS unidad_bulto
      FROM kp.kdii i
      LEFT JOIN kp.kdie e ON e.sucursal = i.sucursal AND TRIM(e.c1) = TRIM(i.c4)
      LEFT JOIN kp.kdif f ON f.sucursal = i.sucursal AND TRIM(f.c1) = TRIM(i.c5)
      LEFT JOIN kp.kdig g ON g.sucursal = i.sucursal AND TRIM(g.c1) = TRIM(i.c3)
      WHERE TRIM(i.c1) = ANY($1)
      ORDER BY i.sucursal`, [variantes]);

    if (!ficha.length) return { encontrado: false, codigo: cod };

    const existencias = await this.q<any>(`
      SELECT sucursal, TRIM(c1) AS almacen,
             c5::numeric     AS existencia,
             c8::numeric     AS valor_costo,
             c16             AS costo_promedio,
             ${SIN_FECHA}    AS ultimo_mov
      FROM kp.kdik
      WHERE TRIM(c2) = ANY($1)
      ORDER BY sucursal, TRIM(c1)`, [variantes]);

    const sucursales = await this.getSucursales();
    const nombreSuc  = new Map(sucursales.map(s => [s.codigo, s.nombre]));
    const base       = ficha[0];

    const maxFecha = (rows: any[]) => rows.reduce<string | null>((max, x) => {
      const t = CatalogoService.iso(x.ultimo_mov);
      return t && (!max || t > max) ? t : max;
    }, null);

    return {
      encontrado:    true,
      generado:      new Date().toISOString(),
      codigo:        base.codigo,
      nombre:        base.nombre,
      unidad:        base.unidad,
      codigo_barras: base.codigo_barras,
      familia:       base.familia    || base.familia_cod,
      subfamilia:    base.subfamilia || base.subfamilia_cod,
      marca:         base.marca      || base.marca_cod,
      pzas_bulto:    Number(base.pzas_bulto ?? 0),
      unidad_bulto:  base.unidad_bulto || '',
      precio_bulto:  Number(base.precio_bulto ?? 0),
      existencia_total: existencias.reduce((a, r) => a + Number(r.existencia ?? 0), 0),
      por_sucursal: ficha.map((r: any) => {
        const alm = existencias.filter(x => x.sucursal === r.sucursal);
        return {
          sucursal:     r.sucursal,
          nombre:       nombreSuc.get(r.sucursal) ?? r.sucursal,
          costo:        interno ? Number(r.costo ?? 0) : undefined,
          margen_pct:   interno ? Number(r.margen_pct ?? 0) : undefined,
          iva_pct:      Number(r.iva_pct ?? 0),
          ieps_pct:     Number(r.ieps_pct ?? 0),
          precio_venta: Number(r.precio_venta ?? 0),
          precio_bulto: Number(r.precio_bulto ?? 0),
          existencia:   alm.reduce((a, x) => a + Number(x.existencia ?? 0), 0),
          valor_costo:  interno
            ? alm.reduce((a, x) => a + Number(x.valor_costo ?? 0), 0)
            : undefined,
          ultimo_mov:   maxFecha(alm),
          almacenes:    alm.map(x => ({
            almacen:        x.almacen,
            existencia:     Number(x.existencia ?? 0),
            costo_promedio: interno ? Number(x.costo_promedio ?? 0) : undefined,
          })),
        };
      }),
    };
  }
}
