/**
 * `[GX.68]` — **Quién puede abrir el expediente de un vale, y de quién.**
 *
 * `GET /finance/expenses/proofs/:id` es el endpoint que trae el expediente **con sus
 * archivos**: es por donde se ve la evidencia. Hasta hoy exigía `FINANCE_EXPENSES_VER` y
 * nada más — el **único read del módulo** que no aceptaba también `CAPTURAR` ni `COMPROBAR`
 * (todos los demás —`mine`, `resumen`, `proof-by-folio`, `calendario`, el alta, `upload` y
 * hasta `POST :id/evidence`— aceptan `VER` **o** `CAPTURAR`).
 *
 * ## ⛔ Lo que costaba, medido
 * En la base local: **11 roles tienen `CAPTURAR` y no `VER`** → **76 usuarios**, entre ellos
 * `captura_gastos`, `cajero`, `encargado_tienda`, `prevencion` y `supervisor_ventas`. O sea
 * que **justo quien levanta el vale recibía 403 al abrir su propia evidencia**.
 *
 * El código ya lo sabía: `expense-proofs.service.ts` lo documenta desde `[GX.48]` —*«quien
 * captura es cajero, no tiene `FINANCE_EXPENSES_VER` y el detalle le da 403 — si viviera
 * allá, justo el dueño del vale nunca la vería»*— y lo esquivó moviendo **un** dato al
 * listado. El agujero del endpoint quedó abierto.
 *
 * ## ⚠️ Abrir el permiso sin ALCANCE sería ensanchar la puerta, no arreglarla
 * Dejar entrar a `CAPTURAR` a secas le daría los comprobantes de toda la empresa a 76
 * personas. Por eso son dos preguntas distintas y esta función contesta la primera:
 *
 *   1. ¿Puede ver el expediente de **cualquiera**?  → esta función
 *   2. Si no, ¿este vale es **suyo**?               → `esDuenoDelVale()`, que ya existe
 *
 * Es el mismo criterio que `GET /mine` aplica desde siempre: *«abrir la bandeja completa a
 * quien sólo captura le daría los comprobantes de toda la empresa»*.
 *
 * ## ⛔ El rol de plataforma va APARTE del mapa de permisos, y no es un detalle
 * `RolesGuard` deja pasar a admin/superadmin **aunque no tengan la clave**. Si acá se mirara
 * sólo `permissions`, un superadmin sin la clave explícita entraría por el guard y después
 * quedaría acotado a «sus» vales — vería el expediente vacío en vez de un error, que es la
 * peor de las dos fallas. Se resuelve por nombre de rol, como manda ADR-054.
 */

import type { IdentidadQueDecide } from './dueno-del-vale.contract';

/** Las claves que habilitan ver el expediente de cualquiera. Literales: este archivo es
 *  contrato y no puede importar el enum de `platform-core` (la dependencia va al revés). */
export const PERMISOS_VEN_CUALQUIER_EXPEDIENTE = Object.freeze([
  'FINANCE_EXPENSES_VER',
  'FINANCE_EXPENSES_COMPROBAR',
] as const);

/** Lo que se sabe de quien abre el expediente. Es la forma del token, nada más. */
export interface QuienAbreExpediente extends IdentidadQueDecide {
  role_name?: string | null;
  permissions?: Record<string, boolean> | null;
}

/**
 * ¿Puede abrir el expediente de **cualquier** vale?
 *
 * `esAdminDePlataforma` se inyecta en vez de importarse: la lista de roles de plataforma vive
 * en `platform-core`, y `libs/contracts` no depende de ahí. Quien llama pasa
 * `isPlatformAdminRole`; así el criterio sigue teniendo **un** dueño (ADR-056) y esta función
 * se puede probar sin arrastrar medio monorepo.
 */
export function puedeVerCualquierExpediente(
  quien: QuienAbreExpediente | null | undefined,
  esAdminDePlataforma: (rol?: string | null) => boolean = () => false,
): boolean {
  if (!quien) return false;
  if (esAdminDePlataforma(quien.role_name ?? null)) return true;
  const p = quien.permissions;
  if (!p) return false;
  // ⚠️ `=== true` y no un truthy: una clave en `false` —que es como quedan las claves nuevas
  // del enum al guardar el mapa completo desde /admin/roles— no puede abrir nada.
  return PERMISOS_VEN_CUALQUIER_EXPEDIENTE.some((k) => p[k] === true);
}

/**
 * La frase para quien pide un vale ajeno teniendo sólo `CAPTURAR`.
 *
 * ⚠️ Dice **qué pasó y qué hacer**, no «prohibido» a secas — y sobre todo **no invita a
 * reintentar**: un permiso no se arregla reintentando, que es la lección de `[GX.37]` que el
 * repo ya aprendió del lado del almacenamiento.
 */
export const MENSAJE_EXPEDIENTE_AJENO =
  'Este vale no es tuyo. Podés abrir los que vos levantaste o los que comprobaste; '
  + 'para ver los de otras personas hace falta permiso de ver gastos.';
