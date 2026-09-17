import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import {
  variacionPct,
  ventanaComparable,
  type MeCanal,
  type MeCanalGrupo,
  type MeZona,
  type MeZonaBloque,
  type MeZonaConsolidado,
  type MeZonaPeriodo,
} from '@megadulces/contracts';
import { todayMx } from '@megadulces/platform-core';

/**
 * `[JZ.3]`/`[JZ.6]` — **CÓMO VA MI ZONA.** El cuarto organismo de «Mi trabajo»: no es trabajo
 * pendiente, es resultado.
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar: *«que los jefes de zona vean cómo van sus tiendas y si están por encima o por debajo de
 * sus ventas»*, con el encuadre que define la pieza —**«mucho de lo que vamos a presentar ya
 * existe, sólo vamos a tomar la información o redireccionar a la interfaz correcta:
 * `/tienda/live` y `/ventas-por-ruta`»**— y después *«hay que mostrar vecinal aparte»*.
 *
 * Por eso acá no hay pantalla nueva ni reporte nuevo: hay una medición barata y un enlace a la
 * pantalla que ya sabe contar el detalle.
 *
 * ── ⛔ `[JZ.6]` La corrección que reescribió este archivo ────────────────────────────────────
 * La primera versión leía la venta de las rutas de `analytics.sales_daily`, por el almacén
 * `RUTA-NN`. **Medido el 2026-09-17, eso publicaba un número que NO es el de la pantalla que este
 * mismo bloque abre:**
 *
 *     Ruta 27, 1-16 de septiembre
 *       este bloque    (sales_daily / almacén RUTA-27)   429,639
 *       la pantalla    (sales_by_route_monthly)          224,025   ← salesByRoute lee ésta
 *       v_rd_route_daily                                 224,025
 *
 * 1.92× de diferencia, y el clic llevaba de un número al otro. Peor: el almacén `RUTA-27` de
 * `sales_daily` no tiene **ni una** fila del canal de ruta —son `tienda` y `credito`—, o sea que
 * nunca contuvo la venta de la ruta.
 *
 * Ahora la venta de ruta sale de **`analytics.v_rd_route_daily`**, que es diaria (sirve para los
 * tres granos), va por `route_code`, declara su procedencia (`venta_origen`) y **es la misma
 * fuente que el rollup mensual que lee la pantalla**. Regla general: *la portada toma el número
 * de donde lo toma la pantalla a la que manda.*
 *
 * ── ⭐ `[JZ.6]` Y la pertenencia sale del registro OPERATIVO, no del catálogo ────────────────
 * `analytics.v_route_zone` (nuevo) resuelve ruta → sucursal madre → zona desde `wincaja.branches`.
 * Con eso:
 *   · las **vecinales** entran por fin (no tienen almacén `RUTA-*`, así que `[JZ.2]` las declaraba
 *     `sin_almacen` y nunca se listaban): **$944,740 en LA PIEDAD del 1 al 16 de septiembre**;
 *   · **desaparecen las 3 claves ambiguas** de `[JZ.2]`: `501…505` cuelgan de CANINDO, no de
 *     ZAMORA — que se queda **sin ninguna ruta**;
 *   · y el fact no tiene **ni una** fila que el puente no resuelva (medido).
 *
 * ── ⛔ Las reglas que este archivo hace cumplir ─────────────────────────────────────────────
 *  1. **Sin venta NO es −100 %.** Las 5 rutas de ZAMORA no registraban un peso desde el 11-ago y
 *     era la pierna Wincaja del sell-out, no una caída. `monto: null` ⇒ `variacion_pct: null`.
 *  2. **Los dos lados de una comparación cubren el mismo universo** (`sumaPareada`), y el tramo
 *     **termina donde termina el dato**, no donde termina el reloj (el ancla de `ventanaComparable`).
 *  3. **Se muestra sólo lo que esta persona RESPONDE** (`[SN.30]`). Una clave por canal.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS, así que cada consulta lleva `tenant_id` EXPLÍCITO.
 */

