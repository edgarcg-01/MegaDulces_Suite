import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import {
  mapearResumen,
  mapearCabecera,
  mapearCanal,
  num,
  type AgreementStatus,
  type ApoyoTipo,
  type AcuerdoResumen,
  type CanalExpediente,
} from './promo-agreements.mapper';

// Se re-exportan para que los consumidores sigan importando de un solo lugar.
export type { AgreementStatus, ApoyoTipo, AcuerdoResumen, CanalExpediente };

/**
 * `[MKT.1]` — ACUERDOS CON PROVEEDOR: el formato MKTN001 y su expediente.
 *
 * ── Qué gobierna este servicio ───────────────────────────────────────────────────────────────
 * El convenio que Mercadotecnia negocia con un proveedor: mecánica, vigencia, canales
 * participantes, presupuesto y evidencia. En papel es el formato **MKTN001** que se firma.
 *
 * ⚠️ NO es `CommercialPromotionsService`. Esa gobierna el motor de PRECIO (`percent_off_product`,
 * `nxm`, …) que `OrdersService` aplica a un pedido. Son entidades distintas con distinto dueño:
 * un acuerdo puede no mover ningún precio en la app (el caso real folio 1013 es «3% en la línea
 * Alteño, aplicado por Sistemas» directo en el ERP) y una regla de precio puede existir sin
 * acuerdo. Mezclarlas obligaría a que una de las dos mienta.
 *
 * ── Los dos módulos, una sola tabla ──────────────────────────────────────────────────────────
 * No hay «vista del jefe» y «vista de la plaza» como dos fuentes. Hay una, y el corte es de
 * **alcance** (`ScopeService`, ADR-050):
 *
 *   · Mercadotecnia (`all`)    → ve los once canales de cada acuerdo, el monto y el presupuesto.
 *   · Encargado de plaza       → ve sólo los acuerdos donde SU sucursal participa, y sólo su
 *                                expediente. El monto viaja aparte (ver `ocultarDinero`).
 *
 * Duplicar la tabla para separar las vistas sería garantizar que un día digan cosas distintas.
 *
 * ── El dinero no se recorta con CSS ──────────────────────────────────────────────────────────
 * `monto`, `presupuesto_detalle` y `conceptos` **no se envían** a quien no tiene
 * `MKT_AGREEMENTS_GESTIONAR`. Ocultarlos en el frontend deja el número viajando en el JSON, y
 * ese JSON se abre con F12. El recorte se hace acá, en el servidor, y por eso `listar()` recibe
 * `verDinero` en vez de deducirlo de la pantalla.
 *
 * ── El contador de evidencia se RECALCULA, nunca se incrementa ───────────────────────────────
 * `evidence_count` sale siempre de contar `promo_agreement_files`. Un `+= 1` sobreviviría a un
 * borrado y la cobertura («6 de 10») quedaría diciendo que hay evidencia que ya no está. Es el
 * mismo criterio que TP usa con `reserved_amount`.
 *
 * Conexión: `TenantKnexService.run()` es OBLIGATORIO — las cuatro tablas tienen RLS forzado y sin
 * el `SET LOCAL app.tenant_id` toda consulta devuelve cero filas en silencio (lección de Fase E).
 */

export type PresupuestoTipo = 'topado' | 'abierto' | 'por_volumen';
export type RecursoTipo =
  | 'cedis_nota_credito'
  | 'proveedor_sin_cargo'
  | 'proveedor_promocionales'
  | 'presupuesto_a_favor'
  | 'otros';
export type FileKind = 'negociacion' | 'evidencia' | 'formato_pdf' | 'nota_credito';

const STATUSES: readonly AgreementStatus[] = ['borrador', 'autorizado', 'vigente', 'cerrado', 'cancelado'];
const APOYOS: readonly ApoyoTipo[] = ['sell_out', 'sell_in', 'exhibicion', 'promocional', 'otro'];
const PRESUPUESTOS: readonly PresupuestoTipo[] = ['topado', 'abierto', 'por_volumen'];
const RECURSOS: readonly RecursoTipo[] = [
  'cedis_nota_credito', 'proveedor_sin_cargo', 'proveedor_promocionales', 'presupuesto_a_favor', 'otros',
];
const FILE_KINDS: readonly FileKind[] = ['negociacion', 'evidencia', 'formato_pdf', 'nota_credito'];

