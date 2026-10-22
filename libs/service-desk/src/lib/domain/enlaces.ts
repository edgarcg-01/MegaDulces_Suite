/**
 * `[MS.ADJ.1.6]` Enlaces a documentos de Google (Docs, Hojas, Presentaciones, Formularios, Drive) como adjunto.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────────
 * Decisión D1 (`FASE_MS_ADJUNTOS`): «cualquier archivo» NO se abre; los documentos de trabajo de la gente viven en
 * Google Drive y se COMPARTEN, no se adjuntan. El enlace es la salida honesta para lo que la lista cerrada no deja
 * subir, y evita copiar a nuestro bucket un archivo que ya tiene dueño y permisos.
 *
 * ── Qué se acepta y qué NO ──────────────────────────────────────────────────────────────────────
 * SÓLO `https://docs.google.com/{document|spreadsheets|presentation|forms}/…/d/<id>` y
 * `https://drive.google.com/{file/d/<id>|drive/folders/<id>|open?id=<id>}`. El host debe ser EXACTAMENTE uno de esos dos
 * (nada de `docs.google.com.evil.com`, ni `docs.google.com@evil.com`, ni subdominios, ni puertos), sólo https, sin
 * usuario/contraseña, sin espacios ni caracteres de control. Lo demás se tira: del enlace se guarda
 * `origen + ruta` y, si hace falta para abrirlo, `resourcekey` (Drive) o `id` (`/open`); se descartan `usp=sharing`,
 * `authuser`, el `#fragmento` y cualquier otro parámetro.
 *
 * ⚠️ NUNCA se pide la URL desde el servidor (ni para vista previa ni para validar permisos): sería un SSRF.
 * ⚠️ Un enlace NO prueba que quien atiende pueda abrirlo: eso depende de cómo se compartió (se avisa en pantalla).
 *
 * Función pura: sin red.
 */
export type TipoEnlace = 'documento' | 'hoja' | 'presentacion' | 'formulario' | 'archivo' | 'carpeta';

export type ResultadoEnlace = { ok: true; url: string; tipo: TipoEnlace; id: string; host: 'docs.google.com' | 'drive.google.com' } | { ok: false; motivo: string };

export const MAX_ENLACES_POR_ENVIO = 3;
const MAX_LARGO = 500;
const ID = '([A-Za-z0-9_-]{10,200})';
const SEG = '(?:/u/\\d{1,2})?'; // `/u/0/` de las cuentas múltiples

const COLAS = new Set(['/edit', '/view', '/preview', '/viewform', '/pub', '/htmlview']);

const RUTAS: { host: 'docs.google.com' | 'drive.google.com'; re: RegExp; tipo: TipoEnlace }[] = [
  { host: 'docs.google.com', re: new RegExp(`^/document${SEG}/d/${ID}(?:/|$)`), tipo: 'documento' },
  { host: 'docs.google.com', re: new RegExp(`^/spreadsheets${SEG}/d/${ID}(?:/|$)`), tipo: 'hoja' },
  { host: 'docs.google.com', re: new RegExp(`^/presentation${SEG}/d/${ID}(?:/|$)`), tipo: 'presentacion' },
  { host: 'docs.google.com', re: new RegExp(`^/forms${SEG}/d/(?:e/)?${ID}(?:/|$)`), tipo: 'formulario' },
  { host: 'drive.google.com', re: new RegExp(`^/file${SEG}/d/${ID}(?:/|$)`), tipo: 'archivo' },
  { host: 'drive.google.com', re: new RegExp(`^/drive${SEG}/folders/${ID}(?:/|$)`), tipo: 'carpeta' },
];

export const ETIQUETA_ENLACE: Record<TipoEnlace, string> = {
  documento: 'Documento de Google',
  hoja: 'Hoja de cálculo de Google',
  presentacion: 'Presentación de Google',
  formulario: 'Formulario de Google',
  archivo: 'Archivo de Drive',
  carpeta: 'Carpeta de Drive',
};

export function normalizarEnlaceGoogle(entrada: string | null | undefined): ResultadoEnlace {
  const crudo = String(entrada ?? '').trim();
  if (!crudo) return { ok: false, motivo: 'El enlace está vacío' };
  if (crudo.length > MAX_LARGO) return { ok: false, motivo: `El enlace es demasiado largo (máximo ${MAX_LARGO} caracteres)` };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(crudo)) return { ok: false, motivo: 'El enlace no puede llevar espacios ni caracteres de control' };

  let u: URL;
  try {
    u = new URL(crudo);
  } catch {
    return { ok: false, motivo: 'No parece un enlace válido (debe empezar con https://)' };
  }
  if (u.protocol !== 'https:') return { ok: false, motivo: 'El enlace debe ser https://' };
  if (u.username || u.password) return { ok: false, motivo: 'El enlace no puede llevar usuario ni contraseña' };
  if (u.port) return { ok: false, motivo: 'El enlace no puede indicar un puerto' };
  const host = u.hostname.toLowerCase();
  if (host !== 'docs.google.com' && host !== 'drive.google.com') {
    return { ok: false, motivo: 'Sólo se aceptan enlaces de Google Docs, Hojas, Presentaciones, Formularios o Drive (docs.google.com / drive.google.com)' };
  }

  // `drive.google.com/open?id=<id>` — el id viaja en la consulta.
  if (host === 'drive.google.com' && u.pathname === '/open') {
    const id = u.searchParams.get('id') ?? '';
    if (!new RegExp(`^${ID}$`).test(id)) return { ok: false, motivo: 'El enlace de Drive no trae un identificador válido' };
    return { ok: true, url: `https://drive.google.com/open?id=${id}`, tipo: 'archivo', id, host };
  }

  for (const r of RUTAS) {
    if (r.host !== host) continue;
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    const id = m[1];
    const rk = host === 'drive.google.com' ? u.searchParams.get('resourcekey') : null;
    const query = rk && /^[A-Za-z0-9_-]{4,64}$/.test(rk) ? `?resourcekey=${rk}` : '';
    // Se conserva hasta el id y, si acaso, UNA cola conocida (`/edit`, `/view`…): cualquier otra cosa en la ruta se descarta.
    const finId = u.pathname.indexOf(id) + id.length;
    const cola = u.pathname.slice(finId).replace(/\/+$/, '');
    const ruta = u.pathname.slice(0, finId) + (COLAS.has(cola) ? cola : '');
    return { ok: true, url: `https://${host}${ruta}${query}`, tipo: r.tipo, id, host };
  }
  return { ok: false, motivo: 'Ese enlace de Google no apunta a un documento, hoja, presentación, formulario, archivo o carpeta (copia el enlace desde «Compartir»)' };
}
