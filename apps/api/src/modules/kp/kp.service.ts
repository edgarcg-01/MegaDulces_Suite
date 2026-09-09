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
 * `[TDA.4]` Un escalón de mayoreo, listo para pintar en el mostrador.
 *
 * `ahorro_en_el_minimo` es el campo que cierra la venta: no es lo mismo decir «$8.90 c/u» que
 * «llevando 12 te ahorrás $22.80». El mostrador existe para cerrar, no sólo para informar.
 *
 * `realza` separa el DATO de la SEÑAL: por debajo del 1 % de descuento el número es cierto pero
 * pintarlo como oferta sería mentir con el color. Medido en prod: 98 productos están en ese caso.
 */
export interface MayoreoTier {
  /** `pieza` | `paquete` — de qué escalera es este tier. */
  etiqueta:            string;
  /** El umbral REAL de Kepler (`kdpv_prod_util.c4`). Nunca un default. */
  desde:               number;
  /** Cómo se nombra lo que se lleva: piezas / paquetes / cajas / kg. */
  palabra:             string;
  precio_con_iva:      number;
  ahorro_por_unidad:   number;
  ahorro_en_el_minimo: number;
  descuento_pct:       number;
  realza:              boolean;
}

/**
 * `[TDA.4]` El mismo tier, con las claves cortas que ya usa el snapshot (`c`/`b`/`bu`/`n`/`u`).
 *
 * NO es una segunda definición: el cómputo y las reglas siguen viviendo UNA vez en
 * `tiersDeFila()`; esto es sólo la codificación del cable. Medido: con las claves largas el
 * snapshot crecía **1,386 KB crudos** — los nombres eran el 51 % de los bytes, repetidos 8,383
 * veces. El kiosco lo baja por LAN cada 12 h y lo guarda en IndexedDB, así que medio mega de
 * nombres de campo es peso real por cero información.
 */
export interface MayoreoTierCompacto {
  e: string;   // etiqueta
  d: number;   // desde
  w: string;   // palabra
  p: number;   // precio_con_iva
  au: number;  // ahorro_por_unidad
  am: number;  // ahorro_en_el_minimo
  pc: number;  // descuento_pct
  r: 0 | 1;    // realza
}

/** Un tier a su forma de cable. La inversa vive en `verificador.service.ts`. */
export const compactarTier = (t: MayoreoTier): MayoreoTierCompacto => ({
  e: t.etiqueta, d: t.desde, w: t.palabra, p: t.precio_con_iva,
  au: t.ahorro_por_unidad, am: t.ahorro_en_el_minimo, pc: t.descuento_pct, r: t.realza ? 1 : 0,
});

/**
 * Descuento mínimo para PINTAR el mayoreo como oferta. Mismo valor y mismo motivo que
 * `label.component.ts`: por debajo de esto el precio es materialmente igual y la señal visual
 * sería falsa.
 */
