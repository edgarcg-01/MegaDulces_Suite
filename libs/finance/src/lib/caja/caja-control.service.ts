import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * `[CG.105]` — **El expediente diario de Caja General y el historial de cortes.**
 *
 * Edgar, 2026-10-13: *"necesito que generes un historial de cortes diario, y un expediente de
 * movimientos diario donde se muestre el ticket"* · *"lo revisan todas las mañanas que el corte
 * sí coincida con lo que existe en la caja"*.
 *
 * Lectura pura sobre dos vistas (`analytics.v_caja_control_*`) que derivan de
 * `caja_general_ods.arqueo_movimientos` — 30,199 renglones desde 2013-09-13, carril vivo. Cero
 * tablas propias, cero importer: la historia que se revisa cada mañana ya estaba en prod.
 *
 * ⚠️ Estas vistas NO llevan `tenant_id`: el origen es el back-end de un Access de una sola
 * empresa. Se usa `TenantKnexService` igual, por la conexión y para no abrir un segundo camino
 * de acceso a la base — pero acá no hay RLS que aislar y se dice en voz alta en vez de dejar
 * creer que lo hay.
 */
@Injectable()
export class CajaControlService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Tope duro: una pantalla que pide "todo" no es una pantalla, es una descarga. */
  private readonly TOPE = 400;

  /**
   * El historial: un renglón por día, con el corte de ESE día.
   *
   * ⛔ `tiene_corte = false` significa que **ese día nadie contó la caja**, y es un hecho
   * distinto de "contó y dio cero". Por eso los totales llegan `null` y no 0 (ADR-056): la
   * pantalla tiene que poder decir las dos cosas distinto, que es justo lo que se revisa en la
   * mañana. Medido en prod: el 12-oct y el 9-oct tienen movimientos y **cero conteos**.
   */
  async cortes(q: { desde?: string; hasta?: string; limit?: number }) {
    const limit = Math.min(Number(q.limit) || 60, this.TOPE);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.v_caja_control_cortes');
      if (q.desde) qb = qb.where('fecha', '>=', q.desde);
      if (q.hasta) qb = qb.where('fecha', '<=', q.hasta);
      const rows = await qb.orderBy('fecha', 'desc').limit(limit);
      return {
        rows, limit, fuente: 'analytics.v_caja_control_cortes',
        frescura: await this.frescura(trx),
      };
    });
  }

  /**
   * ⭐ `[CG.105]` **La edad del dato, declarada.** Sin esto la pantalla se lee como "al día" aunque
   * el carril lleve días parado — el defecto que la Fase OBS midió costando seis días de precios
   * viejos, uno 54 % bajo costo.
   *
   * El eslabón es `caja_general_ods._ship_watermark`: `wm` es hasta dónde llegó el dato de negocio
   * y `updated_at` cuándo corrió el carril por última vez. Se publica **`wm`**, no `updated_at`:
   * un carril que corre cada minuto y no trae nada nuevo reportaría frescura perfecta sobre datos
   * viejos. *Que el proceso corra no es que el dato llegue.*
   *
   * ⚠️ Tres estados, no dos (ADR-056). Si la tabla no está o no tiene fila, el veredicto es
   * `unknown` — **no** `fresh`: no poder medir no es estar al día.
   */
  private async frescura(trx: any) {
    const SRC = '0 T Movimientos';
    let at: string | null = null;
    try {
      const r = await trx('caja_general_ods._ship_watermark')
        .where('src_table', SRC).first('wm', 'updated_at');
      at = r?.wm ? new Date(r.wm).toISOString() : null;
    } catch {
      at = null; // el carril puede no existir en este entorno: se DECLARA, no se inventa
    }
    const horas = at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : null;
    // 30 h: el arqueo de Control se captura en días hábiles, así que un fin de semana normal
    // no puede disparar la alarma. Una alarma que grita en falso enseña a ignorar el tablero.
    const status: 'fresh' | 'stale' | 'unknown' =
      horas === null ? 'unknown' : (horas <= 30 ? 'fresh' : 'stale');
    const edad = horas === null ? null
      : horas < 1 ? 'hace menos de una hora'
        : horas < 48 ? `hace ${Math.round(horas)} h`
          : `hace ${Math.round(horas / 24)} días`;
    const input = {
      key: 'caja_general_ods', label: 'Arqueos de Control',
      at, age_human: edad, status, stale: status !== 'fresh',
    };
    return { data_as_of: at, status, stale: status !== 'fresh', age_human: edad, inputs: [input] };
  }

  /**
   * El expediente de un día: todos sus movimientos, cada uno con su ticket.
   *
   * ⭐ El TICKET es el desglose por denominación tal como se contó. Medido antes de publicarlo:
   * las piezas reconstruyen el efectivo declarado en **23,652 de 23,652** renglones vivos, cero
   * excepciones — por eso `cuadra_ticket` viaja por fila: cuando un renglón no cuadre será un
   * hecho nuevo, no el ruido de un decode flojo.
   *
   * ⛔ Los totales del día NO suman las cuatro piernas que no son efectivo. Medido: los dólares
   * toman 9 valores en todo 2026 y el actual se repite 205 veces; `totalcredito` vale $20,782.00
   * exactos 383 veces desde el 2025-10-06. Son saldos PARADOS que se vuelven a declarar en cada
   * conteo — sumarlos por día publica dinero que no existe. Por eso cada fila trae `naturaleza`
   * y acá sólo se suma lo que es flujo.
   */
  async expediente(fecha: string) {
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.v_caja_control_movimientos')
        .where('fecha', fecha)
        .orderBy('hora', 'asc')
        .limit(this.TOPE);

      const vivos = rows.filter((r: any) => !r.cancelado);
      const num = (x: unknown) => Number(x ?? 0);
      const suma = (pred: (r: any) => boolean, campo: string) =>
        Math.round(vivos.filter(pred).reduce((a: number, r: any) => a + num(r[campo]), 0) * 100) / 100;
      const esMov = (r: any) => r.naturaleza === 'movimiento';

      // El último conteo del día ES el corte: si hubo tres, vale el de más tarde.
      const conteos = vivos.filter((r: any) => r.naturaleza === 'conteo');
      const corte = conteos.length ? conteos[conteos.length - 1] : null;

      return {
        fecha,
        rows,
        resumen: {
          movimientos: vivos.length,
          cancelados: rows.length - vivos.length,
          conteos: conteos.length,
          /** Sólo flujo. Un conteo es una foto del mismo dinero, no un movimiento más. */
          efectivo_movido: suma(esMov, 'total_efectivo'),
          tickets_que_no_cuadran: vivos.filter((r: any) => r.cuadra_ticket === false).length,
        },
        /** `null` = ese día nadie contó la caja. NO es cero. */
        corte,
        fuente: 'analytics.v_caja_control_movimientos',
      };
    });
  }
}
