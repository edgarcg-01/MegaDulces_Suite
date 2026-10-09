import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  CONTPAQI_POLIZA_SINK_PORT, type ContpaqiPolizaSinkPort,
} from '@megadulces/contracts';
import { armarAsientoEgreso, AsientoRechazado, type ReglaCuenta } from './poliza-egreso';
import { tokenDe } from './token';

/**
 * Fase CP `[CP.8.7]` — **El eslabón que faltaba: de un movimiento bancario a una póliza.**
 *
 * Sin esto, `contpaqi.poliza_exports` queda vacía para siempre y el cuadre no tiene qué cuadrar.
 * Lee los egresos clasificados de la Fase CB, busca su regla, arma el asiento, lo entrega por el
 * puerto y deja el registro.
 *
 * ── ⭐ El modelo de entrada, MEDIDO y no supuesto ───────────────────────────────────────────
 * Lo primero que hay que entender es que **el IVA NO viene en el mismo renglón**. El banco cobra
 * el gasto y su impuesto como dos movimientos distintos:
 *
 *     "ADM PAQUETE PYME"  ->  490.00      (categoría del gasto)
 *     "IVA"               ->   78.40      (categoría `iva_acreditable`)   490 × 0.16 = 78.40
 *
 * Por eso CB tiene 4,632 movimientos en `iva_acreditable`. Medido el 2026-10-09 contra prod:
 *
 * | | |
 * |---|--:|
 * | IVA con hermano exacto (misma cuenta, misma fecha, ×0.16) | **76.8%** |
 * | ambiguos (más de un candidato) | 1.5% |
 * | ⭐ **placebo** (fecha corrida 43 días) | **0.1%** |
 *
 * **768× el piso de ruido.** El pareo es real, no una coincidencia aritmética.
 *
 * ⚠️ Y el 23.2% sin hermano **se declara, no se inventa**: puede ser gasto exento, IVA cobrado
 * otro día, o un cargo que ya viene con impuesto adentro. Esos se arman con IVA 0 y el motivo
 * escrito — nunca calculando un 16% que nadie cobró.
 *
 * ⛔ **Y no hay atajo por CFDI**: `bank_movements.client_uuid` parece un UUID pero es la llave de
 * idempotencia del importer (SHA-1); **0 de ellas cruzan con `fiscal.cfdis`**. El desglose sale
 * del banco o no sale.
 *
 * ── Qué hace hoy, que es negarse ────────────────────────────────────────────────────────────
 * Las 19 reglas están en `sin_regla` (`[CP.8.1c]`): el mapa categoría→cuenta no es derivable y lo
 * firma el contador. Así que **hoy este servicio rechaza todo, con motivo**. Eso no es una falla
 * a medias: es el comportamiento correcto, es testeable, y el día que se firme una regla empieza
 * a asentar sin tocar una línea de código.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

export interface ResultadoArmado {
  evento_id: string;
  estado: 'entregada' | 'rechazada';
  motivo: string;
  /** El archivo, cuando el sink es `txt` y el asiento se armó. */
  archivo?: { nombre: string; contenido: string };
}

@Injectable()
export class ContpaqiArmadoService {
  private readonly log = new Logger(ContpaqiArmadoService.name);

  constructor(
    @Inject('KNEX_NEW_DB') private readonly db: Knex,
    @Optional() @Inject(CONTPAQI_POLIZA_SINK_PORT) private readonly sink?: ContpaqiPolizaSinkPort,
  ) {}

  /**
   * Arma (y entrega, si hay sink) los egresos de un periodo.
   *
   * `soloSimular` deja ver qué pasaría sin escribir nada — es lo que la bandeja va a usar para
   * mostrar el "qué entraría" antes de que alguien apriete nada.
   */
  async armarPeriodo(anioMes: string, soloSimular = true): Promise<ResultadoArmado[]> {
    const egresos = await this.leerEgresos(anioMes);
    const reglas = await this.leerReglas();
    const out: ResultadoArmado[] = [];

    for (const e of egresos) {
      const regla = reglas.get(e.categoria_code);
      const evento_id = String(e.id);

      if (!regla) {
        out.push({ evento_id, estado: 'rechazada',
          motivo: `la categoría "${e.categoria_code}" no tiene fila en contpaqi.account_rules` });
        continue;
      }
      if (!e.cuenta_banco) {
        // El crosswalk de CP.2 enlazó 16 de 18 cuentas. Las 2 que faltan no se adivinan.
        out.push({ evento_id, estado: 'rechazada',
          motivo: `la cuenta de banco "${e.banco_label}" no tiene contpaqi_cuenta (crosswalk de CP.2)` });
        continue;
      }

      const subtotal = Number(e.amount_out);
      const iva = Number(e.iva_hermano ?? 0);
      try {
        const asiento = armarAsientoEgreso({
          regla,
          subtotal,
          iva,
          total: Math.round((subtotal + iva) * 100) / 100,
          cuenta_banco: e.cuenta_banco,
          concepto: String(e.concept ?? '').trim() || e.categoria_nombre,
          fecha: e.fecha,
          seg_negocio: 0, // ⚠️ CB no trae segmento por movimiento; omitir es mejor que inventar.
        });

        const token = tokenDe('bank_movement', evento_id);
        if (soloSimular || !this.sink) {
          out.push({ evento_id, estado: 'entregada',
            motivo: this.sink ? 'simulación: el asiento cuadra y se podría entregar'
              : 'el asiento cuadra, pero no hay sink conectado' });
          continue;
        }

        const r = await this.sink.entregar({
          evento_tipo: 'bank_movement', evento_id,
          tipo_poliza: asiento.tipo_poliza, fecha: asiento.fecha, concepto: asiento.concepto,
          movimientos: asiento.movimientos, total: asiento.total, token,
        });
        await this.registrar(evento_id, anioMes, asiento, token, r.estado, r.motivo ?? '');
        out.push({ evento_id, estado: r.estado, motivo: r.motivo ?? 'entregada', archivo: r.archivo });
      } catch (err) {
        // `AsientoRechazado` trae el motivo tipado; cualquier otra cosa se reporta cruda.
        const motivo = err instanceof AsientoRechazado ? `${err.motivo}: ${err.message}`
          : (err instanceof Error ? err.message : String(err));
        out.push({ evento_id, estado: 'rechazada', motivo });
      }
    }

    const entregadas = out.filter((x) => x.estado === 'entregada').length;
    this.log.log(`armado ${anioMes}: ${entregadas}/${out.length} armables${soloSimular ? ' (simulación)' : ''}`);
    return out;
  }

