/**
 * Optimización de imágenes Cloudinary vía URL (Fase 4 — data-light).
 *
 * Inserta transformaciones después de `/upload/`:
 *   - f_auto: formato moderno (AVIF/WebP) según el navegador.
 *   - q_auto: calidad automática (menos bytes, sin pérdida visible).
 *   - c_limit,w_<N>: redimensiona a lo ancho del contenedor SIN agrandar.
 *   - dpr_auto: sirve 2x/3x en pantallas retina automáticamente.
 *
 * El catálogo trae imágenes Cloudinary a tamaño completo; servirlas a ~400px
 * en las tarjetas baja drásticamente los bytes (clave para reps con datos
 * limitados). Idempotente y seguro: si la URL no es de Cloudinary o ya trae
 * transformaciones, la devuelve igual.
 */
export function cldImage(url: string | null | undefined, width = 400): string {
  if (!url) return url ?? '';
  const marker = '/upload/';
  const i = url.indexOf(marker);
  if (i === -1) return url; // no es una URL de Cloudinary upload → intacta

  const head = url.slice(0, i + marker.length);
  const tail = url.slice(i + marker.length);
  const firstSeg = tail.split('/')[0] ?? '';
  // Ya optimizada (tiene f_auto o un w_NNN al frente) → no duplicar transforms.
  if (firstSeg.includes('f_auto') || /(^|,)w_\d+/.test(firstSeg)) return url;

  return `${head}f_auto,q_auto,c_limit,w_${width},dpr_auto/${tail}`;
}
