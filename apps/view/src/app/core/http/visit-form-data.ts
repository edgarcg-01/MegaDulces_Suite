/**
 * Empaquetado multipart/form-data para visitas de /captures.
 *
 * El backend (POST /daily-captures) acepta dos formatos:
 *   - multipart con `payload` (JSON) + file parts `photo_<i>` (preferido)
 *   - application/json con `fotoBase64` dentro de cada exhibición (legacy)
 *
 * Estas utilidades convierten el segundo formato al primero. Vivien en
 * `core/http` para que tanto el flujo online (`DailyCaptureService`) como el
 * sync de visitas offline (`OfflineSyncService`) compartan exactamente la
 * misma serialización sin crear dependencia cruzada entre módulos.
 */

/**
 * Decodifica un data-URI o string base64 a `Blob` con el MIME indicado.
 */
export function base64ToBlob(b64: string, mime = 'image/jpeg'): Blob {
  const cleaned = b64.replace(/^data:image\/\w+;base64,/, '');
  const byteString = atob(cleaned);
  const len = byteString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = byteString.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Convierte un payload con `exhibiciones[].fotoBase64` a un `FormData`:
 *   - field `payload` → JSON sin `fotoBase64`, cada exhibición con foto
 *     gana un campo `_photoField: 'photo_<i>'`.
 *   - file parts `photo_<i>` con la imagen como Blob.
 *
 * Exhibiciones sin foto se pasan tal cual (sin `_photoField`).
 */
export function buildVisitFormData(payload: {
  exhibiciones: Array<Record<string, unknown>>;
  [k: string]: unknown;
}): FormData {
  const fd = new FormData();
  const exhibicionesForJson = payload.exhibiciones.map((ex, i) => {
    const b64 = ex['fotoBase64'] as string | undefined;
    if (!b64) return ex;
    const field = `photo_${i}`;
    const blob = base64ToBlob(b64);
    fd.append(field, blob, `${field}.jpg`);
    // Descartar fotoBase64 del JSON; el _photoField permite al backend
    // mapear la file part de vuelta a la exhibición.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { fotoBase64, ...rest } = ex as any;
    return { ...rest, _photoField: field };
  });
  const jsonPayload = { ...payload, exhibiciones: exhibicionesForJson };
  fd.append('payload', JSON.stringify(jsonPayload));
  return fd;
}
