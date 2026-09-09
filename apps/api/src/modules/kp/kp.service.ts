import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { pgRaw } from './pg-raw.util';

/** Una unidad de venta con su precio, para el verificador. */
export interface UnidadPrecio {
  u:              string;
  precio_con_iva: number;
  precio_sin_iva: number;
  factor:         number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kepler guarda casi todo como texto, incluidos costos y cantidades, y hay
// celdas vacías o con basura. Castear directo revienta con
// «invalid input syntax for type numeric». Estos helpers castean con guarda.
// Se usa la clase POSIX [[:space:]] en vez de \s porque el regex viaja dentro
// de una cadena de JS y el escape se pierde. {0,1} en vez de `?`: equivalente
// en POSIX/Postgres, pero un `?` literal aquí colisiona con el escaneo de
// placeholders de knex.raw() — ver pg-raw.util.ts.
// ─────────────────────────────────────────────────────────────────────────────
const RE_NUM = "'^[[:space:]]*-{0,1}[0-9]+([.][0-9]*){0,1}[[:space:]]*$'";

/** Castea a numeric; NULL si el valor no es un número (para distinguir «no hay dato»). */
const NUMC_NULL = (col: string) =>
  `CASE WHEN ${col}::text ~ ${RE_NUM} THEN ${col}::numeric ELSE NULL END`;

/** Redondeo a 2 decimales, para que no se filtren artefactos de punto flotante. */
const redondea = (n: number) => parseFloat((Number(n) || 0).toFixed(2));

/**
 * `[TDA.2]` Tenant para leer `commercial.product_label_prices`, que tiene RLS **FORCE**.
 * Misma constante y mismo default que `StoreService`: estos endpoints son `@Public()`, así que no
 * hay interceptor de tenant del que sacarlo.
 */
const TENANT = process.env.MEGA_DULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

@Injectable()
export class KpService {
  private readonly logger = new Logger(KpService.name);

  constructor(@Inject(KNEX_NEW_DB) private readonly db: Knex) {}

  /**
   * Arma la lista de unidades con precio, de la base a la mayor, sin repetir.
   * c90/c11 = unidad base, c91/c80 = unidad 2, c92/c83 = unidad 3.
   */
  private armarUnidades(r: any): UnidadPrecio[] {
    const iva  = Math.abs(Number(r.iva_raw))  / 100;
    const ieps = Math.abs(Number(r.ieps_raw)) / 100;
    const div  = (1 + iva) * (1 + ieps);

    const unidades: UnidadPrecio[] = [];
    const agregar = (nom: any, pv: any, factor: any) => {
      const u = String(nom || '').trim().toUpperCase();
      const p = pv != null ? Number(pv) : null;
      if (!u || p === null || p <= 0) return;
      if (unidades.some(x => x.u === u)) return;
      unidades.push({
        u,
        precio_con_iva: redondea(p),
        precio_sin_iva: redondea(p / (div || 1)),
        factor: Number(factor) || 1,
      });
    };

    agregar(r.u1, r.pv1, 1);
    agregar(r.u2, r.pv2, r.f2);
    agregar(r.u3, r.pv3, r.f3);

    // Respaldo por fórmula si Kepler no tiene ningún precio de venta cargado
    if (!unidades.length) {
      const margen = r.margen != null ? Number(r.margen) : null;
      const mf = margen && margen > 0 ? 1 + margen / 100 : 1;
      const conIva = redondea(Number(r.costo) * mf * div);
      if (conIva > 0) agregar(r.u1 || 'PZA', conIva, 1);
    }
    return unidades;
  }

  /** Columnas que necesita el verificador, iguales para uno o para todos. */
  private static readonly COLS_PRECIO = `
    LPAD(TRIM(c1::text), 5, '0') AS codigo,
    TRIM(c7::text)  AS bc1,
    TRIM(c82::text) AS bc2,
    TRIM(c93::text) AS bc3,
    TRIM(c95::text) AS bc4,
    TRIM(c96::text) AS bc5,
    TRIM(c2::text)  AS nombre,
    TRIM(c11::text) AS u1, ${NUMC_NULL('c90')} AS pv1,
    TRIM(c80::text) AS u2, ${NUMC_NULL('c91')} AS pv2, ${NUMC_NULL('c81')} AS f2,
    TRIM(c83::text) AS u3, ${NUMC_NULL('c92')} AS pv3, ${NUMC_NULL('c84')} AS f3,
    ${NUMC_NULL('c77')} AS costo,
    ${NUMC_NULL('c87')} AS margen,
    ${NUMC_NULL('c18')} AS iva_raw,
    ${NUMC_NULL('c19')} AS ieps_raw`;

