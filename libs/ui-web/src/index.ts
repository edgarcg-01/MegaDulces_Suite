export { installNumberWheelGuard } from './number-wheel-guard';

/**
 * `[CG.66]` La firma sobre un canvas. Vivía DENTRO del componente de entregas del repartidor
 * (en producción, Fase LM) y traía **cuatro defectos medidos ahí**: un toque contaba como firma,
 * redimensionar la borraba en silencio, en un teléfono salía borrosa (ignoraba
 * `devicePixelRatio`) y el PNG salía con fondo transparente.
 *
 * ⚠️ Se comparte la LÓGICA y no un componente porque el repo **no tiene ninguna librería que
 * hospede componentes de Angular** (medido: cero `@Component` en `libs/`) y `ui-web` está
 * tagueada `type:util`, que sólo puede depender de `type:util`. La cáscara se repite por app, y
 * eso queda **declarado como deuda**, no disimulado.
 */
export { prepararFirma, MIN_TRAZO } from './firma/firma-canvas';
export type { FirmaCanvas, PuntoFirma } from './firma/firma-canvas';

/**
 * `[CG.74]` Un texto a QR, como SVG. ⚠️ **Sin dependencias nuevas**: `@zxing/browser` ya estaba
 * declarada para ESCANEAR códigos de producto y su `BrowserQRCodeSvgWriter` también genera.
 * Vive acá porque «convertir un texto en un QR» no es de caja: el verificador de precios, las
 * etiquetas de tienda y las guías de logística tienen el mismo problema (ADR-056).
 */
export { qrSvg, pintarQr, QR_LADO_MINIMO } from './qr/qr-svg';

/**
 * `[SEG.2]` Borrar el rastro de la sesion que se va. Vive aca y no en una app porque las tres
 * comparten el problema: el service worker cachea por URL y no mira quien pregunta.
 */
export { limpiarRastroDeSesion, borrarBasesIndexedDb, CLAVES_DEL_APARATO } from './session-cleanup';
export type { RastroLimpiado, OpcionesDeLimpieza } from './session-cleanup';

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

/** `[VTK.9]` Cuanto trae la caja, en las presentaciones del selector. */
export { contenidoCaja, UNIDAD_BASE_SIN_ROTULO } from './order/box-content';
export type { ContenidoCaja, ParteCaja } from './order/box-content';

/**
 * `[KBD.1]` Teclado en tablas. ⛔ NO es una navegación propia: `pSelectableRow` de PrimeNG ya
 * mueve con `↑↓`, `Home`/`End`, `Enter`/`Space` y ya hace roving tabindex. Acá viven los DOS
 * huecos que ese componente deja — la guarda (PrimeNG no mira `event.target`, así que un campo
 * dentro de una fila pierde sus teclas) y el salto buscador→lista.
 */
export { installRowNavGuard, bajarAlPrimerRenglon, volverAlBuscador } from './keyboard/row-nav';
export { installRadioGroupNav } from './keyboard/radio-group-nav';
export { installToolbarNav } from './keyboard/toolbar-nav';

/**
 * `[KBD.2]` Búsqueda tokenizada en el CLIENTE, con la misma semántica que `applySmartSearch` del
 * servidor. Para listas COMPLETAS en memoria (catálogo offline, combos). ⚠️ Sobre una lista
 * paginada filtra sólo la página: ahí el texto va al servidor, no a esta función.
 */
export {
  normalizarBusqueda,
  tokensDeBusqueda,
  coincideBusqueda,
  filtrarPorBusqueda,
} from './search/buscar-en-cliente';

/**
 * `[NP.7.L.8b]` ¿La foto salió borrosa, movida o con el lente sucio? Se mide en el teléfono antes de
 * subir. Umbrales PROVISIONALES hasta calibrarlos con fotos reales del piloto (ver el archivo).
 */
export { medirFoto, juzgarFoto, dimensionesDeMedicion, CALIDAD_VERSION, LADO_MEDICION, UMBRAL_NITIDEZ, UMBRAL_CONTRASTE } from './foto/calidad-foto';
export type { MedicionFoto, VeredictoFoto } from './foto/calidad-foto';

/**
 * `[VTK.17]` Leer un código de barras con la cámara: la lógica de zxing (que se carga al tocar el
 * botón) y los dos apagados que vivían en `apps/view`. La cáscara (botón + capa con el video) se
 * repite por app porque ninguna librería hospeda componentes: deuda declarada en el tracker.
 */
export {
  detenerLector, controlesSiSigueAbierta, camaraDisponible, motivoSinCamara, abrirLectorCodigos,
  RESTRICCIONES_CAMARA, TEXTO_SIN_ACCESO_A_CAMARA,
} from './camara/lector-codigos';
export type { ModulosZxing } from './camara/lector-codigos';

/**
 * `[VTK.17]` (ex `[MOS.1]`) Buscar en el respaldo de precios de Kepler y contar sus presentaciones.
 * Se movió desde `apps/view/.../tienda/mostrador-catalogo.ts` para que el verificador de la tienda y
 * el checador del vendedor usen LA MISMA regla. `Presentacion` sale como `PresentacionMostrador`
 * porque el nombre ya lo usa `order/qty-units` (otra cosa: la escalera de captura).
 */
export {
  presentacionesDe, unidadesDelRespaldo, unidadDelCodigo, escalonesDe, tramoNormal,
  aBuscable, buscarEnCatalogo, productosPorCodigo, singularDe, pluralDe, nombreDe, ETIQUETA_CAMPO,
} from './precios/catalogo-mostrador';
export type {
  RenglonRespaldo, TramoMayoreo, UnidadConFactor, Escalon, CampoCoincidencia, Buscable, Coincidencia,
  Presentacion as PresentacionMostrador,
} from './precios/catalogo-mostrador';
