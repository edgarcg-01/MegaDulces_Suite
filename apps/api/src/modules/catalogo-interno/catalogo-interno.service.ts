import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { pgRaw } from '../kp/pg-raw.util';
import { SucursalesService } from '../kp/sucursales.service';

/**
 * Catálogo interno (con costo/margen) contra `kepler_ods.*` en `postgres_platform`.
 *
 * Absorbido desde el repo standalone `0SistemasMD/catalogo-kp`
 * (`src/catalogo/catalogo.service.ts`) — mismas queries, adaptadas al
 * estándar de `apps/api`:
 *   - `KNEX_NEW_DB` en vez de una conexión propia (`DATABASE_URL_KP_CONCENTRADA`
 *     → luego `DATABASE_URL_PLATAFORMA`, ambas retiradas).
 *   - `SucursalesService` (módulo `kp`, ya portado) en vez de una copia propia
 *     de `getSucursales()` — de paso hereda la frescura correcta
 *     (`analytics.cron_runs`) en vez de `kepler_ods.ctl`, que está vacía.
 *   - El parámetro `interno: boolean` (sesión sí/no) del app original se
 *     reemplaza por `verCostos: boolean`, que el controller resuelve desde
 *     `req.user.permissions[Permission.CATALOGO_INTERNO_COSTOS_VER]` — ya no
 *     hay endpoint público sin sesión para este catálogo (el verificador de
 *     mostrador público es el módulo `kp`, separado).
 *   - `sucursalesPermitidas` reemplaza el filtro de sucursal sin resolver del
 *     app original: ahí `admin.usuarios.sucursales` se guardaba y se devolvía
 *     en el login, pero nunca se metía en ningún guard/query (confirmado por
 *     grep en el momento de la migración — dato de UI, no una frontera real).
 *     Acá lo resuelve `ScopeService` (`dimension: 'warehouse'`) en el
 *     controller y se lo pasa ya intersectado: `null` = todas (alcance
 *     `all`), `[]` = ninguna, `string[]` = esa lista exacta.
 *
 * `getImagenes()` (qué SKUs tienen foto en `public/img/productos`) NO se
 * portó: las imágenes siguen commiteadas en el repo standalone (deuda
 * documentada por Edgar desde el PR #62, punto 5) — hay que resolver
 * Cloudinary primero, no tiene sentido portar una lectura de disco que ya no
 * aplica en este proceso.
 */

// Sucursal canónica para resolver nombres de clasificación: los códigos de
// kdie/kdif/kdig son idénticos en las 6 sucursales (verificado en el repo
// standalone) y la 03 es la que tiene el catálogo más completo.
const SUC_CANONICA = '03';

// c77 (costo) es texto en kdii → castear con guarda para no reventar en basura.
// {0,1} en vez de `?`: un `?` literal colisiona con el escaneo de
// placeholders de knex.raw() — ver pg-raw.util.ts.
const COSTO = `CASE WHEN TRIM(i.c77) ~ '^-{0,1}[0-9]+(\\.[0-9]+){0,1}$' THEN i.c77::numeric ELSE 0 END`;

// Los códigos casan exactamente con TRIM (no usar LPAD: hay códigos de 6
// dígitos que LPAD(...,5) truncaría). El padding es sólo para mostrar.
const COD_DISPLAY = (col: string) =>
  `CASE WHEN LENGTH(TRIM(${col})) < 5 THEN LPAD(TRIM(${col}), 5, '0') ELSE TRIM(${col}) END`;

// Kepler usa 1800-01-01 como "sin fecha".
const SIN_FECHA = `NULLIF(c13, '1800-01-01'::timestamp)`;

// kdii mezcla pseudo-productos contables (unidad 'SER'): "VENTAS AL 0 %",
// "DEVOLUCIONES 16%", "COMISION BANCARIA"... No son mercancía y traen
// existencias absurdas, así que se excluyen salvo que se pidan explícitamente.
const FILTRO_SERVICIOS = `TRIM(i.c11) <> 'SER'`;

export interface CatalogoQuery {
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
export class CatalogoInternoService {
  private readonly logger = new Logger(CatalogoInternoService.name);

  constructor(
    @Inject(KNEX_NEW_DB) private readonly db: Knex,
    private readonly sucursalesService: SucursalesService,
  ) {}

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  private static iso(v: any): string | null {
    return v ? new Date(v).toISOString() : null;
  }

