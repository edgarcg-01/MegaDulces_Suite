/**
 * `[GP.A.1]` **¿Este pedido de telemarketing se autoriza solo?** — regla PURA del anexo EA de GP
 * (`FASES/FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md` §3.1; D-A3 de Edgar, 2026-11-19: dentro del límite se
 * autoriza solo, siempre avisando a Crédito y cobranza).
 *
 * Un pedido TELEMARK nace `CREADO` en Kepler y hoy alguien lo autoriza a mano. Autorizar sólo cambia
 * `kdm1.c11` (GP.A.0a, medido: ni renglones, ni existencia, ni cartera). Esta función no escribe nada:
 * dice qué hacer y POR QUÉ, con los números que vio. Quien escribe es GP.A.2.
 *
 * Las siete condiciones se evalúan TODAS (no se corta en la primera): Crédito y cobranza ve cada motivo,
 * no sólo el primero. La decisión:
 *  - `aparte`    el pedido es viejo (condición 7): no entra ni al automático ni a la bandeja del día.
 *  - `bandeja`   falló alguna otra: decide Crédito y cobranza (y si no, Dirección General).
 *  - `autorizar` pasaron las siete.
 *
 * ⛔ Lo que no se pudo leer NO se da por bueno (ADR-056): un saldo, una cartera, un nombre o una frescura
 * desconocidos mandan el pedido a la bandeja con «no pude verificar…», nunca lo autorizan.
 */

import { SALDO_CERO, esRestoDeFactura } from '@megadulces/contracts';

/**
 * Los parámetros los fija Crédito y cobranza en la Suite (D-A6, D-A10), no el código. Se reciben siempre;
 * {@link PARAMETROS_PROPUESTOS} es sólo la propuesta del anexo mientras no los firme.
 */
export interface ParametrosAutorizacion {
  /** Días de gracia sobre el vencimiento antes de que un vencido detenga el automático (D-A6). */
  graciaDias: number;
  /** Un pedido con más de estos días sin movimiento es «viejo» y se lista aparte (D-A4/D-A10). */
  pedidoViejoDias: number;
  /** La cartera y el pedido se leyeron hace a lo más estos minutos (condición 5). */
  frescuraMaxMin: number;
}

/** La propuesta del anexo (§3.1, D-A6, D-A10). NO está firmada: es lo que se le propone a Crédito y cobranza. */
export const PARAMETROS_PROPUESTOS: Readonly<ParametrosAutorizacion> = Object.freeze({
  graciaDias: 15,
  pedidoViejoDias: 30,
  frescuraMaxMin: 15,
});

/** El cliente está bloqueado si su nombre en el `kdud` de la sucursal del pedido EMPIEZA con esto (GP.A.0c). */
export const MARCA_BLOQUEO = 'NO TOCAR';

/** Una factura viva del cliente, de la cartera CXC. Fechas `YYYY-MM-DD`. */
export interface FacturaDelCliente {
  saldo: number;
  importe: number;
  vencimiento: string | null;
}

export interface EntradaAutorizacion {
  /** Hoy, en la zona de México, `YYYY-MM-DD`. */
  hoy: string;
  pedido: {
    importe: number;
    /** Fecha del pedido, `YYYY-MM-DD`. */
    fecha: string;
    /** Último movimiento conocido, si hay; si no, cuenta la fecha del pedido. */
    ultimo_movimiento?: string | null;
  };
  cliente: {
    /** Nombre en el `kdud` de la sucursal del pedido. null = no se pudo leer. */
    nombre: string | null;
    /** `kdud.c15`. null o 0 = sin límite. */
    limite: number | null;
  };
  /** Saldo vivo del cliente en la cartera. null = no se pudo leer. */
  saldo_vivo: number | null;
  /** Lo de sus OTROS pedidos abiertos sin facturar. null = no se pudo leer. */
  pedidos_abiertos: number | null;
  /** Sus facturas vivas. null = no se pudo leer la cartera. */
  facturas: FacturaDelCliente[] | null;
  /** Minutos desde la lectura más vieja (cartera o pedido). null = desconocido. */
  edad_datos_min: number | null;
  carril: {
    /** El interruptor de la sucursal (`kepler_push_switch`). */
    encendido: boolean;
    autorizados_hoy: number;
    /** Tope del día. null = sin tope configurado. */
    tope_dia: number | null;
  };
}

export type DecisionAutorizacion = 'autorizar' | 'bandeja' | 'aparte';
export type CondicionAutorizacion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface MotivoAutorizacion {
  condicion: CondicionAutorizacion;
  /** Una frase para Crédito y cobranza: «excede $4,200.00 su límite». */
  texto: string;
}

