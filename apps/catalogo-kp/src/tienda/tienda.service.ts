import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { pgRaw } from '../kp-concentrada/pg-raw.util';

/**
 * Catálogo de la tienda en línea. NO es el mismo que el catálogo interno.
 *
 * La tienda es de SÓLO MAYOREO y se surte desde una sola sucursal, así que
 * aplica tres reglas que el catálogo interno no tiene:
 *
 *   1. Una sola sucursal. Se muestra el inventario de PH (`01`) y nada más.
 *      Las existencias de las otras sucursales no se filtran al público; sólo
 *      un usuario interno autenticado puede pedir otra sucursal.
 *
 *   2. Sólo unidades de mayoreo. Ver UNIDAD_MAYOREO más abajo: es la regla que
 *      evita vender promociones internas a un centavo.
 *
 *   3. Sólo con existencia. Un producto sin stock en PH no aparece.
 *
 * Precios: c90/c91/c92 vienen CON impuestos incluidos. Se devuelve también el
 * precio sin impuestos porque el comprador de mayoreo factura.
 */

/** Sucursal que surte la tienda: PH, Padre Hidalgo. */
export const SUC_TIENDA = '01';

/** Envío: menos de este monto cuesta ENVIO_COSTO; de aquí en adelante, gratis. */
export const ENVIO_GRATIS_DESDE = 999;
export const ENVIO_COSTO = 199;

// {0,1} en vez de `?`: equivalente en POSIX/Postgres, pero un `?` literal
// aquí colisiona con el escaneo de placeholders de knex.raw() — ver
// kp-concentrada/pg-raw.util.ts.
const RE_NUM = `'^[[:space:]]*-{0,1}[0-9]+([.][0-9]*){0,1}[[:space:]]*$'`;
const NUM = (c: string) =>
  `CASE WHEN ${c}::text ~ ${RE_NUM} THEN ${c}::numeric ELSE NULL END`;

// Pseudo-productos contables ("VENTAS AL 16 %", "COMISION BANCARIA"): no son
// mercancía y traen existencias absurdas.
const FILTRO_SERVICIOS = `TRIM(i.c11) <> 'SER'`;

/**
 * Regla de unidad de mayoreo. Una unidad se muestra sólo si cumple las tres.
 *
 * Existe porque en Kepler "tener unidad de paquete" NO significa "es mayoreo":
 *   - 328 productos traen literalmente 'PZA' en la casilla de paquete
 *   - 98 traen factor 1, es decir la "caja" contiene una pieza
 *   - los peores son marcadores contables de promociones con proveedores,
 *     cargados a $0.01 y factor 1, con nombres como
 *     "$1,000 RICOLINO = GRATIS 1 EXH CH TRIDENT VALUPACK"
 *
 * Sin esta regla esas promociones aparecen en la tienda a un centavo y alguien
 * las pide. Se aplica POR UNIDAD, no por producto: la mayoría de los productos
 * con 'PZA' son mercancía real que trae basura en la segunda casilla y cuya
 * unidad buena (CJA, BTO) está intacta.
 */
const esUnidadMayoreo = (u: string, factor: number, precio: number | null) =>
  !!u && u !== 'PZA' && factor > 1 && precio !== null && precio >= 1;

/** Redondeo a centavos, para no arrastrar flotantes en los totales. */
const centavos = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface UnidadTienda {
  unidad:          string;   // CJA, PAQ, BTO, KG
  etiqueta:        string;   // "Caja de 16 bolsas de 500 g"
  piezas:          number;   // factor
  precio:          number;   // con impuestos
  precio_sin_iva:  number;
  precio_unitario: number;   // por pieza dentro del paquete, para comparar
}