  async getFiltros() {
    const opciones = (tabla: string) =>
      this.q(`SELECT TRIM(c1) AS codigo, TRIM(c2) AS nombre FROM kepler_ods.${tabla}
              WHERE sucursal = $1 AND TRIM(c2) <> '' ORDER BY TRIM(c2)`, [SUC_CANONICA]);

    const [familias, subfamilias, marcas] = await Promise.all([
      opciones('kdie'), opciones('kdif'), opciones('kdig'),
    ]);
    return { familias, subfamilias, marcas };
  }

  /**
   * Frescura del pipeline por tabla. `kepler_ods._sync_status` (marca a nivel
   * TABLA, sin columna de sucursal) reemplaza a `kp.sync_control`/
   * `kepler_ods.ctl` — ninguno de los dos tiene equivalente real por
   * sucursal (confirmado: `_sync_status` es la única fuente con datos, `ctl`
   * está vacía). Se usa el mismo mecanismo que ya valida `SucursalesService`
   * para la frescura por sucursal (`analytics.cron_runs`).
   */
  async getEstado() {
    const rows = await this.q<any>(`
      SELECT table_name, last_push_at, rows_last
      FROM kepler_ods._sync_status
      WHERE table_name IN ('kdii','kdik','kdil')
      ORDER BY table_name
    `);

    const ultimo = rows.reduce<string | null>((max, r) => {
      const t = CatalogoInternoService.iso(r.last_push_at);
      return t && (!max || t > max) ? t : max;
    }, null);

    return {
      consultado:       new Date().toISOString(),
      datos_al:         ultimo,
      antiguedad_horas: ultimo
        ? Math.round((Date.now() - new Date(ultimo).getTime()) / 3_600_000)
        : null,
      detalle: rows.map(r => ({
        tabla:            r.table_name,
        ultima_sincronizacion: CatalogoInternoService.iso(r.last_push_at),
        filas:            Number(r.rows_last ?? 0),
      })),
    };
  }