/** Un canal participante tal como lo manda el paso 3 del alta. */
export interface CanalDto {
  warehouse_code: string;
  cajas_texto?: string | null;
  cajas_lp?: number | null;
  cajas_can?: number | null;
  cajas_mor?: number | null;
  con_cargo?: boolean | null;
  /** Cuántas piezas de evidencia se le piden a esta plaza. Default 1. */
  evidence_required?: number | null;
}

export interface CodigoDto {
  position: number;
  code: string;
  descripcion?: string | null;
}

/**
 * `[MKT.6]` Un codigo del acuerdo, **tal como lo SELECCIONA `obtener()`**.
 *
 * La nulabilidad no se supuso: sale de la migracion `20260928120000`
 * (`position smallint NOT NULL`, `code varchar(40) NOT NULL`, `descripcion varchar(160)`
 * sin NOT NULL). Declarar un campo como no-nulo cuando la columna si lo admite es como se
 * cuela un `undefined` en pantalla sin que el tipo avise.
 */
export interface CodigoDelAcuerdo {
  id: string;
  position: number;
  code: string;
  descripcion: string | null;
}

/**
 * `[MKT.6]` Un archivo del expediente, tal como lo selecciona `obtener()`. Misma fuente de
 * nulabilidad: la migracion. `channel_id` es NULL a proposito -- son los papeles de la
 * NEGOCIACION, que no cuelgan de ninguna plaza.
 */
export interface ArchivoDelExpediente {
  id: string;
  channel_id: string | null;
  kind: string;
  file_name: string;
  file_url: string;
  mime_type: string | null;
  size_bytes: number | null;
  nota: string | null;
  uploaded_by_username: string | null;
  uploaded_at: string;
}

/**
 * `[MKT.6]` El expediente completo de un acuerdo: la cabecera mas sus tres colecciones.
 *
 * Se arma con `ReturnType<typeof mapearCabecera>` y `mapearCanal` en vez de repetir sus
 * campos: si el mapper cambia de forma, este tipo cambia solo en vez de mentir.
 */
export type AcuerdoDetalle = ReturnType<typeof mapearCabecera> & {
  codigos: CodigoDelAcuerdo[];
  canales: ReturnType<typeof mapearCanal>[];
  archivos: ArchivoDelExpediente[];
};

export interface CrearAcuerdoDto {
  empresa: string;
  proveedor: string;
  apoyo?: ApoyoTipo;
  agente_ventas?: string | null;
  fecha_negociacion: string;
  periodo?: number | null;
  vigencia_desde: string;
  vigencia_hasta?: string | null;
  vigencia_hasta_texto?: string | null;
  oferta_negociada?: string | null;
  mecanica: string;
  presupuesto_tipo?: PresupuestoTipo;
  presupuesto_detalle?: string | null;
  presupuesto_fecha?: string | null;
  recurso: RecursoTipo;
  recurso_otros?: string | null;
  conceptos?: string | null;
  monto?: number | null;
  distribucion_producto?: string | null;
  distribucion_codigo?: string | null;
  distribucion_cargo?: 'con_cargo' | 'sin_cargo' | null;
  autoriza_nombre?: string | null;
  canales?: CanalDto[];
  codigos?: CodigoDto[];
}


