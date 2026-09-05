// Token de inyección en su propio archivo, no en el módulo: evita el import
// circular módulo↔servicio (mismo patrón que kepler-consolidado.constants.ts
// en apps/api/src/modules/kepler-consolidado/).
export const KNEX_PLATFORM = 'KNEX_PLATFORM';

/**
 * Schema del espejo crudo de Kepler dentro de `postgres_platform`.
 *
 * Antes este app leía `kp.*` en la base `KP_CONCENTRADA`. Las dos tienen la
 * MISMA forma — `concentrate-kepler.js` arma `kp.<tabla>` como todas las
 * sucursales `md.*` más una columna `sucursal`, que es exactamente lo que
 * `replicate-ods-live.js` deja en `kepler_ods.<tabla>` — pero `KP_CONCENTRADA`
 * es una copia con su propio ETL y el ODS es la fuente canónica del proyecto
 * (regla #1: cero copias, todo del ODS). Ver el review del PR #62.
 *
 * La única diferencia de forma: `kp.*` traía además `_loaded_at` (que este app
 * nunca leyó) y la tabla de control `kp.sync_control`, que en el ODS no existe
 * — su reemplazo es `analytics.cron_runs` (heartbeat del CDC).
 */
export const ODS = 'kepler_ods';

/**
 * Tenant de Mega Dulces. Este app no es multi-tenant (es el catálogo de una sola
 * empresa), pero `catalog.products` y `analytics.*` en `postgres_platform` SÍ lo
 * son y tienen RLS: leerlas exige `SET LOCAL app.tenant_id` en la misma
 * transacción. Sin eso la consulta no falla — devuelve **cero filas**, que es
 * peor, porque parece "no hay datos" en vez de "no tenés contexto".
 */
export const TENANT_ID =
  process.env.CATALOGO_KP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

/**
 * ⚠️ **Sucursal del catálogo — PENDIENTE DE CONFIRMAR CONTRA DATOS.**
 *
 * `kepler_ods.kdii` (y `kdig`, `kdik`, …) traen una fila por producto **y por
 * sucursal**: el mismo código existe 6-7 veces, una por cada Kepler de sucursal.
 * `KP_CONCENTRADA.kp.kdii` tenía exactamente la misma forma, así que las
 * consultas portadas —que no filtran sucursal— ya se comportaban así antes de
 * este cambio; el repunte NO lo introduce.
 *
 * Por eso el default es `null` = **no filtrar**, que reproduce al pie de la
 * letra lo que hace la versión que hoy corre en `.163`. Un cambio de semántica
 * en el camino del PRECIO no se hace a ciegas: hay que mirar la data primero
 * (¿cuántas filas por código hay realmente?, ¿los precios difieren entre
 * sucursales?) y recién ahí decidir.
 *
 * Cuando esté decidido, se setea `CATALOGO_KP_SUCURSAL` (ej. `03`) y todas las
 * lecturas del catálogo quedan acotadas a esa sucursal, sin tocar código.
 *
 * (`catalogo.service.ts` ya tiene su propia `SUC_CANONICA = '03'` para las
 * consultas por sucursal explícita — esto es para las que hoy no filtran nada.)
 */
export const SUC_CATALOGO: string | null =
  process.env.CATALOGO_KP_SUCURSAL?.trim() || null;

/** `AND <col> = 'NN'` cuando hay sucursal configurada; cadena vacía si no. */
export function filtroSucursal(col = 'sucursal'): string {
  return SUC_CATALOGO ? ` AND ${col} = '${SUC_CATALOGO.replace(/'/g, "''")}'` : '';
}
