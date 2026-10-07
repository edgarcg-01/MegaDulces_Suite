/**
 * El motivo de un error HTTP cuando la petición se hizo con `responseType: 'blob'`.
 *
 * Con `blob`, Angular entrega el cuerpo del error **también como Blob**: el `message` del
 * backend (`«la solicitud 0009678 no está dentro de tu alcance»`) viene adentro, y quien
 * lee `e.error.message` recibe `undefined`. Sin esto la pantalla sólo puede decir «no se
 * pudo» — que fue justo lo que pasó con el «Expediente PDF» de `/finanzas/expediente`
 * (`[GX.70]`): un 404 de alcance llegaba como un error mudo.
 *
 * Nació privado en `comercial-documentos` (la guía de embarque); se sube acá para que el
 * segundo y tercer uso no sean copias.
 *
 * Nunca lanza: si el cuerpo no es JSON o no trae `message`, devuelve `fallback`.
 */
export async function mensajeDeErrorBlob(e: unknown, fallback = 'Intenta de nuevo.'): Promise<string> {
  try {
    const err = (e as { error?: unknown })?.error;
    const cuerpo = err instanceof Blob ? await textoDe(err) : null;
    const json = cuerpo ? JSON.parse(cuerpo) : err;
    const m = (json as { message?: string | string[] } | null)?.message;
    const texto = Array.isArray(m) ? m.join(' · ') : m;
    return texto ? String(texto) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * `Blob.text()` donde exista; si no, `FileReader`. jsdom (el entorno de las pruebas) no trae
 * `text()`, y sin este respaldo el lector caía siempre al `fallback` en las pruebas: una
 * prueba verde que no probaba nada.
 */
function textoDe(b: Blob): Promise<string> {
  if (typeof (b as { text?: unknown }).text === 'function') return b.text();
  return new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result ?? ''));
    r.onerror = () => mal(r.error);
    r.readAsText(b);
  });
}
