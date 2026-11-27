import { createHash } from 'node:crypto';

import type { DatosSolicitudKepler } from '../../expense-proofs/solicitud-kepler/solicitud-kepler.armador';
import type { PlantillaComisiones } from './comisiones-kepler.armador';
import { CONCEPTO_GASTO_COMISION } from './comisiones-kepler.armador';
import type { CargoPropuesta, DiaPropuesta } from './comisiones-kepler.query';

/**
 * `[CB.62.4]` C1 — **El día de comisiones, traducido a las TRES entregas que ya saben escribir en Kepler.**
 *
 * Plan: [`FASE_CB_CONCILIACION_BANCARIA.md`](../../../../../../docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md) §9.
 * Funciones puras: no tocan Kepler ni la Suite. Quien escribe (C2) lee lo vivo y le pasa aquí el día ya aprobado
 * por los tres candados; esto devuelve QUÉ se le entrega a cada escritor, o POR QUÉ no.
 *
 * ── Por qué NO se escribe con el plan del armador de CB.62 (ADR-056 / regla 16) ──────────────────────────────────
 * `armarComisionesKepler` arma `kdm1`, `kdxe`, `kdxf` y las pólizas a mano. **Medido en el ODS el 2026-11-26: los
 * 2,194 pagos `X-D-26` a un banco (`GB…`) de oct–nov llevan su renglón `kdm5`, y el plan de CB.62 no lo pone
 * (2,194 de 2,194).** Un escritor hecho con ese plan habría parido 2,194 pagos mancos. Los tres documentos que
 * necesitan las comisiones ya tienen escritor medido y probado contra el Kepler vivo:
 *
 * | Documento | Escritor | Lo que ya cerró con una captura real |
 * |---|---|---|
 * | Solicitud `X-A-15` | `KeplerSolicitudGastoSinkAdapter` (`[PGP.122]`) | `kdm1`, `kdm6`, el contador `KFXA1501.NN` |
 * | Gasto `X-A-10` | `KeplerGastoSinkAdapter` (`[PGP.123]`) | + `kdxe`, póliza D, `kdc126`, `kdcn26`, `kdxg`, y deja la solicitud en `F` saldo 0 |
 * | Pago `X-D-26` | `KeplerPagoSinkAdapter` (`[PGP.106]`) | + `kdm5`, póliza E, `kdxf`, `kdxg`, `kdc126` |
 *
 * Por eso CB.62.3 («cerrar la lista de tablas con una captura real») **ya está cerrada**: la cierran las tres
 * capturas de PGP, no una foto nueva. El armador de CB.62 se queda con lo que sí es suyo y nadie más sabe: QUÉ días
 * van, con qué cargos, de qué sucursal y de qué día de venta.
 *
 * ── Lo medido de la forma real (ODS, oct–nov 2026, 442 solicitudes de comisión vivas) ───────────────────────────
 *  - **nace en `A`, no en `F`**: 16 solicitudes recientes están en `A` con su saldo entero y 412 ya en `F` con saldo
 *    0 (385). La `F` es donde las DEJA su gasto, no donde nacen. Por eso la solicitud se entrega en `A` y es el
 *    escritor del gasto el que la aplica, igual que en PGP;
 *  - `kdm6`: 1,247 renglones `611-003` con concepto `199`, lado `C`. El concepto `199` resuelve a `611-003` en las
 *    **9 sucursales** (`kdco`), así que la cuenta no se escribe: la pone el catálogo del servidor;
 *  - `c7` «PESOS» (442 de 442) · `c30` «FINANZAS» (390) · `c25` vacío (439: la comisión no trae comprobante) ·
 *    `c12` vacío (442) · `c90` vacío (402).
 */

/** El concepto de Kepler de la comisión bancaria (`kdco.c1`): resuelve a `611-003` en las 9 sucursales. */
export const CONCEPTO_COMISION = CONCEPTO_GASTO_COMISION;

/** `c30` de la solicitud: el área que pide el gasto (390 de 442 lo traen así). */
export const AREA_COMISIONES = 'FINANZAS';

/** `c48` de la solicitud: quién la pide. No es una persona, es el proceso: que se vea en Kepler de dónde salió. */
export const SOLICITA_SUITE = 'SUITE_BANCOS';

/**
 * La marca de la Suite (`c26`) de un día de comisiones, con la MISMA forma que exige el armador de la solicitud
 * (`^SUITE SG-[0-9A-F]{8}$`). Determinista a partir de la llave del día (sucursal · día de venta · acreedor): el
 * mismo día pide siempre la misma marca, y el escritor la busca en el Kepler vivo antes de escribir. Dos días
 * distintos no la comparten (la llave entra entera en el hash).
 */
