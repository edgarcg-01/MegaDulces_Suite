/**
 * Fase CG — Normalizador de beneficiario de la caja general (Doctos.NombreCliente).
 *
 * `NombreCliente` es TEXTO LIBRE. Medido sobre las 116,982 filas de `Doctos` (Comisionistas),
 * el mismo beneficiario aparece con varias grafías y los totales se parten entre ellas:
 *   · "BOLSAS DE LOS ALTOS" / "C Bolsas de los Altos" / "G Bolsas de los Altos"  (~$82M)
 *   · "PROVEDOR ARTURO VILLARRUEL" / "arturo villaruel" / "C Arturo Villaruel"
 *   · "CUERITOS LUPITA" / "C Cueritos Lupita"
 *
 * El prefijo `C `/`G ` que aparece en las capturas recientes (2025-2026) es la CLASE DE CUENTA
 * (C=Compras 1005, G=Gasto), no parte del nombre — hay que quitarlo para que el proveedor cuadre.
 *
 * ⚠️ Alcance declarado: esto colapsa prefijo de clase + mayúsculas/minúsculas + acentos +
 * espacios (incluye `\r\n`, medido: 7 valores traían salto de línea al frente). NO resuelve
 * TYPOS ("VILLARRUEL" vs "VILLARUEL") ni sufijos ("... SAINZ", "SA DE CV") — eso requiere
 * similitud difusa (pg_trgm) o una tabla de alias curada (patrón catalog_aliases), que queda
 * como capa siguiente. Este normalizador es determinista y espejeable 1:1 en SQL (ver
 * `beneficiarioNormSql`) para que el GROUP BY del reporte agrupe igual que este helper.
 */

/** Normaliza un `NombreCliente` a una clave de agrupación estable. */
export function normalizaBeneficiario(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos combinantes
    .toUpperCase()
    .replace(/\s+/g, ' ') // colapsa todo espacio en blanco (incl. \r\n\t) a uno
    .trim();
  // Prefijo de clase de cuenta que Control antepone: "C " / "G " (sólo si algo lo sigue).
  s = s.replace(/^[CG] (?=\S)/, '');
  // "PROVEEDOR " / "PROVEDOR " (typo real en los datos), con o sin punto.
  s = s.replace(/^PROVE+DOR\.?\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * MISMA lógica en SQL, para el GROUP BY del reporte (Postgres). Debe producir la misma clave
 * que `normalizaBeneficiario`. Requiere la extensión `unaccent` para plegar acentos; si no está
 * disponible, se degrada a sólo mayúsculas/espacios/prefijo (documentado, no silencioso).
 *
 * @param col nombre de la columna (ya citada) con el `nombre_cliente`.
 * @param hasUnaccent si el entorno tiene la extensión `unaccent` instalada.
 */
export function beneficiarioNormSql(col: string, hasUnaccent = true): string {
  const upper = hasUnaccent ? `upper(unaccent(${col}))` : `upper(${col})`;
  return `
    btrim(regexp_replace(
      regexp_replace(
        regexp_replace(btrim(regexp_replace(${upper}, '\\s+', ' ', 'g')),
          '^PROVE+DOR\\.?\\s+', ''),
        '^(C|G) (?=\\S)', ''),
      '\\s+', ' ', 'g'))`;
}