@Injectable()
export class PromoAgreementsService {
  private readonly logger = new Logger(PromoAgreementsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    /**
     * `[ZN.3]` El alcance de datos (ADR-050). No es `@Optional()`: acá decide si la plaza ve un
     * acuerdo o no, y un servicio instanciado sin él tendría que elegir entre abrirse o romperse.
     */
    private readonly scope: ScopeService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // LECTURA
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Tablero. Una fila por acuerdo, con la cobertura del expediente ya agregada.
   *
   * El recorte por plaza se hace con `EXISTS` sobre los canales y no con un `JOIN`: un acuerdo
   * que corre en seis plazas saldría seis veces y la cuenta del tablero quedaría inflada.
   */
  async listar(opts: { status?: AgreementStatus; verDinero: boolean } = { verDinero: false }): Promise<AcuerdoResumen[]> {
    if (opts.status && !STATUSES.includes(opts.status)) {
      throw new BadRequestException(`Estado inválido: ${opts.status}`);
    }
    const sc = await this.scope.current();

    return this.tk.run(async (trx) => {
      let q = trx('commercial.promo_agreements as a')
        .select(
          'a.id', 'a.folio', 'a.proveedor', 'a.apoyo', 'a.mecanica', 'a.status',
          'a.vigencia_desde', 'a.vigencia_hasta', 'a.vigencia_hasta_texto', 'a.monto',
        )
        .select(
          trx.raw(`(SELECT count(*) FROM commercial.promo_agreement_channels c
                     WHERE c.tenant_id = a.tenant_id AND c.agreement_id = a.id) AS canales_total`),
          trx.raw(`(SELECT count(*) FROM commercial.promo_agreement_channels c
                     WHERE c.tenant_id = a.tenant_id AND c.agreement_id = a.id
                       AND c.evidence_count >= c.evidence_required) AS canales_con_evidencia`),
          trx.raw(`(SELECT coalesce(sum(c.evidence_count), 0) FROM commercial.promo_agreement_channels c
                     WHERE c.tenant_id = a.tenant_id AND c.agreement_id = a.id) AS evidencia_total`),
        )
        .whereNull('a.deleted_at')
        .orderBy('a.vigencia_desde', 'desc');

      if (opts.status) q = q.where('a.status', opts.status);

      // El corte de la plaza. `applyTo` con `all` no toca el query; con `none` devuelve vacío
      // (no 403: un tablero sin filas es una respuesta legítima, un 403 rompe la pantalla entera).
      const dim = sc.dims['warehouse'];
      if (dim.mode !== 'all') {
        q = q.whereExists(function (this: Knex.QueryBuilder) {
          const sub = this.select(trx.raw('1'))
            .from('commercial.promo_agreement_channels as c')
            .whereRaw('c.tenant_id = a.tenant_id AND c.agreement_id = a.id');
          if (dim.mode === 'none' || !dim.values.length) sub.whereRaw('false');
          else sub.whereIn('c.warehouse_code', dim.values);
        });
      }

      const rows = (await q) as Record<string, unknown>[];
      return rows.map((r) => mapearResumen(r, opts.verDinero));
    });
  }

  /** KPIs del tablero. Se calculan sobre el MISMO recorte que la tabla, o no cuadrarían. */
  async resumen(verDinero: boolean): Promise<{
    activos: number;
    expedientes_completos: number;
    expedientes_total: number;
    canales_sin_evidencia: number;
    monto_comprometido?: number | null;
  }> {
    const lista = await this.listar({ verDinero });
    const activos = lista.filter((a) => a.status === 'autorizado' || a.status === 'vigente');
    const expedientes_total = activos.reduce((s, a) => s + a.canales_total, 0);
    const expedientes_completos = activos.reduce((s, a) => s + a.canales_con_evidencia, 0);

    const salida = {
      activos: activos.length,
      expedientes_completos,
      expedientes_total,
      canales_sin_evidencia: expedientes_total - expedientes_completos,
    };
    if (!verDinero) return salida;

    // Suma sólo lo que TIENE monto. Los acuerdos sin monto pactado no entran como 0: eso diría
    // "se comprometió cero", que es distinto de "no se midió" (ADR-056).
    const conMonto = activos.filter((a) => a.monto !== null && a.monto !== undefined);
    return {
      ...salida,
      monto_comprometido: conMonto.length ? conMonto.reduce((s, a) => s + (a.monto as number), 0) : null,
    };
  }

  /** El expediente completo de un acuerdo: carátula + códigos + canales + archivos. */
  async obtener(id: string, verDinero: boolean): Promise<AcuerdoDetalle> {
    const sc = await this.scope.current();

    return this.tk.run(async (trx) => {
      const cab = await trx('commercial.promo_agreements')
        .select('*')
        .where('id', id)
        .whereNull('deleted_at')
        .first();
      if (!cab) throw new NotFoundException('Acuerdo no encontrado');

      let canales = await trx('commercial.promo_agreement_channels')
        .select('*')
        .where('agreement_id', id)
        .orderBy('warehouse_code');

      // La plaza sólo ve SU expediente dentro del acuerdo. Ver la carátula es legítimo (necesita
      // la mecánica para ejecutarla); ver el desempeño de las otras plazas, no.
      const dim = sc.dims['warehouse'];
      if (dim.mode !== 'all') {
        const permitidas = dim.mode === 'none' ? [] : dim.values;
        canales = canales.filter((c: { warehouse_code: string }) => permitidas.includes(c.warehouse_code));
        // Si el acuerdo no toca ninguna de sus plazas, para esa persona no existe.
        if (!canales.length) throw new NotFoundException('Acuerdo no encontrado');
      }

      const idsCanal = canales.map((c: { id: string }) => c.id);
      const codigos = await trx('commercial.promo_agreement_codes')
        .select('id', 'position', 'code', 'descripcion')
        .where('agreement_id', id)
        .orderBy('position');

      const archivos = await trx('commercial.promo_agreement_files')
        .select('id', 'channel_id', 'kind', 'file_name', 'file_url', 'mime_type', 'size_bytes',
          'nota', 'uploaded_by_username', 'uploaded_at')
        .where('agreement_id', id)
        .whereNull('deleted_at')
        .where((b: Knex.QueryBuilder) => {
          if (dim.mode === 'all') return;
          // La plaza ve los archivos de su canal y los de la negociación (channel_id NULL),
          // que son el respaldo de lo que se le está pidiendo ejecutar.
          b.whereNull('channel_id');
          if (idsCanal.length) b.orWhereIn('channel_id', idsCanal);
        })
        .orderBy('uploaded_at', 'desc');

      return {
        ...mapearCabecera(cab, verDinero),
        codigos,
        canales: canales.map((c: Record<string, unknown>) => mapearCanal(c)),
        archivos,
      };
    });
  }

  /**
   * Módulo 2 — «lo que corre en mi plaza». Devuelve el canal de la persona, no el acuerdo entero.
   *
   * La sucursal llega **explícita** y se valida contra el alcance: el mismo criterio de
   * `[ZN.3]`. Un `:code` libre dejaría a Padre Hidalgo leer el expediente de Zamora.
   */
  async listarPorSucursal(warehouseCode: string): Promise<Array<AcuerdoResumen & { canal: CanalExpediente }>> {
    const code = String(warehouseCode ?? '').trim();
    if (!code) throw new BadRequestException('Falta la sucursal');
    await this.scope.assertCanRead('warehouse', code);

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.promo_agreement_channels as c')
        .join('commercial.promo_agreements as a', function (this: Knex.JoinClause) {
          this.on('a.id', '=', 'c.agreement_id').andOn('a.tenant_id', '=', 'c.tenant_id');
        })
        .select(
          'a.id', 'a.folio', 'a.proveedor', 'a.apoyo', 'a.mecanica', 'a.status',
          'a.vigencia_desde', 'a.vigencia_hasta', 'a.vigencia_hasta_texto',
          'c.id as canal_id', 'c.warehouse_code', 'c.warehouse_name', 'c.cajas_texto',
          'c.cajas_lp', 'c.cajas_can', 'c.cajas_mor', 'c.con_cargo',
          'c.evidence_required', 'c.evidence_count', 'c.evidence_last_at',
        )
        .whereRaw('LOWER(c.warehouse_code) = LOWER(?)', [code])
        .whereNull('a.deleted_at')
        .whereIn('a.status', ['autorizado', 'vigente'])
        .orderBy('a.vigencia_hasta', 'asc');

      return rows.map((r: Record<string, unknown>) => ({
        // `verDinero: false` SIEMPRE en esta superficie: es la pantalla de la plaza.
        ...mapearResumen(
          { ...r, canales_total: 1, canales_con_evidencia: 0, evidencia_total: 0 } as Record<string, unknown>,
          false,
        ),
        canales_total: 1,
        canales_con_evidencia: num(r['evidence_count']) >= num(r['evidence_required']) ? 1 : 0,
        evidencia_total: num(r['evidence_count']),
        canal: mapearCanal({ ...r, id: r['canal_id'] }),
      }));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ESCRITURA — el alta (Mercadotecnia)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async crear(dto: CrearAcuerdoDto, usuario: { id?: string; username?: string }): Promise<ReturnType<typeof mapearCabecera>> {
    this.validarCarátula(dto);
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      const [fila] = await trx('commercial.promo_agreements')
        .insert({
          tenant_id: tenantId,
          empresa: dto.empresa.trim(),
          proveedor: dto.proveedor.trim(),
          apoyo: dto.apoyo ?? 'sell_out',
          agente_ventas: dto.agente_ventas?.trim() || null,
          fecha_negociacion: dto.fecha_negociacion,
          periodo: dto.periodo ?? null,
          vigencia_desde: dto.vigencia_desde,
          vigencia_hasta: dto.vigencia_hasta ?? null,
          vigencia_hasta_texto: dto.vigencia_hasta_texto?.trim() || null,
          oferta_negociada: dto.oferta_negociada?.trim() || null,
          mecanica: dto.mecanica.trim(),
          presupuesto_tipo: dto.presupuesto_tipo ?? 'topado',
          presupuesto_detalle: dto.presupuesto_detalle?.trim() || null,
          presupuesto_fecha: dto.presupuesto_fecha ?? null,
          recurso: dto.recurso,
          recurso_otros: dto.recurso_otros?.trim() || null,
          conceptos: dto.conceptos?.trim() || null,
          monto: dto.monto ?? null,
          distribucion_producto: dto.distribucion_producto?.trim() || null,
          distribucion_codigo: dto.distribucion_codigo?.trim() || null,
          distribucion_cargo: dto.distribucion_cargo ?? null,
          autoriza_nombre: dto.autoriza_nombre?.trim() || null,
          status: 'borrador',
          created_by: usuario?.id ?? null,
          created_by_username: usuario?.username ?? null,
        })
        .returning('*');

      if (dto.canales?.length) await this.escribirCanales(trx, tenantId, fila.id, dto.canales);
      if (dto.codigos?.length) await this.escribirCodigos(trx, tenantId, fila.id, dto.codigos);

      this.logger.log(`[MKT.1] Acuerdo borrador creado · ${fila.id} · ${dto.proveedor}`);
      return mapearCabecera(fila, true);
    });
  }

