import type { Resolucion } from '@megadulces/platform-core';

/**
 * `[CC.33]` **Qué escribe un COBRO `U-A-7` en Kepler, decidido sin tocar la base.**
 *
 * Hermano de `ajuste-abono.armador.ts`, y nace igual: la decisión vive aquí, pura y probada sin Postgres; el
 * adaptador sólo ejecuta. Lo que arma salió de **escribir un cobro de verdad** (`CC.25`: `06/U-A-7/0000900`,
 * 2026-11-27) clonando la fila de un cobro real, no de leer un manual.
 *
 * ── Las tres diferencias con el Ajuste Abono, que son las que importan ──────────────────────────────────────────
 *  1. ⭐ **Un cobro lleva PÓLIZA** (`kdc2AAMM`): dos renglones que cuadran, **cargo a bancos (`102`)** y **abono a
 *     clientes (`115`)**, tipo `I` de ingresos. El Ajuste Abono no tiene ninguna.
 *  2. ⭐ **La fecha es la del DEPÓSITO, no la de hoy.** El complemento de pago declara *cuándo se pagó*; fecharlo
 *     el día de la captura sería declarar mal ante el SAT.
 *  3. ⛔⛔ **La caja (`kdm1.c12`) NO se inventa**: sale del cobro anterior del mismo cliente. Es un código por
 *     sucursal (la 06 usa `30003`/`30004`; la 08, `20003`-`20006`) y si el cliente no tiene uno previo, esto se
 *     **niega** en vez de elegir. Por eso entra como dato, no como constante.
 *
 * ⛔⛔ **Y lo que NO hace, declarado donde se arma: NO TIMBRA.** El complemento lo emite el programa `FE4Cobro` de
 * Kepler llamando al PAC con el CSD (`CC.26`), y escribir las tablas no lo dispara. Un cobro escrito por la Suite
 * nace **sin complemento**, igual que los **6 que el propio Kepler dejó así** el 22 y 23 de septiembre en Canindo
 * (`CC.32`). Quien use esto tiene que cerrar el timbre por el camino de Kepler.
 */

/** El capturista con el que la Suite firma en Kepler. El mismo del Ajuste Abono y del pago. */
export const CAPTURISTA_SUITE = 'SUITE';
/** Tipo y serie del cobro en Kepler: `U-A-7` serie 1. */
export const TIPO_COBRO = 7;
export const SERIE_COBRO = 1;
/** `md.kdm1.c11` es `varchar(20)`. */
export const REFERENCIA_MAX = 20;
/** `kdm1.c43`: `N` normal, `C` cancelado (medido: 870 `N` contra 28 `C` en la 06 desde septiembre). */
export const ESTATUS_NORMAL = 'N';
/** `kdue.c29`: el renglón del cobro es un ABONO en la cartera. */
export const ABONO = 'A';
/** Las dos cuentas de la póliza de un cobro, medidas sobre cobros reales. */
export const CUENTA_BANCOS = '102';
export const CUENTA_CLIENTES = '115';
/** `kdc2AAMM.c8`: `I` de ingresos. */
export const POLIZA_INGRESOS = 'I';
/** El concepto de la póliza va cortito; se mide en el renglón real. */
export const CONCEPTO_MAX = 40;

/** Una factura a la que este cobro se aplica. `monto` en pesos: lo que se le abona. */
export interface FacturaDelCobro {
  tipo: number;
  serie: number;
  folio: string;
  monto: number;
  /** Lo que la factura debe HOY en Kepler, releído por el adaptador. Nunca viene de la pantalla. */
  saldo: number;
}

export interface PeticionCobro {
  sucursal: string;
  /** `kdud.c2`. */
  cliente: string;
  /** El nombre del cliente, para el concepto de la póliza. Se lee de `kdud`, no se teclea. */
  nombre: string;
  /** La llave de idempotencia de la Suite, que va a `kdm1.c11`. */
  referencia: string;
  /** ⭐ La fecha del DEPÓSITO (`YYYY-MM-DD`), no la de captura. */
  fecha: string;
  /** `HH:MM` de captura, como lo guarda `kdm1.c69`. */
  hora: string;
  /** La caja del cobro anterior del mismo cliente. Vacía = el adaptador ya debió negarse. */
  caja: string;
  facturas: FacturaDelCobro[];
  /**
   * `[CC.35]` Si el cliente tiene una ficha de CFDI previa que clonar. Sin ella no se escribe la quinta
   * tabla: los datos fiscales del receptor (RFC, nombre, régimen) **no se inventan ni se traen de otro
   * cliente**. El adaptador la busca y dice si la hay.
   */
  hayFichaPrevia?: boolean;
}