  /**
   * `[TDA.2]` — ¿Hay un precio corregido A MANO para este SKU?
   *
   * `commercial.product_label_prices.source` puede ser `'kepler'` o `'manual'`, y el importer
   * **nunca pisa** un `'manual'`. O sea: un precio corregido a mano es una decisión humana
   * deliberada, y es el precio que sale impreso en la etiqueta del anaquel.
   *
   * El mostrador leía `kepler_ods.kdii` crudo, así que ese override le era **invisible**: el
   * anaquel decía un número y el verificador otro, del mismo producto. Acá se lee para que no se
   * contradigan.
   *
   * ⚠️ **Medido en prod el 2026-09-09: hay CERO filas con `source='manual'`** (9,020, todas
   * `kepler`). O sea que este defecto estaba **latente, no activo** — nadie ha usado el override
   * todavía. Se arregla igual porque la capacidad existe y está documentada en la migración, y el
   * día que alguien la use no puede ser el día en que se descubra que el mostrador la ignora.
   *
   * `SET LOCAL app.tenant_id` en la MISMA transacción porque la tabla tiene RLS **FORCE** y este
   * endpoint es `@Public()` (sin interceptor de tenant): sin el contexto la lectura vuelve **vacía
   * en silencio** si el rol es `app_runtime` — o sea, el override desaparecería sin error. Es el
   * mismo patrón que `StoreService.warehouseMap()`.
   *
   * Devuelve `null` ante cualquier problema: es un refinamiento del precio, no el precio. Si la
   * tabla no está, o el rol no la ve, el mostrador sigue contestando con el ERP como siempre.
   */
  private async overrideManual(codigo: string): Promise<number | null> {
    try {
      return await this.db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
        const { rows } = await trx.raw(
          `SELECT l.piece_price
             FROM catalog.products p
             JOIN commercial.product_label_prices l
               ON l.product_id = p.id AND l.tenant_id = p.tenant_id
            WHERE p.tenant_id = ?
              AND p.deleted_at IS NULL
              AND btrim(p.sku) = ?
              AND l.source = 'manual'
              AND l.piece_price > 0
            LIMIT 1`,
          [TENANT, String(codigo).replace(/^0+/, '')],
        );
        const p = rows?.[0]?.piece_price;
        return p != null ? Number(p) : null;
      });
    } catch (e: any) {
      this.logger.warn(`overrideManual(${codigo}) no se pudo leer: ${e.message}`);
      return null;
    }
  }

  /**
   * Un producto por clave interna o por código de barras.
   *
   * ── `[TDA.2]` Por qué ahora pide sucursal y por qué antes daba un número inestable ──────
   * `kdii` trae UNA FILA POR SUCURSAL. La consulta vieja hacía `ORDER BY c1 LIMIT 1` sin filtrar,
   * así que se quedaba con la primera fila que Postgres devolviera — en orden **arbitrario**. El
   * precio del mostrador podía cambiar solo cada vez que una sucursal se re-sincronizaba, y podía
   * ser el de **CEDIS** (`sucursal='00'`), que es justamente la fila que la etiquetera excluye a
   * propósito.
   *
   * **Medido en prod el 2026-09-09: 712 de 9,348 códigos (7.6 %) tienen más de un precio base
   * entre plazas.** El comentario que estaba acá decía 385 — la cifra había envejecido, y el
   * defecto afectaba a casi el doble de productos de lo que el propio código declaraba.
   *
   * Ahora: con `sucursal` contesta la de esa plaza. Sin ella, elige **determinista** (retail antes
   * que CEDIS, luego la sucursal más baja) y **DECLARA** `precio_ambiguo` cuando las plazas no
   * coinciden. Declararlo es el punto: un número inestable presentado como único es peor que un
   * número acompañado de "esto varía entre plazas".
   */
  async getPrecio(q: string, sucursal?: string) {
    // Sólo alfanumérico: los códigos y los EAN lo son. Además va parametrizado.
    const code = String(q || '').replace(/[^0-9A-Za-z]/g, '');
    if (!code) return { ok: false, error: 'Sin código' };
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;

    try {
      // Se traen TODAS las filas del código (una por sucursal: son pocas) en vez de `LIMIT 1`.
      // Es lo que permite a la vez elegir la plaza pedida y saber si las demás discrepan.
      const rows = await this.query<any>(`
        SELECT ${KpService.COLS_PRECIO}, TRIM(sucursal::text) AS sucursal
        FROM kepler_ods.kdii
        WHERE TRIM(c1::text) = $1
           OR LPAD(TRIM(c1::text), 5, '0') = LPAD($1, 5, '0')
           OR TRIM(c7::text)  = $1
           OR TRIM(c82::text) = $1
           OR TRIM(c93::text) = $1
           OR TRIM(c95::text) = $1
           OR TRIM(c96::text) = $1
        ORDER BY (TRIM(sucursal::text) = '00'), TRIM(sucursal::text), c1
      `, [code]);

      if (!rows.length) return { ok: false, code, error: 'Producto no encontrado' };

      // La fila de la plaza pedida; si esa plaza no tiene el producto, se dice y se sigue con la
      // determinista — un "no encontrado" sería falso (el producto existe, no en esa sucursal).
      const deLaPlaza = suc ? rows.find((x: any) => x.sucursal === suc) : null;
      const r = deLaPlaza || rows[0];
      const plazaPedidaSinDato = !!suc && !deLaPlaza;

      const unidades = this.armarUnidades(r);
      const base = unidades[0] || null;

      // ¿Las plazas discrepan en el precio base? Sólo importa cuando NO se pidió una: con plaza
      // la respuesta es la de esa plaza y no hay ambigüedad que declarar.
      const distintos = new Set(
        rows.map((x: any) => (x.pv1 != null ? Number(x.pv1) : null)).filter((p: number | null) => p != null && p > 0),
      );
      const ambiguo = !suc && distintos.size > 1;

      // El override manual gana: es una corrección humana deliberada y es lo que sale impreso en
      // el anaquel. Sólo se pisa el precio de la unidad BASE (es lo que la tabla guarda por pieza).
      const manual = await this.overrideManual(r.codigo);
      let origen: 'kepler' | 'override_manual' = 'kepler';
      if (manual != null && base) {
        const iva = Math.abs(Number(r.iva_raw)) / 100;
        const ieps = Math.abs(Number(r.ieps_raw)) / 100;
        const div = (1 + iva) * (1 + ieps);
        base.precio_con_iva = redondea(manual);
        base.precio_sin_iva = redondea(manual / (div || 1));
        origen = 'override_manual';
      }

      return {
        ok: true,
        codigo: r.codigo,
        nombre: r.nombre || '',
        unidad: base ? base.u : (r.u1 || ''),
        precio_con_iva: base ? base.precio_con_iva : null,
        precio_sin_iva: base ? base.precio_sin_iva : null,
        unidades,
        iva_pct:  Math.round(Math.abs(Number(r.iva_raw))),
        ieps_pct: Math.round(Math.abs(Number(r.ieps_raw))),
        // `[TDA.2]` Procedencia: de qué plaza salió, si el número varía entre plazas, y si lo
        // corrigió una persona. Sin esto el mostrador publicaba un número sin decir de dónde.
        sucursal_precio: r.sucursal || null,
        precio_ambiguo: ambiguo,
        plazas_con_precio_distinto: ambiguo ? distintos.size : 1,
        plaza_pedida_sin_dato: plazaPedidaSinDato,
        origen_precio: origen,
      };
    } catch (e: any) {
      this.logger.error('getPrecio error: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  /**
   * Todo el catálogo con precios por unidad: alimenta al verificador offline.
   *
   * `sucursal` ('00'..'05') acota los precios a esa plaza. **Conviene siempre
   * pasarla.** Sin ella, kdii trae una fila por sucursal y el código se queda
   * con la primera que aparece, que Postgres devuelve en orden arbitrario: 385
   * códigos tienen precio distinto entre plazas, así que el precio mostrado
   * cambiaría solo cada vez que una sucursal se re-sincroniza.
   */
  async getPreciosTodos(sucursal?: string) {
    // Sólo se aceptan códigos de dos dígitos; cualquier otra cosa se ignora.
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;

    try {
      const rows = await this.query<any>(`
        SELECT ${KpService.COLS_PRECIO}
        FROM kepler_ods.kdii
        WHERE c1 IS NOT NULL AND c1::text ~ '^[0-9]'
          ${suc ? 'AND sucursal = $1' : ''}
        ORDER BY c1
      `, suc ? [suc] : undefined);

      const vistos = new Set<string>();
      const items: any[] = [];

      for (const r of rows) {
        if (vistos.has(r.codigo)) continue;
        vistos.add(r.codigo);

        const unidades = this.armarUnidades(r);
        if (!unidades.length) continue;  // sin precio no sirve para el verificador

        // Códigos de barras. Kepler no tiene una columna de código de barras:
        // tiene cinco casillas y el capturista usa la que encuentra libre, así
        // que hay que leerlas todas. Se descartan los que sólo repiten la clave
        // del producto: no aportan como llave de búsqueda.
        const bcs = [...new Set(
          [r.bc1, r.bc2, r.bc3, r.bc4, r.bc5]
            .map(b => String(b || '').trim())
            .filter(b => b && b !== r.codigo)
        )];

        items.push({
          c: r.codigo,
          b: bcs,
          n: r.nombre || '',
          u: unidades.map(x => ({ u: x.u, p: x.precio_con_iva, s: x.precio_sin_iva })),
        });
      }

      this.logger.log(`getPreciosTodos: ${items.length} productos${suc ? ' (sucursal ' + suc + ')' : ' (TODAS, precio no determinista)'}`);
      return {
        total: items.length,
        sucursal: suc,
        generado: new Date().toISOString(),
        productos: items,
      };
    } catch (e: any) {
      this.logger.error('getPreciosTodos error: ' + e.message);
      return { total: 0, generado: new Date().toISOString(), error: e.message, productos: [] };
    }
  }

  private async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }
}
