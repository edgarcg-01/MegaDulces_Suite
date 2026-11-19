/**
 * FISCAL — Registro de listas SAT soportadas por el motor.
 *
 * Cada lista se define por: su(s) URL(s) de CSV público, los nombres de columna
 * candidatos para mapear rfc/nombre/situación (el SAT no es consistente entre
 * listas), y qué situaciones cuentan como RIESGO (para KPIs / severidad).
 *
 * Agregar una lista nueva = una entrada aquí. Cero cambios de schema.
 * URLs override por env (el Art. 69 publica varios CSV por supuesto y el SAT
 * mueve rutas; ver LISTA69_CSV_URLS).
 */
export interface SatListConfig {
  key: string;
  label: string;
  urls: string[];
  /** Nombres de columna candidatos (normalizados sin acento/minúscula, match por 'includes'). */
  cols: { rfc: string[]; nombre: string[]; situacion: string[] };
  /** Situaciones (lowercase) que cuentan como riesgo operativo/deducibilidad. */
  riesgo: string[];
}

const envUrls = (v: string | undefined, fallback: string[]): string[] => {
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

export const SAT_LISTS: Record<string, SatListConfig> = {
  '69B': {
    key: '69B',
    label: 'EFOS — CFF Art. 69-B',
    // [PGP.161] El SAT dejó de actualizar la ruta vieja (`omawww.sat.gob.mx/cifras_sat/...`):
    // medido el 2026-11-19, su archivo decía «actualizada al 31 de diciembre de 2025» y la
    // Suite lo volvía a bajar cada noche, idéntico. La vigente es la de Datos abiertos
    // (AGAFF), mismo formato, «actualizada al 31 de octubre de 2026». Índice estable:
    // sat.gob.mx/minisitio/DatosAbiertos/contribuyentes_publicados.html.
    urls: envUrls(process.env.EFOS_CSV_URL, [
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGAFF/Listado_completo_69-B.csv',
    ]),
    cols: { rfc: ['rfc'], nombre: ['nombre', 'razon'], situacion: ['situacion'] },
    riesgo: ['definitivo', 'presunto'],
  },
  '69': {
    key: '69',
    label: 'CFF Art. 69 — créditos firmes/cancelados/no localizados',
    // El Art. 69 publica varios CSV por supuesto. El SAT los migró a Azure Blob
    // (2025). URLs override por LISTA69_CSV_URLS (coma). VERIFICAR con HEAD antes
    // de confiar en prod: el SAT mueve rutas; lo estable es la página índice
    // sat.gob.mx/minisitio/DatosAbiertos/contribuyentes_publicados.html.
    urls: envUrls(process.env.LISTA69_CSV_URLS, [
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/Firmes.csv',
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/Exigibles.csv',
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/Cancelados.csv',
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/No_localizados.csv',
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/Sentencias.csv',
      'https://wu1agsprosta001.blob.core.windows.net/agsc-publicaciones/Datos_abiertos/Documents_AGR/CSDsinefectos.csv',
    ]),
    cols: {
      rfc: ['rfc'],
      nombre: ['nombre', 'razon', 'contribuyente'],
      // NO 'tipo': matchea la columna "TIPO PERSONA" (F/M) antes que "SUPUESTO"
      // (FIRMES/CANCELADOS/NO LOCALIZADOS/EXIGIBLES/…), que es la situación real del 69.
      situacion: ['supuesto', 'situacion'],
    },
    riesgo: ['firme', 'no localizado', 'exigible', 'sentencia', 'definitivo', 'presunto'],
  },
};

export const listaConfig = (lista: string): SatListConfig => {
  const cfg = SAT_LISTS[lista];
  if (!cfg) throw new Error(`Lista SAT desconocida: ${lista}`);
  return cfg;
};

/**
 * `[PGP.161]` Más de esto, y la lista que el SAT sirve es vieja: casi seguro la movió de ruta.
 * Una lista que se descarga bien cada noche pero dice tener once meses es el caso que pasó.
 */
export const DIAS_LISTA_VIEJA = 60;

const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

/**
 * `[PGP.161]` La fecha que la propia lista dice tener («Información actualizada al 31 de octubre
 * de 2026», primera línea de los CSV del SAT), como `YYYY-MM-DD`. Null si el archivo no la dice:
 * eso se declara, no se supone fresco.
 */
export function fechaDeActualizacion(texto: string): string | null {
  const m = /actualizada al (\d{1,2}) de ([a-záéíóú]+) de (\d{4})/i.exec(texto.slice(0, 2000));
  if (!m) return null;
  const mes = MESES[m[2].toLowerCase()];
  return mes ? `${m[3]}-${mes}-${m[1].padStart(2, '0')}` : null;
}

/**
 * `[PGP.161]` La fecha de los datos de UN archivo: la que dice su texto (la 69-B la trae) o, si no
 * la dice (los CSV del Art. 69 no), su `Last-Modified`. Null si no hay ninguna de las dos.
 */
export function fechaDeLaLista(texto: string, lastModified: string | null | undefined): string | null {
  const delTexto = fechaDeActualizacion(texto);
  if (delTexto) return delTexto;
  const t = lastModified ? Date.parse(lastModified) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Días entre la fecha que dice la lista y `hoy` (`YYYY-MM-DD`). */
export function diasDeAtraso(fechaLista: string, hoy: string): number {
  return Math.round((Date.parse(`${hoy}T12:00:00Z`) - Date.parse(`${fechaLista}T12:00:00Z`)) / 86_400_000);
}

/** RFC genérico "público en general" / extranjeros — se marca como issue, no como proveedor real. */
export const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);

/** Estructura de RFC persona moral (12) o física (13), incluye & y Ñ. */
export const RFC_REGEX = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