/**
 * `[CC.35]` **La quinta tabla: la ficha del CFDI (`kdfe33m1`) tal como Kepler la deja ANTES de timbrar.**
 *
 * Medido el 2026-11-27 sobre las 892 fichas de cobro de la 06:
 *  · `c3` (folio del CFDI) **= `c13`** (folio del cobro) en **892 de 892**: no hay contador aparte.
 *  · `c2` (serie) = sucursal + código de documento (`06UA0701`) en **892 de 892**.
 *  · Sin timbrar, `c4/c5` = **`1/0`** (21 casos). Timbrada, `4/1` (864); `3/0` son 7 (cancelaciones).
 *  · `c15` = `4.0`, la versión que la pantalla de Kepler exige y que a nuestro cobro le faltaba.
 *
 * ⛔⛔ **Lo que queda VACÍO y no se escribe nunca:** los dos sellos, las rutas del `.key` y del `.cer`, la
 * ruta del XML, el **folio fiscal (UUID)**, el sello del SAT y el nombre del programa. Eso lo pone el PAC a
 * través de Kepler. Escribir cualquiera de esos campos sería **falsificar un comprobante fiscal**.
 */
export const CFDI_VERSION = '4.0';
/** `c4`/`c5` de una ficha **creada y sin timbrar**. */
export const CFDI_CREADA = { c4: 1, c5: 0 } as const;
/**
 * Las columnas que el PAC llena al timbrar. Se **vacían** al clonar: si la plantilla venía timbrada, su
 * UUID y sus sellos son de OTRO documento y copiarlos sería inventar un comprobante.
 */
export const CFDI_DEL_PAC = [
  'c46', 'c47', 'c48', 'c49', 'c50', 'c51', 'c52', 'c53', 'c54', 'c55', 'c56', 'c57', 'c58', 'c59',
  'c60', 'c61', 'c62', 'c65', 'c66',
] as const;