export function marcaDeComisiones(sucursal: string, diaVenta: string, acreedor: string): string {
  const llave = `cb62|${String(sucursal).trim()}|${String(diaVenta).trim()}|${String(acreedor).trim()}`;
  return `SUITE SG-${createHash('sha256').update(llave).digest('hex').slice(0, 8).toUpperCase()}`;
}

/** Lo que el día necesita de su cargo para armar el pago. */
export interface PagoDeCargo {
  /** `finance.bank_statement_lines.id`: a qué renglón del banco corresponde (la bitácora y la idempotencia). */
  cargoId: string;
  /** `YYYY-MM-DD`: la fecha del cargo en el banco (`kdm1.c9` del pago). */
  fecha: string;
  importe: number;
  /** `c11` del pago: «COMISIONES» o «IVA», como lo captura Finanzas. */
  referencia: string;
  /** La cuenta del cargo: `finance.bank_accounts.account_label`, que es `kdm1.c45` en Kepler. */
  cuenta: string;
  /** El banco por nombre, para que el escritor del pago resuelva su código de tesorería en `kdb1`. */
  banco: string;
}

/** Las tres entregas de un día, en el orden en que se escriben. El folio de cada paso lo pone C2. */
export interface EntregasDelDia {
  /** La llave del día, para la bitácora: `<sucursal>|<día de venta>|<acreedor>`. */
  llave: string;
  sucursal: string;
  /** Lo que se le entrega a `KeplerSolicitudGastoSinkAdapter` (le falta sólo `tope_dia`). */
  solicitud: DatosSolicitudKepler;
  /** Lo que el escritor del gasto necesita además del folio de la solicitud que acaba de nacer. */
  gasto: { fecha: string; esperado: { total: number; acreedor: string; fecha: string } };
  /** Un pago por cargo del banco, en el orden del banco. Se aplican todos al gasto. */
  pagos: PagoDeCargo[];
  /** El total con IVA (`c16`) y el IVA (`c14`), al centavo. */
  total: number;
  iva: number;
}

export type ResultadoEntregas = { ok: true; entregas: EntregasDelDia } | { ok: false; motivos: string[] };

const cent = (n: unknown): number => Math.round(Number(n) * 100);
const ddmmaaaa = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** `c11` del pago, como lo captura Finanzas: el IVA aparte de su comisión. */
/**
 * ¿El gasto que ya tiene este cargo es el que NOSOTROS escribimos? La propuesta publica el folio como
 * «gasto 0000116», así que se compara por contenido y no por igualdad exacta.
 * ⛔ Sin `gastoPropio` siempre es `false`: el candado sigue cerrado para todo lo demás.
 */
export function esNuestro(keplerGasto: string | null | undefined, gastoPropio?: string | null): boolean {
  const propio = String(gastoPropio ?? '').trim();
  if (!propio) return false;
  return String(keplerGasto ?? '').includes(propio);
}

export const referenciaDelCargo = (tipo: CargoPropuesta['tipo']): string => (tipo === 'iva' ? 'IVA' : 'COMISIONES');

/**
 * Traduce un día `lista` a sus tres entregas, o dice por qué no. **Fail-closed: un motivo basta.** No repite los
 * candados contra duplicados (`candadosDelDia`, C2 los vuelve a correr sobre lo vivo): aquí se revisa que el día
 * tenga con qué escribirse.
 */
