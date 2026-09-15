import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import {
  variacionPct,
  ventanaComparable,
  type MeCanal,
  type MeCanalGrupo,
  type MeZona,
  type MeZonaBloque,
} from '@megadulces/contracts';
import { todayMx } from '@megadulces/platform-core';

/**
 * `[JZ.3]` — **CÓMO VA MI ZONA.** El cuarto organismo de «Mi trabajo»: no es trabajo pendiente,
 * es resultado.
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar (2026-09-15): *«me gustaría que los jefes de zona vean cómo van sus tiendas y si están
 * por encima o por debajo de sus ventas»*, y después, dos veces, el encuadre que define esta
 * pieza: *«que vea cuánto vendieron las rutas y si bajó o subió; para las tiendas sin visitar
 * sería el supervisor de ruta»* y **⭐ «mucho de lo que vamos a presentar ya existe, sólo vamos a
 * tomar la información o redireccionar a la interfaz correcta: `/tienda/live` y
 * `/ventas-por-ruta`»**.
 *
 * Por eso acá **no hay pantalla nueva ni reporte nuevo**. Hay una medición barata —ocho números
 * por zona— y un enlace a la pantalla que ya sabe contar el detalle. El filtro por URL que hace
 * aterrizar ese enlace es `[JZ.1]`; el puente ruta↔almacén que permite sumar la zona es `[JZ.2]`.
 *
 * ── ⛔ Las tres reglas que este archivo existe para hacer cumplir ───────────────────────────
 *
 *  1. **Sin venta NO es −100 %.** Medido en prod: las 5 rutas de ZAMORA no registran un peso
 *     desde el 11-12 de agosto, y NO es una caída — es la pierna Wincaja del sell-out que dejó
 *     de llegar (las 6 de LA PIEDAD, que venden por otro canal, llegan al día sin hueco). Un
 *     jefe que lee −100 % sale a buscar al vendedor; uno que lee «sin venta desde el 12-ago» le
 *     habla a Sistemas. `monto: null` ⇒ `variacion_pct: null`, siempre (ADR-056).
 *
 *  2. **Lo ambiguo no se suma ni se calla.** `[JZ.2]` dejó 3 claves de ruta reclamadas por dos
 *     zonas (`501`, `502`, `VECINAL1`); las dos primeras valen $1.04M. Sumarlas a las dos zonas
 *     las contaría dos veces y elegir una a dedo sería inventar un hecho de negocio. Van a
 *     `excluidos` con su motivo, para que el subtotal se pueda explicar.
 *
 *  3. **Se muestra sólo lo que esta persona RESPONDE.** `[SN.30]` (Edgar: *«si no tiene
 *     responsabilidades no se le muestra nada»*). Las dos claves son
 *     `comercial.venta_tiendas` y `comercial.venta_rutas`, y son dos porque son dos trabajos:
 *     hay quien responde del piso de venta y no de la ruta directa.
 *
 * ── El sujeto es la ficha, y por qué NO `ScopeService` ──────────────────────────────────────
 * La zona sale de `identity.users.zona_id`. Medido: de los 3 `jefe_zona` de prod, **2 son
 * `superadmin`** y su alcance de zona es `all` — resolverlo por alcance les mostraría las 9 zonas
 * y convertiría *su* portada en la de la empresa. El alcance dice qué PODÉS ver; la ficha dice
 * cuál es TU zona, y esta pantalla pregunta lo segundo.
 *
 * ── Rendimiento, medido contra prod ─────────────────────────────────────────────────────────
 * ⚠️ La forma importa. La consulta natural —unir `sales_daily` contra `warehouses ⋈ zones` y
 * filtrar por nombre de zona— tarda **4.4 s**: el planificador no puede empujar el rango de
 * fechas y termina en un scan. Resolver primero los almacenes (barato, 2 consultas de catálogo) y
 * pasar sus uuid en un `= ANY($2::uuid[])` baja a **131 ms de ejecución** con un *index only scan*
 * sobre `ix_sales_daily_cover`. Son 3 consultas en vez de 1, y cuestan 20 veces menos.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS (igual que el resto de `me-work.ts`), así que cada
 * consulta lleva `tenant_id` EXPLÍCITO.
 */

