import { XMLParser } from 'fast-xml-parser';
import type { RemisionLine } from '@megadulces/platform-core';

/**
 * `[RE.55]` De dónde salen los renglones del proveedor que se concilian contra Kepler.
 *
 * Antes salían SIEMPRE del OCR del papel. Medido en la entrada 0010028 de CEDIS (2026-11-06): la
 * hoja venía escaneada de lado y el OCR devolvió 8 renglones que no están en el papel («GALLETAS
 * SURTIDAS», «CHOCOLATES VARIADOS»…) con códigos de barras cuyo dígito verificador falla en los 4
 * que se revisaron. La pantalla pintó 8 «sin match» sobre mercancía inventada.
 *
 * Ahora, en orden:
 *  1. **El XML del CFDI** ligado a la entrada (`fiscal.cfdis.xml`, lo trae el feed de ContPAQi):
 *     los conceptos son lo que el proveedor timbró, sin lectura de por medio.
 *  2. **El OCR**, sólo si su lectura pasa dos pruebas que no dependen del modelo (`lecturaConfiable`):
 *     el dígito verificador de los códigos de barras y que la suma de los renglones dé el subtotal o
 *     el total leído. Si no las pasa, NO se concilia: se declara que no se pudo leer.
 */

export type FuenteRenglones = 'cfdi' | 'ocr';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false, // claves como «0012» no se vuelven 12 (ver CfdiParserService)
  removeNSPrefix: true,
  trimValues: true,
});

/** Clave de unidad del SAT → la unidad que entiende el motor (`esCaja` en conciliar-renglones). */
const CLAVE_UNIDAD: Record<string, string> = {
  H87: 'PZA', EA: 'PZA', XBX: 'CAJA', XPK: 'PAQ', XPA: 'PAQ', XBJ: 'CAJA', KGM: 'KG', LTR: 'LT', XUN: 'PZA',
};

const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const num = (v: unknown): number | null => {
  const t = txt(v);
  if (t == null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Los conceptos de un CFDI como renglones de remisión. Importe SIN IVA y neto de su descuento (la
 * base del costo de Kepler). La unidad es la `Unidad` impresa si viene; si no, la clave del SAT
 * traducida. [] si el XML no parsea o no trae conceptos.
 */
export function conceptosDelCfdi(xml: string | null | undefined): RemisionLine[] {
  if (!xml) return [];
  let doc: any;
  try { doc = parser.parse(xml); } catch { return []; }
  const comprobante = arr(doc?.Comprobante)[0];
  const conceptos = arr(arr(comprobante?.Conceptos)[0]?.Concepto);
  return conceptos
    .map((c: any): RemisionLine | null => {
      const descripcion = txt(c?.['@_Descripcion']);
      if (!descripcion) return null;
      const clave = (txt(c?.['@_ClaveUnidad']) || '').toUpperCase();
      const importe = num(c?.['@_Importe']);
      const descuento = num(c?.['@_Descuento']) ?? 0;
      return {
        descripcion,
        cantidad: num(c?.['@_Cantidad']),
        unidad: (txt(c?.['@_Unidad']) || CLAVE_UNIDAD[clave] || clave || '').toUpperCase() || null,
        sku_proveedor: txt(c?.['@_NoIdentificacion']),
        codigo_barras: null,
        precio_unitario: num(c?.['@_ValorUnitario']),
        importe: importe == null ? null : Math.round((importe - descuento) * 100) / 100,
      };
    })
    .filter((l): l is RemisionLine => l !== null);
}

/** Dígito verificador GS1 (EAN-8, UPC-A, EAN-13, GTIN-14). null si no tiene forma de código. */
export function eanValido(codigo: string | null | undefined): boolean | null {
  const d = (codigo || '').replace(/\s+/g, '');
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) return null;
  const cuerpo = d.slice(0, -1).split('').reverse().map(Number);
  const suma = cuerpo.reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === Number(d[d.length - 1]);
}

/** Tolerancia de la suma de renglones contra el subtotal/total leído. */
export const SUMA_TOL = 0.02;

export interface LecturaConfiable { confiable: boolean; motivos: string[] }

/** Pesos con separador de miles, como el resto de la pantalla (el motivo se lee tal cual). */
const pesos = (x: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(x);

/**
 * `[RE.55]` ¿Los renglones que leyó el OCR son del papel? Dos pruebas independientes del modelo:
 *  · **códigos de barras**: si trae 2 o más, la mayoría debe pasar el dígito verificador (uno mal
 *    copiado pasa; inventados, 9 de cada 10 fallan);
 *  · **suma**: si se leyó subtotal o total y casi todos los renglones traen importe, su suma debe dar
 *    el subtotal, el total, o el total sin IVA (±2 %).
 * Una prueba sin datos no reprueba: se declara en los motivos que no se midió.
 */
export function lecturaConfiable(
  lines: RemisionLine[],
  doc: { subtotal: number | null; total: number | null },
): LecturaConfiable {
  const motivos: string[] = [];
  let confiable = true;

  const codigos = lines.map((l) => eanValido(l.codigo_barras)).filter((v): v is boolean => v !== null);
  const malos = codigos.filter((v) => !v).length;
  if (codigos.length >= 2 && malos * 2 > codigos.length) {
    confiable = false;
    motivos.push(`${malos} de ${codigos.length} códigos de barras no existen (dígito verificador inválido)`);
  }

  const importes = lines.map((l) => (l.importe != null ? Number(l.importe)
    : l.cantidad != null && l.precio_unitario != null ? Number(l.cantidad) * Number(l.precio_unitario) : null));
  const con = importes.filter((x): x is number => x != null && Number.isFinite(x));
  const refs = [doc.subtotal, doc.total, doc.total != null ? doc.total / 1.16 : null]
    .filter((x): x is number => x != null && x > 0);
  if (!refs.length || !lines.length || con.length < lines.length * 0.8) {
    motivos.push('no se pudo comparar la suma de los renglones con el total del papel');
  } else {
    const suma = con.reduce((s, x) => s + x, 0);
    if (!refs.some((r) => Math.abs(suma - r) / r <= SUMA_TOL)) {
      confiable = false;
      motivos.push(`los renglones suman ${pesos(suma)} y el papel dice ${pesos(doc.subtotal ?? doc.total ?? 0)}`);
    }
  }
  return { confiable, motivos };
}
