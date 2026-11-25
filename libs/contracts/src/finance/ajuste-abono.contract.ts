/**
 * `[GP.R.2]` — **Lo que la pantalla manda y lo que contesta el cierre de un resto de centavos de un cliente.**
 *
 * El documento es el **Ajuste Abono `U-A-30`** que Kepler ya trae; reemplaza al «Cobro» de centavos que Crédito y
 * cobranza usa hoy (74 en 60 días contra cero Ajustes Abono), porque un cobro afirma que entró dinero y no entró.
 *
 * ⛔⛔ **Un Ajuste Abono NO emite CFDI, y eso importa con «todo PPD»** (Edgar, 2026-11-25). Medido en prod el
 * 2026-11-25 sobre los 9,889 complementos de pago de 2026 (control aritmético `ImpSaldoAnt − ImpPagado =
 * ImpSaldoInsoluto`: 0 de 15,160 renglones sin cuadrar):
 *  · 9,736 facturas quedaron **cerradas** ante el SAT (insoluto 0.00);
 *  · **1,782 quedaron con un resto de centavos VIVO ante el SAT** ($729.78 en total) — y ésas ya están timbradas:
 *    un complemento no se edita.
 * Y los 260 restos que la cartera ve hoy son **todos** de facturas de crédito, que se emiten **PPD** (la serie lo
 * dice: `NNUD0801` → PPD · `NNUD0501` → PUE). O sea: cerrar el resto en Kepler **no lo cierra ante el SAT**.
 * Por eso cada ajuste **declara** el insoluto que deja ({@link ResultadoAjusteAbono.cfdi_insoluto}) en vez de
 * dibujar la factura como saldada. Cerrarlo de verdad es otro documento —la nota de crédito `U-A-21`, que sí
 * timbra— y eso **no lo puede hacer la Suite**: el timbre lo pone Kepler. Decisión abierta: D-F10.
 */

/** Una factura con resto, como la manda la pantalla. El servidor NO le cree el saldo: lo relee de Kepler. */
export interface FacturaRestoBody {
  /** `kdm1.c4` (8 = Factura Telemarketing, 6 = Venta crédito). */
  tipo: number;
  /** `kdm1.c5`. */
  serie: number;
  /** `kdm1.c6`, sin espacios. */
  folio: string;
}

export interface CerrarRestosBody {
  cliente: string;
  facturas: FacturaRestoBody[];
  /** Por qué se cierra. Obligatorio salvo en el automático: queda con el nombre de quien lo decidió. */
  motivo: string;
}

export type EstadoAjusteAbono = 'escrito' | 'ya_estaba' | 'apagado' | 'rechazado';

export interface ResultadoAjusteAbono {
  estado: EstadoAjusteAbono;
  /** Para la persona, en una línea. */
  mensaje: string;
  /** El folio del `U-A-30` que Kepler dio, cuando lo dio. */
  kepler_folio?: string | null;
  /** La llave de idempotencia de la Suite (`kdm1.c11`, `varchar(20)`). */
  referencia?: string;
  /** Lo que se cerró, al centavo. */
  total?: number;
  facturas?: number;
  /**
   * ⛔ Lo que cada factura **sigue debiendo ante el SAT** después del ajuste, cuando se pudo medir.
   * `null` = NO MEDIDO (no se pudo leer su complemento), nunca cero por omisión.
   */
  cfdi_insoluto?: number | null;
  /** Si repetir el intento puede funcionar (se cayó la red, no un rechazo de negocio). */
  reintentable?: boolean;
}

/** El tope del resto por factura lo fija D-R1 en `resto-tolerado.contract.ts` (`RESTO_TOLERADO_CLIENTE`). */
export const AJUSTE_ABONO_MOTIVO_MAX = 200;