  /**
   * Los egresos del periodo con su categoría, su cuenta de banco en ContPAQi, y **su hermano de
   * IVA** si existe.
   *
   * ⚠️ El `LEFT JOIN LATERAL` del IVA lleva `LIMIT 1` y ordena por el id: en el 1.5% de casos con
   * más de un candidato hay que elegir uno, y elegir **siempre el mismo** es lo que vuelve
   * reproducible el resultado. La alternativa —rechazar los ambiguos— se descartó porque el
   * armador ya rechaza por falta de regla; sumar un segundo motivo para el 1.5% no cambia nada
   * hoy y sí esconde el que importa.
   */
  private async leerEgresos(anioMes: string): Promise<any[]> {
    return this.db
      .select(
        'm.id', 'm.concept', 'm.amount_out',
        this.db.raw(`to_char(m.movement_date, 'YYYY-MM-DD') as fecha`),
        'c.code as categoria_code', 'c.name as categoria_nombre',
        'ba.contpaqi_cuenta as cuenta_banco', 'ba.account_label as banco_label',
        this.db.raw('iva.amount_out as iva_hermano'),
      )
      .from('finance.bank_movements as m')
      .join('finance.movement_categories as c', 'c.id', 'm.category_id')
      .leftJoin('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
      .joinRaw(`
        LEFT JOIN LATERAL (
          SELECT h.amount_out
            FROM finance.bank_movements h
            JOIN finance.movement_categories hc ON hc.id = h.category_id
           WHERE h.tenant_id = m.tenant_id AND h.deleted_at IS NULL
             AND hc.code = 'iva_acreditable'
             AND h.bank_account_id = m.bank_account_id
             AND h.movement_date   = m.movement_date
             AND round(m.amount_out * 0.16, 2) = round(h.amount_out, 2)
           ORDER BY h.id LIMIT 1
        ) iva ON true`)
      .where('m.tenant_id', MEGA)
      .whereNull('m.deleted_at')
      .where('m.amount_out', '>', 0)
      // El IVA no se arma solo: es el renglón 2 del asiento de su hermano.
      .whereNot('c.code', 'iva_acreditable')
      .whereRaw(`to_char(m.movement_date, 'YYYY-MM') = ?`, [anioMes])
      .orderBy('m.movement_date')
      .orderBy('m.id');
  }

  /** Las reglas, por código de categoría. Hoy todas en `sin_regla` — y el armador lo respeta. */
  private async leerReglas(): Promise<Map<string, ReglaCuenta>> {
    const filas = await this.db('contpaqi.account_rules').where({ tenant_id: MEGA })
      .select('categoria_code', 'cuenta_gasto', 'cuenta_iva', 'confianza_pct', 'estado');
    return new Map(filas.map((f: any) => [f.categoria_code, {
      categoria_code: f.categoria_code,
      cuenta_gasto: f.cuenta_gasto,
      cuenta_iva: f.cuenta_iva,
      confianza_pct: f.confianza_pct === null ? null : Number(f.confianza_pct),
      estado: f.estado,
    } as ReglaCuenta]));
  }

  /**
   * Deja el registro. ⭐ `onConflict` por `(evento_tipo, evento_id)`: **reenviar el mismo evento
   * no duplica** — es el riesgo que `[LC.2]` midió costando $32.6M contabilizados dos veces.
   *
   * ⛔ Nace en `entregada`, nunca en `aplicada`. Quién puede decir que ContPAQi la tiene es el
   * cuadre, leyendo el carril de vuelta.
   */
  private async registrar(
    eventoId: string, periodo: string, asiento: any, token: string,
    estado: string, motivo: string,
  ): Promise<void> {
    await this.db('contpaqi.poliza_exports')
      .insert({
        tenant_id: MEGA,
        evento_tipo: 'bank_movement',
        evento_id: eventoId,
        periodo,
        asiento: JSON.stringify({ ...asiento, token }),
        total: asiento.total,
        estado: estado === 'entregada' ? 'entregada' : 'rechazada',
        sink: this.sink?.sink ?? null,
        motivo,
        updated_at: this.db.fn.now(),
      })
      .onConflict(['tenant_id', 'evento_tipo', 'evento_id'])
      .merge(['asiento', 'total', 'estado', 'sink', 'motivo', 'updated_at']);
  }
}
