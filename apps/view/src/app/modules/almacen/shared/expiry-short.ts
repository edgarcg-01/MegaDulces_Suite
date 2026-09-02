/**
 * Fase WMS-REC — captura de caducidad en 4, 6 u 8 dígitos.
 *
 * El operario está en la rampa, con guantes, mirando la fecha impresa en la
 * caja. Un `<input type="date">` le pide diez caracteres en formato `mm/dd/yyyy`
 * (gringo, porque lo renderiza el navegador). Acá se teclean **dígitos pelados**:
 *
 *   `0327`   → 31/03/2027   (MMAA — el caso más común: el dulce suele imprimir
 *                            sólo mes y año, y el último día del mes es la
 *                            interpretación conservadora: se asume que dura todo
 *                            el mes impreso)
 *   `150327` → 15/03/2027   (DDMMAA)
 *   `15032027` → 15/03/2027 (DDMMAAAA — el año completo, que es lo que teclea
 *                            quien ve la máscara DD/MM/AA y la completa igual)
 *
 * Función **pura y exportada a propósito**, separada del componente: es la
 * pieza testeable y la que decide qué se guarda. El componente sólo la llama.
 *
 * Devuelve ISO `YYYY-MM-DD` o `null` si no se puede interpretar. Nunca lanza:
 * un `null` en un input de captura es "seguí escribiendo", no un error.
 */

/** Siglo asumido para el año de 2 dígitos. 27 → 2027. */
const SIGLO = 2000;

/** Último día del mes (1-12) del año dado. Cubre bisiestos vía Date(y, m, 0). */
function ultimoDiaDelMes(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function iso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * `MMAA` (4), `DDMMAA` (6) o `DDMMAAAA` (8 dígitos) → ISO `YYYY-MM-DD`.
 *
 * Tolera separadores y espacios en la entrada (`03/27`, `15 03 27`): se filtran
 * los no-dígitos antes de decidir. Cualquier otro largo, mes fuera de 1-12 o día
 * que no existe en ese mes → `null`.
 */
export function parseExpiryShort(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length !== 4 && d.length !== 6 && d.length !== 8) return null;

  if (d.length === 4) {
    const month = Number(d.slice(0, 2));
    const year = SIGLO + Number(d.slice(2, 4));
    if (month < 1 || month > 12) return null;
    // Sin día impreso: se toma el último del mes.
    return iso(year, month, ultimoDiaDelMes(year, month));
  }

  const day = Number(d.slice(0, 2));
  const month = Number(d.slice(2, 4));
  // 6 dígitos traen el año en 2 (27 → 2027); 8 lo traen completo. El año completo
  // se acota al mismo siglo que asume SIGLO: si no, un dedazo tipo 2820 pasa como
  // válido y el semáforo lo celebra con "292000 días de vida".
  const year = d.length === 6 ? SIGLO + Number(d.slice(4, 6)) : Number(d.slice(4, 8));
  if (year < SIGLO || year > SIGLO + 99) return null;
  if (month < 1 || month > 12) return null;
  // El día se valida CONTRA EL MES: 3102 (31 de febrero) no existe y no puede
  // pasar como 03/03. Un desbordamiento silencioso acá es una caducidad falsa.
  if (day < 1 || day > ultimoDiaDelMes(year, month)) return null;
  return iso(year, month, day);
}

/** ISO → `DD/MM/AAAA` para el eco debajo del campo (cachar el error antes de guardar). */
export function formatExpiryEcho(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}
