/**
 * `[GX.79]` — **Cuánto puede pesar un archivo de evidencia de un gasto.**
 *
 * Pedido del usuario (2026-10-09): el tope era 10 MB y se queda corto — un PDF escaneado de
 * varias hojas o la foto de un celular nuevo lo pasan. Sube a **20 MB**.
 *
 * ⚠️ El número vive UNA vez acá porque lo revisan tres lugares y basta con que uno se quede atrás
 * para que el archivo rebote con un error que no dice por qué:
 *
 *  · la **pantalla** (Levantar vale y el diálogo de evidencia) — rechaza antes de mandar;
 *  · la **API**: el archivo viaja en base64 dentro de un JSON, que pesa ~4/3 del archivo. El
 *    parser de `/api/finance/expenses/proofs` (`apps/api/src/main.ts`) tiene que aceptar eso;
 *  · el **proxy** (`nginx.conf`, `client_max_body_size`) — igual.
 *
 * El candado `limite-archivo-gasto.spec.ts` lee los dos últimos y falla si no alcanzan.
 */
export const MAX_ARCHIVO_GASTO_MB = 20;
export const MAX_ARCHIVO_GASTO_BYTES = MAX_ARCHIVO_GASTO_MB * 1024 * 1024;

/**
 * Cuánto pesa el cuerpo JSON que lleva un archivo de `bytes`: el base64 (4 caracteres por cada
 * 3 bytes) más un margen para el prefijo `data:…;base64,` y los demás campos.
 */
export function bytesDelCuerpoConArchivo(bytes: number): number {
  return Math.ceil(bytes / 3) * 4 + 64 * 1024;
}
