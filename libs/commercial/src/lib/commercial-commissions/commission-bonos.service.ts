import type { Knex } from 'knex';
import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/** Lo que la base acepta. Se declara acá para traducir el CHECK a un mensaje que se entienda. */
const METRICAS = ['venta', 'markup_pct', 'visitas', 'volumen', 'manual'] as const;
const BENEFICIARIOS = ['chofer', 'supervisor'] as const;
const COMPARADORES = ['gt', 'gte'] as const;

/**
 * `[RD.85]` — **Los bonos quincenales se capturan aquí.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-20: `commission_bonuses` tenía **un `UPDATE`** —el de los
 * criterios del objetivo mensual— y **ningún `INSERT`**. Los 17 bonos vivos se sembraron por
 * migración, así que crear uno nuevo, o apagar uno que ya no aplica, exigía un despliegue.
 *
 * Y no es poco dinero: el libro pagó **$140,800 en bonos a lo largo de 20 quincenas**, o sea
 * **$7,040 por quincena** — más que la comisión de varias rutas juntas.
 *
 * ── Qué entra acá y qué NO ───────────────────────────────────────────────────────────────
 * ⛔ Este servicio administra **los bonos quincenales** (`grupo IS NULL`). Los tres criterios
 * del **objetivo mensual** (`grupo = 'objetivo_mensual'`) **no se tocan desde acá**: sus pesos
 * tienen que sumar 100 % y eso lo hace cumplir `CommissionObjectiveService`, que ya tiene la
 * regla escrita. **Dos escritores sobre la misma tabla con la misma regla escrita dos veces es
 * cómo las dos se desincronizan** — así que acá se rechazan con su mensaje y se manda a la
 * vista «Bono por objetivo», que vive en la misma pantalla desde `[AUD-A6]`.
 *
 * ── Las reglas que hace cumplir ──────────────────────────────────────────────────────────
 *
 * **1. `periodo` es obligatorio y explícito, nunca por defecto.** Es el filtro que impidió que
 * un bono mensual se pagara **dos veces** (`[RD.59]`: sin él el motor veía 17 bonos donde debe
 * ver 14). Un campo que decide eso no se rellena solo.
 *
 * **2. Un bono se apaga, no se borra.** `activo = false` conserva su configuración —así nacen
 * los criterios del objetivo— y deja la historia explicable. Borrar la fila dejaría una
 * quincena pagada sin con qué justificar su bono.
 *
 * **3. La escala se resuelve sola** con la vigente a la fecha: pedirle a Dirección un UUID es
 * pedirle que adivine. ⚠️ Y los bonos **cuelgan de la escala**: `[RD.85.0]` hace que una
 * versión nueva del tabulador los herede, porque antes nacía sin ninguno.
 *
 * **4. El umbral se mide en la unidad de su métrica, y se dice.** `venta` y `markup_pct` no se
 * comparan con el mismo número: 25 es veinticinco por ciento en una y veinticinco pesos en la
 * otra. El servicio no puede adivinarlo, así que lo publica en el mensaje de error y la
 * pantalla lo rotula.
 */
