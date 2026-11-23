/**
 * `[GP.A.1]` **¿Este pedido de telemarketing se autoriza solo?** — regla PURA del anexo EA de GP
 * (`FASES/FASE_GP_ANEXO_AUTORIZACION_PEDIDOS.md` §3.1; D-A3 de Edgar, 2026-11-19: dentro del límite se
 * autoriza solo, siempre avisando a Crédito y cobranza).
 *
 * Un pedido TELEMARK nace `CREADO` en Kepler y hoy alguien lo autoriza a mano. Autorizar sólo cambia
 * `kdm1.c11` (GP.A.0a, medido: ni renglones, ni existencia, ni cartera). Esta función no escribe nada:
 * dice qué hacer y POR QUÉ, con los números que vio. Quien escribe es GP.A.2.
 *
 * Las ocho condiciones se evalúan TODAS (no se corta en la primera): Crédito y cobranza ve cada motivo,
 * no sólo el primero. La decisión:
 *  - `aparte`    el pedido es viejo (7) o de la ruta vecinal (8, D-A13): ni automático ni bandeja del día.
 *  - `bandeja`   falló alguna otra: decide Crédito y cobranza (y si no, Dirección General).
 *  - `autorizar` pasaron todas. A CONTADO no le aplican las de crédito (1, 2 y 3; D-A12).
 *
 * ⛔ Lo que no se pudo leer NO se da por bueno (ADR-056): un saldo, una cartera, un nombre o una frescura
 * desconocidos mandan el pedido a la bandeja con «no pude verificar…», nunca lo autorizan.
 */

import { SALDO_CERO, esRestoDeFactura } from './resto-tolerado.contract';
import { diasEntre } from './pago-vencido.contract';
import type { Freshness } from '../http/provenance.contract';

/**
 * Los parámetros los fija Crédito y cobranza en la Suite (D-A6, D-A10), no el código. Se reciben siempre;
 * {@link PARAMETROS_PROPUESTOS} es sólo la propuesta del anexo mientras no los firme.
 */
export interface ParametrosAutorizacion {
  /** Días de gracia sobre el vencimiento antes de que un vencido detenga el automático (D-A6). */
  graciaDias: number;
  /** Un pedido con más de estos días sin movimiento es «viejo» y se lista aparte (D-A4/D-A10). */
  pedidoViejoDias: number;
  /**
   * Los OTROS pedidos abiertos del cliente que cuentan contra su crédito: los de estos últimos días. Aparte de
   * `pedidoViejoDias` porque son preguntas distintas: un pedido AUTORIZADO de hace una semana sin surtir sigue
   * comprometiendo crédito, aunque un CREADO de esa edad ya esté muerto.
   */
  abiertosHorizonteDias: number;
  /** La cartera y el pedido se leyeron hace a lo más estos minutos (condición 5). */
  frescuraMaxMin: number;
}

/** La propuesta del anexo (§3.1, D-A6, D-A10). NO está firmada: es lo que se le propone a Crédito y cobranza. */
export const PARAMETROS_PROPUESTOS: Readonly<ParametrosAutorizacion> = Object.freeze({
  graciaDias: 15,
  // Medido en prod el 2026-11-20 (TELEMARK de 60 días, sin cancelados ni ruta vecinal): de los capturados hace 0–1
  // días quedan en CREADO 0 de 115; de ahí en adelante, un 1 % que ya no baja (2 de 121 a los 2–3 días, 18 de 1,387 a
  // los 31–60): todo lo que se autoriza se autoriza el mismo día o al siguiente. Lo que sigue en CREADO después es
  // un pedido muerto. Crédito y cobranza lo dijo de los 6 de contado del reporte (de 3 a 30 días): «eran viejos y no
  // debían pasar». Antes, 30 (propuesta sin medir).
  pedidoViejoDias: 2,
  abiertosHorizonteDias: 30,
  frescuraMaxMin: 15,
});