export interface ResultadoAutorizacion {
  decision: DecisionAutorizacion;
  /** true = cliente marcado «NO TOCAR»: en la bandeja se ve, pero no se puede autorizar. */
  bloqueado: boolean;
  motivos: MotivoAutorizacion[];
  /** Los números que vio la regla, para la bandeja y la bitácora (GP.A.2). null = no se pudo calcular. */
  numeros: {
    limite: number | null;
    comprometido: number | null;
    excedente: number | null;
    vencido_fuera_de_gracia: number | null;
    dias_vencido_max: number | null;
    /** Centavos que la regla NO contó como vencido (`[GP.R.1]`). */
    resto_ignorado: number;
    dias_sin_movimiento: number | null;
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const dinero = (n: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(n);

/** Días de `desde` a `hasta` (`YYYY-MM-DD`), por calendario. null si alguna fecha no se entiende. */
export function diasEntre(desde: string, hasta: string): number | null {
  const a = Date.parse(`${desde.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${hasta.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** El nombre del cliente lleva la marca de bloqueo de Kepler (al inicio, sin importar mayúsculas). */
export function clienteBloqueado(nombre: string): boolean {
  return nombre.trim().toUpperCase().startsWith(MARCA_BLOQUEO);
}

export function decidirAutorizacion(e: EntradaAutorizacion, p: ParametrosAutorizacion): ResultadoAutorizacion {
  const motivos: MotivoAutorizacion[] = [];
  const falla = (condicion: CondicionAutorizacion, texto: string) => motivos.push({ condicion, texto });

  // 1 · tiene límite
  const limite = e.cliente.limite != null && e.cliente.limite > 0 ? e.cliente.limite : null;
  if (limite == null) falla(1, 'sin límite en Kepler');

  // 2 · saldo + otros pedidos + este pedido ≤ límite
  let comprometido: number | null = null;
  let excedente: number | null = null;
  if (e.saldo_vivo == null || e.pedidos_abiertos == null) {
    falla(2, 'no pude verificar el saldo');
  } else {
    comprometido = r2(Math.max(e.saldo_vivo, 0) + Math.max(e.pedidos_abiertos, 0) + e.pedido.importe);
    if (limite != null && comprometido > limite + SALDO_CERO) {
      excedente = r2(comprometido - limite);
      falla(2, `excede ${dinero(excedente)} su límite`);
    }
  }

  // 3 · nada vencido fuera de la gracia; los restos de centavos no cuentan
  let vencido: number | null = null;
  let diasMax: number | null = null;
  let resto = 0;
  if (e.facturas == null) {
    falla(3, 'no pude verificar lo vencido');
  } else {
    vencido = 0;
    let sinFecha = false;
    for (const f of e.facturas) {
      if (!(f.saldo > SALDO_CERO)) continue;
      if (esRestoDeFactura(f.saldo, f.importe)) { resto += f.saldo; continue; }
      const dias = f.vencimiento ? diasEntre(f.vencimiento, e.hoy) : null;
      if (dias == null) { sinFecha = true; continue; }
      if (dias > p.graciaDias) {
        vencido += f.saldo;
        diasMax = Math.max(diasMax ?? 0, dias);
      }
    }
    vencido = r2(vencido);
    if (vencido > SALDO_CERO) falla(3, `tiene ${dinero(vencido)} vencidos desde hace ${diasMax} días`);
    if (sinFecha) falla(3, 'tiene facturas sin fecha de vencimiento: no pude verificar lo vencido');
  }

  // 4 · no está bloqueado
  let bloqueado = false;
  if (e.cliente.nombre == null) falla(4, 'no pude leer el cliente en Kepler');
  else if (clienteBloqueado(e.cliente.nombre)) { bloqueado = true; falla(4, 'el cliente está marcado «NO TOCAR» en Kepler'); }

  // 5 · datos frescos
  if (e.edad_datos_min == null) falla(5, 'no pude verificar el saldo: no sé de cuándo es la lectura');
  else if (e.edad_datos_min > p.frescuraMaxMin) falla(5, `no pude verificar el saldo: la lectura es de hace ${Math.round(e.edad_datos_min)} min`);

  // 6 · el carril de la sucursal
  if (!e.carril.encendido) falla(6, 'la autorización automática está apagada en esta sucursal');
  else if (e.carril.tope_dia == null) falla(6, 'la sucursal no tiene tope del día configurado');
  else if (e.carril.autorizados_hoy >= e.carril.tope_dia) falla(6, `ya se autorizaron ${e.carril.autorizados_hoy} hoy: es el tope del día`);

  // 7 · el pedido no es viejo
  const diasSinMov = diasEntre(e.pedido.ultimo_movimiento ?? e.pedido.fecha, e.hoy);
  const viejo = diasSinMov == null || diasSinMov > p.pedidoViejoDias;
  if (diasSinMov == null) falla(7, 'no entiendo la fecha del pedido');
  else if (viejo) falla(7, `lleva ${diasSinMov} días sin movimiento`);

  const decision: DecisionAutorizacion = viejo ? 'aparte' : motivos.length ? 'bandeja' : 'autorizar';
  return {
    decision,
    bloqueado,
    motivos,
    numeros: {
      limite,
      comprometido,
      excedente,
      vencido_fuera_de_gracia: vencido,
      dias_vencido_max: diasMax,
      resto_ignorado: r2(resto),
      dias_sin_movimiento: diasSinMov,
    },
  };
}
