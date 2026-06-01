import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, KNEX_CONNECTION_RAW } from '../../shared/database/database.module';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';
import { ScoringV2Service } from '../scoring/scoring-v2.service';
import { EventsService } from '../websocket/events.service';
import { toMxDateKey } from '../../shared/date/mx-date';
import { legacyTxStorage } from '../../shared/tenant/legacy-tx.als';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

@Injectable()
export class DailyCapturesService {
  private readonly logger = new Logger(DailyCapturesService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Inject(KNEX_CONNECTION_RAW) private readonly knexRaw: Knex,
    private readonly cloudinaryService: CloudinaryService,
    private readonly scoringV2Service: ScoringV2Service,
    private readonly eventsService: EventsService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Cache de la `scoring_config_versions` activa para no pegarle a DB en cada
   * insert. TTL 5 min — la versión cambia muy rara vez (admins la editan).
   * Si necesitan forzar refresh, restart del API basta.
   */
  private _activeVersion: any = null;
  private _activeVersionAt = 0;
  private readonly ACTIVE_VERSION_TTL_MS = 5 * 60_000;
  private async getActiveVersionCached(): Promise<any> {
    if (
      this._activeVersion &&
      Date.now() - this._activeVersionAt < this.ACTIVE_VERSION_TTL_MS
    ) {
      return this._activeVersion;
    }
    this._activeVersion = await this.scoringV2Service.getActiveVersion();
    this._activeVersionAt = Date.now();
    return this._activeVersion;
  }

  /**
   * Cache de la existencia de la columna `sync_uuid`:
   *   - Una vez detectada como `true`, se cachea por la vida del proceso
   *     (la columna no se borra en runtime).
   *   - Si está `false`, re-verifica cada 60s. Esto cubre el caso real:
   *     el API arrancó ANTES de aplicar la migration → el cache se quedó
   *     en `false` para SIEMPRE aunque después se haya creado la columna,
   *     causando regresión del UNIQUE (tenant_id, folio) en cada sync
   *     offline. Re-checkear permite picking up la migration sin reiniciar.
   */
  private _hasSyncUuidColumn: boolean | null = null;
  private _hasSyncUuidCheckedAt = 0;
  private readonly NEGATIVE_TTL_MS = 60_000;
  private async hasSyncUuidColumn(): Promise<boolean> {
    if (this._hasSyncUuidColumn === true) return true;
    const stale =
      this._hasSyncUuidColumn === false &&
      Date.now() - this._hasSyncUuidCheckedAt < this.NEGATIVE_TTL_MS;
    if (stale) return false;
    try {
      const exists = await this.knex.schema.hasColumn(
        'daily_captures',
        'sync_uuid',
      );
      this._hasSyncUuidColumn = exists;
      this._hasSyncUuidCheckedAt = Date.now();
      if (!exists) {
        this.logger.warn(
          'Columna `sync_uuid` no existe en daily_captures. Re-checkeo en 60s. Sin idempotencia offline-sync hasta entonces.',
        );
      } else {
        this.logger.log('Columna `sync_uuid` detectada — idempotencia offline-sync activa.');
      }
      return exists;
    } catch (err) {
      this.logger.error(`Error verificando columna sync_uuid: ${err}`);
      this._hasSyncUuidColumn = false;
      this._hasSyncUuidCheckedAt = Date.now();
      return false;
    }
  }

  async create(
    dto: CreateDailyCaptureDto,
    userId: string,
    username: string,
    zona: string,
  ) {
    this.logger.log(
      `create folio=${dto.folio} user=${username} zona=${zona} exh=${dto.exhibiciones?.length} sync_uuid=${dto.sync_uuid || '-'}`,
    );
    this.logger.debug(`stats=${JSON.stringify(dto.stats)}`);

    // ── IDEMPOTENCIA OFFLINE→SERVER ──────────────────────────────────
    // Si el cliente envió sync_uuid (típico de visitas offline), buscamos
    // antes de hacer cualquier trabajo costoso (Cloudinary, scoring) si ya
    // existe una fila con ese UUID. Esto evita duplicados cuando un POST
    // contestó 504/timeout pero sí escribió en DB, y el cliente reintenta.
    //
    // DEFENSIVE: detectamos si la columna `sync_uuid` existe. Si la migración
    // 20260529_add_sync_uuid_to_daily_captures NO se corrió todavía en este
    // entorno, ignoramos sync_uuid (cae al INSERT normal sin la columna) en
    // lugar de tirar 500 que mataría todos los sync_uuid retries del cliente.
    // El controller marca @SkipTenantTx → no hay auto-trx. Abrimos trxs
    // cortas (audit #3 — Cloudinary upload ya no idlea una conexión a DB).
    const tenantId = this.tenantCtx.requireTenantId();
    const hasSyncUuid = await this.hasSyncUuidColumn();
    if (dto.sync_uuid && hasSyncUuid) {
      // Precheck en trx corta (~ms) — evita upload redundante en retries.
      const existing = await this.knexRaw.transaction(async (tx) => {
        await tx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
        return tx('daily_captures').where({ sync_uuid: dto.sync_uuid }).first();
      });
      if (existing) {
        this.logger.warn(
          `Idempotency hit: sync_uuid=${dto.sync_uuid} ya existe (id=${existing.id}, folio=${existing.folio}). Retornando fila existente sin re-procesar.`,
        );
        return existing;
      }
    } else if (dto.sync_uuid && !hasSyncUuid) {
      this.logger.warn(
        `sync_uuid recibido pero la columna no existe en daily_captures. Corré la migration 20260529_add_sync_uuid_to_daily_captures. Procesando sin idempotencia.`,
      );
    }

    // Validar coordenadas GPS — antes solo se logueaba warning y se insertaba
    // con (0, 0) (Golfo de Guinea) → contaminaba mapas/reportes. Ahora rechazamos.
    const latitud = Number(dto.latitud);
    const longitud = Number(dto.longitud);
    const gpsInvalido =
      !Number.isFinite(latitud) ||
      !Number.isFinite(longitud) ||
      latitud === 0 ||
      longitud === 0 ||
      Math.abs(latitud) > 90 ||
      Math.abs(longitud) > 180;
    if (gpsInvalido) {
      this.logger.warn(
        `Rechazada captura folio=${dto.folio} por GPS inválido lat=${latitud} lng=${longitud}`,
      );
      throw new BadRequestException(
        'Captura sin GPS válido. Reactivá la ubicación en el dispositivo e inténtalo de nuevo.',
      );
    }

    // Track de fotos por exhibición: cuántas REQUERÍAN upload vs cuántas
    // efectivamente subieron. Antes solo contábamos `fallidas` global sin
    // saber si era contra 0 o contra N requeridas → se devolvía 200 silente.
    let fotosSubidas = 0;
    let fotosFallidas = 0;
    let fotosRequeridas = 0;
    const UPLOAD_CONCURRENCY = 3;
    const UPLOAD_TIMEOUT_MS = 30_000;

    const uploadOne = async (ex: any, index: number) => {
      // Path preferido: multipart attaches `_file` (Express.Multer.File con buffer).
      // Ahorra ~25% en wire vs base64 + evita el costo de re-codificar.
      if (ex._file) {
        fotosRequeridas++;
        try {
          const cloudinaryResult = await Promise.race([
            this.cloudinaryService.uploadImage(
              ex._file,
              `daily-captures/${dto.folio}`,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Upload timeout (${UPLOAD_TIMEOUT_MS}ms)`)),
                UPLOAD_TIMEOUT_MS,
              ),
            ),
          ]);

          ex.fotoUrl = cloudinaryResult.secure_url;
          ex.fotoPublicId = cloudinaryResult.public_id;
          fotosSubidas++;
        } catch (error) {
          fotosFallidas++;
          this.logger.error(
            `Foto ${index + 1} falló (multipart): ${error.message || error}`,
          );
          ex.fotoUrl = null;
          ex.fotoPublicId = null;
          // Marca consumida por la UI: ícono de alerta sobre la exhibición.
          ex.fotoUploadFailed = true;
          ex.fotoUploadError = String(error?.message || error).slice(0, 200);
        }
        delete ex._file;
        delete ex.fotoBase64; // safety
        return ex;
      }

      // Legacy path: base64 dentro del JSON (offline cache antigua).
      if (!ex.fotoBase64) return ex;
      fotosRequeridas++;
      try {
        const cloudinaryResult = await Promise.race([
          this.cloudinaryService.uploadImageBase64(
            ex.fotoBase64,
            `daily-captures/${dto.folio}`,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Upload timeout (${UPLOAD_TIMEOUT_MS}ms)`)),
              UPLOAD_TIMEOUT_MS,
            ),
          ),
        ]);

        ex.fotoUrl = cloudinaryResult.secure_url;
        ex.fotoPublicId = cloudinaryResult.public_id;
        fotosSubidas++;
      } catch (error) {
        fotosFallidas++;
        this.logger.error(
          `Foto ${index + 1} falló (base64): ${error.message || error}`,
        );
        ex.fotoUrl = null;
        ex.fotoPublicId = null;
        ex.fotoUploadFailed = true;
        ex.fotoUploadError = String(error?.message || error).slice(0, 200);
      }
      delete ex.fotoBase64;
      return ex;
    };

