/**
 * `[PGP.122]` **Cómo escribe Kepler un texto** — primitivo compartido (ADR-056).
 *
 * Nació en `[ALC.1.6]` (`libs/commercial/.../kepler-cliente.armador.ts`, `textoKepler`) y se muda aquí
 * porque ya lo necesitan dos dominios: el alta de clientes (commercial) y la solicitud de gasto
 * (finance), y finanzas no puede importar de commercial (ADR-028). El armador de clientes lo
 * re-exporta con su nombre de siempre.
 *
 * Medido en `kdud` de la base 00 (2,468 fichas): MAYÚSCULAS, **sin acentos** (`MICHOACAN` 1,599 contra
 * `MICHOACÁN` 361) pero **con Ñ** (70 nombres), sin caracteres de control (42 fichas traen un `\r`
 * pegado) y **sin comillas**: las formas de Kepler arman sus comandos entre comillas simples
 * (`6,'valor'`), y una comilla en el dato rompe la edición posterior en la propia forma.
 *
 * ⚠️ Se llama `textoParaKepler` y no `textoKepler` a propósito: en el repo ya hay otras dos funciones
 * con ese nombre que hacen cosas distintas (número → texto en la requisición; estado → rótulo en
 * Salidas del banco).
 */

const VOCALES: Readonly<Record<string, string>> = {
  Á: 'A', À: 'A', Ä: 'A', Â: 'A', É: 'E', È: 'E', Ë: 'E', Ê: 'E', Í: 'I', Ì: 'I', Ï: 'I', Î: 'I',
  Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O', Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U',
};

export function textoParaKepler(v: unknown): string {
  return String(v ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/[ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛ]/g, (x) => VOCALES[x] ?? x)
    .replace(/[̀-ͯ]/g, '')
    .replace(/['"`´‘’“”]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `textoParaKepler` recortado a lo que cabe en la columna (las de Kepler son `varchar(n)`: más largo, revienta). */
export function textoKeplerCabe(v: unknown, max: number): string {
  return textoParaKepler(v).slice(0, Math.max(0, max)).trimEnd();
}
