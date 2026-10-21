/**
 * `[CB.53]` — La lógica pura del disparador de conciliación **por aviso**: qué periodos tocar,
 * cuándo vale la pena correr y cómo se decide que no hay nada nuevo.
 *
 * Vive aparte del servicio para que el candado pueda ejercerla sin base de datos y sin worker.
 * El servicio sólo escucha, mide la firma y obedece lo que estas funciones deciden.
 */

/** Firma de un periodo: si no cambió, no hay nada nuevo que conciliar. */
export interface FirmaPeriodo {
  /** Movimientos de Kepler en la ventana del motor. */
  kepFilas: number;
  /** Última fecha efectiva vista del lado Kepler (`''` si no hay ninguna). */
  kepUltima: string;
  /** Suma de importes del lado Kepler, en centavos: cambia aunque el conteo no. */
  kepCentavos: number;
  /** Movimientos del estado de cuenta cargados para ese periodo. */
  bancoFilas: number;
  /** Último `updated_at` visto del lado banco (`''` si no hay ninguno). */
  bancoUltimo: string;
}

export const firmaVacia: FirmaPeriodo = {
  kepFilas: 0, kepUltima: '', kepCentavos: 0, bancoFilas: 0, bancoUltimo: '',
};

/** Texto comparable de una firma. Dos firmas iguales = el periodo no se movió. */
export function textoFirma(f: FirmaPeriodo): string {
  return [f.kepFilas, f.kepUltima, f.kepCentavos, f.bancoFilas, f.bancoUltimo].join('|');
}

/**
 * ⭐ **Cuántos meses hacia atrás re-evaluar, y por qué no es uno solo.**
 *
 * El lado Kepler llega TARDE: medido en prod sobre octubre 2026, la captura de un movimiento de
 * tesorería tiene **mediana de 2 días a mitad de mes y 5 a principio, con máximo de 19**. O sea
 * que un documento con fecha del mes pasado puede aparecer hoy, y si sólo se re-evalúa el mes en
 * curso, ese movimiento **nunca encuentra a su pareja**: cuando por fin existe, su mes ya no se
 * vuelve a mirar.
 *
 * Por eso, hasta el día `diaCorte` del mes, también se re-evalúa el mes anterior. El default
 * (20) sale de ese máximo medido de 19 días, con un día de margen.
 *
 * ⚠️ Es una ventana **medida, no elegida**: si el lag de captura cambia, este número cambia con
 * él — y el día que alguien lo mueva, el candado de este archivo dice qué dejó de cubrirse.
 */
export function periodosAEvaluar(hoyMx: string, diaCorte = 20): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hoyMx);
  if (!m) throw new Error(`fecha inválida: ${hoyMx} (se espera YYYY-MM-DD)`);
  const [, aa, mm, dd] = m;
  const actual = `${aa}-${mm}`;
  if (Number(dd) > diaCorte) return [actual];
  const anioN = Number(aa), mesN = Number(mm);
  const previo = mesN === 1
    ? `${anioN - 1}-12`
    : `${anioN}-${String(mesN - 1).padStart(2, '0')}`;
  return [actual, previo];
}

export type MotivoNoCorrer = 'apagado' | 'ya_corriendo' | 'sin_cambios' | 'sin_datos';

export interface Decision {
  correr: boolean;
  motivo: MotivoNoCorrer | 'cambio';
  /** Qué decir en el log: un motor que no corre y no lo dice es indistinguible de uno roto. */
  detalle: string;
}

/**
 * Decide si esta llegada de aviso merece una corrida.
 *
 * ⛔ Los cuatro `false` son distintos a propósito (`[CG.195]`): «apagado», «ya estoy corriendo»,
 * «nada cambió» y «no hay datos» se parecen desde afuera —el motor no escribe— y se diagnostican
 * de maneras opuestas. Un `return` mudo ya costó una ventana de 15 minutos en Caja General.
 */
export function decidirCorrida(ctx: {
  habilitado: boolean;
  corriendo: boolean;
  firma: FirmaPeriodo;
  ultimaFirma: string;
}): Decision {
  const nueva = textoFirma(ctx.firma);
  if (!ctx.habilitado) {
    return { correr: false, motivo: 'apagado', detalle: `apagado (ENABLE_BANK_RECON_AVISO≠true); la firma sería ${nueva}` };
  }
  if (ctx.corriendo) {
    return { correr: false, motivo: 'ya_corriendo', detalle: 'ya hay una corrida en curso; este aviso se descarta (la que corre ya verá el dato)' };
  }
  if (ctx.firma.kepFilas === 0 && ctx.firma.bancoFilas === 0) {
    return { correr: false, motivo: 'sin_datos', detalle: 'el periodo no tiene movimientos de ninguno de los dos lados' };
  }
  if (nueva === ctx.ultimaFirma) {
    return { correr: false, motivo: 'sin_cambios', detalle: `la firma no se movió desde la última corrida (${nueva})` };
  }
  return { correr: true, motivo: 'cambio', detalle: `firma ${ctx.ultimaFirma || '(ninguna)'} → ${nueva}` };
}