/**
 * `[GP.A.0b]` **El «Monto por Cobrar» de Kepler, con SU fórmula** (pantalla Finanzas › Crédito y cobranza ›
 * Operación CFDI › Autorización de Pedidos). Decodificado el 2026-11-20 contra la captura de Zamora Centro:
 * **9 de 9 clientes al centavo**, incluido uno negativo (−7,610.28):
 *
 *     Σ cargos del cliente en `kdue` (c29 = 'C') SIN los tickets de contado (tipo 10)  −  Σ todos sus abonos (c29 = 'A')
 *
 * Crudo: no aplica abonos factura por factura. Lo que lo aleja de la cartera de la Suite son las facturas de
 * ticket (`U-D-5` «Fac», que apuntan a su `U-D-10` por `c37/c38/c39`) sin abono aplicado; en telemarketing,
 * 60 días: 22 de 445 clientes difieren y la condición 2 da el mismo veredicto en 2,975 de 2,975 pedidos.
 */
/** La suma de Kepler, para meterla en un GROUP BY por lote. `x` es el alias de `kepler_ods.kdue`. */
export const porCobrarKeplerSuma = (x = 'x'): string =>
  `coalesce(sum(${x}.c11::numeric) FILTER (WHERE ${x}.c29 = 'C' AND ${x}.c4 <> 10), 0) - coalesce(sum(${x}.c11::numeric) FILTER (WHERE ${x}.c29 = 'A'), 0)`;

/**
 * La misma, para un cliente. La llave va CRUDA (`c1`, `c2` sin `btrim`): medido el 2026-11-20, ninguna de las 745 mil
 * filas de `kdue` trae espacios en `c1` ni `c2`, y así entra por `kdue_pkey` (30 clientes en 20 ms). Un barrido de la
 * red con `btrim` se pasó del tiempo límite de 5 minutos (no se midió cuánto aportó cada parte).
 */
export const POR_COBRAR_KEPLER_SQL = `
  SELECT ${porCobrarKeplerSuma('x')} AS por_cobrar
    FROM kepler_ods.kdue x
   WHERE x.sucursal = $1 AND x.c1 = $1 AND x.c2 = $2`;

/**
 * Las marcas de bloqueo que Kepler escribe al INICIO del nombre del cliente (`kdud.c3`), por sucursal.
 *
 * `[GP.A.0c]` midió «NO TOCAR»: 235 filas, 158 claves, 145 de ellas con límite vivo. **Pero la medición buscó
 * ocho palabras y «NO USAR» no estaba entre ellas.** Encontrada el 2026-11-23 en un caso real de la bandeja
 * («NO USARRRRRRRRMA. LOURDES ENCINO ALEMAN», Padre Hidalgo): **63 filas más, 40 claves, 3 con límite vivo**
 * que la regla no veía — y el panel decía «No está marcado NO TOCAR ✔» con el nombre gritando lo contrario.
 *
 * ⛔ Van al INICIO y se comparan así: «contiene» daría falsos positivos (el `BAJA` de GP.A.0c, 10 filas, todas
 * de «trabajadores»). Si aparece otra forma, se agrega aquí y se mide cuántas filas trae.
 */
export const MARCAS_BLOQUEO = ['NO TOCAR', 'NO USAR'] as const;
/** @deprecated Se conserva para no romper a quien la importe; la regla usa `MARCAS_BLOQUEO`. */
export const MARCA_BLOQUEO = MARCAS_BLOQUEO[0];

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
    /**
     * `[D-A13]` Lo capturó la ruta vecinal (vendedor `3V…`, `kdm1.c12`) aunque diga TELEMARK. Edgar, 2026-11-20: va aparte,
     * ni automático ni bandeja del día (eran 49 de los 64 de la bandeja, todos de Zamora Centro, nunca facturados).
     */
    ruta_vecinal?: boolean;
  };
  cliente: {
    /** Nombre en el `kdud` de la sucursal del pedido. null = no se pudo leer. */
    nombre: string | null;
    /** `kdud.c15`. null o 0 = sin límite. */
    limite: number | null;
    /**
     * `[D-A12]` La cuenta CONTADO (venta de contado). Edgar, 2026-11-20: no usa crédito, así que las condiciones de
     * crédito (1, 2 y 3) no le aplican; las demás sí.
     */
    es_contado?: boolean;
  };
  /**
   * El «Monto por Cobrar» de la pantalla Autorización de Pedidos de Kepler, **con la fórmula de Kepler**
   * ({@link POR_COBRAR_KEPLER_SQL}, GP.A.0b: 9 de 9 al centavo). Puede ser negativo (saldo a favor) y así
   * cuenta, como en Kepler. null = no se pudo leer.
   */
  por_cobrar_kepler: number | null;
  /**
   * Lo de sus OTROS pedidos abiertos sin facturar. **Agregado de la Suite** (Kepler no lo suma): evita que
   * varios pedidos que caben uno por uno se autoricen juntos por encima del límite. null = no se pudo leer.
   */
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
export type CondicionAutorizacion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

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

