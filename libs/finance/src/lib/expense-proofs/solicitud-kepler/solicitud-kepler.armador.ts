import {
  formaPago, lineaAmpara, referenciaDelComprobante, totalesDeLaSolicitud, type ComprobanteDeLaSolicitud,
} from '@megadulces/contracts';
import { CAPTURISTA_SUITE, textoKeplerCabe } from '@megadulces/platform-core';

/**
 * `[PGP.122.7]` C1 — **La solicitud de gasto en el idioma de Kepler, armada sin tocar Kepler.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` §5.2. Funciones puras: el
 * escritor (C2, `kepler-solicitud-gasto-sink.adapter.ts`) lee lo vivo —la plantilla, el acreedor y los
 * catálogos del servidor— y le pasa aquí lo de la Suite; esto devuelve QUÉ se escribe o POR QUÉ no.
 *
 * ── Lo medido (5,224 X-A-15-1 de 120 días, ODS, 2026-11-14) ─────────────────────────────────
 * De las 200 columnas de `kdm1` (todas NOT NULL) sólo **23 varían**; 8 son constantes con valor
 * (X/A/15/1, PESOS, `Sol`, paridad 1, `XA1501-`) y 169 están vacías o en cero en el 100 %. El escritor
 * clona una solicitud real del servidor (la plantilla) y pisa EXACTAMENTE las 23 que varían
 * (`COLUMNAS_QUE_VARIAN`); de ellas, `c6` (folio) la pone el escritor con el contador y `c22`/`c32` (RFC
 * y nombre) las copia en SQL desde `kdxd` del servidor, sin pasar por aquí (no se re-codifica un nombre).
 * `kdm6` (18 columnas, todas conocidas) se construye entero, salvo `c8` (cuenta) y `c9` (texto), que el
 * escritor toma en SQL del concepto en `kdco` de ESE servidor (la cuenta es la del catálogo en el 99.5 %).
 *
 * Tipos que un doble no ve (`KEPLER_ESTRUCTURA.json`): `c17` (plazo) es TEXTO de 4; `kdm6.c7` es
 * `numeric(3,0)`; `kdxd.c3` mide 200 y `c32` 60.
 *
 * ── Las dos fechas (DS15, Francisco 2026-11-14) ─────────────────────────────────────────────
 * `c9` = fecha de solicitud. La fecha del documento que ampara va en `c25` (`AMPARA CFDI F-393 DEL
 * 09/11/2026`) y su folio en `c11`: el X-A-10 hereda las dos (`c11` 99.7 %, `c25` 496 de 496). `c18` es la
 * fecha de pago y NO se usa para otra cosa: el gasto la copia como vencimiento de su CxP (4,284 de 4,284).
 */

type Valor = string | number;

/** Las 23 columnas de `kdm1` que varían en una X-A-15 real: lo único que el escritor pisa de la plantilla. */
export const COLUMNAS_QUE_VARIAN = [
  'c1', 'c6', 'c9', 'c10', 'c11', 'c14', 'c15', 'c16', 'c17', 'c18', 'c22', 'c24', 'c25', 'c26',
  'c30', 'c32', 'c42', 'c43', 'c48', 'c67', 'c68', 'c69', 'c90',
] as const;

/** Las 8 constantes con valor que la plantilla TIENE que traer (fail-closed si no). */
export const CONSTANTES_DE_LA_PLANTILLA: Readonly<Record<string, Valor>> = {
  c2: 'X', c3: 'A', c4: 15, c5: 1, c7: 'PESOS', c31: 'Sol', c40: 1, c63: 'XA1501-',
};

/** Quién autoriza (`c30`): texto libre en Kepler, «FINANZAS» en el 85 %. Quién firmó y cuándo vive en la Suite. */
export const AUTORIZA_KEPLER = 'FINANZAS';

export type EstadoSolicitudKepler = 'A' | 'F';

