import { Injectable, Logger } from '@nestjs/common';
import type {
  ContpaqiPolizaSinkPort,
  PolizaSinkEntrada,
  SinkResultado,
} from '@megadulces/contracts';
import { construirTxt, type Movimiento } from '../purchase-book/poliza-txt';
import { conceptoConToken, guidDe } from './token';

/**
 * `[CP.8.5]` — **El sink de archivo**: la póliza armada sale como el TXT que ContPAQi importa.
 *
 * ── Por qué REUSA `poliza-txt.ts` y no serializa por su cuenta ──────────────────────────────
 * ⛔ Porque un segundo serializador son dos verdades sobre el mismo formato. El propio
 * `poliza-txt.ts` documenta que escritor y lector no se pueden separar: los anchos viven una
 * sola vez en `LAYOUT_P`/`LAYOUT_M` y los leen los dos. Un adaptador que arme sus propias
 * líneas se desincroniza el día que alguien corrija un ancho — y el síntoma sería un archivo
 * que ContPAQi rechaza, o peor, uno que acepta corrido de campo.
 *
 * Para eso `construirTxt` se generalizó en `[CP.8.5]`: acepta `tipoPol` (default `'3'`, así el
 * libro de compras sale idéntico al byte) y serializa `seg_negocio`. Verificado: el smoke de LC
 * da **38 ok · 0 fallidas** antes y después del cambio.
 *
 * ── Lo que este sink NO afirma ──────────────────────────────────────────────────────────────
 * ⭐ Devuelve `entregada`, **nunca `aplicada`**. Generar un archivo no es asentar una póliza: en
 * medio hay una persona que lo importa. Quien puede decir que ContPAQi la tiene es el cuadre
 * (`[CP.8.8]`), leyendo el carril de vuelta. Confundir las dos cosas es exactamente el problema
 * que este puente existe para resolver.
 *
 * ⚠️ **Y lo más importante que falta:** el `SEP` del layout **sigue sin verificarse** contra un
 * archivo que ContPAQi haya aceptado de verdad (`[CP.8.4]`). Este adaptador produce el formato
 * que creemos correcto, validado campo por campo contra `Polizas`/`MovimientosPoliza` — que
 * prueba qué SIGNIFICA cada campo, no cómo se serializa.
 */
@Injectable()
export class ContpaqiTxtSinkAdapter implements ContpaqiPolizaSinkPort {
  private readonly log = new Logger(ContpaqiTxtSinkAdapter.name);

  readonly sink = 'txt' as const;

  /**
   * El archivo siempre se puede generar: no depende de ninguna máquina ni de ninguna licencia.
   * Es justamente lo que lo vuelve la reversa permanente del sink `sdk`.
   */
  async disponible(): Promise<boolean> {
    return true;
  }

  async entregar(entrada: PolizaSinkEntrada): Promise<SinkResultado> {
    const rechazo = (motivo: string, detalle: string): SinkResultado => {
      this.log.warn(`[${entrada.evento_tipo}/${entrada.evento_id}] ${motivo}: ${detalle}`);
      return { sink: this.sink, estado: 'rechazada', motivo: `${motivo}: ${detalle}` };
    };

    if (!entrada.movimientos?.length) {
      return rechazo('sin_movimientos', 'un asiento sin renglones no es una póliza');
    }

    // El layout lleva la fecha en `yyyyMMdd`. Se exige `YYYY-MM-DD` en la entrada y se
    // convierte acá por posición, SIN pasar por `Date`: construir un Date con una fecha suelta
    // la interpreta en UTC y al volver a texto en hora MX (-06:00) sale el día ANTERIOR. Ya
    // pasó en `[LC.16]`, donde una factura del 2026-09-01 se serializaba como 31 de agosto.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entrada.fecha ?? '');
    if (!m) {
      return rechazo('fecha_invalida', `se esperaba YYYY-MM-DD y llegó "${entrada.fecha}"`);
    }
    const fechaTxt = `${m[1]}${m[2]}${m[3]}`;

    // ⭐ El token viaja en el concepto del ENCABEZADO. Es lo que el cuadre va a buscar en
    // `analytics.gl_poliza_lines`, que el carril de vuelta trae cada minuto. Si no entra en los
    // 100 caracteres del campo, se RECHAZA en vez de recortarlo: un token cortado no casa con
    // nada y el evento quedaría entregado y para siempre sin verificar — el peor de los
    // estados, porque se ve igual que uno que todavía no llega.
    // `[CP.8.6]` — el armado del concepto vive en `token.ts`, no acá: es la misma regla que usa
    // el cuadre para extraerlo, y tenerla en dos lugares sería tener dos reglas.
    const ANCHO_CONCEPTO = 100;
    let concepto: string;
    try {
      concepto = conceptoConToken(entrada.token ?? '', entrada.concepto ?? '', ANCHO_CONCEPTO);
    } catch (e) {
      // Sólo lanza cuando el TOKEN no entra. La descripción se recorta sola; el token nunca.
      return rechazo('concepto_excede', e instanceof Error ? e.message : String(e));
    }

    const movs: Movimiento[] = entrada.movimientos.map((mv) => ({
      cuenta: mv.cuenta,
      // `referencia` va vacía a propósito: medido el 2026-10-08, ContPAQi la tiene vacía en los
      // egresos reales. Llenarla con algo nuestro sería inventar un dato que su contabilidad no
      // usa, y encima ocuparía un campo que algún día ellos sí quieran.
      referencia: '',
      abono: mv.abono,
      importe: mv.importe,
      concepto: mv.concepto ?? '',
      seg_negocio: mv.seg_negocio || '',
    }));

    try {
      // `folio 0` = que ContPAQi asigne el suyo. Nosotros NO controlamos su numeración, y por
      // eso existe el token: pelearse con el folio sería pedirle a su sistema que respete una
      // secuencia nuestra.
      // [CP.8.24] El `Guid` va derivado del evento: estructural, determinista, y no gasta los 100
      // caracteres del concepto. Si ContPAQi lo RESPETA, el puente gana una llave que no depende
      // de que nadie edite el texto; si lo pisa con el suyo, no se pierde nada -- el token sigue.
      // Emitirlo es la unica forma de llegar a saberlo.
      const guid = guidDe(entrada.evento_tipo, entrada.evento_id);
      // [CP.8.29] Los UUID viajan al final de la poliza (renglones AD). Sin uuids el archivo
      // sale identico a antes -- el libro de compras no se entera.
      const contenido = construirTxt(
        fechaTxt, 0, concepto, movs, String(entrada.tipo_poliza), guid, '0', '0',
        entrada.uuids ?? [],
      );
      return {
        sink: this.sink,
        estado: 'entregada',
        archivo: {
          nombre: `poliza-${entrada.evento_tipo}-${entrada.evento_id}-${fechaTxt}.txt`,
          contenido,
        },
      };
    } catch (e) {
      // `construirTxt` lanza cuando un renglón no trae cuenta — el nulo que `padR` vuelve 30
      // espacios y tumba el archivo entero (`[LC.9]`). Que llegue acá significa que el armador
      // lo dejó pasar; se reporta, no se repara.
      return rechazo('layout_rechaza', e instanceof Error ? e.message : String(e));
    }
  }
}
