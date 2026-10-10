import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  CONTPAQI_POLIZA_SINK_PORT, type ContpaqiPolizaSinkPort,
} from '@megadulces/contracts';
import {
  armarAsientoEgreso, armarLoteEgresos, AsientoRechazado, type ReglaCuenta,
} from './poliza-egreso';
import { tokenDe } from './token';
import {
  construirIndice, resolverProveedor,
  type CuentaProveedor, type IndiceProveedores,
} from './proveedor-resolver';

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

/**
 * `[CP.8.21]` — Un lote = una póliza candidata, al grano real (cuenta de banco × día).
 * `motivos` lleva el conteo **por motivo**, no un total: cuatro rechazos distintos tienen cuatro
 * dueños distintos y colapsarlos a "N rechazadas" borra justamente la información accionable.
 */
export interface ResumenLote {
  cuenta_banco: string;
  /**
   * Cómo lo nombra finanzas (`BBAJIO 4166`). ⚠️ Viaja además de la cuenta contable, no en vez
   * de ella: la pantalla no debe inventar el alias, y una cuenta mal rotulada en contabilidad
   * es peor que una cuenta sin rótulo.
   */
  banco_label: string | null;
  fecha: string;
  movimientos: number;
  incluidas: number;
  renglones: number;
  total: number;
  /** `'no_emitido'` = el lote cuadra pero le falta el traspaso de impuesto. Se declara. */
  iva_traspaso: 'no_emitido' | null;
  motivos: Record<string, number>;
}

/**
 * `[CP.8.34]` — **Lo que el puente NO cubre, dicho por el servidor.**
 *
 * ⛔ Antes esto vivía en un `logger.warn` que nadie lee: *"876 egresos sin contpaqi_cuenta"*.
 * La bandeja publicaba 1,474 como si fuera el universo del mes, y el universo real de enero es
 * **2,350** — un denominador recortado en 37.3 %, el mismo defecto que esta fase le corrigió al
 * `0 %` del cuadre.
 *
 * ⚠️ **Y la causa no es la que el `warn` sugería.** Medido el 2026-10-09: los 876 **sí tienen
 * cuenta**; son `CAJA CG` (864) y `FACTORAJE FAC` (12), que **no son bancos** y por eso no
 * tienen cuenta `102*` que ponerles. No es un mapeo que falte: es un circuito distinto, fuera
 * del alcance de un puente de egresos de banco. Se declara con nombre e importe para que nadie
 * lo lea como trabajo pendiente ni como cero.
 */
export interface CuentaFueraDeLote {
  /** Como la conoce finanzas: `CAJA CG`, `FACTORAJE FAC`. */
  cuenta: string;
  movimientos: number;
  importe: number;
}

