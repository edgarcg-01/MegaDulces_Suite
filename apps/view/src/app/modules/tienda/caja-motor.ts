// `[PDV.31]` La lógica de la caja de mostrador, en funciones puras: lo que el cajero teclea, el precio
// de cada renglón con su escalera de mayoreo, los totales con impuestos INCLUIDOS y el cobro.
// Sale del prototipo validado con Edgar (2026-11-02) y del anexo `FASE_PDV_ANEXO_CAJERO.md` §6.
// ⚠️ Es la caja de PRÁCTICA: el precio sale del verificador (lista + escalera de Kepler), no del motor
// único (PDV.11), y las promociones por cantidad no se aplican. Se declara en pantalla.

export interface EscalonCaja {
  desde: number;
  precio: number;
}

export interface LineaCaja {
  codigo: string;
  nombre: string;
  unidad: string;
  /** Precio de lista CON impuestos de la presentación elegida. */
  lista: number;
  escalera: EscalonCaja[];
  ivaPct: number;
  iepsPct: number;
  /** Se vende por peso: la cantidad admite decimales. */
  granel: boolean;
  cantidad: number;
  /** Quitado: queda a la vista, tachado, con su motivo. Nada se borra. */
  quitado: { motivo: string; quien: string } | null;
  /** Las otras presentaciones del producto, para cambiar con F4. */
  presentaciones: { unidad: string; lista: number; escalera: EscalonCaja[] }[];
}

export interface PrecioRenglon {
  precio: number;
  lista: number;
  /** El escalón que aplica, o null si se cobra la lista. */
  escalon: EscalonCaja | null;
  /** El siguiente escalón, para el «lleva N más». */
  siguiente: EscalonCaja | null;
}

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function precioRenglon(l: Pick<LineaCaja, 'lista' | 'escalera' | 'cantidad'>): PrecioRenglon {
  const esc = [...l.escalera].sort((a, b) => a.desde - b.desde);
  let escalon: EscalonCaja | null = null;
  for (const e of esc) if (l.cantidad >= e.desde) escalon = e;
  const siguiente = esc.find((e) => l.cantidad < e.desde) ?? null;
  return { precio: escalon ? escalon.precio : l.lista, lista: l.lista, escalon, siguiente };
}

export function importeRenglon(l: LineaCaja): number {
  return l.quitado ? 0 : r2(l.cantidad * precioRenglon(l).precio);
}

export interface TotalesCaja {
  total: number;
  iva: number;
  ieps: number;
  ahorro: number;
  articulos: number;
  renglones: number;
}

/** Impuestos INCLUIDOS en el precio al público: la parte de impuesto es importe × tasa ÷ (1 + tasa). */
export function totalesCaja(lineas: LineaCaja[]): TotalesCaja {
  let total = 0, iva = 0, ieps = 0, ahorro = 0, articulos = 0, renglones = 0;
  for (const l of lineas) {
    if (l.quitado) continue;
    const p = precioRenglon(l);
    const imp = r2(l.cantidad * p.precio);
    total += imp;
    if (l.ivaPct) iva += (imp * l.ivaPct) / (100 + l.ivaPct);
    if (l.iepsPct) ieps += (imp * l.iepsPct) / (100 + l.iepsPct);
    ahorro += r2(l.cantidad * (p.lista - p.precio));
    articulos += l.granel ? 1 : l.cantidad;
    renglones++;
  }
  return { total: r2(total), iva: r2(iva), ieps: r2(ieps), ahorro: r2(ahorro), articulos: r2(articulos), renglones };
}

export type Comando =
  | { tipo: 'vacio' }
  | { tipo: 'codigo'; codigo: string; cantidad: number; conCantidad: boolean }
  | { tipo: 'texto'; texto: string }
  | { tipo: 'invalido'; razon: string };

/**
 * La línea de comandos: `código`, `5*código` (cantidad antes del código, como en caja de
 * supermercado), `1.884*código` (peso) o letras (buscar por nombre). Liberal en la FORMA: tolera
 * espacios y la coma decimal; nunca adivina el significado.
 */
export function leerComando(entrada: string): Comando {
  const v = entrada.trim().replace(/\s+/g, ' ');
  if (!v) return { tipo: 'vacio' };
  if (/[a-zñáéíóú]/i.test(v)) return { tipo: 'texto', texto: v };
  const m = v.replace(/\s/g, '').match(/^(\d+(?:[.,]\d+)?)\*(\d+)$/);
  if (m) {
    const cantidad = Number(m[1].replace(',', '.'));
    if (!(cantidad > 0)) return { tipo: 'invalido', razon: 'La cantidad debe ser mayor que cero.' };
    return { tipo: 'codigo', codigo: m[2], cantidad, conCantidad: true };
  }
  if (/^\d+$/.test(v)) return { tipo: 'codigo', codigo: v, cantidad: 1, conCantidad: false };
  return { tipo: 'invalido', razon: `No entiendo «${v}». Escanea, teclea el código o cantidad*código.` };
}

/** Importe tecleado en el cobro: acepta «1,250.50» y «250»; null si no es un importe. */
export function leerImporte(entrada: string): number | null {
  const v = entrada.trim().replace(/[$\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Number(v);
}

/**
 * Límite de cambio: si lo recibido pasa el saldo por $1,000 o más, siempre sobraría un billete. Caza
 * el error clásico de teclear un código y luego F12 («$33,061.00 recibidos»).
 */
export const LIMITE_CAMBIO = 1000;
export function errorEfectivo(recibido: number, saldo: number): string | null {
  if (!(recibido > 0)) return 'Teclea el importe recibido.';
  if (recibido - saldo >= LIMITE_CAMBIO) return `¿Recibiste ${pesos(recibido)}? Es $1,000 o más arriba de lo que falta. Si era un código, presiona Esc.`;
  return null;
}

export const pesos = (n: number): string =>
  '$' + r2(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Corrección inmediata: el último renglón tocado hace menos de 15 s se corrige sin supervisor. */
export const VENTANA_CORRECCION_MS = 15_000;
export function esCorreccionInmediata(ultimo: { indice: number; en: number } | null, indice: number, ahora: number): boolean {
  return !!ultimo && ultimo.indice === indice && ahora - ultimo.en < VENTANA_CORRECCION_MS;
}

export const MOTIVOS_QUITAR = [
  'El cliente ya no lo quiere',
  'Se escaneó de más',
  'Producto dañado o caducado',
  'El precio no coincide con la etiqueta',
] as const;
