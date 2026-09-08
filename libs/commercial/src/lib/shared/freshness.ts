/**
 * [VP.2.2] El primitivo de procedencia se MUDÓ a `@megadulces/platform-core`
 * (`libs/platform-core/src/lib/provenance/freshness.ts`). Este archivo queda como re-export para no
 * tocar los consumidores que ya lo importaban por esta ruta.
 *
 * ── POR QUÉ SE MUDÓ ──────────────────────────────────────────────────────────────────────
 * ADR-056 pide que un primitivo genérico viva en `libs/` compartido. Vivía en `libs/commercial`,
 * que es un DOMINIO, no algo compartido — y eso se volvió un bloqueo concreto: el briefing de Horus
 * (`libs/trade`) necesitaba declarar su frescura, y `libs/trade` **no depende de**
 * `@megadulces/commercial` a propósito (Horus se construyó separado del motor comercial). Las dos
 * salidas eran acoplar dos dominios o copiar la lógica por tercera vez; las dos malas.
 *
 * `platform-core` ya es dependencia de los dos, así que es el lugar que el primitivo debió tener
 * desde el principio. La FORMA ya vivía en `@megadulces/contracts` desde VP.2.1; ahora la LÓGICA
 * también está fuera del dominio.
 *
 * Se re-exportan sólo los nombres del primitivo — no un `export *` del paquete entero, que
 * arrastraría todo `platform-core` a cualquiera que importe esta ruta.
 */
export {
  ageHuman,
  evalInput,
  composeFreshness,
  FRESHNESS_UNKNOWN,
  laneAt,
  tableAt,
} from '@megadulces/platform-core';
export type { Freshness, FreshnessInput, FreshnessStatus } from '@megadulces/contracts';