    const processedExhibiciones: any[] = [];
    for (let i = 0; i < dto.exhibiciones.length; i += UPLOAD_CONCURRENCY) {
      const batch = dto.exhibiciones.slice(i, i + UPLOAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map((ex, j) => uploadOne(ex, i + j)),
      );
      processedExhibiciones.push(...results);
    }

    if (fotosSubidas || fotosFallidas) {
      this.logger.log(`Fotos: ${fotosSubidas} subidas, ${fotosFallidas} fallidas`);
    }

    // ── PHASE DB-WORK ────────────────────────────────────────────────────
    // Desde acá hasta el INSERT TODO va en UNA trx corta. Antes del refactor,
    // la trx la abría el interceptor para TODA la request (incluyendo
    // Cloudinary upload) → 30s+ idle → pool exhausted o
    // idle_in_transaction_timeout. Audit #3.
    const dbWork = async () => {

    // ── Sanitización JSONB (audit #14): productosMarcados debe ser array de
    // strings UUID. Garbage (objetos, nulls, números) explota reports que
    // joinean con products.id.
    const UUID_LIKE = /^[a-z0-9-]{8,}$/i;
    for (const ex of processedExhibiciones) {
      if (Array.isArray(ex.productosMarcados)) {
        ex.productosMarcados = ex.productosMarcados.filter(
          (p: any) => typeof p === 'string' && UUID_LIKE.test(p),
        );
      } else {
        ex.productosMarcados = [];
      }
    }

    // ── ENRIQUECIMIENTO: backfill nivelEjecucionId desde el string si falta ──
    // Esto resuelve el bug donde el frontend mandaba exhibiciones sin nivelEjecucionId.
    // Bulk lookup: una sola query por todos los nombres distintos de nivel faltantes.
    const nivelesFaltantes = new Set<string>();
    for (const ex of processedExhibiciones) {
      if (!ex.nivelEjecucionId && !ex.nivel_ejecucion_id && ex.nivelEjecucion) {
        nivelesFaltantes.add(String(ex.nivelEjecucion).toLowerCase());
      }
    }

    // Audit #10: si vienen `nivelEjecucionId` desde el front, validar que
    // existan REALMENTE en catalogs. Antes ids basura pasaban al scoring que
    // devolvía 0 puntos silente.
    const incomingIds = new Set<string>();
    for (const ex of processedExhibiciones) {
      const id = ex.nivelEjecucionId || ex.nivel_ejecucion_id;
      if (id && typeof id === 'string') incomingIds.add(id);
    }
    if (incomingIds.size > 0) {
      const validRows = await this.knex('catalogs')
        .whereIn('id', Array.from(incomingIds))
        .select('id');
      const validIds = new Set(validRows.map((r) => r.id));
      for (const ex of processedExhibiciones) {
        const id = ex.nivelEjecucionId || ex.nivel_ejecucion_id;
        if (id && !validIds.has(id)) {
          this.logger.warn(
            `nivelEjecucionId "${id}" no existe en catalogs — limpiando para que backfill por nombre intente resolverlo.`,
          );
          ex.nivelEjecucionId = undefined;
          ex.nivel_ejecucion_id = undefined;
        }
      }
    }

    if (nivelesFaltantes.size > 0) {
      const valores = Array.from(nivelesFaltantes);
      const nivelRows = await this.knex('catalogs')
        .where({ catalog_id: 'niveles' })
        .whereIn(this.knex.raw('LOWER(value)') as any, valores)
        .select('id', 'value');

      const nivelByName = new Map<string, string>();
      for (const row of nivelRows) {
        nivelByName.set(String(row.value).toLowerCase(), row.id);
      }

      for (const ex of processedExhibiciones) {
        if (!ex.nivelEjecucionId && !ex.nivel_ejecucion_id && ex.nivelEjecucion) {
          const id = nivelByName.get(String(ex.nivelEjecucion).toLowerCase());
          if (id) {
            ex.nivelEjecucionId = id;
            this.logger.debug(
              `Backfill nivelEjecucionId "${ex.nivelEjecucion}" → ${id}`,
            );
          }
        }
      }
    }

    // Versión vigente del scoring (cacheada 5min para ahorrar la query en hot path).
    const activeVersion = await this.getActiveVersionCached();
    const configVersionId = activeVersion?.id;
    const scoreMaximoVersion = Number(activeVersion?.score_maximo) || 0;

    // Recalcular los puntos puros con el Backend Engine y no de la app móvil
    let puntosBackendTotales = dto.stats.puntuacionTotal || 0;

    if (configVersionId && processedExhibiciones.length > 0) {
       try {
         const exhibicionesParaScoring = processedExhibiciones.map((ex) => ({
           posicion_id: ex.ubicacionId,
           exhibicion_id: ex.conceptoId,
           nivel_ejecucion_id: ex.nivelEjecucionId || ex.nivel_ejecucion_id,
         }));

         // Filtrar exhibiciones que tienen todos los IDs resueltos
         const validExhibiciones = exhibicionesParaScoring.filter(
           ex => ex.posicion_id && ex.exhibicion_id && ex.nivel_ejecucion_id
         );

         if (validExhibiciones.length > 0) {
           const scoringDto = {
             config_version_id: configVersionId,
             exhibiciones: validExhibiciones,
           };
           
           const backendScore = await this.scoringV2Service.calculateVisitScore(scoringDto as any);
           puntosBackendTotales = backendScore.puntos_obtenidos;
           this.logger.log(`Puntos backend: ${puntosBackendTotales}`);

           if (validExhibiciones.length < processedExhibiciones.length) {
             this.logger.warn(
               `${processedExhibiciones.length - validExhibiciones.length} exhibiciones sin nivelEjecucionId; usando score frontend para esas`,
             );
           }
         } else {
           this.logger.warn('Ninguna exhibición con nivelEjecucionId válido; usando score frontend');
         }
       } catch (error) {
         this.logger.warn(`Fallo al recalcular scores; usando frontend. ${error.message}`);
       }
    }

    // Sanitización numérica (audit #13): NaN, Infinity, strings garbage no
    // pueden entrar al JSONB porque rompen casts downstream (`SUM((stats->>
    // 'ventaTotal')::numeric)` → ERROR). Coerción defensiva a 0.
    const safeNum = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const ventaAdicional = safeNum(dto.stats.ventaAdicional);
    const ventaTotalActual = safeNum(dto.stats.ventaTotal);
    const ventaTotalFinal = ventaTotalActual > 0 ? ventaTotalActual : ventaAdicional;

    // Recalibramos stats numéricos. `puntuacionTotal` viene del backend score
    // ya saneado (Number.isFinite garantizado por scoringV2).
    const statsWithPct = {
      ...dto.stats,
      ventaTotal: ventaTotalFinal,
      ventaAdicional,
      puntuacionTotal: safeNum(puntosBackendTotales),
      totalExhibiciones: safeNum((dto.stats as any).totalExhibiciones),
      totalProductosMarcados: safeNum((dto.stats as any).totalProductosMarcados),
    };

    this.logger.debug(
      `ventaTotal recibido=${ventaTotalActual} ventaAdicional=${ventaAdicional} ventaTotalFinal=${ventaTotalFinal}`,
    );

    // CRÍTICO: derivar `fecha` (DATE) en TZ MX, no UTC. Antes se usaba
    // `toISOString().split('T')[0]` que devuelve UTC — capturas hechas
    // entre 18:00–23:59 MX rolaban al día siguiente en UTC y la fila se
    // insertaba con `fecha` del día equivocado, contaminando TODOS los
    // reportes downstream (trend semanal, CSV, heatmap, etc.).
    //
    // Defense: si dto.horaInicio es un string mal formado, `new Date(s)` da
    // Invalid Date → toMxDateKey() podría devolver "NaN-NaN-NaN" y romper
    // queries downstream. Fallback a la hora actual del servidor.
    const horaInicioDate = dto.horaInicio ? new Date(dto.horaInicio) : null;
    const horaInicioValid =
      horaInicioDate && !Number.isNaN(horaInicioDate.getTime());
    if (dto.horaInicio && !horaInicioValid) {
      this.logger.warn(
        `dto.horaInicio inválido (${dto.horaInicio}). Fallback a Date.now() para 'fecha'.`,
      );
    }
    const fecha = toMxDateKey(horaInicioValid ? horaInicioDate! : new Date());

    // INSERT con ON CONFLICT por sync_uuid (defense in depth).
    // Si dos requests concurrentes pasaron el lookup pero llegan a INSERT al
    // mismo tiempo, el UNIQUE constraint resuelve. Postgres devuelve la fila
    // existente vía DO NOTHING + segundo SELECT.
    // Score maximo total del visita = max por exhibición × cantidad. Permite
    // que reports calculen `score_final_pct` sin recomputar la versión.
    const scoreMaximoVisita =
      scoreMaximoVersion && processedExhibiciones.length > 0
        ? scoreMaximoVersion * processedExhibiciones.length
        : null;
    const scoreFinalPct =
      scoreMaximoVisita && scoreMaximoVisita > 0
        ? Number(((puntosBackendTotales / scoreMaximoVisita) * 100).toFixed(2))
        : null;

    const insertPayload: any = {
      folio: dto.folio,
      user_id: userId,
      captured_by_username: username,
      zona_captura: zona || 'No Asignada',
      fecha: fecha,
      hora_inicio: dto.horaInicio,
      hora_fin: dto.horaFin,
      exhibiciones: JSON.stringify(processedExhibiciones),
      stats: JSON.stringify(statsWithPct),
      latitud: latitud,
      longitud: longitud,
      store_id: dto.store_id || null,
      // Persistencia del scoring backend — antes solo iba a `stats` JSONB y
      // los reports que leían `score_*` columns siempre veían NULL.
      config_version_id: configVersionId || null,
      score_maximo: scoreMaximoVisita,
      score_final_pct: scoreFinalPct,
    };
    // Solo incluir sync_uuid si la columna existe — protege contra entornos
    // donde la migration aún no se corrió.
    if (hasSyncUuid) {
      insertPayload.sync_uuid = dto.sync_uuid || null;
    }

    // INSERT con manejo unificado de colisiones por race condition.
    //
    // Antes usábamos `.onConflict('sync_uuid').ignore()` pero Postgres rechaza
    // el ON CONFLICT cuando el UNIQUE es un índice PARCIAL (`WHERE sync_uuid
    // IS NOT NULL`), ya que la inferencia exige incluir la misma predicate
    // en el ON CONFLICT y Knex no lo expone limpiamente. Solución: hacemos
    // INSERT normal y atrapamos `23505` por unique violation, sea por
    // (tenant_id, folio) o por sync_uuid. La pre-validación arriba ya cubre
    // el happy path; este try/catch es solo defensa contra la race window
    // entre el SELECT idempotente y este INSERT.
    let dailyCapture;
    try {
      [dailyCapture] = await this.knex('daily_captures')
        .insert(insertPayload)
        .returning('*');
    } catch (err: any) {
      if (err?.code !== '23505') throw err;

      // Determinar por qué constraint falló y releer la fila.
      const isSyncUuidCollision =
        err?.constraint === 'uniq_daily_captures_sync_uuid';
      const isFolioCollision =
        err?.constraint === 'daily_captures_tenant_folio_unique';

      if (isSyncUuidCollision && dto.sync_uuid) {
        dailyCapture = await this.knex('daily_captures')
          .where({ sync_uuid: dto.sync_uuid })
          .first();
        if (!dailyCapture) throw err;
        this.logger.warn(
          `Race condition resolved: sync_uuid=${dto.sync_uuid} insertó otro request, retornando fila existente id=${dailyCapture.id}.`,
        );
      } else if (isFolioCollision) {
        dailyCapture = await this.knex('daily_captures')
          .where({ folio: dto.folio })
          .first();
        if (!dailyCapture) throw err;
        // CRÍTICO (audit #2): si la fila existente NO es del mismo user, NO
        // la devolvemos — significa que el folio chocó con OTRA visita (otro
        // vendedor con misma inicial+segundo). Antes esto devolvía la fila
        // ajena como "exitosa" → la captura del user actual se perdía silente
        // y el reporte mostraba data cruzada. Ahora lanzamos para que el
        // cliente reintente con nuevo folio.
        if (dailyCapture.user_id && dailyCapture.user_id !== userId) {
          this.logger.error(
            `Folio collision con OTRO user: dto.folio=${dto.folio} requesting_user=${userId} existing_user=${dailyCapture.user_id}. Rechazando para evitar mezcla de data.`,
          );
          throw new BadRequestException(
            'El folio generado choca con otro pedido. Reintentá la captura.',
          );
        }
        this.logger.warn(
          `Folio ${dto.folio} ya existía (mismo user). Retornando fila existente id=${dailyCapture.id}.`,
        );
      } else {
        // Otra unique no contemplada — re-throw para que el cliente sepa.
        throw err;
      }
    }

    this.logger.log(
      `Captura guardada id=${dailyCapture.id} folio=${dailyCapture.folio} fecha=${dailyCapture.fecha}`,
    );

    return dailyCapture;
    }; // ← fin de la closure dbWork