/** Las claves de `identity.responsibilities` que encienden cada bloque. Una por canal. */
export const RESPONSABILIDAD_CANAL: Readonly<Record<MeCanalGrupo, string>> = {
  tienda: 'comercial.venta_tiendas',
  ruta: 'comercial.venta_rutas',
};

/**
 * La pantalla que muestra el detalle de cada canal, con el permiso que la abre.
 *
 * ⛔ El permiso DEBE ser el que gatea la ruta en `app.routes.ts` — la misma regla dura que
 * `BandejaDef.anyOf`. Si no coincide, el enlace lleva a un rebote. Medido en prod: la jefa de
 * zona de LA PIEDAD **no tiene `COMMERCIAL_ROUTE_SALES_VER`**, así que sus filas de ruta salen
 * sin enlace y con el motivo — no escondidas, que taparía la discrepancia.
 */
const DESTINO: Readonly<Record<MeCanalGrupo, { ruta: string; permiso: Permission; label: string }>> = {
  tienda: { ruta: '/tienda/live', permiso: Permission.STORE_LIVE_VER, label: 'Tus tiendas' },
  ruta: {
    ruta: '/comercial/ventas-por-ruta',
    permiso: Permission.COMMERCIAL_ROUTE_SALES_VER,
    label: 'Tus rutas',
  },
};

export interface ZonaCtx {
  tenantId: string;
  userId: string;
  /** Claves vigentes de esta persona. `null` = no se pudieron leer (se falla ABIERTO arriba). */
  responsabilidades: ReadonlySet<string> | null;
  permisos: Record<string, boolean> | null | undefined;
  esAdmin: boolean;
}

/** Una fila cruda de canal antes de medirle la venta. */
interface CanalCrudo {
  id: string;
  label: string;
  warehouse_id: string;
  grupo: MeCanalGrupo;
}

interface Medida {
  monto: number | null;
  comparado: number | null;
  ultima: string | null;
}

/** `null` cuando no hay nada que decir; `motivo` explica por qué (va a `no_medido`). */
export interface ResultadoZona {
  zona: MeZona | null;
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
 * Esto no estaba en la primera versión y lo destapó el reporte contra prod: ZAMORA salía
 * **−42.2 %**. Sus 3 rutas vendieron ~$480k del 1 al 15 de agosto y **nada** en septiembre porque
 * dejó de llegar el dato; el `monto` sumaba un canal y el `comparado` sumaba dos, así que el
 * total comparaba una tienda contra una tienda más tres rutas. Es exactamente el −100 % que este
 * archivo existe para no publicar, un nivel más arriba — y más difícil de ver, porque el número
 * es verosímil.
 *
 * La regla: **un canal entra en los dos lados o en ninguno.** Lo que queda fuera no se pierde: se
 * cuenta en `no_comparado` para que la pantalla pueda decir cuánto vale lo que no se pudo comparar.
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
      ? {
          canales: fuera.length,
          monto_anterior: fuera.reduce((a, c) => a + (c.comparado ?? 0), 0),
        }
      : null,
  };
}

