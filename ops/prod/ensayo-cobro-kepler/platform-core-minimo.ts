/**
 * `[CC.35]` Lo poquito de `@megadulces/platform-core` que usa el adaptador del cobro.
 *
 * ⛔ Existe sólo para EMPAQUETAR el ensayo. El índice real del dominio arrastra NestJS entero y el
 * contenedor del ensayo corre `node` pelón. Acá se re-exporta por ruta profunda, sin tocar el adaptador:
 * el código de producción sigue importando por su alias, como debe.
 */
export { reservarFolioKepler } from '../../../libs/platform-core/src/lib/kepler/kepler-folio';
export { urlDeServidor } from '../../../libs/platform-core/src/lib/kepler/kepler-servidor';
export type { Env } from '../../../libs/platform-core/src/lib/kepler/kepler-servidor';
