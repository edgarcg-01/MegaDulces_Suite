import type { IScannerControls } from '@zxing/browser';

/**
 * `[VTK.17]` **Leer un código de barras con la cámara del teléfono — la lógica, una sola vez.**
 *
 * Vivía en `apps/view/src/app/shared/util/lector-camara.util.ts` (los dos apagados) y el cableado
 * de zxing estaba copiado en cuatro componentes de esa app (levantamiento/caducidades, andén,
 * verificador, conteo). La app de vendedores lo necesita para el checador de precios y para el
 * buscador de Tomar pedido, y una app Nx no puede importar de otra: o se movía acá o salía la
 * copia número cinco.
 *
 * ⚠️ Se comparte la LÓGICA y no el componente, por la misma razón que la firma (`[CG.66]`): el repo
 * no tiene ninguna librería que hospede componentes de Angular y `ui-web` es `type:util`. La
 * cáscara (botón + capa con el video) se repite por app, y eso queda DECLARADO como deuda.
 *
 * ⭐ zxing se carga **al tocar el botón** (`import()` dinámico), no con la pantalla: pesa más que
 * cualquier pantalla del vendedor y en Tomar pedido la cámara es la excepción, no el camino.
 * Sin señal sigue funcionando: el service worker de la app ya guardó todos los `.js` al instalar.
 */

/**
 * **Apagar la cámara de un lector de códigos (`@zxing/browser`) sin dejar un rechazo suelto.**
 *
 * zxing 0.2 tiene dos `stop()`. Sin linterna es síncrono. CON linterna —casi todo celular— es una
 * promesa: corta la cámara y después intenta apagar la linterna sobre la pista ya cortada, y eso se
 * RECHAZA. Un `try { controles.stop() } catch {}` no ve ese rechazo: queda suelto, el manejador global
 * lo atrapa y sale «Algo falló en esta pantalla» con cada código leído. *Medido en prod el 2026-11-03
 * (NP.7): el aviso caía 177 ms antes de que el servidor creara la ficha escaneada.*
 */
export function detenerLector(controles: Pick<IScannerControls, 'stop'> | null | undefined): void {
  try {
    const cierre: unknown = controles?.stop();
    if (cierre && typeof (cierre as PromiseLike<unknown>).then === 'function') {
      (cierre as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch { /* la cámara ya estaba cerrada */ }
}

/**
 * Lo que devuelve `decodeFromConstraints` llega DESPUÉS de esperar el permiso y la cámara. Si en ese
 * lapso la persona tocó «Cancelar», el cierre no tenía nada que detener y la cámara se quedaba prendida
 * y leyendo detrás de la pantalla. Esto la apaga en cuanto llega si ya no hace falta.
 */
export function controlesSiSigueAbierta<T extends Pick<IScannerControls, 'stop'>>(controles: T, sigueAbierta: boolean): T | undefined {
  if (sigueAbierta) return controles;
  detenerLector(controles);
  return undefined;
}

/**
 * ¿Este navegador puede pedir la cámara? `getUserMedia` sólo existe en contexto seguro (HTTPS o
 * localhost): servido por http de la LAN, el botón tiene que decir por qué no abre, no quedarse mudo.
 */
export function camaraDisponible(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined =
  typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function';
}

/** Lo que se dice cuando el navegador ni siquiera ofrece la cámara. */
export const TEXTO_SIN_ACCESO_A_CAMARA = 'Este navegador no da acceso a la cámara. Escribe el código o el nombre.';

/**
 * Por qué no abrió la cámara, en palabras de quien la usa. El error de `getUserMedia` es un
 * `DOMException` con nombre estándar; cualquier otro caso se dice sin inventar la causa.
 */
export function motivoSinCamara(e: unknown): string {
  const nombre = (e as { name?: unknown } | null)?.name;
  switch (nombre) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'No se dio permiso para usar la cámara. Puedes escribir el código o el nombre; para usarla, permítela en los ajustes del navegador.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Este teléfono no tiene una cámara disponible. Escribe el código o el nombre.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'La cámara la está usando otra aplicación. Ciérrala e intenta de nuevo, o escribe el código.';
    default:
      return 'No se pudo abrir la cámara. Escribe el código o el nombre.';
  }
}

/** La cámara trasera, en buena resolución: los códigos de dulce son chicos. */
export const RESTRICCIONES_CAMARA: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

/** Lo que hace falta de zxing. Se inyecta en las pruebas; en la app se carga al tocar el botón. */
export interface ModulosZxing {
  browser: Pick<typeof import('@zxing/browser'), 'BrowserMultiFormatReader'>;
  library: Pick<typeof import('@zxing/library'), 'BarcodeFormat' | 'DecodeHintType'>;
}

async function cargarZxing(): Promise<ModulosZxing> {
  const [browser, library] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
  return { browser, library };
}

/**
 * Abre la cámara sobre `video` y llama `alLeer` con cada código leído (ya sin espacios).
 *
 * Sólo formatos de producto (EAN/UPC, Code 128 de las claves internas, ITF de las cajas): menos
 * trabajo por intento, engancha antes. La promesa se RECHAZA con el error de `getUserMedia` si no
 * hay permiso o cámara — quien llama lo traduce con `motivoSinCamara`.
 */
export async function abrirLectorCodigos(
  video: HTMLVideoElement,
  alLeer: (codigo: string) => void,
  cargar: () => Promise<ModulosZxing> = cargarZxing,
): Promise<IScannerControls> {
  const { browser, library } = await cargar();
  const { BarcodeFormat, DecodeHintType } = library;
  const hints = new Map<unknown, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.ITF,
  ]);
  const lector = new browser.BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 100 });
  return lector.decodeFromConstraints(RESTRICCIONES_CAMARA, video, (r) => {
    const codigo = r?.getText()?.trim();
    if (codigo) alLeer(codigo);
  });
}