function fechaCorta(iso: string): string {
  const [, m, d] = iso.split('-');
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(d)}-${MES[Number(m) - 1]}`;
}

export async function medirZona(knex: Knex, ctx: ZonaCtx): Promise<ResultadoZona> {
  const { tenantId, userId, responsabilidades } = ctx;

  /*
   * `[SN.30]` Sin reparto no se muestra nada. ⛔ `null` (no se pudo leer) también corta acá, y a
   * propósito: al revés que las bandejas, éste es un bloque que NO existía — fallar abierto
   * estrenaría una pantalla nueva para 122 personas por una falla transitoria.
   */
  const grupos = (Object.keys(RESPONSABILIDAD_CANAL) as MeCanalGrupo[]).filter((g) =>
    responsabilidades?.has(RESPONSABILIDAD_CANAL[g]),
  );
  if (grupos.length === 0) return { zona: null, motivo: null };

  const ficha = await knex('identity.users as u')
    .leftJoin('trade.zones as z', function () {
      this.on('z.id', '=', 'u.zona_id').andOn('z.tenant_id', '=', 'u.tenant_id');
    })
    .where({ 'u.id': userId, 'u.tenant_id': tenantId })
    .select('u.zona_id', 'z.name as zona_name')
    .first<{ zona_id: string | null; zona_name: string | null }>();

  if (!ficha?.zona_id || !ficha.zona_name) {
    // Se DECLARA. Responde de la venta de su zona y su ficha no dice cuál es: eso lo arregla
    // quien administra usuarios, y hasta entonces la pantalla no puede inventarle una zona.
    return {
      zona: null,
      motivo: 'Respondes de la venta de tu zona, pero tu ficha no tiene zona asignada.',
    };
  }

  const v = ventanaComparable(todayMx());

  // ── Los canales, de sus dos catálogos ────────────────────────────────────────────────────
  const canales: CanalCrudo[] = [];
  const excluidos: Record<MeCanalGrupo, { label: string; motivo: string }[]> = {
    tienda: [],
    ruta: [],
  };

  if (grupos.includes('tienda')) {
    const tiendas = await knex('commercial.warehouses')
      .where({ tenant_id: tenantId, zone_id: ficha.zona_id })
      .whereNull('deleted_at')
      .orderBy('code')
      .select('id', 'code', 'name');
    for (const t of tiendas) {
      canales.push({ id: t.code, label: `${t.code} · ${t.name}`, warehouse_id: t.id, grupo: 'tienda' });
    }
  }

  if (grupos.includes('ruta')) {
    /*
     * `[JZ.2]` La vista ya trae el puente normalizado y —lo importante— ya marcó lo que NO se
     * puede resolver. Acá sólo se respeta esa marca: `ambigua` y `sin_almacen` se declaran.
     */
    const rutas = await knex('analytics.v_route_warehouse')
      .where({ tenant_id: tenantId, zona_id: ficha.zona_id })
      .orderBy('route_label')
      .select('route_label', 'warehouse_id', 'warehouse_code', 'sin_almacen', 'ambigua');
    for (const r of rutas) {
      if (r.ambigua) {
        excluidos.ruta.push({
          label: r.route_label,
          motivo: 'otra zona reclama la misma clave de ruta: sumarla la contaría dos veces',
        });
        continue;
      }
      if (r.sin_almacen || !r.warehouse_id) {
        excluidos.ruta.push({
          label: r.route_label,
          motivo: 'está en el catálogo de la zona y no tiene almacén que venda',
        });
        continue;
      }
      canales.push({
        id: r.warehouse_code,
        label: r.route_label,
        warehouse_id: r.warehouse_id,
        grupo: 'ruta',
      });
    }
  }

  // ── La venta, en UNA consulta sobre los uuid ya resueltos ────────────────────────────────
  const medidas = new Map<string, Medida>();
  if (canales.length > 0) {
    const filas = await knex('analytics.sales_daily')
      .where('tenant_id', tenantId)
      .whereIn('warehouse_id', canales.map((c) => c.warehouse_id))
      .whereBetween('sale_date', [v.desde_comparado, v.hasta])
      .groupBy('warehouse_id')
      .select(
        'warehouse_id',
        knex.raw('sum(revenue) filter (where sale_date between ? and ?) as mtd', [v.desde, v.hasta]),
        knex.raw('sum(revenue) filter (where sale_date between ? and ?) as prev', [
          v.desde_comparado,
          v.hasta_comparado,
        ]),
        knex.raw('max(sale_date) as ultima'),
      );
    for (const f of filas as { warehouse_id: string; mtd: string | null; prev: string | null; ultima: Date | string | null }[]) {
      medidas.set(f.warehouse_id, {
        // `null` se preserva: "no hubo ninguna fila" no es "vendió cero".
        monto: f.mtd === null ? null : Number(f.mtd),
        comparado: f.prev === null ? null : Number(f.prev),
        ultima: f.ultima ? new Date(f.ultima).toISOString().slice(0, 10) : null,
      });
    }
  }

  /*
   * ⚠️ La última venta se busca SIN tope de fechas y sólo para los canales que el tramo no pudo
   * medir. Es el dato que convierte «−100 %» en «sin venta desde el 12-ago», y por definición
   * está FUERA de la ventana: preguntarlo dentro devolvería `null` otra vez.
   */
  const mudos = canales.filter((c) => (medidas.get(c.warehouse_id)?.monto ?? null) === null);
  if (mudos.length > 0) {
    const ult = await knex('analytics.sales_daily')
      .where('tenant_id', tenantId)
      .whereIn('warehouse_id', mudos.map((c) => c.warehouse_id))
      // ⛔ Tope en hoy: `sales_daily` tiene filas fechadas en el FUTURO (medido: 4 del
      // 6-dic-2026, canal `wincaja_ruta`). Sin el tope, «última venta» diría diciembre.
      .where('sale_date', '<=', v.hasta)
      .groupBy('warehouse_id')
      .select('warehouse_id', knex.raw('max(sale_date) as ultima'));
    for (const f of ult as { warehouse_id: string; ultima: Date | string | null }[]) {
      const prev = medidas.get(f.warehouse_id) ?? { monto: null, comparado: null, ultima: null };
      medidas.set(f.warehouse_id, {
        ...prev,
        ultima: f.ultima ? new Date(f.ultima).toISOString().slice(0, 10) : null,
      });
    }
  }

  // ── Armado ───────────────────────────────────────────────────────────────────────────────
  const permisos = ctx.permisos ?? {};
  const bloques: MeZonaBloque[] = [];

  for (const grupo of grupos) {
    const d = DESTINO[grupo];
    const abre = ctx.esAdmin || permisos[d.permiso] === true;
    const filas: MeCanal[] = canales
      .filter((c) => c.grupo === grupo)
      .map((c) => {
        const m = medidas.get(c.warehouse_id) ?? { monto: null, comparado: null, ultima: null };
        const sin_medir =
          m.monto !== null
            ? null
            : m.ultima
              ? `sin venta registrada desde el ${fechaCorta(m.ultima)}`
              : 'nunca registró una venta';
        return {
          id: c.id,
          label: c.label,
          detalle:
            m.comparado !== null
              ? `contra ${Math.round(m.comparado).toLocaleString('es-MX')} del mismo tramo`
              : 'sin tramo comparable el mes pasado',
          grupo,
          monto: m.monto,
          comparado: m.comparado,
          variacion_pct: variacionPct(m.monto, m.comparado),
          ultima_venta: m.ultima,
          sin_medir,
          ruta: abre ? d.ruta : null,
          queryParams: abre ? paramsDe(grupo, c.id) : null,
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
      peso: null, // se completa abajo, cuando el total de la zona existe
      canales: filas.sort(ordenCanal),
      excluidos: excluidos[grupo],
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
  // El canal de más peso primero: es el que explica el titular. Lo no medido, al final.
  bloques.sort((a, b) => (b.monto ?? -1) - (a.monto ?? -1));

  return {
    zona: {
      zona: ficha.zona_name,
      desde: v.desde,
      hasta: v.hasta,
      desde_comparado: v.desde_comparado,
      hasta_comparado: v.hasta_comparado,
      monto,
      comparado,
      variacion_pct: variacionPct(monto, comparado),
      no_comparado,
      bloques,
    },
    motivo: null,
  };
}

/**
 * Los params que aterrizan la pantalla filtrada.
 *
 * ⚠️ `/comercial/ventas-por-ruta` los lee desde `[JZ.1]` (`?route=`/`?branch=`/`?year=`).
 * `/tienda/live` NO lee ninguno todavía — se acota sola por el alcance del usuario
 * (`scopedWarehouse`), así que mandarle un param sería inventar un contrato que la pantalla no
 * tiene. Por eso `tienda` devuelve `null` y no un `?branch=` que nadie leería.
 */
function paramsDe(grupo: MeCanalGrupo, id: string): Record<string, string> | null {
  return grupo === 'ruta' ? { route: id } : null;
}

/** Lo que no se pudo medir va al final: una fila sin cifra no compite con una que sí la tiene. */
function ordenCanal(a: MeCanal, b: MeCanal): number {
  if ((a.monto === null) !== (b.monto === null)) return a.monto === null ? 1 : -1;
  return (b.monto ?? 0) - (a.monto ?? 0);
}
