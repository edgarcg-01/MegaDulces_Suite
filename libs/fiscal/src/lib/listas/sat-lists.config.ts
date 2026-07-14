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
    urls: envUrls(process.env.EFOS_CSV_URL, [
      'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv',
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
      situacion: ['supuesto', 'situacion', 'tipo'],
    },
    riesgo: ['firme', 'no localizado', 'exigible', 'sentencia', 'definitivo', 'presunto'],
  },
};

export const listaConfig = (lista: string): SatListConfig => {
  const cfg = SAT_LISTS[lista];
  if (!cfg) throw new Error(`Lista SAT desconocida: ${lista}`);
  return cfg;
};

/** RFC genérico "público en general" / extranjeros — se marca como issue, no como proveedor real. */
export const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);

/** Estructura de RFC persona moral (12) o física (13), incluye & y Ñ. */
export const RFC_REGEX = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
