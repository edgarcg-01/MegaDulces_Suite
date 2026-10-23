/**
 * `[MS.ADJ.1.1]` + `[MS.ADJ.1.2]` El NOMBRE con que se guarda y se muestra un adjunto, coherente con lo que el archivo ES.
 *
 * ── Qué corrige ──────────────────────────────────────────────────────────────────────────────────
 * El tipo ya se detecta por firma (`validarAdjunto`), pero el nombre seguía siendo lo que mandó el cliente:
 *   · `foto.exe` con bytes de JPEG se guardaba con la clave `…/<uuid>.exe` (`putBuffer` saca la extensión de la clave del
 *     NOMBRE) y se mostraba como «foto.exe» — medido contra el Garage local el 2026-10-22;
 *   · `factura.pdf.exe` se veía como un PDF a medias;
 *   · los caracteres de dirección Unicode (`U+202E`) invierten lo que se lee: `reporte<RLO>fdp.exe` se ve `reporteexe.pdf`.
 *
 * ── Regla ─────────────────────────────────────────────────────────────────────────────────────────
 *  1. Se quitan los caracteres de dirección y de ancho cero (además de los controles, que ya quitaba `sanitizarNombre`).
 *  2. Se quitan, de derecha a izquierda, las extensiones PELIGROSAS (`.exe`, `.js`, `.lnk`, …).
 *  3. Si la extensión que queda no corresponde al tipo detectado (o no hay), se agrega la del tipo.
 * Así la clave del bucket y el nombre mostrado siempre terminan en lo que el archivo es.
 *
 * Vive aquí y no en `sanitizarNombre` porque ése es un primitivo COMPARTIDO con Reclutamiento: lo que cambia el nombre
 * de un CV no se decide en la Mesa de Servicio. Función pura.
 */

const EXTENSIONES: Record<string, readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/heic': ['heic', 'heif'],
  'application/pdf': ['pdf'],
};

/** Extensiones que no deben figurar al final de un adjunto, aunque el contenido sea una imagen o un PDF. */
const PELIGROSAS = new Set([
  'exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'scr', 'pif', 'lnk', 'url', 'msi', 'msp',
  'dll', 'sys', 'jar', 'apk', 'sh', 'py', 'rb', 'php', 'pl', 'html', 'htm', 'xhtml', 'svg', 'xml', 'reg', 'inf', 'cpl', 'iso', 'img',
  'vhd', 'dmg', 'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'xlsb', 'zip', 'rar', '7z', 'gz', 'tar', 'cab',
]);

/** Dirección de texto (LRM/RLM, LRE…RLO, LRI…PDI), ancho cero y marcas de orden de bytes. */
// Se arma con códigos numéricos: escribirlos literales dejaría caracteres invisibles dentro del código fuente.
const RANGOS_INVISIBLES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f], // ancho cero, LRM, RLM
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2060, 0x2064], // unión de palabras y operadores invisibles
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI
  [0xfeff, 0xfeff], // marca de orden de bytes
];
const INVISIBLES = new RegExp(
  `[${RANGOS_INVISIBLES.map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`).join('')}]`,
  'g',
);

const canonica = (tipo: string): string => EXTENSIONES[tipo]?.[0] ?? 'bin';

export function nombreDeAdjunto(nombre: string, tipo: string): string {
  let base = String(nombre ?? '').replace(INVISIBLES, '').trim();
  if (!base) return `adjunto.${canonica(tipo)}`;

  const ext = (n: string): string => {
    const i = n.lastIndexOf('.');
    return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
  };
  // 2) fuera las extensiones peligrosas del final (`factura.pdf.exe` → `factura.pdf`)
  while (PELIGROSAS.has(ext(base))) base = base.slice(0, base.lastIndexOf('.'));
  if (!base || base === '.') return `adjunto.${canonica(tipo)}`;

  // 3) la extensión que queda tiene que ser la del tipo; si no, se agrega
  const permitidas = EXTENSIONES[tipo] ?? [];
  if (!permitidas.includes(ext(base))) base = `${base}.${canonica(tipo)}`;
  return base;
}
