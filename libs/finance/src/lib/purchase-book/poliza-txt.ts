/**
 * Fase LC (ADR-052) — **El layout del TXT de pólizas de ContPAQi**, escritor y lector.
 *
 * Vive aparte del servicio, sin dependencias de Nest, por dos razones:
 *
 *  1. **se puede probar sin DI.** Decide sobre dinero: un archivo mal serializado es una
 *     póliza que ContPAQi rechaza, o peor, que acepta corrida de campo. El smoke
 *     `test-newdb-libro-compras-txt.js` carga este archivo tal cual (mismo patrón que
 *     `receipt-match.ts`), así que si el layout cambia de criterio el test se pone rojo.
 *  2. **escritor y lector no se pueden separar.** Los anchos y la alineación están una sola
 *     vez, en `LAYOUT_P` / `LAYOUT_M`, y los leen los dos: `construirTxt` los escribe y
 *     `parsearTxt` los lee. Si alguien mueve un ancho, se mueven los dos lados o ninguno.
 *
 * ⚠️ `SEP` es lo ÚNICO del layout que no está verificado contra un archivo real. Los 19
 * campos se validaron uno a uno contra las tablas `Polizas` / `MovimientosPoliza` de
 * ContPAQi, pero eso prueba qué SIGNIFICA cada campo, no cómo se serializa. La otra
 * posibilidad es concatenación pura (`SEP = ''`). Se cierra con el round-trip byte a byte
 * del smoke contra un TXT que ContPAQi ya haya aceptado.
 *
 * Va como constante y no como variable de entorno a propósito: un formato que PUEDE estar
 * mal en producción es peor que una constante que está bien.
 */

/** ContPAQi: 3 = Diario. Verificado contra su catálogo `TiposPolizas`. */
export const TIPO_POLIZA_DIARIO = '3';

export const SEP = ' ';

export const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const padR = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n, ' ');
const padL = (s: unknown, n: number) => String(s ?? '').slice(0, n).padStart(n, ' ');
/** ContPAQi pide entre 1 y 2 decimales: `6.5` y `6.53` valen, `6` no. */
export const impTxt = (n: number) => (Number.isInteger(r2(n)) ? `${r2(n)}.0` : r2(n).toFixed(2));

export interface CampoFijo {
  nombre: string;
  ancho: number;
  /** Alineado a la derecha (`padL`). Por default va a la izquierda (`padR`). */
  der?: boolean;
}

/** Encabezado de póliza. 138 chars de campos + 9 separadores = 147. */
export const LAYOUT_P: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 },
  { nombre: 'fecha', ancho: 8, der: true },
  { nombre: 'tipo_pol', ancho: 4, der: true },
  { nombre: 'folio', ancho: 9, der: true },
  { nombre: 'clase', ancho: 1, der: true },
  { nombre: 'id_diario', ancho: 10 },
  { nombre: 'concepto', ancho: 100 },
  { nombre: 'sist_orig', ancho: 2, der: true },
  { nombre: 'impresa', ancho: 1, der: true },
  { nombre: 'ajuste', ancho: 1, der: true },
];

/** Movimiento. 203 chars de campos + 8 separadores = 211. */
export const LAYOUT_M: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 },
  { nombre: 'cuenta', ancho: 30 },
  { nombre: 'referencia', ancho: 10 },
  { nombre: 'tipo_movto', ancho: 1, der: true },
  { nombre: 'importe', ancho: 20 },
  { nombre: 'id_diario', ancho: 10 },
  { nombre: 'importe_me', ancho: 20 },
  { nombre: 'concepto', ancho: 100 },
  { nombre: 'seg_negocio', ancho: 10 },
];

export interface Movimiento {
  cuenta: string;
  referencia: string;
  abono: boolean;
  importe: number;
  concepto: string;
}

/** El TXT desarmado. `movimientos` reusa la misma interfaz que produce el generador. */
export interface PolizaTxtParseada {
  header: { fecha: string; tipo_pol: string; folio: number; concepto: string } | null;
  movimientos: Movimiento[];
  /** Renglones que no cumplen el layout. Si hay uno, el archivo NO es comparable. */
  invalidos: { linea: number; motivo: string; texto: string }[];
}

export const armarLinea = (layout: CampoFijo[], vals: unknown[]) =>
  layout.map((c, i) => (c.der ? padL(vals[i], c.ancho) : padR(vals[i], c.ancho))).join(SEP);

export const largoLinea = (layout: CampoFijo[]) =>
  layout.reduce((a, c) => a + c.ancho, 0) + (layout.length - 1) * SEP.length;

/**
 * Corta una línea en sus campos por posición. **No se puede usar `split`** por el
 * separador: `cuenta` y `concepto` van rellenados con espacios y `referencia` puede venir
 * entera en blanco, así que partir por espacios corre todos los campos.
 */
export const partirLinea = (layout: CampoFijo[], linea: string): string[] => {
  const out: string[] = [];
  let i = 0;
  for (const c of layout) {
    out.push(linea.slice(i, i + c.ancho));
    i += c.ancho + SEP.length;
  }
  return out;
};