export function entregasDelDia(
  d: Pick<DiaPropuesta, 'sucursal' | 'dia_venta' | 'acreedor' | 'banco' | 'cargos'>,
  p: PlantillaComisiones,
  capturadaEn: { fecha: string; hora: string },
  /**
   * ⭐ El folio del gasto que **nosotros ya escribimos** para este día, cuando se está TERMINANDO un día
   * a medias. Los candados de abajo frenan un cargo que ya es renglón de un gasto —correcto para escribir
   * desde cero— pero en un retome ese gasto es el propio, y frenarlo deja la CxP abierta para siempre.
   * ⛔ Sólo exime a ESE folio: un gasto de Finanzas sigue frenando el día entero.
   */
  gastoPropio?: string | null,
): ResultadoEntregas {
  const motivos: string[] = [];
  if (!/^\d{2}$/.test(String(d.sucursal))) motivos.push(`Sucursal Kepler inválida «${d.sucursal}»`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.dia_venta))) motivos.push(`Día de venta inválido «${d.dia_venta}»`);
  if (p.acreedor !== d.acreedor) motivos.push(`La plantilla es del acreedor ${p.acreedor} y el día es de ${d.acreedor}`);
  if (!/^GB/.test(String(p.acreedor ?? ''))) motivos.push(`El acreedor «${p.acreedor || '(vacío)'}» no es un banco (GB…)`);
  for (const k of ['proyecto', 'departamento'] as const) {
    if (!String(p[k] ?? '').trim()) motivos.push(`La plantilla no trae ${k}: no se copia de otra sucursal`);
  }

  const comisiones = d.cargos.filter((c) => c.tipo === 'comision');
  if (!comisiones.length) motivos.push('El día no tiene comisiones: un IVA solo no hace gasto');
  for (const c of d.cargos) {
    if (!(Number(c.importe) > 0)) motivos.push(`El cargo ${c.id} no tiene importe positivo`);
    if (!String(c.cuenta ?? '').trim()) motivos.push(`El cargo ${c.id} no trae cuenta de tesorería`);
    if (c.kepler_pago) motivos.push(`El cargo ${c.id} ya tiene su pago ${c.kepler_pago} en Kepler`);
    if (c.tipo === 'comision' && c.kepler_gasto && !esNuestro(c.kepler_gasto, gastoPropio)) {
      motivos.push(`La comisión ${c.id} ya es renglón del gasto ${c.kepler_gasto}`);
    }
  }
  if (motivos.length) return { ok: false, motivos };

  const base = comisiones.reduce((s, c) => s + cent(c.importe), 0);
  const ivaCent = d.cargos.filter((c) => c.tipo === 'iva').reduce((s, c) => s + cent(c.importe), 0);
  const total = (base + ivaCent) / 100;
  const iva = ivaCent / 100;

  const solicitud: DatosSolicitudKepler = {
    sucursal: d.sucursal,
    acreedor: p.acreedor,
    fechaSolicitud: d.dia_venta,
    fechaPago: d.dia_venta,
    renglones: comisiones.map((c) => ({
      concepto: CONCEPTO_COMISION,
      proyecto: p.proyecto,
      departamento: p.departamento,
      importe: cent(c.importe) / 100,
    })),
    iva,
    // La comisión no trae comprobante: `c25` queda vacío (439 de 442) y `c11` lleva la referencia que esa
    // sucursal usa con ese banco, copiada de su último gasto (`PlantillaComisiones.referenciaGasto`).
    comprobante: { tipo: 'ticket', folio: p.referenciaGasto, fecha: null, uuid: null },
    // ⛔ Y se DECLARA, porque el armador de la solicitud exige la fecha del documento (DS15) y sin esto
    //    rechazaba el día entero: «Falta la fecha del documento que ampara el gasto». Lo encontró el
    //    canario del 2026-11-26. Medido ese día en el ODS, acreedor GB% desde septiembre: de 690 X-A-15 y
    //    653 X-A-10 de comisiones, CERO llevan renglón AMPARA. La regla DS15 es del flujo con ticket o
    //    CFDI y ahí sigue en pie; acá se declara que no hay papel que fechar.
    sinDocumentoQueAmpare: true,
    comentario: `COMISION TARJETA ${p.sucursalNombre} VTAS ${ddmmaaaa(d.dia_venta)}`,
    solicita: SOLICITA_SUITE,
    formaPago: null,
    marca: marcaDeComisiones(d.sucursal, d.dia_venta, p.acreedor),
    // ⭐ Nace AUTORIZADA, no aplicada: medido en el ODS (16 vivas en `A` con su saldo entero). La deja en `F`
    // con saldo 0 el escritor del gasto, como en PGP.
    estado: 'A',
    capturadaEn,
  };

  return {
    ok: true,
    entregas: {
      llave: `${d.sucursal}|${d.dia_venta}|${p.acreedor}`,
      sucursal: d.sucursal,
      solicitud,
      gasto: { fecha: d.dia_venta, esperado: { total, acreedor: p.acreedor, fecha: d.dia_venta } },
      pagos: d.cargos.map((c) => ({
        cargoId: c.id,
        fecha: c.fecha,
        importe: cent(c.importe) / 100,
        referencia: referenciaDelCargo(c.tipo),
        cuenta: c.cuenta,
        banco: String(d.banco ?? ''),
      })),
      total,
      iva,
    },
  };
}
