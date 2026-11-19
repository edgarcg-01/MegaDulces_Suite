/**
 * `[BFU.1.3]` De qué cuenta es un archivo, probado DESPUÉS de subido, por la cadena de saldos (VERDAD §39.3).
 *
 * BBVA y BanBajío no escriben el número de cuenta en su descarga. Al subirla, la suite compara su apertura con el
 * último saldo conocido; si no lo hay (o el archivo se encima con otros), la acepta «sin testigo». Medido el
 * 2026-11-19: 19 de 100 archivos. Esta función los prueba con lo que llegó después:
 *
 *   un archivo es de su cuenta si su saldo de apertura es un saldo que ESA cuenta tuvo en los `dias` previos a su
 *   primer día —en una línea de un archivo ya probado, o en un renglón del libro—, y se repite hasta que nada cambie.
 *
 * Las anclas son los archivos con la cuenta en el archivo (`en_archivo`) o comprobados al subir (`saldo_continuo`).
 * Medido en prod: prueba 18 de 19; contra otra cuenta del mismo banco, 0 de 87 intentos (control negativo); de los
 * 64 comprobados al subir, olvidando su comprobación, prueba 63 (control positivo).
 *
 * ⚠️ No distingue dos cuentas que por casualidad tuvieron el mismo saldo la misma semana: por eso el número en el
 * archivo, cuando existe, gana, y esto sólo se usa donde no lo hay.
 */
export type ComoSeComproboLaCuenta = 'en_archivo' | 'saldo_continuo' | 'cadena' | null;

export interface ArchivoEnCadena {
  id: string;
  cuenta: string;
  /** Cómo se fijó la cuenta al subirlo. */
  check: 'en_archivo' | 'saldo_continuo' | 'sin_testigo';
  /** Primer día del archivo, `YYYY-MM-DD`. */
  desde: string;
  apertura: number;
}

/** Un saldo que una cuenta tuvo: una línea de la descarga (con su archivo) o un renglón del libro (`archivo: null`). */
export interface SaldoConocido {
  cuenta: string;
  fecha: string;
  saldo: number;
  archivo: string | null;
}

const centavos = (v: number) => Math.round(v * 100);
const restaDias = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() - n);
  return x.toISOString().slice(0, 10);
};

export function probarCuentasPorCadena(archivos: ArchivoEnCadena[], saldos: SaldoConocido[], dias = 7): Map<string, ComoSeComproboLaCuenta> {
  const prueba = new Map<string, ComoSeComproboLaCuenta>(
    archivos.map((a) => [a.id, a.check === 'sin_testigo' ? null : a.check]),
  );
  // Saldos por cuenta y por importe en centavos: la búsqueda es por (cuenta, saldo), después se filtra la fecha.
  const indice = new Map<string, SaldoConocido[]>();
  for (const s of saldos) {
    const k = `${s.cuenta}|${centavos(s.saldo)}`;
    const arr = indice.get(k);
    if (arr) arr.push(s); else indice.set(k, [s]);
  }
  const pendientes = archivos.filter((a) => a.check === 'sin_testigo');
  for (let vuelta = 0; vuelta <= pendientes.length; vuelta++) {
    let cambio = false;
    for (const a of pendientes) {
      if (prueba.get(a.id)) continue;
      const lo = restaDias(a.desde, dias);
      const candidatos = indice.get(`${a.cuenta}|${centavos(a.apertura)}`) ?? [];
      const ok = candidatos.some((s) => s.fecha >= lo && s.fecha <= a.desde && (
        s.archivo === null ? s.fecha < a.desde : s.archivo !== a.id && !!prueba.get(s.archivo)
      ));
      if (ok) { prueba.set(a.id, 'cadena'); cambio = true; }
    }
    if (!cambio) break;
  }
  return prueba;
}