/** Días de calendario con el `diasEntre` de pago-vencido (un solo cálculo); null si alguna fecha no se entiende. */
function dias(desde: string, hasta: string): number | null {
  const d = diasEntre(desde, hasta);
  return Number.isFinite(d) ? d : null;
}

/** El nombre del cliente lleva alguna marca de bloqueo de Kepler (al inicio, sin importar mayúsculas). */
export function clienteBloqueado(nombre: string): boolean {
  const n = nombre.trim().toUpperCase();
  return MARCAS_BLOQUEO.some((m) => n.startsWith(m));
}

/** Cuál de las marcas trae, para decirlo tal cual en la pantalla en vez de nombrar sólo una. */
export function marcaDeBloqueo(nombre: string): string | null {
  const n = nombre.trim().toUpperCase();
  return MARCAS_BLOQUEO.find((m) => n.startsWith(m)) ?? null;
}

export function decidirAutorizacion(e: EntradaAutorizacion, p: ParametrosAutorizacion): ResultadoAutorizacion {
  const motivos: MotivoAutorizacion[] = [];
  const falla = (condicion: CondicionAutorizacion, texto: string) => motivos.push({ condicion, texto });

  // [D-A12] Contado no usa crédito: las condiciones 1, 2 y 3 no le aplican.
  const credito = !e.cliente.es_contado;

  // 1 · tiene límite
  const limite = e.cliente.limite != null && e.cliente.limite > 0 ? e.cliente.limite : null;
  if (credito && limite == null) falla(1, 'sin límite en Kepler');

  // 2 · por cobrar (fórmula de Kepler) + otros pedidos + este pedido ≤ límite
  let comprometido: number | null = null;
  let excedente: number | null = null;
  if (!credito) {
    // contado: nada que comparar contra un límite
  } else if (e.por_cobrar_kepler == null || e.pedidos_abiertos == null) {
    falla(2, 'no pude verificar el saldo');
  } else {
    comprometido = r2(e.por_cobrar_kepler + Math.max(e.pedidos_abiertos, 0) + e.pedido.importe);
    if (limite != null && comprometido > limite + SALDO_CERO) {
      excedente = r2(comprometido - limite);
      falla(2, `excede ${dinero(excedente)} su límite`);
    }
  }

  // 3 · nada vencido fuera de la gracia; los restos de centavos no cuentan
  let vencido: number | null = null;
  let diasMax: number | null = null;
  let resto = 0;
  if (!credito) {
    // contado: su cartera no es la de un cliente con crédito
  } else if (e.facturas == null) {
    falla(3, 'no pude verificar lo vencido');
  } else {
    vencido = 0;
    let sinFecha = false;
    for (const f of e.facturas) {
      if (!(f.saldo > SALDO_CERO)) continue;
      if (esRestoDeFactura(f.saldo, f.importe)) { resto += f.saldo; continue; }
      const atraso = f.vencimiento ? dias(f.vencimiento, e.hoy) : null;
      if (atraso == null) { sinFecha = true; continue; }
      if (atraso > p.graciaDias) {
        vencido += f.saldo;
        diasMax = Math.max(diasMax ?? 0, atraso);
      }
    }
    vencido = r2(vencido);
    if (vencido > SALDO_CERO) falla(3, `tiene ${dinero(vencido)} vencidos desde hace ${diasMax} días`);
    if (sinFecha) falla(3, 'tiene facturas sin fecha de vencimiento: no pude verificar lo vencido');
  }

  // 4 · no está bloqueado
  let bloqueado = false;
  if (e.cliente.nombre == null) falla(4, 'no pude leer el cliente en Kepler');
  else if (clienteBloqueado(e.cliente.nombre)) { bloqueado = true; falla(4, `el cliente está marcado «${marcaDeBloqueo(e.cliente.nombre)}» en Kepler`); }

  // 5 · datos frescos
  if (e.edad_datos_min == null) falla(5, 'no pude verificar el saldo: no sé de cuándo es la lectura');
  else if (e.edad_datos_min > p.frescuraMaxMin) falla(5, `no pude verificar el saldo: la lectura es de hace ${Math.round(e.edad_datos_min)} min`);

  // 6 · el carril de la sucursal
  if (!e.carril.encendido) falla(6, 'la autorización automática está apagada en esta sucursal');
  // [D-A14] Sin tope = el interruptor encendido sólo para autorizar a mano desde la Suite; el automático no corre.
  else if (e.carril.tope_dia == null) falla(6, 'en esta sucursal la Suite sólo autoriza a mano (sin tope del día)');
  else if (e.carril.autorizados_hoy >= e.carril.tope_dia) falla(6, `ya se autorizaron ${e.carril.autorizados_hoy} hoy: es el tope del día`);

  // 7 · el pedido no es viejo
  const diasSinMov = dias(e.pedido.ultimo_movimiento ?? e.pedido.fecha, e.hoy);
  const viejo = diasSinMov == null || diasSinMov > p.pedidoViejoDias;
  if (diasSinMov == null) falla(7, 'no entiendo la fecha del pedido');
  else if (viejo) falla(7, `lleva ${diasSinMov} días sin movimiento`);

  // 8 · [D-A13] no es de la ruta vecinal
  const vecinal = e.pedido.ruta_vecinal === true;
  if (vecinal) falla(8, 'es de la ruta vecinal: va aparte');

  const decision: DecisionAutorizacion = viejo || vecinal ? 'aparte' : motivos.length ? 'bandeja' : 'autorizar';
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

/** Cómo paga el cliente, de sus facturas ya pagadas en la cartera. Lo que no hay se dice `null`, no 0. */
export interface PagoDelCliente {
  facturas_pagadas: number;
  /** Mediana de días de la factura a su último cobro. */
  mediana_dias: number | null;
  /** Cuántas pagó dentro de su plazo (`kdud.c16`). null = sin plazo en Kepler. */
  a_tiempo: number | null;
  /** El peor atraso sobre su plazo, en días. */
  peor_atraso: number | null;
}

/** `[GP.A.4]` Un pedido TELEMARK en `CREADO`, con lo que vio la regla y lo que necesita el panel (§3.6). */
export interface PedidoPorAutorizar {
  sucursal: string;
  sucursal_nombre: string;
  serie: number;
  folio: string;
  fecha: string;
  dias_esperando: number | null;
  cliente: string;
  cliente_nombre: string | null;
  /** La cuenta CONTADO (venta de contado): sin «por cobrar» de Kepler ni cartera, porque no es un cliente con crédito. */
  es_contado: boolean;
  /** `[D-A13]` Lo capturó la ruta vecinal: va aparte con esa etiqueta. */
  ruta_vecinal: boolean;
  importe: number;
  /** El veredicto de `decidirAutorizacion`, con sus motivos y números. */
  resultado: ResultadoAutorizacion;
  limite: number | null;
  plazo_dias: number | null;
  por_cobrar_kepler: number | null;
  /** Lo que el cliente debe según la cartera de la Suite; la diferencia con Kepler va al panel («lo que Kepler no dice»). */
  saldo_cartera: number | null;
  otros_pedidos: number | null;
  /**
   * `[GP.A.5d]` Cuáles son esos otros pedidos. Ya se leían para sumarlos; se publican para que el total se
   * pueda abrir (Edgar, 2026-11-23: la información completa, pero sólo cuando la pidan).
   */
  otros_pedidos_detalle: { serie: number; folio: string; fecha: string; importe: number }[];
  pago: PagoDelCliente;
  /**
   * `[GP.A.4b]` La última decisión de la Suite sobre ESTE pedido que sigue en pie. `null` = nadie decidió aquí
   * todavía. Sin esto, un pedido rechazado (que no cambia nada en Kepler: sigue `CREADO`) volvería a la bandeja
   * cada día como si nadie lo hubiera visto.
   */
  decision: DecisionVigente | null;
}

/** `[GP.A.4b]` Lo que la Suite ya decidió sobre un pedido, para que la bandeja no lo vuelva a pedir. */
export interface DecisionVigente {
  accion: AccionDecisionPedido;
  estado: EstadoDecisionPedido;
  /** Lo que escribió quien decidió. Vacío en las automáticas (las decide la regla, no una persona). */
  motivo: string | null;
  automatica: boolean;
  /** Quién decidió. `null` = la regla (automática). */
  quien: string | null;
  cuando: string;
}

export interface BandejaAutorizacion {
  hoy: string;
  freshness: Freshness;
  /** Los parámetros con los que se evaluó. `propuesta` = los del anexo, sin firmar por Crédito y cobranza. */
  parametros: ParametrosAutorizacion & { origen: 'propuesta' | 'credito_cobranza' };
  /** Lo que decide Crédito y cobranza hoy (y lo que pasaría solo si el carril estuviera encendido), el más viejo primero. */
  pendientes: PedidoPorAutorizar[];
  /** Pedidos viejos (7) o de la ruta vecinal (8): ni automático ni bandeja del día. */
  aparte: PedidoPorAutorizar[];
  /** `[D-A12]` Pedidos de CONTADO: no usan crédito, no le tocan a Crédito y cobranza. Con el automático encendido pasan solos. */
  contado: PedidoPorAutorizar[];
  /**
   * `[GP.A.4b]` Lo que la Suite YA decidió y Kepler todavía muestra `CREADO`: lo rechazado (que nunca cambia en
   * Kepler) y lo autorizado que el ODS aún no refleja. No espera a nadie, pero se ve: si se decidió mal, desde aquí
   * se vuelve a decidir.
   */
  decididos: PedidoPorAutorizar[];
  /** Sucursales con la autorización automática encendida (`kepler_push_switch`, tipo `autorizacion`). */
  sucursales_encendidas: string[];
  /** `[GP.A.4b]` Cuántas autorizó SOLA la Suite hoy (bitácora `finance.order_authorizations`). Las de una persona no cuentan: el tope del día es del automático. */
  autorizados_hoy: number;
}

/**
 * `[GP.A.2]` Lo que decide Crédito y cobranza sobre un pedido, desde el panel de la bandeja.
 *  · `autorizar`: CREADO → AUTORIZADO en Kepler.
 *  · `regresar` (D-A7): AUTORIZADO → CREADO en Kepler; sólo un pedido que autorizó la Suite.
 *  · `rechazar`: no toca Kepler (el pedido sigue CREADO); el motivo queda en la Suite y sube a Dirección (GP.A.6b).
 *  · `escalar`: «Pasar a Dirección General», tampoco toca Kepler.
 */
export type AccionDecisionPedido = 'autorizar' | 'regresar' | 'rechazar' | 'escalar';

/** El cuerpo de `POST /api/finance/autorizacion-pedidos/:sucursal/:serie/:folio`: lo que manda el panel. */
export interface DecisionPedidoBody {
  accion: AccionDecisionPedido;
  /** Obligatorio (§3.6): queda en la bitácora con quién y cuándo. */
  motivo: string;
}

/**
 * Cómo terminó. `escrito` / `ya_estaba`: Kepler tiene el estatus pedido. `apagado` / `rechazado`: Kepler no se tocó o
 * no aceptó (el motivo dice por qué; `reintentable` si fue la red o un candado). `registrado`: rechazar o escalar.
 */
export type EstadoDecisionPedido = 'escrito' | 'ya_estaba' | 'apagado' | 'rechazado' | 'registrado';

export interface ResultadoDecisionPedido {
  id: string;
  accion: AccionDecisionPedido;
  estado: EstadoDecisionPedido;
  /** La frase para la persona, corta. */
  mensaje: string;
  reintentable: boolean;
}

export const MOTIVO_MAX = 500;