const MAYOREO_MIN_DESC = 0.01;
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

  /**
   * `[TDA.3]` — ¿De qué UNIDAD es el código que se escaneó?
   *
   * ── El decode, que este módulo no tenía ─────────────────────────────────────
   * Kepler no tiene "una columna de código de barras": tiene casillas, y **cada UNIDAD tiene la
   * suya**. El decode verificado (2026-08-25, contra la pantalla del POS; vive en
   * `services/feeds-ingest/barcode-compute.js`) es:
   *
   *   · unidad BASE (`c11`) → `c7`  + `c93`
   *   · unidad DOS  (`c80`) → `c82` + `c95`   (factor `c81`)
   *   · unidad TRES (`c83`) → `c85`            (factor `c84`)
   *
   * Este módulo se portó de un proyecto externo con la lista `c7, c82, c93, c95, c96`, o sea:
   *  · **le falta `c85`** — el código de la tercera unidad. Medido en prod: sólo **2 SKUs** son
   *    alcanzables únicamente por ahí, así que el hueco es real y chico. Se agrega igual.
   *  · **`c96` no es un barcode**: trae códigos internos (`CB2383139`…). Se **conserva** en la
   *    búsqueda porque 15 SKUs tienen ahí algo de 8-14 dígitos y quitarlo los volvería
   *    inencontrables, pero NO se usa para deducir unidad: no la sabe.
   *
   * Es el mismo off-by-one que `barcode-compute.js` documenta como corregido para el importer
   * («el importer viejo mapeaba c82→c83 … e ignoraba c93/c95/c85») y que a esta ruta nunca se le
   * aplicó.
   *
   * ── Su techo, medido y dicho ────────────────────────────────────────────────
   * **10,771 de 11,506 SKUs (93.6 %) tienen UNA sola unidad registrada**, así que en 9 de cada 10
   * escaneos esto no puede expresar una elección: devuelve la única que hay. No es un defecto de
   * este código — es el catálogo. Por eso la pantalla **no dice nada** cuando hay una sola unidad:
   * un aviso que sale siempre se aprende a ignorar.
   *
   * Devuelve el NOMBRE de la unidad (`PZA`/`PAQ`/`CJA`/`KG`…) o `null` si el código no cayó en
   * ningún slot con unidad conocida — y `null` se lee como "no sé", nunca como "es la base".
   */
  private unidadDelCodigo(r: any, code: string): string | null {
    const norm = (v: any) => String(v == null ? '' : v).trim();
    const igual = (v: any) => {
      const s = norm(v);
      if (!s) return false;
      // Se comparan sin ceros a la izquierda: el escáner y Kepler no siempre coinciden en el pad.
      return s === code || s.replace(/^0+/, '') === code.replace(/^0+/, '');
    };
    // El orden es la precedencia cuando el MISMO código está en dos slots: base > U2 > U3,
    // igual que el `SRC_RANK` de `barcode-compute.js` — una sola fuente de verdad para la regla.
    if (igual(r.bc1) || igual(r.bc3)) return norm(r.u1).toUpperCase() || null;  // c7  / c93 → c11
    if (igual(r.bc2) || igual(r.bc4)) return norm(r.u2).toUpperCase() || null;  // c82 / c95 → c80
    if (igual(r.bc6)) return norm(r.u3).toUpperCase() || null;                  // c85       → c83
    return null; // el SKU mismo, o `c96` (código interno): no dice unidad
  }

  /** Columnas que necesita el verificador, iguales para uno o para todos. */
  private static readonly COLS_PRECIO = `
    LPAD(TRIM(c1::text), 5, '0') AS codigo,
    -- [TDA.3] Los slots, con su unidad. El orden importa: unidadDelCodigo() lo usa para saber a
    -- que unidad pertenece cada casilla (base = bc1/bc3, U2 = bc2/bc4, U3 = bc6).
    -- SIN ACENTOS GRAVES aca: esto vive dentro de un template literal y lo cierran.
    TRIM(c7::text)  AS bc1,
    TRIM(c82::text) AS bc2,
    TRIM(c93::text) AS bc3,
    TRIM(c95::text) AS bc4,
    TRIM(c96::text) AS bc5,
    TRIM(c85::text) AS bc6,
    TRIM(c2::text)  AS nombre,
    TRIM(c11::text) AS u1, ${NUMC_NULL('c90')} AS pv1,
    TRIM(c80::text) AS u2, ${NUMC_NULL('c91')} AS pv2, ${NUMC_NULL('c81')} AS f2,
    TRIM(c83::text) AS u3, ${NUMC_NULL('c92')} AS pv3, ${NUMC_NULL('c84')} AS f3,
    ${NUMC_NULL('c77')} AS costo,
    ${NUMC_NULL('c87')} AS margen,
    ${NUMC_NULL('c18')} AS iva_raw,
    ${NUMC_NULL('c19')} AS ieps_raw`;

  /**
   * `[TDA.4]` — Convierte UNA fila de `product_label_prices` en sus escalones de mayoreo.
   *
   * Vive aparte porque lo usan los dos caminos —la consulta de un producto y el lote del snapshot
   * offline— y la regla del descuento mínimo no puede existir dos veces: el modo sin red
   * terminaría contestando distinto que el modo en línea el día que una copia cambie. Es el mismo
   * defecto que `[TDA.3]` arregló con la unidad escaneada.
   *
   * ── Las cuatro guardas, heredadas de la etiquetera ──────────────────────────
   * Cada una salió de un defecto real en producción:
   *  1. precio > 0
   *  2. **umbral > 1** — un tier "desde 1" es el precio normal con otro nombre
   *  3. **más barato que el unitario** — si no, no es un mayoreo
   *  4. el unitario tiene que existir, o no hay contra qué comparar
   *
   * Lo que NO se hace, y es deliberado: **inventar un umbral**. La etiquetera ponía "desde 3" por
   * default y afirmaba una condición que la caja no iba a respetar — *"un mayoreo cuya condición
   * de cantidad no se conoce fabrica una discusión en el mostrador"*. Medido en prod: **17
   * productos** tienen precio de mayoreo de paquete sin umbral; a esos no se les muestra mayoreo.
   */
  private tiersDeFila(r: any): { mayoreo: MayoreoTier[]; contenido: string | null } {
    const base = r.piece_price != null ? Number(r.piece_price) : null;

    const tier = (
      etiqueta: string,
      precio: unknown,
      desde: unknown,
      palabra: string,
    ): MayoreoTier | null => {
      const p = precio != null ? Number(precio) : NaN;
      const n = desde != null ? Number(desde) : NaN;
      if (!Number.isFinite(p) || p <= 0) return null;
      if (!Number.isFinite(n) || n <= 1) return null;      // "desde 1" no es mayoreo
      if (!base || base <= 0 || p >= base) return null;     // tiene que ser MÁS barato
      const desc = (base - p) / base;
      const nn = Math.trunc(n);
      return {
        etiqueta,
        desde: nn,
        palabra,
        precio_con_iva: redondea(p),
        ahorro_por_unidad: redondea(base - p),
        // Lo que de verdad cierra la venta: cuánto se ahorra llevando el mínimo.
        ahorro_en_el_minimo: redondea((base - p) * nn),
        descuento_pct: Math.round(desc * 1000) / 10,
        // Debajo del 1 % el descuento es cierto pero no perceptible: se muestra el DATO y no la
        // señal de oferta. Medido: 98 productos caen acá.
        realza: desc >= MAYOREO_MIN_DESC,
      };
    };

    // La palabra de lo que se lleva sale de la unidad BASE del producto, no del tier: si la base
    // es KG, "desde 20 piezas" sería falso — son 20 kilos.
    const ub = String(r.unit_base || '').trim().toUpperCase();
    const palabraBase = ub === 'KG' ? 'kg' : ub === 'PAQ' ? 'paquetes' : ub === 'CJA' ? 'cajas' : 'piezas';

    const mayoreo = [
      tier('pieza', r.wholesale_piece_price, r.wholesale_piece_min_qty, palabraBase),
      tier('paquete', r.wholesale_pack_price, r.wholesale_pack_min_qty, 'paquetes'),
    ].filter((x): x is MayoreoTier => x !== null);

    return { mayoreo, contenido: r.content ? String(r.content) : null };
  }

  /**
   * `[TDA.4]` — Los tiers de mayoreo de TODO el catálogo, en una sola lectura.
   *
   * El snapshot offline lo bajan los kioscos una vez cada 12 h: pedir la etiqueta producto por
   * producto serían ~9,000 viajes. Se lee la tabla entera y se indexa por SKU.
   *
   * El snapshot lleva **el mismo objeto** que la respuesta en vivo, no una forma comprimida. La
   * tentación era mandar sólo `{desde, precio}` y que el kiosco derivara el ahorro y el realce —
   * pero eso pondría la regla del 1 % en DOS lugares, y el modo offline terminaría contestando
   * distinto que el modo en línea el día que una de las dos copias cambie. Es exactamente el
   * defecto que `[TDA.3]` acaba de arreglar con la unidad escaneada. El costo es tamaño de
   * descarga en una LAN, una vez cada 12 h; el beneficio es una sola definición.
   */
  private async mayoreoDeTodos(): Promise<Map<string, { mayoreo: MayoreoTier[]; contenido: string | null }>> {
    const idx = new Map<string, { mayoreo: MayoreoTier[]; contenido: string | null }>();
    try {
      await this.db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
        const { rows } = await trx.raw(
          `SELECT btrim(p.sku) AS sku, l.piece_price, l.content, l.unit_base,
                  l.wholesale_piece_price, l.wholesale_piece_min_qty,
                  l.wholesale_pack_price,  l.wholesale_pack_min_qty
             FROM catalog.products p
             JOIN commercial.product_label_prices l
               ON l.product_id = p.id AND l.tenant_id = p.tenant_id
            WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND btrim(coalesce(p.sku,'')) <> ''`,
          [TENANT],
        );
        for (const r of rows || []) {
          const t = this.tiersDeFila(r);
          if (t.mayoreo.length || t.contenido) idx.set(String(r.sku), t);
        }
      });
    } catch (e: any) {
      // Sin mayoreo el snapshot sigue sirviendo para lo que servía: el precio unitario. Se
      // degrada, no se cae.
      this.logger.warn(`mayoreoDeTodos: no se pudo leer, el snapshot va sin mayoreo — ${e.message}`);
    }
    return idx;
  }

  /**
   * `[TDA.4]` — Lo que la etiqueta del anaquel sabe de este producto y el mostrador no leía.
   *
   * Devuelve el override manual (si lo hay) **y los tiers de mayoreo**. Son la misma consulta
   * porque salen de la misma fila: separarlas sería pagar dos viajes por un solo hecho.
   *
   * ── Por qué el mayoreo importa acá ──────────────────────────────────────────
   * Medido en prod el 2026-09-09: **8,481 de 9,020 productos (94 %) tienen mayoreo real**
   * (7,538 por paquete, 1,563 por pieza). No es un extra para un rincón — es el caso normal, y
   * el mostrador es donde se cierra la venta. El descuento mediano es **7.41 %** (p90 9.41 %).
   *
   * ── Las reglas se HEREDAN de la etiquetera, no se reinventan ────────────────
   * Cada una salió de un defecto real en producción, así que se copian tal cual:
   *  · **`min_qty > 1` o no es mayoreo.** Un tier "desde 1" es el precio normal con otro nombre.
   *  · **Sin umbral real NO se muestra.** Textual de `label.component`: *"un mayoreo cuya
   *    condición de cantidad no se conoce fabrica una discusión en el mostrador"*. Antes la
   *    etiqueta ponía "desde 3" por default y mentía. Medido: **17 productos** tienen precio de
   *    mayoreo de paquete sin umbral — a esos no se les muestra el mayoreo, y punto.
   *  · **El precio de mayoreo tiene que ser MENOR** que el unitario, o no es un mayoreo.
   *  · **Realce sólo con descuento ≥ 1 %** (`MAYOREO_MIN_DESC`). Medido: **98 productos** tienen
   *    menos de 1 % y pintarlos como oferta sería una señal falsa sobre un precio igual.
   *
   * ── Por qué acá y no vía `/store/labels/resolve` ────────────────────────────
   * Ese endpoint ya devuelve todo esto, pero exige **sesión + `STORE_LABELS_VER`**, y este
   * kiosco es `@Public()` a propósito: *"el kiosco no tiene con quién autenticarse"*. Se lee la
   * tabla directo, que es lo que este servicio ya hacía para el override. No cambia la clase de
   * exposición: sigue publicando **precios de venta**, nunca costo ni margen.
   *
   * `SET LOCAL app.tenant_id` en la MISMA tx: la tabla tiene RLS **FORCE** y sin contexto la
   * lectura vuelve **vacía en silencio** si el rol es `app_runtime`.
   *
   * Ante cualquier problema devuelve todo en `null`: es un refinamiento del precio, no el precio.
   */
  private async datosDeEtiqueta(codigo: string): Promise<{
    override: number | null;
    mayoreo: MayoreoTier[];
    contenido: string | null;
  }> {
    const vacio = { override: null, mayoreo: [] as MayoreoTier[], contenido: null };
    try {
      return await this.db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
        const { rows } = await trx.raw(
          `SELECT l.piece_price, l.source, l.content, l.unit_base,
                  l.wholesale_piece_price, l.wholesale_piece_min_qty,
                  l.wholesale_pack_price,  l.wholesale_pack_min_qty
             FROM catalog.products p
             JOIN commercial.product_label_prices l
               ON l.product_id = p.id AND l.tenant_id = p.tenant_id
            WHERE p.tenant_id = ?
              AND p.deleted_at IS NULL
              AND btrim(p.sku) = ?
            LIMIT 1`,
          [TENANT, String(codigo).replace(/^0+/, '')],
        );
        const r = rows?.[0];
        if (!r) return vacio;

        const base = r.piece_price != null ? Number(r.piece_price) : null;
        const override = r.source === "manual" && base && base > 0 ? base : null;
        // El cómputo vive en `tiersDeFila` porque el snapshot offline usa el MISMO: la regla del
        // descuento mínimo no puede existir dos veces.
        const { mayoreo, contenido } = this.tiersDeFila(r);
        return { override, mayoreo, contenido };
      });
    } catch (e: any) {
      this.logger.warn(`datosDeEtiqueta(${codigo}) no se pudo leer: ${e.message}`);
      return vacio;
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
           OR TRIM(c85::text) = $1
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

      // `[TDA.3]` De qué unidad es el código que se escaneó. Se resuelve contra ESTA fila —la misma
      // de la que sale el precio— y no contra `catalog.product_barcodes`: así la unidad y el precio
      // no pueden quedar en desacuerdo. La tabla canónica es otra copia y puede ir un tick atrás.
      //
      // `unidades` NO se reordena: sus `factor` significan "cuántas unidades base entran acá", así
      // que poner otra primero volvería falsa la leyenda de las demás ("1 CJA" para una pieza). La
      // pantalla decide a cuál le da el número grande; el arreglo sigue siendo base-primero.
      const uEscaneada = this.unidadDelCodigo(r, code);

      // ¿Las plazas discrepan en el precio base? Sólo importa cuando NO se pidió una: con plaza
      // la respuesta es la de esa plaza y no hay ambigüedad que declarar.
      const distintos = new Set(
        rows.map((x: any) => (x.pv1 != null ? Number(x.pv1) : null)).filter((p: number | null) => p != null && p > 0),
      );
      const ambiguo = !suc && distintos.size > 1;

      // El override manual gana: es una corrección humana deliberada y es lo que sale impreso en
      // el anaquel. Sólo se pisa el precio de la unidad BASE (es lo que la tabla guarda por pieza).
      // `[TDA.4]` Una sola lectura trae el override manual Y los tiers de mayoreo: salen de la
      // misma fila de la etiqueta, así que separarlas sería pagar dos viajes por un solo hecho.
      const etiqueta = await this.datosDeEtiqueta(r.codigo);
      const manual = etiqueta.override;
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
        // `[TDA.3]` La unidad del código escaneado, y la base (que es a la que se refieren los
        // `factor`). `null` = el código no cayó en un slot con unidad conocida (el SKU mismo, o
        // `c96`, que trae códigos internos) — se lee "no sé", nunca "es la base".
        unidad_escaneada: uEscaneada && unidades.some((x) => x.u === uEscaneada) ? uEscaneada : null,
        unidad_base: base ? base.u : null,
        // `[TDA.4]` Los escalones de mayoreo y el gramaje. Es lo que la etiqueta del anaquel ya
        // decía y el mostrador callaba: el 94 % de los productos tiene mayoreo real, así que
        // omitirlo no era una simplificación, era esconder el argumento de venta.
        // Llega vacío cuando no hay tier con umbral REAL — nunca con un umbral inventado.
        mayoreo: etiqueta.mayoreo,
        contenido: etiqueta.contenido,
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

      // `[TDA.4]` Las etiquetas de TODO el catálogo en una sola lectura: el snapshot lo bajan los
      // kioscos una vez cada 12 h y pedir producto por producto serían ~9,000 viajes.
      const etiquetas = await this.mayoreoDeTodos();

      const vistos = new Set<string>();
      const items: any[] = [];

      for (const r of rows) {
        if (vistos.has(r.codigo)) continue;
        vistos.add(r.codigo);

        const unidades = this.armarUnidades(r);
        if (!unidades.length) continue;  // sin precio no sirve para el verificador

        // Códigos de barras. Kepler no tiene una columna de código de barras: tiene casillas, y
        // **cada UNIDAD tiene la suya** (ver `unidadDelCodigo`). Hay que leerlas todas. Se
        // descartan los que sólo repiten la clave del producto: no aportan como llave de búsqueda.
        //
        // `[TDA.3]` Ahora se agrega `c85` (la tercera unidad, que faltaba) y —lo importante— el
        // snapshot lleva **la unidad de cada barcode** en `bu`, en el mismo índice que `b`. Sin eso
        // el kiosco sin red no podía saber qué unidad se escaneó y mostraba siempre la base, o sea
        // el modo offline contestaba distinto que el modo en línea. `bu` se agrega EN PARALELO en
        // vez de cambiar `b` a objetos: un lector viejo del snapshot sigue funcionando igual.
        const bcs: string[] = [];
        const bus: (string | null)[] = [];
        for (const raw of [r.bc1, r.bc2, r.bc3, r.bc4, r.bc5, r.bc6]) {
          const b = String(raw || '').trim();
          if (!b || b === r.codigo || bcs.includes(b)) continue;
          bcs.push(b);
          const u = this.unidadDelCodigo(r, b);
          bus.push(u && unidades.some((x) => x.u === u) ? u : null);
        }

        // El SKU sin ceros a la izquierda: `catalog.products.sku` no los lleva y `r.codigo` viene
        // con LPAD(5). Sin normalizar, el join en memoria fallaría para TODO el catálogo.
        const et = etiquetas.get(String(r.codigo).replace(/^0+/, ''));

        items.push({
          c: r.codigo,
          b: bcs,
          bu: bus,
          n: r.nombre || '',
          u: unidades.map(x => ({ u: x.u, p: x.precio_con_iva, s: x.precio_sin_iva })),
          // `[TDA.4]` Mayoreo y gramaje, con la MISMA forma que la respuesta en vivo — una sola
          // definición para los dos modos. Se OMITEN cuando no hay nada que decir: un array vacío
          // por producto son ~9,000 arrays vacíos en la descarga del kiosco.
          ...(et?.mayoreo.length ? { m: et.mayoreo.map(compactarTier) } : {}),
          ...(et?.contenido ? { g: et.contenido } : {}),
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