/** Las claves de `identity.responsibilities` que encienden cada bloque. Una por canal. */
export const RESPONSABILIDAD_CANAL: Readonly<Record<MeCanalGrupo, string>> = {
  tienda: 'comercial.venta_tiendas',
  ruta: 'comercial.venta_rutas',
  vecinal: 'comercial.venta_vecinal',
};

/**
 * `[JZ.7]` — **La clave de dirección: todas las zonas, todos los canales.**
 *
 * Edgar (2026-09-17), al corregir el organigrama: *«luis francisco es dirección general y
 * guillermo lopez es dirección comercial»*. Ninguno de los dos tenía **ninguna** responsabilidad
 * (medido en prod: sólo **12 de ~50 puestos** tienen alguna, y toda la dirección está fuera), así
 * que por `[SN.30]` la portada del dueño de la empresa estaba vacía.
 *
 * ⛔ **No se resolvió dándoles las tres claves de canal.** Ésas anclan en `identity.users.zona_id`
 * y la ficha de los dos dice **OFICINAS**, que tiene 0 almacenes y 0 rutas: les habría publicado
 * «la venta de OFICINAS», un cero con cara de cifra. Una clave aparte también deja decir *«el
 * director comercial ve las zonas pero no la bandeja de finanzas»*, que con `superadmin` no se
 * puede decir.
 */
export const RESPONSABILIDAD_TODAS_LAS_ZONAS = 'comercial.venta_zonas';

/**
 * La pantalla que muestra el detalle de cada canal, con el permiso que la abre.
 *
 * ⛔ El permiso DEBE ser el que gatea la ruta en `app.routes.ts` — la misma regla dura que
 * `BandejaDef.anyOf`. Si no coincide, el enlace lleva a un rebote.
 */
const DESTINO: Readonly<Record<MeCanalGrupo, { ruta: string; permiso: Permission; label: string }>> = {
  tienda: { ruta: '/tienda/live', permiso: Permission.STORE_LIVE_VER, label: 'Tus tiendas' },
  ruta: {
    ruta: '/comercial/ventas-por-ruta',
    permiso: Permission.COMMERCIAL_ROUTE_SALES_VER,
    label: 'Tus rutas',
  },
  vecinal: {
    ruta: '/comercial/ventas-por-ruta',
    permiso: Permission.COMMERCIAL_ROUTE_SALES_VER,
    label: 'Tus rutas vecinales',
  },
};

/** El orden en que se pintan los bloques cuando empatan en peso. Tiendas primero, por decisión. */
const ORDEN_GRUPO: Readonly<Record<MeCanalGrupo, number>> = { tienda: 0, ruta: 1, vecinal: 2 };

export interface ZonaCtx {
  tenantId: string;
  userId: string;
  /** Claves vigentes de esta persona. `null` = no se pudieron leer. */
  responsabilidades: ReadonlySet<string> | null;
  permisos: Record<string, boolean> | null | undefined;
  esAdmin: boolean;
}

/** Una fila cruda de canal antes de medirle la venta. */
interface CanalCrudo {
  id: string;
  label: string;
  grupo: MeCanalGrupo;
  /** `[JZ.7]` De qué zona cuelga. Con una sola zona es constante; con dirección, agrupa. */
  zonaId: string;
  /** Almacén (tiendas) o `route_code` (rutas). Es la llave con la que se mide. */
  clave: string;
  /** Lo que la pantalla de destino acepta como filtro. `null` en tiendas (se acota sola). */
  filtro: string | null;
}

interface Medida {
  monto: number | null;
  comparado: number | null;
  ultima: string | null;
}

/** Vacío cuando no hay nada que decir; `motivo` explica por qué (va a `no_medido`). */
export interface ResultadoZona {
  zonas: MeZona[];
  consolidado: MeZonaConsolidado | null;
  motivo: string | null;
}

/** Suma que preserva el `null`: si NINGÚN sumando se midió, el total tampoco (ADR-056). */
function sumaMedida(vs: (number | null)[]): number | null {
  const hay = vs.filter((v): v is number => v !== null);
  return hay.length === 0 ? null : hay.reduce((a, b) => a + b, 0);
}

