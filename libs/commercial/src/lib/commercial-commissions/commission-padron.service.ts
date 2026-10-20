import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[RD.84]` — **El padrón de rutas se administra desde la pantalla, no desde una migración.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * Medido el 2026-10-20: el módulo de comisiones sólo podía `INSERT` en cinco tablas
 * (`scales`, `scale_tiers`, `runs`, `run_lines`, `engine_lines`). **`commission_route_config`
 * no era una de ellas**, así que cada cambio de padrón —una ruta que entra, una que sale, un
 * chofer que cambia, una nómina de banco que sube— exigía **escribir una migración,
 * commitearla, empujarla y aplicarla a prod a mano**.
 *
 * ⭐ La prueba no es teórica: mover las rutas **321 y 322** de Ruta Directa a Vecinal —un hecho
 * operativo que decide Comercial, no un desarrollador— costó exactamente eso. Mientras un
 * cambio de padrón necesite un despliegue, **el proceso no está en la aplicación: está en el
 * repositorio**.
 *
 * ── Las cuatro reglas que este servicio hace cumplir ─────────────────────────────────────
 *
 * **1. Una baja SIEMPRE lleva fecha y motivo.** `activo_hasta` decide qué quincenas siguen
 * comisionando (`[RD.84.0]`) y `notes` es lo único que explica el porqué seis meses después.
 * Una baja sin fecha no comisiona en **ningún** periodo — se traga la historia entera.
 *
 * **2. Un alta lleva `activo_desde`.** Sin él, una ruta dada de alta hoy comisionaría la
 * quincena 1. Es el defecto de la baja, espejado.
 *
 * **3. ⛔ Una fecha de vigencia que toca una quincena YA PAGADA exige `confirmar`.** No se
 * bloquea —a veces la corrección es justamente ésa— pero no se hace de paso: la respuesta
 * nombra las quincenas y el monto que cambiarían de signo si alguien recalcula. *El acto
 * destructivo nunca es el camino por defecto.*
 *
 * **4. La escala es obligatoria y se resuelve sola.** `scale_id` es `NOT NULL` con FK; pedirle
 * a Comercial que elija un UUID de escala es pedirle que adivine. Si no se manda, se toma la
 * vigente a la fecha.
 *
 * ⚠️ **Lo que este servicio NO hace: borrar.** Una ruta que sale del padrón se da de baja con
 * su fecha; nunca se elimina la fila. Borrarla dejaría las corridas pasadas sin con qué
 * explicar a quién le pagaron, y la regla dura del repo prohíbe borrar en prod.
 */
@Injectable()
export class CommissionPadronService {
  private readonly logger = new Logger(CommissionPadronService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * El padrón **editable**, que no es el universo.
   *
   * ⛔ `GET /universe` devuelve el universo DERIVADO —rutas que vienen del ERP, con veredicto—
   * y es de sólo lectura. Esto devuelve las filas de `commission_route_config`, que son las
   * únicas que se pueden editar. Mezclarlos haría creer que una ruta `camion_sin_config` se
   * puede modificar desde acá, cuando lo que hay que hacer es **darla de alta**.
   */
  async listar(): Promise<PadronFila[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT c.id, c.route_code, c.scale_id, c.zona,
                c.chofer_nombre, c.supervisor_nombre,
                c.nomina_banco, c.activo, c.notes,
                to_char(c.activo_desde, 'YYYY-MM-DD') AS activo_desde,
                to_char(c.activo_hasta, 'YYYY-MM-DD') AS activo_hasta,
                c.updated_at, c.updated_by,
                -- Lo que la fila PRODUJO, para que una baja no se decida a ciegas.
                COALESCE(h.quincenas, 0)   AS quincenas_pagadas,
                COALESCE(h.pagado, 0)      AS pagado_historico
           FROM commercial.commission_route_config c
           LEFT JOIN LATERAL (
             SELECT count(DISTINCT r.period_id) AS quincenas,
                    sum(l.a_pagar)              AS pagado
               FROM commercial.commission_run_lines l
               JOIN commercial.commission_runs r ON r.id = l.run_id
              WHERE l.route_code = c.route_code AND l.deleted_at IS NULL
                AND r.status = 'pagado' AND r.deleted_at IS NULL
           ) h ON true
          WHERE c.tenant_id = ? AND c.deleted_at IS NULL
          ORDER BY c.activo DESC, c.route_code`, [tenantId]);
      return rows as PadronFila[];
    });
  }

  async crear(dto: AltaRuta): Promise<PadronFila> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    const code = String(dto?.route_code ?? '').trim();
    if (!code) throw new BadRequestException('route_code requerido');
    if (dto?.nomina_banco == null || Number(dto.nomina_banco) < 0) {
      throw new BadRequestException(
        'nomina_banco requerida y no puede ser negativa. Es la deducción que se le resta al '
        + 'chofer; si la ruta no la tiene, va en 0 explícitamente.',
      );
    }
    // ⭐ Regla 2: sin `activo_desde` el alta comisiona hacia atrás. Se exige acá y no se
    // rellena con `current_date` en silencio: la fecha en que la ruta EMPEZÓ a comisionar es un
    // dato del negocio, y casi nunca es el día en que alguien se acordó de capturarla.
    if (!dto?.activo_desde) {
      throw new BadRequestException(
        'activo_desde requerida: sin ella la ruta comisionaría también las quincenas anteriores '
        + 'a su alta. Es la primera quincena en que esta ruta cobra.',
      );
    }

    return this.tk.run(async (trx) => {
      const ya = await trx('commercial.commission_route_config')
        .where({ tenant_id: tenantId, route_code: code }).whereNull('deleted_at').first();
      if (ya) {
        // El UNIQUE (tenant_id, route_code) ya lo impediría, pero con un 23505 ilegible. Y la
        // salida correcta casi nunca es "elegí otro código": es reactivar la que ya existe.
        throw new ConflictException(
          `La ruta ${code} ya está en el padrón (${ya.activo ? 'activa' : 'dada de baja'}). `
          + 'Para volver a darla de alta, editá esa fila y quitale la fecha de baja — así '
          + 'conserva su historia en vez de arrancar una segunda.',
        );
      }
      const scaleId = dto.scale_id ?? await this.escalaVigente(trx, dto.activo_desde);
      const [fila] = await trx('commercial.commission_route_config')
        .insert({
          tenant_id: tenantId,
          route_code: code,
          scale_id: scaleId,
          zona: dto.zona ?? null,
          chofer_nombre: dto.chofer_nombre ?? null,
          supervisor_nombre: dto.supervisor_nombre ?? null,
          nomina_banco: dto.nomina_banco,
          activo: true,
          activo_desde: dto.activo_desde,
          notes: dto.notes ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning('*');
      this.logger.log(`[RD.84] alta de ruta ${code} desde ${dto.activo_desde} por ${userId}`);
      return fila as PadronFila;
    });
  }

  /**
   * Edita una fila del padrón. La **baja** es un caso de esto, no un endpoint aparte: dar de
   * baja es poner `activo = false` con su fecha y su motivo.
   */
  async editar(id: string, dto: EditarRuta): Promise<{ fila: PadronFila; aviso: AvisoPagadas | null }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;

    return this.tk.run(async (trx) => {
      const actual = await trx('commercial.commission_route_config')
        .where({ id, tenant_id: tenantId }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException(`La ruta ${id} no está en el padrón`);

      const baja = dto.activo === false;
      // ⭐ Regla 1. Se mira el VALOR RESULTANTE, no el del payload: una baja puede llegar en dos
      // pasos (primero la fecha, después el apagado) y mirar sólo lo que viene en este PATCH
      // dejaría pasar el segundo sin fecha.
      const hasta = dto.activo_hasta !== undefined ? dto.activo_hasta : actual.activo_hasta;
      const motivo = dto.notes !== undefined ? dto.notes : actual.notes;
      if (baja && !hasta) {
        throw new BadRequestException(
          'Una baja lleva fecha: sin activo_hasta la ruta deja de comisionar en TODAS las '
          + 'quincenas, también en las que sí trabajó. Poné el último día en que cobró.',
        );
      }
      if (baja && !String(motivo ?? '').trim()) {
        throw new BadRequestException(
          'Una baja lleva motivo. Es lo único que va a explicar esta fila dentro de seis meses, '
          + 'cuando alguien pregunte por qué esta ruta dejó de cobrar.',
        );
      }

      // ── Regla 3: ¿esta fecha toca una quincena ya PAGADA? ────────────────────────────────
      const aviso = await this.quincenasPagadasAfectadas(
        trx, tenantId, actual.route_code,
        dto.activo_desde !== undefined ? dto.activo_desde : actual.activo_desde,
        hasta, dto.activo !== undefined ? dto.activo : actual.activo,
      );
      if (aviso && !dto.confirmar) {
        throw new ConflictException(
          `Esta vigencia cambia ${aviso.quincenas} quincena(s) YA PAGADA(S) por `
          + `$${aviso.pagado} (${aviso.detalle}). Lo pagado no se recalcula solo, pero si alguien `
          + 'corre "calcular desde", esas quincenas saldrían distintas. Volvé a enviarlo con '
          + 'confirmar:true si eso es justamente lo que estás corrigiendo.',
        );
      }

      const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      for (const campo of ['zona', 'chofer_nombre', 'supervisor_nombre', 'nomina_banco',
        'activo', 'activo_desde', 'activo_hasta', 'notes', 'scale_id'] as const) {
        if (dto[campo] !== undefined) patch[campo] = dto[campo];
      }
      if (patch.nomina_banco !== undefined && Number(patch.nomina_banco) < 0) {
        throw new BadRequestException('nomina_banco no puede ser negativa');
      }
      const [fila] = await trx('commercial.commission_route_config')
        .where({ id, tenant_id: tenantId }).update(patch).returning('*');
      this.logger.log(`[RD.84] ${baja ? 'baja' : 'edicion'} de ruta ${actual.route_code} por ${userId}`);
      return { fila: fila as PadronFila, aviso };
    });
  }

  // ── Internos ───────────────────────────────────────────────────────────────────────────

  private async escalaVigente(trx: any, onDate: string): Promise<string> {
    const escala = await trx('commercial.commission_scales')
      .whereNull('deleted_at')
      .where('valid_from', '<=', onDate)
      .andWhere((b: any) => b.whereNull('valid_to').orWhere('valid_to', '>', onDate))
      .orderBy('valid_from', 'desc').first();
    if (!escala) {
      throw new ConflictException(
        `No hay tabulador vigente al ${onDate}, y una ruta del padrón no puede existir sin uno: `
        + 'es lo que decide su porcentaje. Creá la escala primero.',
      );
    }
    return escala.id as string;
  }

  /**
   * Las quincenas **pagadas** en las que esta ruta cobró y que la vigencia nueva dejaría fuera.
   *
   * ⛔ Se mide contra lo que de verdad se pagó (`commission_run_lines` de corridas `pagado`),
   * no contra el calendario: una ruta puede no haber cobrado en una quincena por otros motivos,
   * y avisar de ésas sería ruido que enseña a ignorar el aviso.
   */
  private async quincenasPagadasAfectadas(
    trx: any, tenantId: string, routeCode: string,
    desde: string | null, hasta: string | null, activo: boolean,
  ): Promise<AvisoPagadas | null> {
    const { rows } = await trx.raw(
      `SELECT p.anio, p.period_no, sum(l.a_pagar) AS pagado
         FROM commercial.commission_run_lines l
         JOIN commercial.commission_runs r    ON r.id = l.run_id
         JOIN commercial.commission_periods p ON p.id = r.period_id
        WHERE r.tenant_id = ? AND r.status = 'pagado'
          AND r.deleted_at IS NULL AND l.deleted_at IS NULL
          AND l.route_code = ? AND l.a_pagar > 0
          -- La regla de [RD.84.0], negada: las que YA NO quedarían vigentes.
          AND NOT (
                (?::date IS NULL OR ?::date <= p.date_to)
            AND (?::boolean OR (?::date IS NOT NULL AND ?::date >= p.date_from))
          )
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenantId, routeCode, desde, desde, activo, hasta, hasta]);
    if (!rows.length) return null;
    const pagado = rows.reduce((s: number, r: any) => s + Number(r.pagado || 0), 0);
    return {
      quincenas: rows.length,
      pagado: pagado.toFixed(2),
      detalle: rows.map((r: any) => `Q${r.period_no}/${r.anio}`).join(', '),
    };
  }
}

export interface PadronFila {
  id: string; route_code: string; scale_id: string; zona: string | null;
  chofer_nombre: string | null; supervisor_nombre: string | null;
  nomina_banco: string | number; activo: boolean; notes: string | null;
  activo_desde: string | null; activo_hasta: string | null;
  updated_at: string | null; updated_by: string | null;
  quincenas_pagadas: number; pagado_historico: string | number;
}

export interface AltaRuta {
  route_code: string; nomina_banco: number; activo_desde: string;
  scale_id?: string; zona?: string | null;
  chofer_nombre?: string | null; supervisor_nombre?: string | null; notes?: string | null;
}

export interface EditarRuta {
  zona?: string | null; chofer_nombre?: string | null; supervisor_nombre?: string | null;
  nomina_banco?: number; activo?: boolean;
  activo_desde?: string | null; activo_hasta?: string | null;
  notes?: string | null; scale_id?: string;
  /** El acto sobre quincenas ya pagadas no es el camino por defecto. Ver regla 3. */
  confirmar?: boolean;
}

/** Lo que una vigencia nueva dejaría fuera, en quincenas y en pesos. */
export interface AvisoPagadas { quincenas: number; pagado: string; detalle: string }