/** Lo que devuelve la simulación de un mes: los lotes **y** lo que quedó fuera de todo lote. */
export interface ResumenMes {
  lotes: ResumenLote[];
  fuera_de_lote: {
    movimientos: number;
    importe: number;
    cuentas: CuentaFueraDeLote[];
  };
}

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
        // `[CP.8.34]` El nombre del banco viaja para poder NOMBRAR lo que queda fuera de lote:
        // `CAJA CG` y `FACTORAJE FAC` se leen solos; un `CG` suelto no lo entiende nadie.
        'ba.bank as banco_nombre',
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

  /**
   * Las reglas, por código de categoría.
   *
   * ⭐ `[CP.8.19]` agregó `tipo_regla`: la cuenta de cargo no siempre la decide la categoría.
   * Leerlo acá es lo que hace que `no_aplica` (ya decidido) deje de verse igual que `sin_regla`
   * (falta decidir) — dos estados con dueños distintos.
   */
  /**
   * `[CP.8.35]` — Un índice de proveedores **por rubro**, uno por cada regla `por_proveedor`.
   *
   * ⛔ El rubro sale de `cuenta_prefijo` de la propia regla y no de una constante: ahí estuvo el
   * defecto que tuvo esto en 1.4 % de resolución. Las cuentas de proveedor viven en 2120, 5010 y
   * 5020; un PAGO carga a la de por pagar, y el mismo nombre existe en los tres rubros.
   */
  private async leerIndicesProveedor(
    reglas: Map<string, ReglaCuenta>,
  ): Promise<Map<string, IndiceProveedores>> {
    const prefijos = [...new Set([...reglas.values()]
      .filter((r) => r.tipo_regla === 'por_proveedor' && r.cuenta_prefijo)
      .map((r) => r.cuenta_prefijo as string))];
    if (!prefijos.length) return new Map();

    const filas = await this.db('contpaqi.supplier_accounts').where({ tenant_id: MEGA })
      .select('cuenta', 'proveedor_nombre', 'cuenta_nombre', 'veredicto', 'rfc');
    const out = new Map<string, IndiceProveedores>();
    for (const p of prefijos) out.set(p, construirIndice(filas as CuentaProveedor[], p));
    this.log.log(`índice de proveedores: ${filas.length} cuentas · rubros ${prefijos.join(', ')}`);
    return out;
  }

  /** Devuelve la regla con la cuenta del proveedor puesta, o igual con su motivo si no resolvió. */
  private conProveedor(
    base: ReglaCuenta,
    concepto: unknown,
    indices: Map<string, IndiceProveedores>,
  ): ReglaCuenta {
    if (base.tipo_regla !== 'por_proveedor') return base;
    const idx = base.cuenta_prefijo ? indices.get(base.cuenta_prefijo) : undefined;
    if (!idx) return base;
    const r = resolverProveedor(idx, concepto);
    return r.veredicto === 'resuelto' ? { ...base, cuenta_gasto: r.cuenta } : base;
  }

  private async leerReglas(): Promise<Map<string, ReglaCuenta>> {
    const filas = await this.db('contpaqi.account_rules').where({ tenant_id: MEGA })
      .select('categoria_code', 'cuenta_gasto', 'cuenta_iva', 'confianza_pct', 'estado',
        'tipo_regla', 'cuenta_prefijo');
    return new Map(filas.map((f: any) => [f.categoria_code, {
      categoria_code: f.categoria_code,
      cuenta_gasto: f.cuenta_gasto,
      cuenta_iva: f.cuenta_iva,
      confianza_pct: f.confianza_pct === null ? null : Number(f.confianza_pct),
      estado: f.estado,
      tipo_regla: f.tipo_regla ?? 'por_categoria',
      cuenta_prefijo: f.cuenta_prefijo ?? null,
    } as ReglaCuenta]));
  }

  /**
   * `[CP.8.21]` — **Simula el armado POR LOTE**, que es la unidad real: ContPAQi agrupa.
   *
   * Medido: 4,067 de 4,457 pólizas de egreso de 2026 (91.2 %) tienen **un solo renglón de
   * banco**. Una póliza por movimiento daría 4,727 donde la contadora hace ~500 — un archivo
   * que cuadra y que ella no reconoce como su trabajo.
   *
   * Devuelve un renglón por lote con lo que entraría y los motivos de lo que no. No escribe.
   */
  async simularLotes(anioMes: string): Promise<ResumenMes> {
    const egresos = await this.leerEgresos(anioMes);
    const reglas = await this.leerReglas();
    const indices = await this.leerIndicesProveedor(reglas);

    // (cuenta de banco × día) — exactamente el grano de la póliza real.
    const grupos = new Map<string, any[]>();
    const sinBanco: any[] = [];
    for (const e of egresos) {
      if (!e.cuenta_banco) { sinBanco.push(e); continue; }
      const k = `${e.cuenta_banco}|${e.fecha}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push(e);
    }

    const out: ResumenLote[] = [];
    for (const [k, filas] of [...grupos.entries()].sort()) {
      const [cuenta_banco, fecha] = k.split('|');
      const entradas = filas.map((e) => {
        const subtotal = Number(e.amount_out);
        const iva = Number(e.iva_hermano ?? 0);
        // Una categoría sin fila en `account_rules` no se inventa: entra con `sin_medir`
        // para que el lote la rechace con ese motivo, no con uno prestado.
        const base = reglas.get(e.categoria_code) ?? {
          categoria_code: e.categoria_code, cuenta_gasto: null, cuenta_iva: '1060000000',
          confianza_pct: null, estado: 'sin_regla' as const, tipo_regla: 'sin_medir' as const,
          cuenta_prefijo: null,
        };
        return {
          // ⭐ `[CP.8.35]` En una regla `por_proveedor` la cuenta **no es de la categoría**: hay
          // que resolverla por movimiento, desde el concepto del banco. Sin este paso los 216
          // movimientos de `compra_mercancia` de enero ($43.5M) se rechazaban en bloque.
          // ⛔ Si no resuelve, se deja `cuenta_gasto` en null **con su motivo**: el armador la
          // rechaza con `proveedor_sin_cuenta` y la bandeja dice por qué, en vez de inventar.
          regla: this.conProveedor(base, e.concept, indices),
          subtotal,
          iva,
          total: Math.round((subtotal + iva) * 100) / 100,
          cuenta_banco,
          concepto: String(e.concept ?? '').trim() || e.categoria_nombre,
          fecha,
          seg_negocio: 0,
        };
      });

      const lote = armarLoteEgresos(cuenta_banco, fecha, entradas,
        `EGRESOS ${fecha} ${cuenta_banco}`);
      const porMotivo: Record<string, number> = {};
      for (const r of lote.rechazadas) porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;

      out.push({
        cuenta_banco,
        banco_label: [filas[0]?.banco_nombre, filas[0]?.banco_label].filter(Boolean).join(' ').trim() || null,
        fecha,
        movimientos: filas.length,
        incluidas: lote.incluidas,
        renglones: lote.asiento?.movimientos.length ?? 0,
        total: lote.asiento?.total ?? 0,
        iva_traspaso: lote.asiento?.iva_traspaso ?? null,
        motivos: porMotivo,
      });
    }
    // ⭐ `[CP.8.34]` Lo que quedó fuera se AGRUPA y se devuelve, no se registra en un `warn`.
    // Un hueco que sólo existe en el log no lo ve quien mira la pantalla, que es justo
    // quien necesita saber que el denominador no es el universo del mes.
    const porCuenta = new Map<string, CuentaFueraDeLote>();
    for (const e of sinBanco) {
      const cuenta = [e.banco_nombre, e.banco_label].filter(Boolean).join(' ').trim() || '(sin cuenta)';
      const acc = porCuenta.get(cuenta) ?? { cuenta, movimientos: 0, importe: 0 };
      acc.movimientos += 1;
      acc.importe = Math.round((acc.importe + Number(e.amount_out)) * 100) / 100;
      porCuenta.set(cuenta, acc);
    }
    const cuentas = [...porCuenta.values()].sort((a, b) => b.movimientos - a.movimientos);
    const fuera = {
      movimientos: sinBanco.length,
      importe: Math.round(cuentas.reduce((a, c) => a + c.importe, 0) * 100) / 100,
      cuentas,
    };

    const conAsiento = out.filter((l) => l.incluidas > 0).length;
    this.log.log(`lotes ${anioMes}: ${out.length} (banco × día) · ${conAsiento} con asiento`
      + ` · ${fuera.movimientos} fuera de lote (${cuentas.map((c) => c.cuenta).join(', ') || '—'})`);
    return { lotes: out, fuera_de_lote: fuera };
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