/**
 * ⛔ **Los dos lados de una comparación tienen que cubrir el MISMO universo.**
 *
 * Lo destapó el reporte contra prod: ZAMORA salía **−42.2 %** porque el `monto` sumaba un canal y
 * el `comparado` sumaba dos. Es el −100 % un nivel más arriba, y más difícil de ver porque el
 * número es verosímil. La regla: **un canal entra en los dos lados o en ninguno**, y lo que queda
 * fuera se cuenta en `no_comparado` en vez de desaparecer del subtotal.
 */
function sumaPareada(canales: MeCanal[]): {
  monto: number | null;
  comparado: number | null;
  no_comparado: { canales: number; monto_anterior: number } | null;
} {
  const dentro = canales.filter((c) => c.monto !== null);
  const fuera = canales.filter((c) => c.monto === null && c.comparado !== null);
  return {
    monto: sumaMedida(dentro.map((c) => c.monto)),
    comparado: dentro.length === 0 ? null : sumaMedida(dentro.map((c) => c.comparado)),
    no_comparado: fuera.length
      ? { canales: fuera.length, monto_anterior: fuera.reduce((a, c) => a + (c.comparado ?? 0), 0) }
      : null,
  };
}

function fechaCorta(iso: string): string {
  const [, m, d] = iso.split('-');
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(d)}-${MES[Number(m) - 1]}`;
}

const iso = (v: Date | string | null): string | null =>
  v ? new Date(v).toISOString().slice(0, 10) : null;

export async function medirZona(
  knex: Knex,
  ctx: ZonaCtx,
  periodo: MeZonaPeriodo = 'mes',
): Promise<ResultadoZona> {
  const { tenantId, userId, responsabilidades } = ctx;

  /*
   * `[SN.30]` Sin reparto no se muestra nada. ⛔ `null` (no se pudo leer) también corta acá: al
   * revés que las bandejas, éste es un bloque que NO existía — fallar abierto estrenaría una
   * pantalla nueva para 122 personas por una falla transitoria.
   */
  const todasLasZonas = !!responsabilidades?.has(RESPONSABILIDAD_TODAS_LAS_ZONAS);
  const grupos = todasLasZonas
    ? (Object.keys(RESPONSABILIDAD_CANAL) as MeCanalGrupo[])
    : (Object.keys(RESPONSABILIDAD_CANAL) as MeCanalGrupo[]).filter((g) =>
        responsabilidades?.has(RESPONSABILIDAD_CANAL[g]),
      );
  if (grupos.length === 0) return { zonas: [], consolidado: null, motivo: null };

  /*
   * `[JZ.7]` **Qué zonas son las tuyas.** Dirección: todas las que tienen un canal de venta —
   * medido en prod el 2026-09-17, **6 de 9**: LA PIEDAD RD (3 almacenes + 10 rutas), CANINDO
   * (1+5), MORELIA ABASTOS (1+0), MORELIA MADERO (1+2), YURECUARO (1+1) y ZAMORA (1+0).
   *
   * ⛔ Las otras tres —OFICINAS, LA PIEDAD VECINAL, ZAMORA VECINAL— **no se filtran por nombre**:
   * caen solas porque no tienen ni un almacén ni una ruta. Son eje de PERSONAS (19, 3 y 2
   * fichas), no de venta. Una lista negra escrita a mano se rompería con la próxima zona nueva.
   *
   * ⚠️ Y el conteo deja ver algo que no es mío de arreglar: **3 de esas 6 zonas no tienen jefe**
   * (sólo hay 3 `jefe_zona`, en LA PIEDAD RD, MORELIA ABASTOS y ZAMORA). Hoy nadie responde de
   * CANINDO, MORELIA MADERO ni YURECUARO.
   */
  const zonasObjetivo: { id: string; name: string }[] = [];
  if (todasLasZonas) {
    const filas = (await knex('trade.zones as z')
      .where('z.tenant_id', tenantId)
      // Agrupado a propósito: sin este `where(function)` el `orWhere` se llevaría el `tenant_id`
      // por delante y la rama derecha leería las zonas de TODAS las tenants.
      .where(function () {
        this.whereExists(function () {
          this.select(knex.raw('1'))
            .from('commercial.warehouses as w')
            .whereRaw('w.zone_id = z.id AND w.tenant_id = z.tenant_id AND w.deleted_at IS NULL');
        }).orWhereExists(function () {
          this.select(knex.raw('1'))
            .from('analytics.v_route_zone as rz')
            .whereRaw('rz.zone_id = z.id AND rz.tenant_id = z.tenant_id');
        });
      })
      .orderBy('z.name')
      .select('z.id', 'z.name')) as { id: string; name: string }[];
    zonasObjetivo.push(...filas);
    if (zonasObjetivo.length === 0) {
      return {
        zonas: [],
        consolidado: null,
        motivo: 'Respondes de la venta de todas las zonas, y ninguna tiene un canal de venta.',
      };
    }
  } else {
    const ficha = await knex('identity.users as u')
      .leftJoin('trade.zones as z', function () {
        this.on('z.id', '=', 'u.zona_id').andOn('z.tenant_id', '=', 'u.tenant_id');
      })
      .where({ 'u.id': userId, 'u.tenant_id': tenantId })
      .select('u.zona_id', 'z.name as zona_name')
      .first<{ zona_id: string | null; zona_name: string | null }>();

    if (!ficha?.zona_id || !ficha.zona_name) {
      return {
        zonas: [],
        consolidado: null,
        motivo: 'Respondes de la venta de tu zona, pero tu ficha no tiene zona asignada.',
      };
    }
    zonasObjetivo.push({ id: ficha.zona_id, name: ficha.zona_name });
  }
  const zonaIds = zonasObjetivo.map((z) => z.id);

  const hoy = todayMx();
  const nominal = ventanaComparable(hoy, periodo);

  // ── Los canales, de sus dos catálogos ────────────────────────────────────────────────────
  const canales: CanalCrudo[] = [];
  /** `[JZ.7]` Por zona y por grupo: lo excluido de LA PIEDAD no es lo excluido de ZAMORA. */
  const excluidos = new Map<string, { label: string; motivo: string }[]>();
  const claveEx = (zonaId: string, grupo: MeCanalGrupo) => `${zonaId}|${grupo}`;
  const excluir = (zonaId: string, grupo: MeCanalGrupo, x: { label: string; motivo: string }) => {
    const k = claveEx(zonaId, grupo);
    const prev = excluidos.get(k);
    if (prev) prev.push(x);
    else excluidos.set(k, [x]);
  };

  if (grupos.includes('tienda')) {
    /* ⚠️ `whereIn` sobre la lista de zonas: **una** consulta para 1 zona o para 6. Repetirla por
     * zona multiplicaría por N el costo de la portada del director sin traer nada nuevo. */
    const tiendas = (await knex('commercial.warehouses')
      .where('tenant_id', tenantId)
      .whereIn('zone_id', zonaIds)
      .whereNull('deleted_at')
      .orderBy('code')
      .select('id', 'code', 'name', 'zone_id')) as {
      id: string; code: string; name: string; zone_id: string;
    }[];
    for (const t of tiendas) {
      canales.push({
        id: t.code,
        label: `${t.code} · ${t.name}`,
        grupo: 'tienda',
        zonaId: t.zone_id,
        clave: t.id,
        filtro: null,
      });
    }
  }

  const quiereRutas = grupos.includes('ruta') || grupos.includes('vecinal');
  if (quiereRutas) {
    /*
     * `[JZ.6]` La pertenencia sale de `v_route_zone` (registro operativo de Wincaja), no del
     * catálogo: es lo que hace aparecer las vecinales y lo que disolvió las 3 claves «ambiguas».
     */
    const rutas = await knex('analytics.v_route_zone')
      .where('tenant_id', tenantId)
      .whereIn('zone_id', zonaIds)
      .orderBy(['tipo', 'route_code'])
      .select('route_code', 'route_name', 'tipo', 'historica', 'parent_code', 'zone_id');
    for (const r of rutas as {
      route_code: string; route_name: string; tipo: MeCanalGrupo; historica: boolean;
      parent_code: string; zone_id: string;
    }[]) {
      if (!grupos.includes(r.tipo)) continue;
      if (r.historica) {
        /*
         * ⚠️ `VEC-PH-H` termina el 26-jun y `1V001`/`1V002` arrancan el 27: es la MISMA ruta antes
         * del corte. Sumarla con sus sucesoras duplicaría el histórico. Se declara.
         */
        excluir(r.zone_id, r.tipo, {
          label: r.route_name,
          motivo: 'es la serie histórica de esta ruta, antes del corte: sumarla la contaría dos veces',
        });
        continue;
      }
      canales.push({
        id: r.route_code,
        label: r.route_name,
        grupo: r.tipo,
        zonaId: r.zone_id,
        clave: r.route_code,
        /*
         * ⛔ El filtro que `/comercial/ventas-por-ruta` acepta es `"<sucursal>|<route_code>"`
         * (`01|WIN-28`), NO el código de almacén. `[JZ.1]` mandaba `RUTA-28` y la pantalla abría
         * **vacía**: la prueba afirmaba sobre el argumento que viajaba, no sobre el valor que el
         * backend reconoce. Verificado contra prod: los 17 valores armados así existen.
         */
        filtro: `${r.parent_code}|WIN-${r.route_code}`,
      });
    }
  }

  /*
   * ── `[JZ.4]`/`[JZ.6]` Hasta dónde entregó cada FUENTE, antes de medir nada ──────────────────
   *
   * ⛔ Existe porque MORELIA ABASTOS publicó **−26.1 %** siendo **+17.1 %**: su fuente
   * (`wincaja_*`) no entregaba desde el 10-sep y el tramo comparaba 10 días de septiembre contra
   * 15 de agosto. `hasta` salía del reloj y no del dato.
   *
   * ⚠️ **La línea entre «va atrasada» y «este canal murió» es un UMBRAL declarado, no el tramo.**
   * La primera versión preguntaba «¿entregó algo dentro del tramo?», y con el grano `dia` el tramo
   * es UN día: la venta por ruta, que iba un día atrás, se leía como muerta y los 9 canales de
   * ruta de LA PIEDAD salían «sin medir» por 24 horas de rezago. Ahora se mira el rezago contra
   * HOY, sobre una ventana fija.
   *
   * El umbral separa las dos poblaciones con margen, medido: las fuentes vivas van **1 a 5 días**
   * atrás (`wincaja_*` llegó a 5 y sigue entregando; `mayoreo` 2; la venta por ruta 1), y las que
   * de verdad se cortaron llevaban **35** (las rutas de ZAMORA desde el 11-ago). Cualquier corte
   * entre 6 y 30 daba el mismo resultado; **7 días** deja una semana de tolerancia sin acercarse
   * a ninguna de las dos.
   */
  const VIVA_DIAS = 7;
  const limiteVivo = new Date(Date.parse(`${hoy}T00:00:00Z`) - VIVA_DIAS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tiendasIds = canales.filter((c) => c.grupo === 'tienda').map((c) => c.clave);
  const rutasCodes = canales.filter((c) => c.grupo !== 'tienda').map((c) => c.clave);
  const fuentes: { fuente: string; ultimo: string }[] = [];

  if (tiendasIds.length) {
    const f = (await knex('analytics.sales_daily')
      .where('tenant_id', tenantId)
      .whereIn('warehouse_id', tiendasIds)
      // ⛔ Tope en hoy: hay filas fechadas en el futuro y una fuente adelantada no puede estirar.
      .whereBetween('sale_date', [limiteVivo, hoy])
      .groupBy('channel')
      .select('channel', knex.raw('max(sale_date) as ultimo'))) as {
      channel: string; ultimo: Date | string;
    }[];
    for (const r of f) fuentes.push({ fuente: r.channel, ultimo: iso(r.ultimo) as string });
  }
  if (rutasCodes.length) {
    const f = (await knex('analytics.v_rd_route_daily')
      .where('tenant_id', tenantId)
      .whereIn('route_code', rutasCodes)
      .whereBetween('business_date', [limiteVivo, hoy])
      .select(knex.raw('max(business_date) as ultimo'))
      .first()) as { ultimo: Date | string | null } | undefined;
    if (f?.ultimo) fuentes.push({ fuente: 'venta por ruta', ultimo: iso(f.ultimo) as string });
  }

  let v = nominal;
  let corte: MeZona['corte'] = null;
  if (fuentes.length) {
    const masLento = fuentes.reduce((a, b) => (b.ultimo < a.ultimo ? b : a));
    // El ancla se resuelve DENTRO de `ventanaComparable`: con `dia`/`semana` el tramo se CORRE
    // hacia atrás (conservando el día de la semana) y con `mes` se recorta. Aplicarlo después
    // no podía correr un tramo de un solo día sin dejarlo vacío.
    v = ventanaComparable(hoy, periodo, masLento.ultimo);
    if (v.hasta !== nominal.hasta) {
      corte = {
        hasta_nominal: nominal.hasta,
        dias_sin_entregar: Math.round(
          (Date.parse(`${nominal.hasta}T00:00:00Z`) - Date.parse(`${v.hasta}T00:00:00Z`)) / 86_400_000,
        ),
        fuentes: fuentes.filter((f) => f.ultimo === masLento.ultimo).map((f) => f.fuente).sort(),
      };
    }
  }

  // ── La venta ─────────────────────────────────────────────────────────────────────────────
  const medidas = new Map<string, Medida>();
  const guardar = (k: string, mtd: unknown, prev: unknown, ultima: unknown) =>
    medidas.set(k, {
      // `null` se preserva: «no hubo ninguna fila» NO es «vendió cero».
      monto: mtd === null || mtd === undefined ? null : Number(mtd),
      comparado: prev === null || prev === undefined ? null : Number(prev),
      ultima: iso(ultima as Date | string | null),
    });

  if (tiendasIds.length) {
    /*
     * ⚠️ La forma importa: unir `sales_daily` contra `warehouses ⋈ zones` y filtrar por nombre de
     * zona tarda **4.4 s** (el planificador no empuja el rango de fechas). Resolver los almacenes
     * primero y pasar sus uuid en un `= ANY(...)` baja a **131 ms** con un *index only scan*.
     */
    const filas = (await knex('analytics.sales_daily')
      .where('tenant_id', tenantId)
      .whereIn('warehouse_id', tiendasIds)
      .whereBetween('sale_date', [v.desde_comparado, v.hasta])
      .groupBy('warehouse_id')
      .select(
        'warehouse_id',
        knex.raw('sum(revenue) filter (where sale_date between ? and ?) as mtd', [v.desde, v.hasta]),
        knex.raw('sum(revenue) filter (where sale_date between ? and ?) as prev', [
          v.desde_comparado, v.hasta_comparado,
        ]),
        knex.raw('max(sale_date) as ultima'),
      )) as { warehouse_id: string; mtd: string | null; prev: string | null; ultima: Date | null }[];
    for (const f of filas) guardar(f.warehouse_id, f.mtd, f.prev, f.ultima);
  }

  if (rutasCodes.length) {
    const filas = (await knex('analytics.v_rd_route_daily')
      .where('tenant_id', tenantId)
      .whereIn('route_code', rutasCodes)
      .whereBetween('business_date', [v.desde_comparado, v.hasta])
      .groupBy('route_code')
      .select(
        'route_code',
        knex.raw('sum(venta) filter (where business_date between ? and ?) as mtd', [v.desde, v.hasta]),
        knex.raw('sum(venta) filter (where business_date between ? and ?) as prev', [
          v.desde_comparado, v.hasta_comparado,
        ]),
        knex.raw('max(business_date) as ultima'),
      )) as { route_code: string; mtd: string | null; prev: string | null; ultima: Date | null }[];
    for (const f of filas) guardar(f.route_code, f.mtd, f.prev, f.ultima);
  }

  /*
   * ⚠️ La última venta se busca SIN tope inferior y sólo para lo que el tramo no pudo medir: es el
   * dato que convierte «−100 %» en «sin venta desde el 12-ago», y por definición cae FUERA de la
   * ventana. ⛔ Con tope en `v.hasta`: las dos fuentes tienen filas fechadas en el FUTURO (medido:
   * `sales_daily` 4 filas del 6-dic-2026; `v_rd_route_daily` la ruta 22 llega al 6-dic).
   */
  const mudos = canales.filter((c) => (medidas.get(c.clave)?.monto ?? null) === null);
  const mudasTiendas = mudos.filter((c) => c.grupo === 'tienda').map((c) => c.clave);
  const mudasRutas = mudos.filter((c) => c.grupo !== 'tienda').map((c) => c.clave);
  const ponerUltima = (k: string, u: unknown) => {
    const prev = medidas.get(k) ?? { monto: null, comparado: null, ultima: null };
    medidas.set(k, { ...prev, ultima: iso(u as Date | string | null) });
  };
  if (mudasTiendas.length) {
    const f = (await knex('analytics.sales_daily')
      .where('tenant_id', tenantId)
      .whereIn('warehouse_id', mudasTiendas)
      .where('sale_date', '<=', v.hasta)
      .groupBy('warehouse_id')
      .select('warehouse_id', knex.raw('max(sale_date) as ultima'))) as {
      warehouse_id: string; ultima: Date | null;
    }[];
    for (const r of f) ponerUltima(r.warehouse_id, r.ultima);
  }
  if (mudasRutas.length) {
    const f = (await knex('analytics.v_rd_route_daily')
      .where('tenant_id', tenantId)
      .whereIn('route_code', mudasRutas)
      .where('business_date', '<=', v.hasta)
      .groupBy('route_code')
      .select('route_code', knex.raw('max(business_date) as ultima'))) as {
      route_code: string; ultima: Date | null;
    }[];
    for (const r of f) ponerUltima(r.route_code, r.ultima);
  }

  // ── Armado ───────────────────────────────────────────────────────────────────────────────
  const permisos = ctx.permisos ?? {};
  const zonasMedidas: MeZona[] = [];

  for (const zona of zonasObjetivo) {
  const bloques: MeZonaBloque[] = [];

  for (const grupo of grupos) {
    const filasCrudas = canales.filter((c) => c.grupo === grupo && c.zonaId === zona.id);
    const fueraDeBloque = excluidos.get(claveEx(zona.id, grupo)) ?? [];
    // Un bloque sin canales NI excluidos no se pinta: no hay nada que decir de él.
    if (filasCrudas.length === 0 && fueraDeBloque.length === 0) continue;

    const d = DESTINO[grupo];
    const abre = ctx.esAdmin || permisos[d.permiso] === true;
    const filas: MeCanal[] = filasCrudas.map((c) => {
      const m = medidas.get(c.clave) ?? { monto: null, comparado: null, ultima: null };
      return {
        id: c.id,
        label: c.label,
        detalle:
          m.comparado !== null
            ? `contra ${Math.round(m.comparado).toLocaleString('es-MX')} del mismo tramo`
            : 'sin tramo comparable',
        grupo,
        monto: m.monto,
        comparado: m.comparado,
        variacion_pct: variacionPct(m.monto, m.comparado),
        ultima_venta: m.ultima,
        sin_medir:
          m.monto !== null
            ? null
            : m.ultima
              ? `sin venta registrada desde el ${fechaCorta(m.ultima)}`
              : 'nunca registró una venta',
        ruta: abre ? d.ruta : null,
        queryParams: abre && c.filtro ? { route: c.filtro } : null,
        sin_acceso: abre
          ? null
          : `Respondes de esto y tu permiso no abre ${d.ruta} (falta ${d.permiso}).`,
      } satisfies MeCanal;
    });

    const s = sumaPareada(filas);
    bloques.push({
      grupo,
      label: d.label,
      monto: s.monto,
      comparado: s.comparado,
      variacion_pct: variacionPct(s.monto, s.comparado),
      no_comparado: s.no_comparado,
      peso: null,
      canales: filas.sort(ordenCanal),
      excluidos: fueraDeBloque,
    });
  }

  /*
   * El total de la zona hereda el mismo pareo: un BLOQUE entra en los dos lados o en ninguno.
   * Sin esto, ZAMORA volvería a publicar −42.2 % sumando la tienda de este mes contra la tienda
   * más las rutas del anterior.
   */
  const conCifra = bloques.filter((b) => b.monto !== null);
  const monto = sumaMedida(conCifra.map((b) => b.monto));
  const comparado = conCifra.length === 0 ? null : sumaMedida(conCifra.map((b) => b.comparado));
  const fueraZona = bloques
    .map((b) => b.no_comparado)
    .filter((x): x is { canales: number; monto_anterior: number } => x !== null);
  const no_comparado = fueraZona.length
    ? {
        canales: fueraZona.reduce((a, x) => a + x.canales, 0),
        monto_anterior: fueraZona.reduce((a, x) => a + x.monto_anterior, 0),
      }
    : null;

  for (const b of bloques) {
    b.peso = monto === null || monto === 0 || b.monto === null ? null : b.monto / monto;
  }
  // El canal de más peso primero; lo no medido, al final. Empate → el orden declarado.
  bloques.sort((a, b) => (b.monto ?? -1) - (a.monto ?? -1) || ORDEN_GRUPO[a.grupo] - ORDEN_GRUPO[b.grupo]);

  // Una zona sin un solo bloque no se pinta (dirección: una zona que perdió sus canales).
  if (bloques.length === 0) continue;

  zonasMedidas.push({
    zona: zona.name,
    periodo,
    corte,
    incluye_dia_en_curso: v.incluye_dia_en_curso,
    desde: v.desde,
    hasta: v.hasta,
    desde_comparado: v.desde_comparado,
    hasta_comparado: v.hasta_comparado,
    monto,
    comparado,
    variacion_pct: variacionPct(monto, comparado),
    no_comparado,
    bloques,
  });
  }

  // La que más vende primero; la que no se pudo medir, al final. Igual criterio que los canales.
  zonasMedidas.sort((a, b) => (b.monto ?? -1) - (a.monto ?? -1) || a.zona.localeCompare(b.zona));

  /*
   * `[JZ.7]` El consolidado hereda el MISMO pareo que ya se aplica dos niveles más abajo (canal
   * dentro de bloque, bloque dentro de zona): una zona entra en los dos lados o en ninguno. Sin
   * esto, el total de la empresa repetiría el −42.2 % de ZAMORA a escala de compañía.
   *
   * `null` con una sola zona: repetir el único bloque como «total» sólo agrega ruido.
   */
  let consolidado: MeZonaConsolidado | null = null;
  if (zonasMedidas.length > 1) {
    const dentro = zonasMedidas.filter((z) => z.monto !== null);
    const fuera = zonasMedidas.filter((z) => z.monto === null && z.comparado !== null);
    const tot = sumaMedida(dentro.map((z) => z.monto));
    const totPrev = dentro.length === 0 ? null : sumaMedida(dentro.map((z) => z.comparado));
    consolidado = {
      zonas: zonasMedidas.length,
      monto: tot,
      comparado: totPrev,
      variacion_pct: variacionPct(tot, totPrev),
      no_comparado: fuera.length
        ? {
            canales: fuera.length,
            monto_anterior: fuera.reduce((a, z) => a + (z.comparado ?? 0), 0),
          }
        : null,
    };
  }

  return { zonas: zonasMedidas, consolidado, motivo: null };
}

/** Lo que no se pudo medir va al final: una fila sin cifra no compite con una que sí la tiene. */
function ordenCanal(a: MeCanal, b: MeCanal): number {
  if ((a.monto === null) !== (b.monto === null)) return a.monto === null ? 1 : -1;
  return (b.monto ?? 0) - (a.monto ?? 0);
}