export interface DatosSolicitudKepler {
  /** El servidor (`md_NN`) y `c1`. */
  sucursal: string;
  /** `kdxd.c2` del acreedor (≤ 7). */
  acreedor: string;
  /** `YYYY-MM-DD` → `c9` (fecha de solicitud). */
  fechaSolicitud: string;
  /** `YYYY-MM-DD` → `c18` (fecha de pago); sin ella, la de solicitud (`c18 = c9` en el 85 %). */
  fechaPago?: string | null;
  renglones: ReadonlyArray<{ concepto: string; proyecto: string; departamento: string; importe: number }>;
  /** IVA de toda la solicitud (`c14`). */
  iva: number;
  /** El documento que ampara el gasto → `c11` (folio) y `c25` (`AMPARA …`). */
  comprobante: ComprobanteDeLaSolicitud;
  /**
   * ⭐ **El gasto NO tiene papel que lo ampare, y quien llama lo DECLARA.** Entonces `c25` queda vacío
   * y no se exige la fecha del documento (DS15). `c11` sigue saliendo del comprobante: suele traer la
   * referencia de la sucursal aunque no haya documento.
   *
   * Nace para las comisiones de la terminal (`[CB.62.4]`), que el banco cobra en el estado de cuenta:
   * no hay ticket ni CFDI que fechar. **Medido en el ODS el 2026-11-26**, acreedor `GB%` desde
   * septiembre: de **690** solicitudes `X-A-15` y **653** gastos `X-A-10` de comisiones, **CERO**
   * llevan renglón AMPARA, y `c25` está vacío en 658 y 621. La regla DS15 es del flujo con ticket o
   * CFDI (496 de 496 lo traen) y ahí **sigue exigiéndose**: esta bandera no la afloja, la acota.
   *
   * ⛔ Por eso es explícita y no se deduce de «no vino fecha»: un ticket al que se le olvidó la fecha
   * es un defecto, y tiene que seguir saliendo rojo.
   */
  sinDocumentoQueAmpare?: boolean;
  /** `c24`: el comentario (lo arma `comentarioDeLaSolicitud`). */
  comentario: string;
  /** `c48`: quién solicita, el usuario de la Suite (≤ 50). */
  solicita: string;
  /** Id de `FORMAS_PAGO` → `c90` con su `codigo_kepler`. */
  formaPago?: string | null;
  /** `c26`: la marca de la Suite que vuelve idempotente la escritura (`SUITE SG-…`). */
  marca: string;
  /**
   * `c43`: `A` = autorizada (nace al firmar, DS2). `F` = aplicada.
   * ⚠️ **Corregido el 2026-11-26**: esta línea decía que «así nacen las de comisiones (CB.62)». Medido en el ODS
   * sobre las 442 solicitudes de comisión vivas de oct–nov: **16 están en `A` con su saldo entero** y 412 en `F`
   * (385 con saldo 0). La `F` es donde las DEJA su gasto, no donde nacen. CB.62 las entrega en `A`, como PGP.
   */
  estado: EstadoSolicitudKepler;
  /** `c68` (`YYYY-MM-DD`) y `c69` (`HH:MM`), hora de México: cuándo la escribió la Suite. */
  capturadaEn: { fecha: string; hora: string };
}

export interface PlanSolicitudKepler {
  /** Lo que se pisa de la plantilla, SIN `c6`, `c22` ni `c32` (los pone el escritor). */
  kdm1: Record<string, Valor>;
  /** Cada renglón entero, SIN `c6` (folio), `c8` ni `c9` (los toma el escritor de `kdco`). */
  kdm6: Record<string, Valor>[];
  subtotal: number;
  iva: number;
  total: number;
}