export interface ProductoTienda {
  codigo:      string;
  nombre:      string;
  familia:     string | null;
  marca:       string | null;
  /** Existencia en PH. Cero en los productos de bajo pedido. */
  existencia:  number;
  /** Lo que se puede pedir hoy: PH si hay, o el resto de sucursales si no. */
  disponible:  number;
  /**
   * No hay en PH, pero sí en otra sucursal.
   *
   * Decidido el 31/08/2026: en vez de ocultarlos, se venden con aviso de que
   * tardan más. Son 1,989 productos y llevan el catálogo de 3,563 a 5,552.
   *
   * Lo que NO se dice nunca al público es de qué sucursal viene: la decisión
   * fue que el resto del inventario permanece oculto.
   */
  bajo_pedido: boolean;
  unidades:    UnidadTienda[];
  desde:       number;            // precio de la unidad más barata
  costo?:      number;            // sólo interno
  margen_pct?: number;            // sólo interno
  existencia_otras?: number;      // sólo interno
}

export interface TiendaQuery {
  q?:        string;
  familia?:  string;
  marca?:    string;
  orden?:    string;   // 'nombre' | 'precio' | 'existencia'
  dir?:      string;
  page?:     string;
  limit?:    string;
  sucursal?: string;   // sólo se respeta si la sesión es interna
}

const ORDEN_SQL: Record<string, string> = {
  nombre:     'nombre',
  codigo:     'codigo',
  existencia: 'existencia',
};

@Injectable()
export class TiendaService {
  private readonly logger = new Logger(TiendaService.name);

  constructor(@Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex) {}

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  /** Reglas de envío, para que el frontend no las traiga escritas a mano. */
  getConfig() {
    return {
      sucursal:           SUC_TIENDA,
      solo_mayoreo:       true,
      envio: {
        costo:            ENVIO_COSTO,
        gratis_desde:     ENVIO_GRATIS_DESDE,
        paqueterias:      ['Estafeta', 'DHL'],
      },
    };
  }

  /**
   * Costo de envío de un subtotal. Único lugar donde vive esta regla.
   *
   * Un subtotal de cero no paga envío: no hay nada que enviar. Sin esta
   * guarda, un carrito vacío mostraba "Total: $199", que es lo primero que ve
   * quien entra a la tienda. También cubre el caso de un carrito cuyos
   * renglones se agotaron todos.
   */
  calcularEnvio(subtotal: number): number {
    const s = Number(subtotal) || 0;
    if (s <= 0) return 0;
    return s >= ENVIO_GRATIS_DESDE ? 0 : ENVIO_COSTO;
  }

  /**
   * Etiqueta legible de una unidad de mayoreo.
   *
   * Kepler guarda a veces el peso del empaque EN GRAMOS como nombre de la
   * unidad base: '500' son 500 g. Se comprobó contra el nombre del propio
   * producto en tres casos independientes (CACAHUATE PASTEL / 8 KG con
   * unidad 500 y caja de 16 → 16 × 0.5 kg = 8 kg). Cuando es así, la caja se
   * describe por su contenido real en vez de decir "16 piezas".
   */
  private etiquetaUnidad(unidad: string, factor: number, unidadBase: string): string {
    const nombre = unidad === 'CJA' ? 'Caja'
                 : unidad === 'PAQ' ? 'Paquete'
                 : unidad === 'BTO' ? 'Bulto'
                 : unidad === 'KG'  ? 'Kilo'
                 : unidad;

    const gramos = /^[0-9]+$/.test(unidadBase) ? Number(unidadBase) : 0;
    if (gramos > 0) {
      const peso = gramos >= 1000
        ? `${centavos(gramos / 1000)} kg`
        : `${gramos} g`;
      return `${nombre} de ${factor} bolsas de ${peso}`;
    }
    return `${nombre} de ${factor} piezas`;
  }