/**
 * `fecha` va en `yyyyMMdd` — es el último día del mes de la póliza.
 *
 * **Invariante: ningún renglón se serializa sin cuenta.** Va acá, en el último momento
 * posible, y no sólo en quien arma los movimientos, porque atrapa CUALQUIER camino al
 * archivo. El modo de falla es invisible sin esto: `padR(null, 30)` produce 30 espacios,
 * el renglón se ve bien en pantalla, y ContPAQi rechaza el archivo entero al importarlo.
 */
export function construirTxt(fecha: string, folio: number, concepto: string, movs: Movimiento[]): string {
  const sinCuenta = movs.findIndex((m) => !m.cuenta || !String(m.cuenta).trim());
  if (sinCuenta >= 0) {
    throw new Error(`el movimiento ${sinCuenta + 1} no tiene cuenta contable; el archivo sería rechazado`);
  }
  const header = armarLinea(LAYOUT_P, [
    'P', fecha, TIPO_POLIZA_DIARIO, String(folio), '1', '0', concepto, '11', '0', '0',
  ]);
  const lineas = movs.map((m) => armarLinea(LAYOUT_M, [
    'M', m.cuenta, m.referencia, m.abono ? '1' : '0',
    impTxt(m.importe), '0', '0.0', m.concepto, '',
  ]));
  return [header, ...lineas].join('\r\n') + '\r\n';
}

/**
 * Desarma un TXT de póliza. Es el inverso exacto de `construirTxt` y paga tres veces:
 *
 *  1. prueba el layout — `construirTxt(parsearTxt(real))` tiene que dar el archivo real
 *     byte por byte, y el primer byte distinto nombra el defecto (separador, dirección del
 *     pad, la regla de decimales de `impTxt`, CRLF);
 *  2. deja que LC.7 cuadre contra **lo entregado** en vez de re-derivarlo de datos que ya
 *     cambiaron;
 *  3. da el listado movimiento-a-UUID para el Asociador de CFDI de ContPAQi.
 *
 * El criterio es fallar ruidoso antes que adivinar: cualquier renglón dudoso se va a
 * `invalidos` y quien llama decide. Un default silencioso acá voltearía el signo de una
 * pata de millones sin que nadie lo vea.
 */
export function parsearTxt(txt: string): PolizaTxtParseada {
  const out: PolizaTxtParseada = { header: null, movimientos: [], invalidos: [] };
  if (!txt) {
    out.invalidos.push({ linea: 0, motivo: 'archivo vacío', texto: '' });
    return out;
  }
  // El archivo cierra con CRLF, así que la última línea del split viene vacía.
  const lineas = txt.split(/\r?\n/);
  while (lineas.length && lineas[lineas.length - 1].trim() === '') lineas.pop();

  lineas.forEach((cruda, idx) => {
    const nro = idx + 1;
    const marca = cruda.slice(0, 1);
    const esP = marca === 'P';
    const esM = marca === 'M';
    if (!esP && !esM) {
      out.invalidos.push({ linea: nro, motivo: 'no arranca con P ni con M', texto: cruda.slice(0, 40) });
      return;
    }
    const layout = esP ? LAYOUT_P : LAYOUT_M;
    const largo = largoLinea(layout);
    // Más corta se rellena: un editor de texto recorta los blancos del final y son
    // semánticamente vacíos. Más larga NO se toca — ahí sí hay algo que no entendemos.
    if (cruda.length > largo) {
      out.invalidos.push({ linea: nro, motivo: `mide ${cruda.length} y el layout pide ${largo}`, texto: cruda.slice(0, 40) });
      return;
    }
    const campos = partirLinea(layout, cruda.padEnd(largo, ' '));

    if (esP) {
      if (out.header) {
        out.invalidos.push({ linea: nro, motivo: 'segundo encabezado P en el mismo archivo', texto: cruda.slice(0, 40) });
        return;
      }
      const folio = Number(campos[3].trim());
      out.header = {
        fecha: campos[1].trim(),
        tipo_pol: campos[2].trim(),
        folio,
        concepto: campos[6].trimEnd(),
      };
      if (!Number.isFinite(folio)) {
        out.invalidos.push({ linea: nro, motivo: 'folio no numérico', texto: campos[3] });
      }
      return;
    }

    const cuenta = campos[1].trimEnd();
    const tipoMovto = campos[3].trim();
    const importe = Number(campos[4].trim());
    if (!cuenta) {
      out.invalidos.push({ linea: nro, motivo: 'movimiento sin cuenta', texto: cruda.slice(0, 40) });
      return;
    }
    // Sin default: 0 es cargo y 1 es abono, y cualquier otra cosa es un renglón que no
    // sabemos leer. Asumir "cargo" invertiría el asiento en silencio.
    if (tipoMovto !== '0' && tipoMovto !== '1') {
      out.invalidos.push({ linea: nro, motivo: `tipo de movimiento "${tipoMovto}" no es 0 ni 1`, texto: cruda.slice(0, 40) });
      return;
    }
    if (!Number.isFinite(importe)) {
      out.invalidos.push({ linea: nro, motivo: 'importe no numérico', texto: campos[4] });
      return;
    }
    out.movimientos.push({
      cuenta,
      referencia: campos[2].trimEnd(),
      abono: tipoMovto === '1',
      importe: r2(importe),
      concepto: campos[7].trimEnd(),
    });
  });

  if (!out.header && !out.invalidos.length) {
    out.invalidos.push({ linea: 0, motivo: 'el archivo no tiene encabezado P', texto: '' });
  }
  return out;
}
