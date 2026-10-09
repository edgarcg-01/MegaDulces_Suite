/**
 * `[CP.8.5]` — **El puerto por el que una póliza armada sale hacia ContPAQi.**
 *
 * Plan: [`FASE_CP8_PUENTE_CONTPAQI.md`](../../../../docs/IMPLEMENTACION/FASES/FASE_CP8_PUENTE_CONTPAQI.md).
 * Hereda ADR-040: **la plataforma nunca escribe a la base de ContPAQi**. Las únicas dos puertas
 * son el archivo que ContPAQi importa y el SDK; las dos viven detrás de este token.
 *
 * ── Por qué un puerto y no una llamada directa ──────────────────────────────────────────────
 * Porque hay dos transportes con dependencias MUY distintas y queremos poder cambiar de uno a
 * otro sin tocar quien arma el asiento:
 *
 *   `txt` — genera el archivo; **lo importa una persona**. Cero dependencias externas. Es lo
 *           que ContPAQi ya acepta hoy, y es la REVERSA permanente: si el agente no responde,
 *           se cae acá y el flujo sigue.
 *   `sdk` — lo aplica un agente en una terminal ContPAQi. Automático, pero depende de una
 *           máquina Windows con el SDK instalado y posiblemente de un asiento de licencia.
 *
 * ⭐ El cuadre (`[CP.8.8]`) **no vive acá**. Un sink entrega; no afirma que ContPAQi lo tenga.
 * Quién confirma es el carril de vuelta leyendo `analytics.gl_poliza_lines`, cada minuto. Por
 * eso `SinkResultado` dice `entregada`, nunca `aplicada`: un sink no puede saber eso, y si lo
 * dijera estaríamos de vuelta en el problema que este puente existe para resolver.
 *
 * Binding `@Optional()` en el composition root, patrón `finance-findings-sink`. Sin binding, el
 * motor arma y guarda en `contpaqi.poliza_exports` pero no entrega — que es un estado legítimo
 * y visible, no una falla silenciosa.
 */

export const CONTPAQI_POLIZA_SINK_PORT = 'CONTPAQI_POLIZA_SINK_PORT';

/** Un renglón del asiento, ya resuelto a cuentas de ContPAQi. */
export interface PolizaSinkMovimiento {
  /** Código de cuenta de ContPAQi (máscara `3-3-4`, 10 dígitos). */
  cuenta: string;
  abono: boolean;
  importe: number;
  concepto: string;
  /** `IdSegNeg`. 0 = sin segmento. */
  seg_negocio: number;
}

export interface PolizaSinkEntrada {
  /**
   * Identidad del evento del lado de la Suite. Es la llave de idempotencia
   * (`contpaqi.poliza_exports` la tiene como UNIQUE): reenviar el mismo evento no duplica.
   */
  evento_tipo: string;
  evento_id: string;
  /** `1` Ingreso · `2` Egreso · `3` Diario. */
  tipo_poliza: number;
  /** `YYYY-MM-DD`. */
  fecha: string;
  concepto: string;
  movimientos: PolizaSinkMovimiento[];
  total: number;
  /**
   * ⭐ El token de correlación (`[CP.8.6]`). Viaja dentro del `concepto` y es lo que permite
   * reconocer este asiento cuando el carril de vuelta lo traiga. **Sin token el asiento se
   * puede entregar igual, pero el cuadre queda en `no verificado`** — y eso se declara, no se
   * disimula.
   */
  token?: string;
  /**
   * ⭐⭐ `[CP.8.29]` — **Los UUID de CFDI que este asiento asocia** (renglones `AD`).
   *
   * Hasta ahora la asociación comprobante-póliza se hacía **a mano**, con el botón `Asociar` del
   * ADD. Medido: **90.0 % de los CFDIs recibidos terminan asociados** (169,030 históricos), pero
   * a costa de ~1,400 asociaciones manuales al mes, y el 10 % que nunca se hace son **2,606
   * CFDIs de 2026 por $105,399,045.52**.
   *
   * El formato del renglón está verificado contra el esquema del fabricante (`[CP.8.28]`), no
   * supuesto. ⚠️ **Lo que sigue sin verificarse es si ContPAQi lo HONRA al importar** — eso lo
   * contesta el archivo B de `[CP.8.24]`.
   */
  uuids?: string[];
}

export interface SinkResultado {
  /** Qué transporte lo entregó. */
  sink: 'txt' | 'sdk';
  /**
   * `entregada` = salió de acá. **NO significa que ContPAQi lo tenga** — eso lo dice el cuadre.
   * `rechazada` = el transporte se negó (y `motivo` dice por qué).
   */
  estado: 'entregada' | 'rechazada';
  motivo?: string;
  /** Sólo el sink `txt`: el contenido del archivo y cómo llamarlo. */
  archivo?: { nombre: string; contenido: string };
  /**
   * Sólo el sink `sdk`: lo que ContPAQi devolvió al aplicar. Con esto el cuadre es exacto y no
   * hace falta buscar el token.
   */
  contpaqi?: { folio: number; guid?: string };
}

export interface ContpaqiPolizaSinkPort {
  /** Qué transporte es éste. Lo usa la bandeja para decir cómo se va a entregar. */
  readonly sink: 'txt' | 'sdk';

  /**
   * ¿Está utilizable AHORA? El sink `sdk` contesta que no cuando el agente no responde, y el
   * llamador cae a `txt`. Nunca lanza: un transporte caído es un dato, no una excepción.
   */
  disponible(): Promise<boolean>;

  /**
   * Entrega el asiento. **No valida el cuadre contable** — eso ya lo hizo el armador
   * (`poliza-egreso.ts`) y repetirlo acá sería una segunda implementación de la misma regla.
   * Lo que sí hace es negarse a entregar lo que el transporte no puede expresar.
   */
  entregar(entrada: PolizaSinkEntrada): Promise<SinkResultado>;
}