export type ResultadoSolicitudKepler = { ok: true; plan: PlanSolicitudKepler } | { ok: false; motivos: string[] };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const CLAVE = /^[^\s'"]{1,10}$/;
/** `^\d-\d{2}-(\d{2})-\d{2}$`: los proyectos con año en el código (p. ej. `2-15-26-02` es de 2026). */
/** `c90` decodificados: efectivo 01, cheque 02, transferencia 03, tarjeta 04, otro 99. «Vales» (07) va vacío. */
export const C90_DECODIFICADOS: ReadonlySet<string> = new Set(['01', '02', '03', '04', '99']);

const PROYECTO_CON_ANO = /^\d-\d{2}-(\d{2})-\d{2}$/;
const cent = (n: unknown): number => Math.round(Number(n) * 100);
const dias = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** La marca de la Suite en `c26`: `SUITE SG-` + los primeros 8 del id del vale, en mayúsculas. */
export function marcaDeLaSolicitud(valeId: string): string {
  const id = String(valeId ?? '').replace(/[^0-9a-fA-F]/g, '').slice(0, 8).toUpperCase();
  return id.length === 8 ? `SUITE SG-${id}` : '';
}

/** Arma la cabecera y los renglones, o dice por qué no. Fail-closed: un motivo basta. */
export function armarSolicitudKepler(d: DatosSolicitudKepler): ResultadoSolicitudKepler {
  const no: string[] = [];
  if (!/^\d{2}$/.test(d.sucursal ?? '')) no.push(`Sucursal Kepler inválida «${d.sucursal}»`);
  const acreedor = String(d.acreedor ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,7}$/.test(acreedor)) no.push(`Acreedor inválido «${d.acreedor}» (kdxd.c2, hasta 7)`);
  if (!FECHA.test(d.fechaSolicitud ?? '') || Number.isNaN(Date.parse(d.fechaSolicitud))) no.push(`Fecha de solicitud inválida «${d.fechaSolicitud}»`);
  const fechaPago = d.fechaPago ? String(d.fechaPago) : d.fechaSolicitud;
  if (!FECHA.test(fechaPago ?? '') || Number.isNaN(Date.parse(fechaPago))) no.push(`Fecha de pago inválida «${d.fechaPago}»`);
  const plazo = FECHA.test(fechaPago ?? '') && FECHA.test(d.fechaSolicitud ?? '') ? dias(d.fechaSolicitud, fechaPago) : NaN;
  if (Number.isFinite(plazo) && plazo < 0) no.push(`La fecha de pago (${fechaPago}) es anterior a la de solicitud (${d.fechaSolicitud})`);
  if (Number.isFinite(plazo) && plazo > 9999) no.push(`El plazo (${plazo} días) no cabe en Kepler (c17, 4)`);
  if (!FECHA.test(d.capturadaEn?.fecha ?? '') || !HORA.test(d.capturadaEn?.hora ?? '')) no.push('Falta cuándo la escribe la Suite (fecha y hora de México)');
  if (d.estado !== 'A' && d.estado !== 'F') no.push(`Estado inválido «${d.estado}»: la Suite sólo escribe A (autorizada) o F (aplicada)`);
  if (!/^SUITE SG-[0-9A-F]{8}$/.test(d.marca ?? '')) no.push(`La marca «${d.marca}» no es SUITE SG-<8>: sin marca no se puede reintentar sin escribir dos veces`);

  const renglones = d.renglones ?? [];
  if (!renglones.length) no.push('La solicitud no trae renglones');
  if (renglones.length > 999) no.push('Más de 999 renglones (kdm6.c7 es numeric(3,0))');
  renglones.forEach((r, i) => {
    for (const k of ['concepto', 'proyecto', 'departamento'] as const) {
      if (!CLAVE.test(String(r[k] ?? '').trim())) no.push(`Renglón ${i + 1}: ${k} inválido «${r[k]}» (1 a 10 caracteres, sin comillas)`);
    }
    if (!(Number(r.importe) > 0) || cent(r.importe) / 100 !== Number(r.importe)) no.push(`Renglón ${i + 1}: importe inválido «${r.importe}»`);
    const m = PROYECTO_CON_ANO.exec(String(r.proyecto ?? '').trim());
    if (m && FECHA.test(d.fechaSolicitud ?? '') && m[1] !== d.fechaSolicitud.slice(2, 4)) {
      no.push(`Renglón ${i + 1}: el proyecto ${r.proyecto} es de 20${m[1]} y la solicitud de ${d.fechaSolicitud.slice(0, 4)} (en enero de 2026, 305 renglones cayeron así)`);
    }
  });
  if (!(Number(d.iva) >= 0) || cent(d.iva) / 100 !== Number(d.iva)) no.push(`IVA inválido «${d.iva}»`);

  const ampara = lineaAmpara(d.comprobante);
  // ⛔ Sólo se exige el AMPARA cuando el gasto SÍ tiene papel. Si quien llama declara que no lo hay
  // (`sinDocumentoQueAmpare`), `c25` queda vacío, que es como están los 658 de 690 reales de comisiones.
  if (!ampara && !d.sinDocumentoQueAmpare) no.push('Falta la fecha del documento que ampara el gasto: sin ella no hay renglón AMPARA (DS15)');
  const solicita = textoKeplerCabe(d.solicita, 50);
  if (!solicita) no.push('Falta quién solicita (c48)');
  const fp = d.formaPago ? formaPago(d.formaPago) : undefined;
  if (d.formaPago && !fp) no.push(`Forma de pago fuera del catálogo «${d.formaPago}»`);
  if (no.length) return { ok: false, motivos: no };

  const t = totalesDeLaSolicitud(renglones, d.iva);
  const kdm1: Record<string, Valor> = {
    c1: d.sucursal,
    c9: d.fechaSolicitud,
    c10: acreedor,
    c11: textoKeplerCabe(referenciaDelComprobante(d.comprobante), 20),
    c14: t.iva,
    c15: 0,
    c16: t.total,
    c17: String(plazo),
    c18: fechaPago,
    c24: textoKeplerCabe(d.comentario, 60),
    c25: ampara ? textoKeplerCabe(ampara, 60) : '',
    c26: d.marca,
    c30: AUTORIZA_KEPLER,
    // En A el saldo es el total (191 de 194 N lo traen así); en F, 0 (5,015 de 5,140).
    c42: d.estado === 'A' ? t.total : 0,
    c43: d.estado,
    c48: solicita,
    c67: CAPTURISTA_SUITE,
    c68: d.capturadaEn.fecha,
    c69: d.capturadaEn.hora,
    // Sólo los códigos decodificados (anexo §5.1: 07 y 98 siguen sin decodificar y no se escriben).
    c90: fp && C90_DECODIFICADOS.has(fp.codigo_kepler) ? fp.codigo_kepler : '',
  };
  const kdm6 = renglones.map((r, i) => ({
    c1: d.sucursal, c2: 'X', c3: 'A', c4: 15, c5: 1, c7: i + 1, c10: 'C',
    c11: cent(r.importe) / 100, c12: String(r.concepto).trim(), c13: String(r.proyecto).trim(),
    c14: '', c15: '', c16: String(r.departamento).trim(), c17: 0, c18: 0,
  }));
  return { ok: true, plan: { kdm1, kdm6, subtotal: t.subtotal, iva: t.iva, total: t.total } };
}