    // ── Ejecutamos dbWork dentro de UNA trx corta ────────────────────────
    let dailyCapture: any;
    try {
      dailyCapture = await this.knexRaw.transaction(async (tx) => {
        await tx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
        return legacyTxStorage.run({ tx, tenantId }, () => dbWork());
      });
    } catch (err: any) {
      // Cleanup audit #4: si el INSERT falló post-Cloudinary, las fotos ya
      // subidas quedarían huérfanas pagas para siempre. Mejor esfuerzo.
      await this.cleanupOrphanCloudinary(processedExhibiciones);
      throw err;
    }

    // ── Emit POST-COMMIT (audit #5) ──────────────────────────────────────
    // Antes el emit corría dentro del trx. Si el COMMIT fallaba, los WS
    // subscribers recibían un evento de una fila que NO existe.
    this.eventsService.emitCaptureCreated({
      type: 'capture:created',
      captureId: dailyCapture.id,
      userId: userId,
      tenantId,
      capturedByUsername: username,
      zonaCaptura: zona || 'No Asignada',
      fecha: dailyCapture.fecha,
      stats: dailyCapture.stats,
    });

    // Surfacear resultado de upload de fotos al cliente. Permite que la UI
    // muestre un warning explícito si alguna foto no llegó a Cloudinary, en
    // lugar de dejar al usuario asumiendo "todo se guardó OK".
    return {
      ...dailyCapture,
      fotos: {
        requeridas: fotosRequeridas,
        subidas: fotosSubidas,
        fallidas: fotosFallidas,
      },
    };
  }

  /**
   * Audit #4: limpia uploads a Cloudinary que quedaron huérfanos cuando el
   * INSERT post-upload falla. Best-effort: si no se puede borrar (Cloudinary
   * down, etc.) loguea warning pero no propaga error.
   */
  private async cleanupOrphanCloudinary(exhibiciones: any[]): Promise<void> {
    const pids = exhibiciones
      .map((ex) => ex?.fotoPublicId)
      .filter((p): p is string => !!p);
    if (pids.length === 0) return;
    this.logger.warn(`Limpiando ${pids.length} fotos huérfanas en Cloudinary tras INSERT fallido.`);
    await Promise.allSettled(
      pids.map((p) =>
        this.cloudinaryService
          .deleteImage(p)
          .catch((e) =>
            this.logger.warn(`No se pudo borrar Cloudinary ${p}: ${e?.message || e}`),
          ),
      ),
    );
  }

  async findAll(
    fecha?: string,
    zona?: string,
    ejecutivo?: string,
    userId?: string,
  ) {
    // Defense in depth (audit #6): RLS scopea por current_tenant_id() pero
    // si por algún motivo el CLS no se setea (degradación), un user de un
    // tenant podría ver data de otro. Filter explícito.
    const tenantId = this.tenantCtx.get()?.tenantId;
    const query = this.knex('daily_captures').select('*');
    if (tenantId) query.where('tenant_id', tenantId);
    if (fecha) {
      // hora_inicio convertida a TZ MX para que "hoy" del cliente coincida
      // con el día calendario del backend (visitas vespertinas en MX están
      // en UTC del día siguiente).
      query.whereRaw(
        "DATE(hora_inicio AT TIME ZONE 'America/Mexico_City') = ?",
        [fecha],
      );
    }
    if (zona) query.where({ zona_captura: zona });
    if (ejecutivo) query.where({ captured_by_username: ejecutivo });
    if (userId) query.where({ user_id: userId });

    query.orderBy('created_at', 'desc');
    return query;
  }

  /**
   * Productos más marcados por el usuario en los últimos `days` días.
   * Devuelve top-N IDs con su frecuencia. Usado en captures step 5 para
   * mostrar una sección "Frecuentes" antes de la lista completa de marcas,
   * acortando dramáticamente el flujo cuando el usuario captura las mismas
   * tiendas/exhibidores repetidamente.
   *
   * Soporta scoping por tienda (`storeId`) para "frecuentes en esta tienda"
   * cuando hay tienda detectada — más relevante que el promedio del usuario.
   */
  async findFrequentProducts(
    userId: string,
    opts: { days?: number; limit?: number; storeId?: string } = {},
  ): Promise<{ product_id: string; marks: number }[]> {
    const days = opts.days ?? 30;
    const limit = Math.min(opts.limit ?? 20, 50);
    const tenantId = this.tenantCtx.get()?.tenantId;

    const rows = await this.knex.raw(
      `
      SELECT pid::text AS product_id, COUNT(*)::int AS marks
      FROM daily_captures dc,
           jsonb_array_elements(dc.exhibiciones) ex,
           jsonb_array_elements_text(ex->'productosMarcados') pid
      WHERE dc.user_id = ?
        AND dc.created_at >= NOW() - (? || ' days')::interval
        ${tenantId ? 'AND dc.tenant_id = ?' : ''}
        ${opts.storeId ? "AND ex->>'tiendaId' = ?" : ''}
      GROUP BY pid
      ORDER BY marks DESC
      LIMIT ?
      `,
      [
        userId,
        days,
        ...(tenantId ? [tenantId] : []),
        ...(opts.storeId ? [opts.storeId] : []),
        limit,
      ],
    );

    return rows.rows.map((r: any) => ({
      product_id: r.product_id,
      marks: Number(r.marks),
    }));
  }

  async findOne(id: string) {
    const dailyCapture = await this.knex('daily_captures').where({ id }).first();
    if (!dailyCapture) {
      // Intentar por folio
      const fallback = await this.knex('daily_captures').where({ folio: id }).first();
      if (fallback) return fallback;

      throw new NotFoundException(
        `Validación fallida: Captura con identificador ${id} no encontrada`,
      );
    }
    return dailyCapture;
  }

  async remove(
    id: string,
    requester?: { sub: string; username: string; role_name: string },
  ) {
    const visit = await this.knex('daily_captures').where({ id }).first()
      || await this.knex('daily_captures').where({ folio: id }).first();
    if (!visit) {
      throw new NotFoundException(`Visita con identificador ${id} no encontrada`);
    }

    // Ownership check: si pasaron un requester, solo puede borrar si es el dueño
    // o si tiene rol administrativo (superadmin). El control de permiso fino
    // (REPORTES_GESTIONAR) ya lo hace el guard en el controller.
    if (requester) {
      const isOwner = visit.user_id === requester.sub;
      const isAdmin = requester.role_name === 'superadmin';
      if (!isOwner && !isAdmin) {
        throw new ForbiddenException(
          'No puedes eliminar visitas que no te pertenecen.',
        );
      }
    }

    await this.knex('daily_captures').where({ id: visit.id }).del();

    // Audit log mínimo: queda en logs del servidor con quién borró qué.
    this.logger.log(
      `Visita eliminada folio=${visit.folio} id=${visit.id} owner=${visit.user_id} ` +
        `por=${requester?.username ?? 'sistema'} role=${requester?.role_name ?? '?'}`,
    );

    return { message: `Visita ${visit.folio} eliminada` };
  }
}
