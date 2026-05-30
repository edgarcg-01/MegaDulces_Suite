import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';
import { ScoringV2Service } from '../scoring/scoring-v2.service';
import { EventsService } from '../websocket/events.service';
import { toMxDateKey } from '../../shared/date/mx-date';

@Injectable()
export class DailyCapturesService {
  private readonly logger = new Logger(DailyCapturesService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly cloudinaryService: CloudinaryService,
    private readonly scoringV2Service: ScoringV2Service,
    private readonly eventsService: EventsService,
  ) {}

  /**
   * Cache booleano: si la migration `add_sync_uuid_to_daily_captures` corrió,
   * la columna existe. Evita pegarle a `information_schema` por cada INSERT.
   * Asumimos que la columna no se borra en runtime (no es manejado por DDL
   * live), por eso una sola query inicial es suficiente.
   */
  private _hasSyncUuidColumn: boolean | null = null;
  private async hasSyncUuidColumn(): Promise<boolean> {
    if (this._hasSyncUuidColumn !== null) return this._hasSyncUuidColumn;
    try {
      this._hasSyncUuidColumn = await this.knex.schema.hasColumn(
        'daily_captures',
        'sync_uuid',
      );
      if (!this._hasSyncUuidColumn) {
        this.logger.warn(
          'Columna `sync_uuid` no existe en daily_captures. Sin idempotencia offline-sync hasta correr la migration.',
        );
      }
      return this._hasSyncUuidColumn;
    } catch (err) {
      this.logger.error(`Error verificando columna sync_uuid: ${err}`);
      this._hasSyncUuidColumn = false;
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
    const hasSyncUuid = await this.hasSyncUuidColumn();
    if (dto.sync_uuid && hasSyncUuid) {
      const existing = await this.knex('daily_captures')
        .where({ sync_uuid: dto.sync_uuid })
        .first();
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

    // Validar coordenadas GPS
    const latitud = Number(dto.latitud);
    const longitud = Number(dto.longitud);
    if (!latitud || !longitud || latitud === 0 || longitud === 0) {
      this.logger.warn(`GPS inválido o no proporcionado: lat=${latitud} lng=${longitud}`);
    }

    // Procesar fotos Base64 con concurrencia limitada (máx 3) y timeout por foto.
    let fotosSubidas = 0;
    let fotosFallidas = 0;
    const UPLOAD_CONCURRENCY = 3;
    const UPLOAD_TIMEOUT_MS = 30_000;

    const uploadOne = async (ex: any, index: number) => {
      // Path preferido: multipart attaches `_file` (Express.Multer.File con buffer).
      // Ahorra ~25% en wire vs base64 + evita el costo de re-codificar.
      if (ex._file) {
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
        }
        delete ex._file;
        delete ex.fotoBase64; // safety
        return ex;
      }

      // Legacy path: base64 dentro del JSON (offline cache antigua).
      if (!ex.fotoBase64) return ex;
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

    // ── ENRIQUECIMIENTO: backfill nivelEjecucionId desde el string si falta ──
    // Esto resuelve el bug donde el frontend mandaba exhibiciones sin nivelEjecucionId.
    // Bulk lookup: una sola query por todos los nombres distintos de nivel faltantes.
    const nivelesFaltantes = new Set<string>();
    for (const ex of processedExhibiciones) {
      if (!ex.nivelEjecucionId && !ex.nivel_ejecucion_id && ex.nivelEjecucion) {
        nivelesFaltantes.add(String(ex.nivelEjecucion).toLowerCase());
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

    // Consultar score_maximo dinámico desde scoring_config_versions (para meta local opcional)
    const activeVersion = await this.scoringV2Service.getActiveVersion();
    const configVersionId = activeVersion?.id;

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

    // Normalizar ventaTotal: si es 0 o menor que ventaAdicional, usar ventaAdicional
    const ventaAdicional = dto.stats.ventaAdicional || 0;
    const ventaTotalActual = dto.stats.ventaTotal || 0;
    const ventaTotalFinal = ventaTotalActual > 0 ? ventaTotalActual : ventaAdicional;

    // Agregar puntosTotales recalibrados
    const statsWithPct = {
      ...dto.stats,
      ventaTotal: ventaTotalFinal,
      puntuacionTotal: puntosBackendTotales,
      // Se eliminan campos legacy % obsoletos
    };

    this.logger.debug(
      `ventaTotal recibido=${ventaTotalActual} ventaAdicional=${ventaAdicional} ventaTotalFinal=${ventaTotalFinal}`,
    );

    // CRÍTICO: derivar `fecha` (DATE) en TZ MX, no UTC. Antes se usaba
    // `toISOString().split('T')[0]` que devuelve UTC — capturas hechas
    // entre 18:00–23:59 MX rolaban al día siguiente en UTC y la fila se
    // insertaba con `fecha` del día equivocado, contaminando TODOS los
    // reportes downstream (trend semanal, CSV, heatmap, etc.).
    const fecha = dto.horaInicio
      ? toMxDateKey(new Date(dto.horaInicio))
      : toMxDateKey(new Date());

    // INSERT con ON CONFLICT por sync_uuid (defense in depth).
    // Si dos requests concurrentes pasaron el lookup pero llegan a INSERT al
    // mismo tiempo, el UNIQUE constraint resuelve. Postgres devuelve la fila
    // existente vía DO NOTHING + segundo SELECT.
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
      latitud: latitud || 0,
      longitud: longitud || 0,
      store_id: dto.store_id || null,
    };
    // Solo incluir sync_uuid si la columna existe — protege contra entornos
    // donde la migration aún no se corrió.
    if (hasSyncUuid) {
      insertPayload.sync_uuid = dto.sync_uuid || null;
    }

    let dailyCapture;
    if (dto.sync_uuid && hasSyncUuid) {
      const inserted = await this.knex('daily_captures')
        .insert(insertPayload)
        .onConflict('sync_uuid')
        .ignore()
        .returning('*');
      dailyCapture = inserted[0];
      if (!dailyCapture) {
        // Concurrent insert ganó; releer fila existente.
        dailyCapture = await this.knex('daily_captures')
          .where({ sync_uuid: dto.sync_uuid })
          .first();
        this.logger.warn(
          `Race condition resolved: sync_uuid=${dto.sync_uuid} insertó otro request, retornando fila existente.`,
        );
      }
    } else {
      [dailyCapture] = await this.knex('daily_captures')
        .insert(insertPayload)
        .returning('*');
    }

    this.logger.log(
      `Captura guardada id=${dailyCapture.id} folio=${dailyCapture.folio} fecha=${dailyCapture.fecha}`,
    );

    this.eventsService.emitCaptureCreated({
      type: 'capture:created',
      captureId: dailyCapture.id,
      userId: userId,
      capturedByUsername: username,
      zonaCaptura: zona || 'No Asignada',
      fecha: fecha,
      stats: dailyCapture.stats,
    });

    return dailyCapture;
  }

  async findAll(
    fecha?: string,
    zona?: string,
    ejecutivo?: string,
    userId?: string,
  ) {
    const query = this.knex('daily_captures').select('*');
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