  /** Reemplaza los canales participantes. Sólo en borrador: cambiarlos después mueve el papel. */
  async fijarCanales(id: string, canales: CanalDto[]): Promise<{ ok: true; canales: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const a = await trx('commercial.promo_agreements').select('status').where('id', id).first();
      if (!a) throw new NotFoundException('Acuerdo no encontrado');
      if (a.status !== 'borrador') {
        throw new ConflictException(
          'Los canales sólo se cambian en borrador: el formato ya autorizado es el que se firmó.',
        );
      }
      // Borra sólo los canales SIN evidencia. Uno con fotos no se puede quitar sin perder el
      // rastro de que esa plaza sí ejecutó (y el CASCADE se llevaría los archivos).
      const conEvidencia = await trx('commercial.promo_agreement_channels')
        .select('warehouse_code')
        .where('agreement_id', id)
        .where('evidence_count', '>', 0);
      if (conEvidencia.length) {
        throw new ConflictException(
          `No se pueden reemplazar los canales: ${conEvidencia.map((c: { warehouse_code: string }) => c.warehouse_code).join(', ')} ya subieron evidencia.`,
        );
      }
      await trx('commercial.promo_agreement_channels').where('agreement_id', id).del();
      await this.escribirCanales(trx, tenantId, id, canales);
      return { ok: true, canales: canales.length };
    });
  }

  /**
   * Autoriza el acuerdo: asigna folio y lo vuelve un compromiso.
   *
   * El folio se genera **sólo acá** (patrón TP.8) y con el MISMO UPSERT atómico de
   * `commercial.order_sequences` que ya usan pedidos, picking, cotizaciones y embarques — no un
   * `MAX()+1`, que con dos autorizaciones simultáneas asigna el mismo número a las dos.
   */
  async autorizar(id: string, usuario: { id?: string; username?: string }): Promise<ReturnType<typeof mapearCabecera>> {
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      const a = await trx('commercial.promo_agreements')
        .select('*').where('id', id).whereNull('deleted_at').first();
      if (!a) throw new NotFoundException('Acuerdo no encontrado');
      if (a.status !== 'borrador') throw new ConflictException(`El acuerdo ya está ${a.status}.`);

      // Un acuerdo sin canales no le llega a ninguna plaza: sería un papel firmado que nadie
      // ejecuta y una cobertura de "0 de 0" que se lee como completa.
      const [{ count }] = await trx('commercial.promo_agreement_channels')
        .where('agreement_id', id).count({ count: '*' });
      if (Number(count) === 0) {
        throw new BadRequestException('Marca al menos un canal participante antes de autorizar.');
      }

      const folio = await this.siguienteFolio(trx, tenantId);
      const [fila] = await trx('commercial.promo_agreements')
        .where('id', id)
        .update({
          folio,
          status: 'autorizado',
          authorized_by: usuario?.id ?? null,
          authorized_by_username: usuario?.username ?? null,
          authorized_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');

      this.logger.log(`[MKT.1] Acuerdo AUTORIZADO · folio ${folio} · ${a.proveedor} · por ${usuario?.username ?? '?'}`);
      return mapearCabecera(fila, true);
    });
  }

  async cambiarEstado(id: string, status: AgreementStatus): Promise<ReturnType<typeof mapearCabecera>> {
    if (!STATUSES.includes(status)) throw new BadRequestException(`Estado inválido: ${status}`);
    if (status === 'borrador') throw new BadRequestException('No se regresa a borrador: el folio ya salió.');

    return this.tk.run(async (trx) => {
      const a = await trx('commercial.promo_agreements').select('status').where('id', id).first();
      if (!a) throw new NotFoundException('Acuerdo no encontrado');
      if (a.status === 'borrador' && status !== 'cancelado') {
        throw new ConflictException('Autoriza el acuerdo antes de ponerlo vigente o cerrarlo.');
      }
      const patch: Record<string, unknown> = { status, updated_at: trx.fn.now() };
      if (status === 'cerrado') patch['closed_at'] = trx.fn.now();

      const [fila] = await trx('commercial.promo_agreements').where('id', id).update(patch).returning('*');
      return mapearCabecera(fila, true);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ESCRITURA — la evidencia (la plaza)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Sube una pieza de evidencia al expediente de un canal.
   *
   * El corte de alcance va **antes** de tocar la base: quien trabaja en Padre Hidalgo no sube
   * (ni ve) el expediente de Zamora, aunque tenga el permiso que abre la pantalla.
   */
  async subirEvidencia(
    channelId: string,
    dto: { file_name: string; file_url: string; mime_type?: string; size_bytes?: number; nota?: string; kind?: FileKind },
    usuario: { id?: string; username?: string },
  ): Promise<ReturnType<typeof mapearCanal>> {
    if (!dto?.file_name?.trim() || !dto?.file_url?.trim()) {
      throw new BadRequestException('Falta el archivo');
    }
    const kind: FileKind = dto.kind && FILE_KINDS.includes(dto.kind) ? dto.kind : 'evidencia';
    if (kind !== 'evidencia') {
      throw new BadRequestException('Este endpoint sube evidencia de ejecución; el resto va por el acuerdo.');
    }
    const tenantId = this.tenantCtx.requireTenantId();

    // 1) Resolver el canal para saber de qué plaza es. Lectura mínima, antes del alcance.
    const canal = await this.tk.run(async (trx) =>
      trx('commercial.promo_agreement_channels')
        .select('id', 'agreement_id', 'warehouse_code')
        .where('id', channelId)
        .first(),
    );
    if (!canal) throw new NotFoundException('Expediente no encontrado');

    // 2) El corte. Si no alcanza, 403 y no se escribió nada.
    await this.scope.assertCanRead('warehouse', canal.warehouse_code);

    return this.tk.run(async (trx) => {
      await trx('commercial.promo_agreement_files').insert({
        tenant_id: tenantId,
        agreement_id: canal.agreement_id,
        channel_id: canal.id,
        kind,
        file_name: dto.file_name.trim(),
        file_url: dto.file_url.trim(),
        mime_type: dto.mime_type ?? null,
        size_bytes: dto.size_bytes ?? null,
        nota: dto.nota?.trim() || null,
        uploaded_by: usuario?.id ?? null,
        uploaded_by_username: usuario?.username ?? null,
      });

      const canalActualizado = await this.recalcularEvidencia(trx, canal.id);
      this.logger.log(`[MKT.1] Evidencia subida · canal ${canal.warehouse_code} · ${dto.file_name}`);
      return mapearCanal(canalActualizado);
    });
  }

  /** Baja lógica de una pieza de evidencia. Recalcula el contador: nunca `-= 1`. */
  async quitarEvidencia(fileId: string): Promise<ReturnType<typeof mapearCanal>> {
    return this.tk.run(async (trx) => {
      const f = await trx('commercial.promo_agreement_files')
        .select('id', 'channel_id')
        .where('id', fileId)
        .whereNull('deleted_at')
        .first();
      if (!f) throw new NotFoundException('Archivo no encontrado');
      if (!f.channel_id) throw new BadRequestException('Ese archivo no pertenece a un expediente de plaza.');

      const canal = await trx('commercial.promo_agreement_channels')
        .select('warehouse_code').where('id', f.channel_id).first();
      await this.scope.assertCanRead('warehouse', canal.warehouse_code);

      await trx('commercial.promo_agreement_files')
        .where('id', fileId)
        .update({ deleted_at: trx.fn.now() });

      return mapearCanal(await this.recalcularEvidencia(trx, f.channel_id));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // internos
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Cuenta los archivos vivos del canal y escribe el resultado. **Recalcula, no incrementa**: un
   * `+= 1` sobrevive a un borrado y deja la cobertura afirmando evidencia que ya no existe.
   */
  private async recalcularEvidencia(trx: Knex, channelId: string) {
    const [agg] = await trx('commercial.promo_agreement_files')
      .where('channel_id', channelId)
      .where('kind', 'evidencia')
      .whereNull('deleted_at')
      .select(
        trx.raw('count(*)::int as n'),
        trx.raw('min(uploaded_at) as primera'),
        trx.raw('max(uploaded_at) as ultima'),
      );

    const [fila] = await trx('commercial.promo_agreement_channels')
      .where('id', channelId)
      .update({
        evidence_count: agg.n,
        evidence_first_at: agg.primera ?? null,
        evidence_last_at: agg.ultima ?? null,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    return fila;
  }

  /** Folio consecutivo por año. Mismo UPSERT atómico de `commercial.order_sequences`. */
  private async siguienteFolio(trx: Knex, tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const { rows } = await trx.raw(
      `INSERT INTO commercial.order_sequences (tenant_id, year, current_value)
       VALUES (?, ?, 1)
       ON CONFLICT (tenant_id, year) DO UPDATE
         SET current_value = commercial.order_sequences.current_value + 1,
             updated_at = now()
       RETURNING current_value`,
      [tenantId, year],
    );
    return `MK-${year}-${String(rows[0].current_value).padStart(4, '0')}`;
  }

  private async escribirCanales(trx: Knex, tenantId: string, agreementId: string, canales: CanalDto[]) {
    const codes = canales.map((c) => String(c.warehouse_code ?? '').trim()).filter(Boolean);
    if (!codes.length) throw new BadRequestException('Ningún canal válido');

    const almacenes = await trx('commercial.warehouses')
      .select('id', 'code', 'name')
      .whereRaw('LOWER(code) = ANY(?)', [codes.map((c) => c.toLowerCase())])
      .whereNull('deleted_at');

    const porCode = new Map(almacenes.map((w: { code: string }) => [w.code.toLowerCase(), w]));
    const faltan = codes.filter((c) => !porCode.has(c.toLowerCase()));
    if (faltan.length) {
      // Se falla explícito: un canal que no existe en el catálogo dejaría un expediente
      // huérfano y una cobertura que nunca se puede completar.
      throw new BadRequestException(`Estas sucursales no existen: ${faltan.join(', ')}`);
    }

    await trx('commercial.promo_agreement_channels').insert(
      canales.map((c) => {
        const w = porCode.get(String(c.warehouse_code).trim().toLowerCase()) as { id: string; code: string; name: string };
        return {
          tenant_id: tenantId,
          agreement_id: agreementId,
          warehouse_id: w.id,
          warehouse_code: w.code,
          warehouse_name: w.name ?? null,
          cajas_texto: c.cajas_texto?.trim() || null,
          cajas_lp: c.cajas_lp ?? null,
          cajas_can: c.cajas_can ?? null,
          cajas_mor: c.cajas_mor ?? null,
          con_cargo: c.con_cargo ?? null,
          evidence_required: c.evidence_required ?? 1,
        };
      }),
    );
  }

  private async escribirCodigos(trx: Knex, tenantId: string, agreementId: string, codigos: CodigoDto[]) {
    const limpios = codigos
      .filter((c) => String(c.code ?? '').trim())
      .map((c) => ({
        tenant_id: tenantId,
        agreement_id: agreementId,
        position: c.position,
        code: String(c.code).trim(),
        descripcion: c.descripcion?.trim() || null,
      }));
    // Un renglón vacío no es un código: el formato trae 6 casillas y casi siempre se usan 1 o 2.
    if (limpios.length) await trx('commercial.promo_agreement_codes').insert(limpios);
  }

  private validarCarátula(dto: CrearAcuerdoDto) {
    if (!dto?.empresa?.trim()) throw new BadRequestException('Falta la empresa');
    if (!dto?.proveedor?.trim()) throw new BadRequestException('Falta el proveedor o marca');
    if (!dto?.mecanica?.trim()) throw new BadRequestException('Falta la mecánica');
    if (!dto?.fecha_negociacion) throw new BadRequestException('Falta la fecha de negociación');
    if (!dto?.vigencia_desde) throw new BadRequestException('Falta la fecha de inicio de vigencia');

    const hasta = dto.vigencia_hasta ?? null;
    const texto = dto.vigencia_hasta_texto?.trim() || null;
    // El campo `AL` del formato admite fecha o condición ("hasta agotar"), nunca las dos ni
    // ninguna: sin fin no se puede cerrar el acuerdo ni reportarle al proveedor.
    if (!!hasta === !!texto) {
      throw new BadRequestException(
        'La vigencia termina en una fecha o en una condición («hasta agotar»), no en las dos ni en ninguna.',
      );
    }
    if (dto.apoyo && !APOYOS.includes(dto.apoyo)) throw new BadRequestException(`Apoyo inválido: ${dto.apoyo}`);
    if (dto.presupuesto_tipo && !PRESUPUESTOS.includes(dto.presupuesto_tipo)) {
      throw new BadRequestException(`Tipo de presupuesto inválido: ${dto.presupuesto_tipo}`);
    }
    if (!RECURSOS.includes(dto.recurso)) throw new BadRequestException(`Recurso inválido: ${dto.recurso}`);
    if (dto.recurso === 'otros' && !dto.recurso_otros?.trim()) {
      throw new BadRequestException('Con recurso «otros» hay que especificar cuál.');
    }
    if (dto.monto !== null && dto.monto !== undefined && !(dto.monto > 0)) {
      // Un 0 se lee como "no cuesta nada"; si no se pactó monto, va sin monto (ADR-056).
      throw new BadRequestException('El monto va vacío cuando no se pactó, nunca en 0.');
    }
  }



}
