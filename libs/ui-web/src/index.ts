export { installNumberWheelGuard } from './number-wheel-guard';

/**
 * `[SEG.2]` Borrar el rastro de la sesion que se va. Vive aca y no en una app porque las tres
 * comparten el problema: el service worker cachea por URL y no mira quien pregunta.
 */
export { limpiarRastroDeSesion, CLAVES_DEL_APARATO } from './session-cleanup';
export type { RastroLimpiado } from './session-cleanup';

/**
 * `[COT.1b]` Aritmetica de la captura por presentacion (pieza / paquete / caja).
 *
 * Vivia en `apps/vendor/src/app/core/order/` con UN solo importador. Una app Nx no puede
 * importar de otra app, asi que la pantalla de cotizaciones (en `apps/view`) no la alcanzaba
 * y habria terminado en la copia numero 12 de un stepper. Medido antes de mover: 11
 * implementaciones de stepper en 10 archivos, cero compartidas entre apps.
 *
 * Se movio entera CON su spec (11 candados). Mover sin el spec habria dejado la invariante
 * `lo que se VE x factor = lo que se PIDE` sin quien la sostenga.
 */
export {
  escalera,
  rotuloCrudo,
  hayEleccion,
  factorDe,
  conteoExacto,
  subirEscalon,
  bajarEscalon,
  ajustarARejilla,
} from './order/qty-units';
export type { Presentacion } from './order/qty-units';