@Injectable()
export class CommissionBonosService {
  private readonly logger = new Logger(CommissionBonosService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Los bonos de la escala vigente, con lo que **de verdad pagaron** al lado.
   *
   * ⭐ `pagado_historico` sale de `commission_run_lines`, no de `monto × veces`: un bono
   * configurado en $500 que nunca se cumplió pagó $0, y la diferencia entre «vale $500» y «pagó
   * $0 en veinte quincenas» es justamente la que hace falta para decidir si sigue vivo.
   */
  async listar(): Promise<BonoFila[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT b.id, b.beneficiario, b.nombre, b.metrica, b.comparador,
                b.umbral, b.monto, b.route_code, b.gate_venta_min,
                b.periodo, b.grupo, b.peso_pct, b.activo,
                b.updated_at, s.nombre AS escala_nombre,
                to_char(s.valid_from, 'YYYY-MM-DD') AS escala_desde
           FROM commercial.commission_bonuses b
           JOIN commercial.commission_scales s ON s.id = b.scale_id
          WHERE b.tenant_id = ? AND b.deleted_at IS NULL AND s.deleted_at IS NULL
            AND s.valid_to IS NULL
          ORDER BY b.periodo, b.nombre, b.route_code NULLS FIRST`, [tenantId]);
      return rows as BonoFila[];
    });
  }

  async crear(dto: AltaBono): Promise<BonoFila> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    this.validar(dto);

    return this.tk.run(async (trx) => {
      const escala = await this.escalaVigente(trx);
      const ya = await trx('commercial.commission_bonuses')
        .where({
          tenant_id: tenantId, scale_id: escala.id,
          beneficiario: dto.beneficiario, nombre: dto.nombre.trim(),
          route_code: dto.route_code ?? null,
        }).whereNull('deleted_at').first();
      if (ya) {
        // El UNIQUE lo impediría con un 23505 ilegible, y la salida correcta casi nunca es
        // «ponele otro nombre»: es editar el que ya está, o reactivarlo si está apagado.
        throw new ConflictException(
          `Ya existe el bono "${dto.nombre}" para ${dto.beneficiario}`
          + `${dto.route_code ? ` en la ruta ${dto.route_code}` : ' (todas las rutas)'}`
          + `${ya.activo ? '' : ', apagado'}. Editá ése en vez de crear un segundo: dos bonos `
          + 'con el mismo nombre pagarían los dos.');
      }
      const [fila] = await trx('commercial.commission_bonuses').insert({
        tenant_id: tenantId,
        scale_id: escala.id,
        beneficiario: dto.beneficiario,
        nombre: dto.nombre.trim(),
        metrica: dto.metrica,
        comparador: dto.comparador,
        umbral: dto.umbral,
        monto: dto.monto,
        route_code: dto.route_code ?? null,
        gate_venta_min: dto.gate_venta_min ?? null,
        periodo: dto.periodo,
        // ⛔ `grupo` y `peso_pct` quedan NULL a propósito: un bono con grupo es un criterio del
        // objetivo mensual, y ésos los administra su propio servicio (ver la cabecera).
        grupo: null,
        peso_pct: null,
        activo: dto.activo ?? true,
        created_by: userId, updated_by: userId,
      }).returning('*');
      this.logger.log(`[RD.85] alta de bono "${dto.nombre}" (${dto.periodo}) por ${userId}`);
      return fila as BonoFila;
    });
  }

  async editar(id: string, dto: EditarBono): Promise<BonoFila> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;

    return this.tk.run(async (trx) => {
      const actual = await trx('commercial.commission_bonuses')
        .where({ id, tenant_id: tenantId }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException(`El bono ${id} no existe`);
      if (actual.grupo) {
        throw new BadRequestException(
          `"${actual.nombre}" es un criterio del objetivo mensual, no un bono quincenal. Se edita `
          + 'en la vista «Bono por objetivo», donde la pantalla puede cuidar que los pesos sigan '
          + 'sumando 100 %.');
      }
      this.validar({ ...actual, ...dto } as AltaBono, true);

      const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      for (const campo of ['nombre', 'metrica', 'comparador', 'umbral', 'monto',
        'route_code', 'gate_venta_min', 'periodo', 'activo'] as const) {
        if (dto[campo] !== undefined) patch[campo] = dto[campo];
      }
      const [fila] = await trx('commercial.commission_bonuses')
        .where({ id, tenant_id: tenantId }).update(patch).returning('*');
      this.logger.log(`[RD.85] bono "${actual.nombre}" editado por ${userId}`);
      return fila as BonoFila;
    });
  }

  // ── Internos ───────────────────────────────────────────────────────────────────────────

  /**
   * ⭐ Los mensajes nombran el valor que llegó y los que se aceptan. Un «valor inválido» obliga
   * a abrir el código para saber qué poner, y lo que hay del otro lado es un `CHECK` cuyo error
   * (`23514`) no dice ni la columna.
   */
  private validar(dto: AltaBono, parcial = false): void {
    if (!parcial && !String(dto?.nombre ?? '').trim()) {
      throw new BadRequestException('nombre requerido: es con lo que se lee el bono en el recibo');
    }
    if (!(BENEFICIARIOS as readonly string[]).includes(dto?.beneficiario ?? '')) {
      throw new BadRequestException(
        `beneficiario "${dto?.beneficiario}" no existe. Son: ${BENEFICIARIOS.join(' | ')}.`);
    }
    if (!(METRICAS as readonly string[]).includes(dto?.metrica ?? '')) {
      throw new BadRequestException(
        `metrica "${dto?.metrica}" no existe. Son: ${METRICAS.join(' | ')}. `
        + '"manual" es la que no se deriva: la marca una persona.');
    }
    if (!(COMPARADORES as readonly string[]).includes(dto?.comparador ?? '')) {
      throw new BadRequestException(
        `comparador "${dto?.comparador}" no existe. Son: gt (estrictamente mayor) | gte (mayor o igual).`);
    }
    if (dto?.periodo !== 'quincena' && dto?.periodo !== 'mes') {
      // ⛔ Sin esto un bono mensual entra a las DOS quincenas del mes y se paga dos veces. Es
      // `[RD.59]`, y por eso no tiene valor por defecto.
      throw new BadRequestException(
        'periodo requerido: "quincena" o "mes". No tiene valor por defecto a propósito — un bono '
        + 'mensual sin marcar entraría a las dos quincenas del mes y se pagaría DOS VECES.');
    }
    if (dto?.monto == null || Number(dto.monto) < 0) {
      throw new BadRequestException('monto requerido y no puede ser negativo');
    }
    if (dto?.umbral == null || Number.isNaN(Number(dto.umbral))) {
      const unidad = dto?.metrica === 'markup_pct' ? 'por ciento'
        : dto?.metrica === 'venta' ? 'pesos de venta'
          : dto?.metrica === 'visitas' ? 'visitas' : 'unidades';
      throw new BadRequestException(`umbral requerido, en ${unidad} (la unidad de "${dto?.metrica}")`);
    }
  }

  private async escalaVigente(trx: Knex.Transaction): Promise<{ id: string }> {
    const escala = await trx('commercial.commission_scales')
      .whereNull('deleted_at').whereNull('valid_to')
      .orderBy('valid_from', 'desc').first();
    if (!escala) {
      throw new ConflictException(
        'No hay tabulador vigente, y un bono cuelga de uno: es lo que define desde cuándo rige. '
        + 'Creá la escala primero.');
    }
    return escala;
  }
}

export interface BonoFila {
  id: string; beneficiario: string; nombre: string; metrica: string; comparador: string;
  umbral: string | number; monto: string | number;
  route_code: string | null; gate_venta_min: string | number | null;
  periodo: string; grupo: string | null; peso_pct: string | number | null;
  activo: boolean; updated_at: string | null;
  escala_nombre?: string; escala_desde?: string;
}

export interface AltaBono {
  beneficiario: 'chofer' | 'supervisor'; nombre: string;
  metrica: typeof METRICAS[number]; comparador: 'gt' | 'gte';
  umbral: number; monto: number; periodo: 'quincena' | 'mes';
  route_code?: string | null; gate_venta_min?: number | null; activo?: boolean;
}

export interface EditarBono {
  nombre?: string; metrica?: typeof METRICAS[number]; comparador?: 'gt' | 'gte';
  umbral?: number; monto?: number; periodo?: 'quincena' | 'mes';
  route_code?: string | null; gate_venta_min?: number | null; activo?: boolean;
}