  /** Arma las unidades vendibles de una fila, aplicando la regla de mayoreo. */
  private armarUnidades(r: any): UnidadTienda[] {
    const iva  = Math.abs(Number(r.iva_raw  ?? 0)) / 100;
    const ieps = Math.abs(Number(r.ieps_raw ?? 0)) / 100;
    const div  = (1 + iva) * (1 + ieps) || 1;

    const unidadBase = String(r.u1 || '').trim();
    const out: UnidadTienda[] = [];

    const agregar = (nom: any, precio: any, factor: any) => {
      const u = String(nom || '').trim().toUpperCase();
      const p = precio != null ? Number(precio) : null;
      const f = Number(factor) || 0;
      if (!esUnidadMayoreo(u, f, p)) return;
      if (out.some(x => x.unidad === u)) return;
      out.push({
        unidad:          u,
        etiqueta:        this.etiquetaUnidad(u, f, unidadBase),
        piezas:          f,
        precio:          centavos(p as number),
        precio_sin_iva:  centavos((p as number) / div),
        precio_unitario: centavos((p as number) / f),
      });
    };

    agregar(r.u2, r.pv2, r.f2);
    agregar(r.u3, r.pv3, r.f3);

    return out.sort((a, b) => a.precio - b.precio);
  }

  /**
   * Catálogo de la tienda.
   *
   * `interno` viene de una sesión válida. Sin ella no se devuelve costo ni
   * margen, y no se puede consultar otra sucursal: el visitante anónimo ve
   * PH y nada más.
   */
  async getCatalogo(qy: TiendaQuery, interno = false) {
    const suc = interno && /^[0-9]{2}$/.test(String(qy.sucursal ?? ''))
      ? String(qy.sucursal)
      : SUC_TIENDA;

    const page  = Math.max(1, Number(qy.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(qy.limit) || 40));

    const params: any[] = [suc];
    const p = (v: any) => `$${params.push(v)}`;

    const filtros: string[] = [];
    if (qy.q && String(qy.q).trim()) {
      const t = `%${String(qy.q).trim()}%`;
      filtros.push(`(TRIM(i.c2) ILIKE ${p(t)} OR TRIM(i.c1) ILIKE ${p(t)})`);
    }
    if (qy.familia) filtros.push(`TRIM(i.c4) = ${p(String(qy.familia).trim())}`);
    if (qy.marca)   filtros.push(`TRIM(i.c6) = ${p(String(qy.marca).trim())}`);

    const orden = ORDEN_SQL[String(qy.orden || 'nombre')] || 'nombre';
    const dir   = String(qy.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Se traen todos los candidatos y la regla de mayoreo se aplica en código:
    // depende de tres columnas a la vez y expresarla en SQL la volvería
    // ilegible y difícil de mantener. El universo por sucursal son ~9,500
    // filas, así que no compensa complicarla.
    const rows = await this.q<any>(`
      WITH ex AS (
        SELECT TRIM(c2) AS cod, SUM(c5)::numeric AS existencia
        FROM kp.kdik
        WHERE sucursal = $1 AND c5::text ~ ${RE_NUM}
        GROUP BY TRIM(c2)
      ),
      -- Existencia en el RESTO de las sucursales, para los de bajo pedido.
      -- Se suma sin distinguir de cuál viene: al público no se le dice en qué
      -- tienda está, sólo que se puede conseguir.
      ex_otras AS (
        SELECT TRIM(c2) AS cod, SUM(c5)::numeric AS existencia
        FROM kp.kdik
        WHERE sucursal <> $1 AND c5::text ~ ${RE_NUM}
        GROUP BY TRIM(c2)
        HAVING SUM(c5)::numeric > 0
      )
      SELECT TRIM(i.c1) AS codigo, TRIM(i.c2) AS nombre,
             TRIM(i.c11) AS u1,
             TRIM(i.c80) AS u2, ${NUM('i.c91')} AS pv2, ${NUM('i.c81')} AS f2,
             TRIM(i.c83) AS u3, ${NUM('i.c92')} AS pv3, ${NUM('i.c84')} AS f3,
             ${NUM('i.c18')} AS iva_raw, ${NUM('i.c19')} AS ieps_raw,
             ${NUM('i.c77')} AS costo, ${NUM('i.c87')} AS margen,
             TRIM(e.c2) AS familia, TRIM(g.c2) AS marca,
             COALESCE(ex.existencia, 0)       AS existencia,
             COALESCE(ex_otras.existencia, 0) AS existencia_otras
      FROM kp.kdii i
      LEFT JOIN ex       ON ex.cod       = TRIM(i.c1)
      LEFT JOIN ex_otras ON ex_otras.cod = TRIM(i.c1)
      LEFT JOIN kp.kdie e ON e.sucursal = i.sucursal AND TRIM(e.c1) = TRIM(i.c4)
      LEFT JOIN kp.kdig g ON g.sucursal = i.sucursal AND TRIM(g.c1) = TRIM(i.c6)
      WHERE i.sucursal = $1
        AND i.c1 IS NOT NULL AND i.c1::text ~ '^[0-9]'
        AND ${FILTRO_SERVICIOS}
        -- Entra si hay en PH (entrega inmediata) O en cualquier otra
        -- (bajo pedido). Lo que no tiene nadie sigue oculto.
        AND (COALESCE(ex.existencia, 0) > 0 OR COALESCE(ex_otras.existencia, 0) > 0)
        ${filtros.length ? 'AND ' + filtros.join(' AND ') : ''}
      ORDER BY ${orden} ${dir}
    `, params);

    const productos: ProductoTienda[] = [];
    for (const r of rows) {
      const unidades = this.armarUnidades(r);
      if (!unidades.length) continue;   // no tiene ninguna unidad de mayoreo

      const enPh    = Number(r.existencia ?? 0);
      const enOtras = Number(r.existencia_otras ?? 0);
      const puedePedir = enPh > 0 ? enPh : enOtras;

      // No basta con que haya existencia: tiene que alcanzar para al menos UNA
      // unidad completa de mayoreo.
      //
      // POR QUE: al medirlo el 01/09/2026, 1,007 productos de 5,552 tenían
      // existencia pero no la suficiente para la unidad más chica. Por ejemplo
      // ARANDANOS 500 GR con 13 piezas cuando el paquete son 18. Aparecían en
      // la tienda como disponibles y el carrito los rechazaba con "sólo hay
      // existencia para 0", que al cliente le suena a error del sistema.
      //
      // 467 de esos eran de entrega inmediata, así que el problema ya existía
      // antes de habilitar el bajo pedido.
      if (!unidades.some(u => u.piezas <= puedePedir)) continue;

      productos.push({
        codigo:     r.codigo,
        nombre:     r.nombre || '',
        familia:    r.familia || null,
        marca:      r.marca || null,
        existencia: enPh,
        // Lo que el cliente puede pedir hoy. Para un producto de bajo pedido
        // es lo que hay en las otras sucursales: el carrito valida contra
        // esto, no contra la existencia de PH, que es cero.
        disponible:  enPh > 0 ? enPh : enOtras,
        bajo_pedido: enPh <= 0,
        // NO se dice en qué sucursal está. La decisión fue que las demás
        // permanecen ocultas al público; sólo se informa que se consigue.
        unidades,
        desde:      unidades[0].precio,
        ...(interno ? {
          costo:      Number(r.costo ?? 0),
          margen_pct: Number(r.margen ?? 0),
          existencia_otras: enOtras,
        } : {}),
      });
    }

    const desde = (page - 1) * limit;
    return {
      sucursal:  suc,
      total:     productos.length,
      page,
      limit,
      paginas:   Math.max(1, Math.ceil(productos.length / limit)),
      envio:     this.getConfig().envio,
      productos: productos.slice(desde, desde + limit),
    };
  }

  /** Ficha de un producto de la tienda. */
  async getProducto(codigo: string, interno = false) {
    const cod = String(codigo || '').replace(/[^0-9A-Za-z]/g, '');
    if (!cod) return { ok: false, error: 'Sin código' };

    const rows = await this.q<any>(`
      WITH ex AS (
        SELECT TRIM(c2) AS cod, SUM(c5)::numeric AS existencia
        FROM kp.kdik
        WHERE sucursal = $1 AND c5::text ~ ${RE_NUM}
        GROUP BY TRIM(c2)
      ),
      ex_otras AS (
        SELECT TRIM(c2) AS cod, SUM(c5)::numeric AS existencia
        FROM kp.kdik
        WHERE sucursal <> $1 AND c5::text ~ ${RE_NUM}
        GROUP BY TRIM(c2)
        HAVING SUM(c5)::numeric > 0
      )
      SELECT TRIM(i.c1) AS codigo, TRIM(i.c2) AS nombre,
             TRIM(i.c11) AS u1,
             TRIM(i.c80) AS u2, ${NUM('i.c91')} AS pv2, ${NUM('i.c81')} AS f2,
             TRIM(i.c83) AS u3, ${NUM('i.c92')} AS pv3, ${NUM('i.c84')} AS f3,
             ${NUM('i.c18')} AS iva_raw, ${NUM('i.c19')} AS ieps_raw,
             ${NUM('i.c77')} AS costo, ${NUM('i.c87')} AS margen,
             TRIM(e.c2) AS familia, TRIM(g.c2) AS marca,
             COALESCE(ex.existencia, 0)       AS existencia,
             COALESCE(ex_otras.existencia, 0) AS existencia_otras
      FROM kp.kdii i
      LEFT JOIN ex       ON ex.cod       = TRIM(i.c1)
      LEFT JOIN ex_otras ON ex_otras.cod = TRIM(i.c1)
      LEFT JOIN kp.kdie e ON e.sucursal = i.sucursal AND TRIM(e.c1) = TRIM(i.c4)
      LEFT JOIN kp.kdig g ON g.sucursal = i.sucursal AND TRIM(g.c1) = TRIM(i.c6)
      WHERE i.sucursal = $1 AND TRIM(i.c1) = $2 AND ${FILTRO_SERVICIOS}
      LIMIT 1
    `, [SUC_TIENDA, cod]);

    if (!rows.length) return { ok: false, codigo: cod, error: 'Producto no encontrado' };

    const r = rows[0];
    const unidades = this.armarUnidades(r);

    // Un producto sin unidades de mayoreo no se vende en la tienda aunque
    // exista en Kepler: decirlo explícitamente evita que el frontend muestre
    // una ficha vacía sin explicación.
    if (!unidades.length) {
      return { ok: false, codigo: cod, error: 'Producto no disponible para mayoreo' };
    }

    const enPh    = Number(r.existencia ?? 0);
    const enOtras = Number(r.existencia_otras ?? 0);
    // Sin existencia en NINGUNA sucursal: eso sí es "no hay". Que falte en PH
    // ya no basta para negarlo, porque ahora se vende bajo pedido.
    if (enPh <= 0 && enOtras <= 0) {
      return { ok: false, codigo: cod, error: 'Sin existencia' };
    }

    // Hay existencia, pero no alcanza para una unidad completa. Se dice con
    // claridad en vez de devolver "sin existencia", que sería falso, o dejar
    // que el carrito lo rechace después con un mensaje confuso.
    const puedePedir = enPh > 0 ? enPh : enOtras;
    const minima = Math.min(...unidades.map(u => u.piezas));
    if (!unidades.some(u => u.piezas <= puedePedir)) {
      return {
        ok: false, codigo: cod,
        error: `Sólo quedan ${puedePedir} piezas y la presentación más chica son ${minima}`,
      };
    }

    return {
      ok: true,
      producto: {
        codigo:      r.codigo,
        nombre:      r.nombre || '',
        familia:     r.familia || null,
        marca:       r.marca || null,
        existencia:  enPh,
        disponible:  enPh > 0 ? enPh : enOtras,
        bajo_pedido: enPh <= 0,
        unidades,
        desde:       unidades[0].precio,
        ...(interno ? {
          costo:      Number(r.costo ?? 0),
          margen_pct: Number(r.margen ?? 0),
          existencia_otras: enOtras,
        } : {}),
      },
    };
  }
}