  /**
   * @param sucursalesPermitidas Alcance ya resuelto por `ScopeService`
   *   (`dimension: 'warehouse'`) e intersectado con lo pedido en la query:
   *   `null` = todas (alcance `all`, o `all` + sin filtro pedido),
   *   `[]` = ninguna sucursal visible, `string[]` = esa lista exacta.
   * @param verCostos Sólo true si el rol tiene `CATALOGO_INTERNO_COSTOS_VER`
   *   (fresco, leído de `req.user.permissions` — lo puebla `RolesGuard` en
   *   cada request, nunca del JWT viejo).
   */
  async getCatalogo(qy: CatalogoQuery, sucursalesPermitidas: string[] | null, verCostos: boolean) {
    const page     = Math.max(1, Number(qy.page) || 1);
    const limit    = Math.min(200, Math.max(1, Number(qy.limit) || 50));
    const offset   = (page - 1) * limit;
    const ordenCol = ORDEN_SQL[(qy.orden || '').toLowerCase()] || 'nombre';
    const ordenDir = (qy.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const stock    = (qy.stock || 'todos').toLowerCase();

    const soloInterno = <T>(v: T): T | undefined => (verCostos ? v : undefined);
    const vacio = () => ({
      generado: new Date().toISOString(), sucursales_alcance: [] as string[],
      filtros: { q: qy.q ?? '', familia: qy.familia ?? '', subfamilia: qy.subfamilia ?? '', marca: qy.marca ?? '', stock, orden: ordenCol, dir: ordenDir.toLowerCase() },
      paginacion: { page, limit, total: 0, paginas: 1 },
      resumen: { productos: 0, con_existencia: 0, sin_existencia: 0, existencia_total: 0, valor_inventario: soloInterno(0), valor_a_precio_venta: soloInterno(0) },
      productos: [] as any[],
    });

    // Alcance vacío: el rol no tiene ninguna sucursal asignada. Responder
    // vacío, no un 500 ni (peor) la red completa por fail-open.
    if (sucursalesPermitidas !== null && sucursalesPermitidas.length === 0) {
      return vacio();
    }

    const unaSucursal = sucursalesPermitidas !== null && sucursalesPermitidas.length === 1
      ? sucursalesPermitidas[0] : null;

    // Parámetros: nunca se interpolan valores en el SQL.
    const params: any[] = [];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };

    // ── CTE de existencias (antes del WHERE para fijar el orden de $n) ──────
    const exiCte = unaSucursal
      ? `exi AS (
           SELECT TRIM(c2)         AS cod,
                  SUM(c5)::numeric AS existencia,
                  SUM(c8::numeric) AS valor,
                  MAX(${SIN_FECHA}) AS ultimo_mov,
                  STRING_AGG(DISTINCT TRIM(c1), '/') AS almacenes
           FROM kepler_ods.kdik
           WHERE sucursal = ${p(unaSucursal)}
           GROUP BY TRIM(c2)
         )`
      : `exi AS (
           SELECT TRIM(c2)         AS cod,
                  SUM(c5)::numeric AS existencia,
                  SUM(c8::numeric) AS valor,
                  MAX(${SIN_FECHA}) AS ultimo_mov,
                  STRING_AGG(DISTINCT sucursal || ':' || TRIM(c1), ' ') AS almacenes
           FROM kepler_ods.kdik
           ${sucursalesPermitidas !== null ? `WHERE sucursal = ANY(${p(sucursalesPermitidas)})` : ''}
           GROUP BY TRIM(c2)
         )`;

    // ── Filtros del catálogo ────────────────────────────────────────────────
    const incluyeServicios = (qy.servicios || '').toLowerCase() === 'incluir';
    const where: string[] = [];
    if (unaSucursal)                where.push(`i.sucursal = ${p(unaSucursal)}`);
    else if (sucursalesPermitidas)  where.push(`i.sucursal = ANY(${p(sucursalesPermitidas)})`);
    if (!incluyeServicios)          where.push(FILTRO_SERVICIOS);

    if (qy.q && qy.q.trim()) {
      const like = `%${qy.q.trim().toUpperCase()}%`;
      const ph   = p(like);
      where.push(`(UPPER(i.c2) LIKE ${ph} OR UPPER(TRIM(i.c1)) LIKE ${ph} OR UPPER(TRIM(i.c93)) LIKE ${ph})`);
    }
    if (qy.familia)    where.push(`TRIM(i.c4) = ${p(qy.familia.trim())}`);
    if (qy.subfamilia) where.push(`TRIM(i.c5) = ${p(qy.subfamilia.trim())}`);
    if (qy.marca)      where.push(`TRIM(i.c3) = ${p(qy.marca.trim())}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Con una sola sucursal en el alcance hay un renglón por código; con
    // varias (o todas) hay que agrupar.
    const catCte = unaSucursal
      ? `cat AS (
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
                  TRIM(i.c83)             AS unidad_bulto
           FROM kepler_ods.kdii i
           ${whereSql}
         )`
      : `cat AS (
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
                  MAX(TRIM(i.c83))            AS unidad_bulto
           FROM kepler_ods.kdii i
           ${whereSql}
           GROUP BY TRIM(i.c1)
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
      LEFT JOIN kepler_ods.kdie e ON e.sucursal = ${p(SUC_CANONICA)} AND TRIM(e.c1) = u.familia_cod
      LEFT JOIN kepler_ods.kdif f ON f.sucursal = ${p(SUC_CANONICA)} AND TRIM(f.c1) = u.subfamilia_cod
      LEFT JOIN kepler_ods.kdig g ON g.sucursal = ${p(SUC_CANONICA)} AND TRIM(g.c1) = u.marca_cod
      ORDER BY ${ordenCol} ${ordenDir} NULLS LAST, codigo ASC
      LIMIT ${p(limit)} OFFSET ${p(offset)}`;

    const [resumenRows, lista, estado] = await Promise.all([
      this.q(resumenSql, paramsResumen),
      this.q(listaSql, params),
      this.getEstado(),
    ]);

    const resumen = resumenRows[0] ?? {};
    const total   = Number(resumen.productos ?? 0);

    const porSucursal = lista.length
      ? await this.getDesgloseSucursales(lista.map((r: any) => r.cod), sucursalesPermitidas)
      : {};

    return {
      generado:           new Date().toISOString(),
      datos_al:           estado.datos_al,
      antiguedad_horas:   estado.antiguedad_horas,
      sucursales_alcance: sucursalesPermitidas, // null = todas
      filtros: {
        q: qy.q ?? '', familia: qy.familia ?? '', subfamilia: qy.subfamilia ?? '', marca: qy.marca ?? '',
        stock, orden: ordenCol, dir: ordenDir.toLowerCase(),
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
        precio_bulto:     Number(r.precio_bulto ?? 0),
        pzas_bulto:       Number(r.pzas_bulto ?? 0),
        unidad_bulto:     r.unidad_bulto || '',
        existencia:       Number(r.existencia ?? 0),
        valor_inventario: soloInterno(Number(r.valor_inventario ?? 0)),
        ultimo_mov:       CatalogoInternoService.iso(r.ultimo_mov),
        almacenes:        r.almacenes || '',
        por_sucursal:     porSucursal[r.cod] ?? {},
      })),
    };
  }

  /** Existencia y precio de cada código en cada sucursal del alcance (para la página actual). */
  private async getDesgloseSucursales(codigos: string[], sucursalesPermitidas: string[] | null) {
    const filtroSuc = sucursalesPermitidas !== null ? 'AND sucursal = ANY($2)' : '';
    const paramsExi = sucursalesPermitidas !== null ? [codigos, sucursalesPermitidas] : [codigos];

    const [exi, precios] = await Promise.all([
      this.q<any>(`
        SELECT TRIM(c2) AS cod, sucursal,
               SUM(c5)::numeric  AS existencia,
               MAX(${SIN_FECHA}) AS ultimo_mov
        FROM kepler_ods.kdik
        WHERE TRIM(c2) = ANY($1) ${filtroSuc}
        GROUP BY TRIM(c2), sucursal`, paramsExi),
      this.q<any>(`
        SELECT TRIM(c1) AS cod, sucursal, c90 AS precio
        FROM kepler_ods.kdii
        WHERE TRIM(c1) = ANY($1) ${filtroSuc}`, paramsExi),
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
      c.ultimo_mov = CatalogoInternoService.iso(r.ultimo_mov);
    }
    return out;
  }

  /**
   * Ficha de un producto: precio y existencia por sucursal y almacén,
   * recortada al alcance de sucursales del rol.
   */
  async getProducto(codigo: string, sucursalesPermitidas: string[] | null, verCostos: boolean) {
    const cod = codigo.trim();
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
      FROM kepler_ods.kdii i
      LEFT JOIN kepler_ods.kdie e ON e.sucursal = i.sucursal AND TRIM(e.c1) = TRIM(i.c4)
      LEFT JOIN kepler_ods.kdif f ON f.sucursal = i.sucursal AND TRIM(f.c1) = TRIM(i.c5)
      LEFT JOIN kepler_ods.kdig g ON g.sucursal = i.sucursal AND TRIM(g.c1) = TRIM(i.c3)
      WHERE TRIM(i.c1) = ANY($1)
      ORDER BY i.sucursal`, [variantes]);

    // Recorte al alcance DESPUÉS de leer: la ficha ya trae pocas filas (una
    // por sucursal real, máximo 7), no vale la pena complicar el SQL.
    const fichaVisible = sucursalesPermitidas === null
      ? ficha : ficha.filter((r: any) => sucursalesPermitidas.includes(r.sucursal));

    if (!fichaVisible.length) return { encontrado: false, codigo: cod };

    const existencias = await this.q<any>(`
      SELECT sucursal, TRIM(c1) AS almacen,
             c5::numeric     AS existencia,
             c8::numeric     AS valor_costo,
             c16             AS costo_promedio,
             ${SIN_FECHA}    AS ultimo_mov
      FROM kepler_ods.kdik
      WHERE TRIM(c2) = ANY($1)
      ORDER BY sucursal, TRIM(c1)`, [variantes]);

    const existenciasVisibles = sucursalesPermitidas === null
      ? existencias : existencias.filter((r: any) => sucursalesPermitidas.includes(r.sucursal));

    const sucursales = await this.sucursalesService.getSucursales();
    const nombreSuc  = new Map(sucursales.map(s => [s.codigo, s.nombre]));
    const base       = fichaVisible[0];

    const maxFecha = (rows: any[]) => rows.reduce<string | null>((max, x) => {
      const t = CatalogoInternoService.iso(x.ultimo_mov);
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
      existencia_total: existenciasVisibles.reduce((a, r) => a + Number(r.existencia ?? 0), 0),
      por_sucursal: fichaVisible.map((r: any) => {
        const alm = existenciasVisibles.filter(x => x.sucursal === r.sucursal);
        return {
          sucursal:     r.sucursal,
          nombre:       nombreSuc.get(r.sucursal) ?? r.sucursal,
          costo:        verCostos ? Number(r.costo ?? 0) : undefined,
          margen_pct:   verCostos ? Number(r.margen_pct ?? 0) : undefined,
          iva_pct:      Number(r.iva_pct ?? 0),
          ieps_pct:     Number(r.ieps_pct ?? 0),
          precio_venta: Number(r.precio_venta ?? 0),
          precio_bulto: Number(r.precio_bulto ?? 0),
          existencia:   alm.reduce((a, x) => a + Number(x.existencia ?? 0), 0),
          valor_costo:  verCostos
            ? alm.reduce((a, x) => a + Number(x.valor_costo ?? 0), 0)
            : undefined,
          ultimo_mov:   maxFecha(alm),
          almacenes:    alm.map(x => ({
            almacen:        x.almacen,
            existencia:     Number(x.existencia ?? 0),
            costo_promedio: verCostos ? Number(x.costo_promedio ?? 0) : undefined,
          })),
        };
      }),
    };
  }
}