/** Sólo las columnas DECIDIDAS: las demás salen de la plantilla clonada. */
export interface PlanCobro {
  kdm1: Record<string, unknown>;
  kdue: Record<string, unknown>;
  kdm5: Record<string, unknown>[];
  /** Los dos renglones de la póliza, ya cuadrados. `cuenta` elige cuál de la plantilla se clona. */
  poliza: { cuenta: string; campos: Record<string, unknown> }[];
  /**
   * `[CC.35]` La ficha del CFDI, sin timbrar. `vaciar` son las columnas del PAC que se limpian al clonar.
   * ⛔ `null` cuando no se va a escribir (el cliente no tiene una ficha previa que clonar).
   */
  cfdi: { campos: Record<string, unknown>; vaciar: readonly string[] } | null;
  /** `kdc2AAMM` de la fecha del depósito: una tabla por mes. */
  tablaPoliza: string;
  total: number;
  facturas: number;
  /** ⛔ Siempre `false`: escribir las tablas no timbra (`CC.26`). Va en el plan para que nadie lo olvide. */
  timbra: false;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const ES_FECHA = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ES_HORA = /^[0-9]{2}:[0-9]{2}$/;

/** `kdc2AAMM` de una fecha `YYYY-MM-DD`: el cobro vive en la póliza de SU mes, no del mes de captura. */
export function tablaDePoliza(fecha: string): string {
  return `kdc2${fecha.slice(2, 4)}${fecha.slice(5, 7)}`;
}

/**
 * Arma el cobro, o dice por qué no. ⛔ Cada negativa de abajo es una que ya costó algo: la referencia que no cabe,
 * la factura que se cobraría de más, la caja que no se puede adivinar.
 */
export function armarCobro(p: PeticionCobro): Resolucion<PlanCobro> {
  const ref = (p.referencia ?? '').trim();
  if (!ref) return { ok: false, motivo: 'El cobro necesita una referencia: es su llave de idempotencia en Kepler.' };
  if (ref.length > REFERENCIA_MAX) {
    return { ok: false, motivo: `La referencia ${ref} tiene ${ref.length} caracteres y kdm1.c11 admite ${REFERENCIA_MAX}.` };
  }
  if (!ES_FECHA.test(p.fecha ?? '')) {
    return { ok: false, motivo: `La fecha del depósito ${p.fecha} no es YYYY-MM-DD: el complemento declara cuándo se pagó.` };
  }
  if (!ES_HORA.test(p.hora ?? '')) return { ok: false, motivo: `La hora ${p.hora} no es HH:MM.` };
  const caja = (p.caja ?? '').trim();
  if (!caja) {
    return { ok: false, motivo: `No se sabe por qué caja entra el cobro del cliente ${p.cliente}: sin un cobro anterior suyo no se inventa.` };
  }
  const cliente = (p.cliente ?? '').trim();
  if (!cliente) return { ok: false, motivo: 'El cobro necesita el cliente.' };

  const fs = p.facturas ?? [];
  if (!fs.length) return { ok: false, motivo: 'Un cobro se aplica a por lo menos una factura.' };
  const vistas = new Set<string>();
  for (const f of fs) {
    const id = `${f.tipo}-${f.serie}-${f.folio}`;
    if (vistas.has(id)) return { ok: false, motivo: `La factura ${id} viene dos veces: se le abonaría doble.` };
    vistas.add(id);
    if (!Number.isFinite(f.monto) || f.monto <= 0) {
      return { ok: false, motivo: `A la factura ${id} se le aplicaría ${f.monto}: un abono es mayor que cero.` };
    }
    // ⛔ El control que impide cobrar de más: nunca se abona arriba de lo que la factura debe HOY.
    if (!Number.isFinite(f.saldo) || r2(f.monto) > r2(f.saldo) + 0.005) {
      return {
        ok: false,
        motivo: `La factura ${id} debe ${Number(f.saldo).toFixed(2)} y se le aplicarían ${f.monto.toFixed(2)}: un cobro no deja saldo a favor.`,
      };
    }
  }

  const total = r2(fs.reduce((s, f) => s + Number(f.monto), 0));
  if (total <= 0) return { ok: false, motivo: 'El cobro suma cero.' };
  const concepto = (p.nombre ?? '').trim().slice(0, CONCEPTO_MAX);

  return {
    ok: true,
    valor: {
      kdm1: {
        c9: p.fecha, c68: p.fecha, c69: p.hora, c10: cliente, c11: ref,
        c12: caja, c16: total, c42: total, c43: ESTATUS_NORMAL, c67: CAPTURISTA_SUITE,
      },
      kdue: { c2: cliente, c7: p.fecha, c11: total, c16: ref, c17: total, c29: ABONO },
      kdm5: fs.map((f, i) => ({
        c7: i + 1, c9: f.tipo, c10: f.serie, c11: f.folio, c12: r2(f.monto), c13: r2(f.monto), c14: ref,
      })),
      // ⭐ Cuadra por construcción: el MISMO total a las dos cuentas, una de cargo y otra de abono.
      poliza: [
        { cuenta: CUENTA_BANCOS, campos: { c5: total, c4: 'C', c6: concepto } },
        { cuenta: CUENTA_CLIENTES, campos: { c5: total, c4: 'A', c6: concepto } },
      ],
      // `[CC.35]` La ficha del CFDI, en el estado «creada, sin timbrar». Sólo si hay una previa del MISMO
      // cliente que clonar: los datos fiscales del receptor no se inventan.
      cfdi: p.hayFichaPrevia
        ? {
            campos: {
              c3: '', c13: '', c6: p.fecha, c7: `${p.fecha}T${p.hora}:00`,
              c15: CFDI_VERSION, ...CFDI_CREADA,
            },
            vaciar: CFDI_DEL_PAC,
          }
        : null,
      tablaPoliza: tablaDePoliza(p.fecha),
      total,
      facturas: fs.length,
      timbra: false,
    },
  };
}
