import { Injectable, Inject, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { JobQueueService, FiscalJob } from '../jobs/job-queue.service';
import { JobRunnerService, FiscalPermanentError } from '../jobs/job-runner.service';
import { SatCredentialsService } from '../vault/sat-credentials.service';
import { CryptoService } from '../vault/crypto.service';
import { SAT_SOAP_PORT, SatSoapPort } from './sat-soap.port';
import { EstadoSolicitud, estadoLocalDe, COD_PERMANENTES, ESTADOS_TERMINALES_ERROR, EfirmaMaterial } from './sat-ws.types';
import { CfdiIngestService } from '../cfdi/cfdi-ingest.service';

const POLL_CAP = 120;

/**
 * FISCAL.4 — Handlers del pipeline de descarga masiva sobre fiscal.jobs.
 *   sat.solicitud  → autentica + SolicitaDescarga → guarda IdSolicitud, encola verificación
 *   sat.verificacion → VerificaSolicitudDescarga; polling one-shot (cada poll re-encola el
 *                      siguiente); al Terminar crea paquetes y encola su descarga
 *   sat.paquete    → descarga el ZIP (parseo/persistencia = FISCAL.4.2, diferido)
 *
 * Corre dentro del scope de tenant que fija JobRunnerService. Requiere e.firma en
 * la bóveda (FISCAL.2). Best-effort a nivel job (backoff/DLQ del runner).
 */
@Injectable()
export class DescargaOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(DescargaOrchestratorService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly jobs: JobQueueService,
    private readonly runner: JobRunnerService,
    private readonly creds: SatCredentialsService,
    private readonly crypto: CryptoService,
    @Optional() @Inject(SAT_SOAP_PORT) private readonly soap?: SatSoapPort,
    @Optional() private readonly cfdiIngest?: CfdiIngestService,
  ) {}

  onModuleInit(): void {
    this.runner.register('sat.solicitud', (j) => this.handleSolicitud(j));
    this.runner.register('sat.verificacion', (j) => this.handleVerificacion(j));
    this.runner.register('sat.paquete', (j) => this.handlePaquete(j));
    // Reconciliación cuando un paso agota reintentos (DLQ): no dejar el request colgado.
    this.runner.onDead('sat.solicitud', (j) => this.deadRequest(j));
    this.runner.onDead('sat.verificacion', (j) => this.deadRequest(j));
    this.runner.onDead('sat.paquete', (j) => this.deadPaquete(j));
  }

  /** Ejecuta `fn` con el material de e.firma descifrado (efímero). */
  private async withEfirma<T>(rfc: string, fn: (m: EfirmaMaterial, soap: SatSoapPort) => Promise<T>): Promise<T> {
    if (!this.soap) throw new FiscalPermanentError('SAT_SOAP_PORT no ligado');
    const cred = await this.creds.getSealed(rfc);
    if (!cred) throw new FiscalPermanentError(`Sin e.firma en la bóveda para ${rfc}`);
    return this.crypto.withDecryptedEfirma(cred, ({ key, password }) =>
      fn({ cerDer: cred.cer_der, keyDer: key, password }, this.soap!));
  }

  private async handleSolicitud(job: FiscalJob): Promise<Record<string, unknown>> {
    const requestId = (job.payload as any).requestId as string;
    const req = await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).first());
    if (!req) throw new FiscalPermanentError(`request ${requestId} no existe`);

    // Idempotencia: si un intento previo YA obtuvo IdSolicitud pero falló al encolar la
    // verificación, no re-solicitar (duplicaría la solicitud ante el SAT) — solo encolar.
    if (req.id_solicitud) {
      await this.jobs.enqueue(job.tenant_id, {
        queue: 'sat', type: 'sat.verificacion', payload: { requestId, poll: 0 },
        dedupKey: `sat.verificacion:${requestId}:0`, runAfterMs: 60_000,
      });
      return { idSolicitud: req.id_solicitud, resumed: true };
    }

    const r = await this.withEfirma(req.rfc_solicitante, async (m, soap) => {
      const auth = await soap.authenticate(m);
      return soap.solicita(auth.token, m, {
        rfcSolicitante: req.rfc_solicitante, rol: req.rol, tipo: req.tipo_solicitud,
        fechaIni: String(req.fecha_ini).slice(0, 10), fechaFin: String(req.fecha_fin).slice(0, 10),
      });
    });

    const permanente = COD_PERMANENTES.has(r.cod);
    await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).update({
      id_solicitud: r.idSolicitud || null, codigo_estado: r.cod, mensaje_sat: r.mensaje,
      estado: r.idSolicitud ? 'solicitada' : (permanente ? 'error' : 'nueva'), updated_at: trx.fn.now(),
    }));
    if (!r.idSolicitud) throw new (permanente ? FiscalPermanentError : Error)(`SolicitaDescarga cod=${r.cod} ${r.mensaje}`);

    await this.jobs.enqueue(job.tenant_id, {
      queue: 'sat', type: 'sat.verificacion', payload: { requestId, poll: 0 },
      dedupKey: `sat.verificacion:${requestId}:0`, runAfterMs: 120_000,
    });
    return { idSolicitud: r.idSolicitud };
  }

  private async handleVerificacion(job: FiscalJob): Promise<Record<string, unknown>> {
    const requestId = (job.payload as any).requestId as string;
    const poll = Number((job.payload as any).poll ?? 0);
    const req = await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).first());
    if (!req || !req.id_solicitud) throw new FiscalPermanentError(`request ${requestId} sin IdSolicitud`);
    // 'terminada' NO va en el skip: si un reintento reentra, re-crea paquetes (onConflict
    // ignore) y los re-encola (dedupKey) — así se completan los que quedaron sin encolar.
    if (['descargada', 'error', 'rechazada', 'vencida'].includes(req.estado)) return { skip: req.estado };

    const v = await this.withEfirma(req.rfc_solicitante, async (m, soap) => {
      const auth = await soap.authenticate(m);
      return soap.verifica(auth.token, m, req.rfc_solicitante, req.id_solicitud);
    });

    const estado = v.estadoSolicitud;
    const terminalErr = ESTADOS_TERMINALES_ERROR.has(estado);
    const enCurso = estado === EstadoSolicitud.Aceptada || estado === EstadoSolicitud.EnProceso;
    // "conocido" = el SAT devolvió un EstadoSolicitud del contrato (1..6). Un 0 (parseo
    // fallido) o cualquier valor fuera de rango = blip transitorio del WS → NO pisar el
    // estado local a 'error' ni abandonar el IdSolicitud; solo refrescar metadatos y re-pollear.
    const conocido = enCurso || terminalErr || estado === EstadoSolicitud.Terminada;
    await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).update({
      ...(conocido ? { estado: estadoLocalDe(estado) } : {}),
      estado_solicitud: estado, codigo_estado: v.codigoEstadoSolicitud,
      numero_cfdis: v.numeroCFDIs, mensaje_sat: v.mensaje,
      ...(estado === EstadoSolicitud.Terminada ? { packages_total: v.idsPaquetes.length } : {}),
      updated_at: trx.fn.now(),
    }));

    if (estado === EstadoSolicitud.Terminada) {
      // Rango sin CFDIs (mes sin facturas, etc.): 0 paquetes → cerrar como 'descargada'
      // directamente; si no, handlePaquete nunca correría y el request quedaría colgado.
      if (v.idsPaquetes.length === 0) {
        await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).update({ estado: 'descargada', packages_total: 0, packages_done: 0, updated_at: trx.fn.now() }));
        return { estado: 'descargada', paquetes: 0, cfdis: v.numeroCFDIs };
      }
      for (const idPaquete of v.idsPaquetes) {
        const pkgId = await this.tk.run(async (trx) => {
          const [row] = await trx('fiscal.download_packages')
            .insert({ tenant_id: job.tenant_id, request_id: requestId, id_paquete: idPaquete, estado: 'pendiente' })
            .onConflict(['tenant_id', 'request_id', 'id_paquete']).ignore().returning('id');
          if (row?.id) return row.id;
          // Ya existía (intento previo que murió a media del loop): recuperar su id para
          // (re)encolar su descarga. Sin esto el paquete queda insertado pero sin job.
          const ex = await trx('fiscal.download_packages').where({ request_id: requestId, id_paquete: idPaquete }).first('id');
          return ex?.id ?? null;
        });
        // dedupKey hace el encolado idempotente: si el job ya existe (done/pending) no duplica.
        if (pkgId) await this.jobs.enqueue(job.tenant_id, { queue: 'sat', type: 'sat.paquete', payload: { packageId: pkgId }, dedupKey: `sat.paquete:${pkgId}` });
      }
      return { estado: 'terminada', paquetes: v.idsPaquetes.length };
    }

    if (terminalErr) return { estado: estadoLocalDe(estado) }; // Rechazada / Error / Vencida → terminal

    // Aceptada / EnProceso / estado desconocido → seguir polleando (no abandonar por un blip).
    if (poll >= POLL_CAP) {
      await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).update({ estado: 'error', mensaje_sat: 'Timeout de verificación', updated_at: trx.fn.now() }));
      return { estado: 'timeout' };
    }
    const delay = Math.min(120_000 * (1 + Math.floor(poll / 5)), 30 * 60_000);
    await this.jobs.enqueue(job.tenant_id, { queue: 'sat', type: 'sat.verificacion', payload: { requestId, poll: poll + 1 }, dedupKey: `sat.verificacion:${requestId}:${poll + 1}`, runAfterMs: delay });
    return { estado: conocido ? estadoLocalDe(estado) : 'en_proceso', poll: poll + 1 };
  }

  private async handlePaquete(job: FiscalJob): Promise<Record<string, unknown>> {
    const packageId = (job.payload as any).packageId as string;
    const pkg = await this.tk.run(async (trx) => trx('fiscal.download_packages').where({ id: packageId }).first());
    if (!pkg) throw new FiscalPermanentError(`paquete ${packageId} no existe`);
    // Idempotencia: si un intento previo ya lo descargó (reintento/reaper), no re-descargar;
    // solo reconciliar por si el request quedó sin cerrar.
    if (pkg.estado === 'descargado' || pkg.estado === 'parseado') {
      await this.tk.run(async (trx) => this.reconcileRequest(trx, pkg.request_id));
      return { skip: pkg.estado };
    }
    const req = await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: pkg.request_id }).first());

    let zip: Buffer;
    try {
      zip = await this.withEfirma(req.rfc_solicitante, async (m, soap) => {
        const auth = await soap.authenticate(m);
        return soap.descargaPaquete(auth.token, m, req.rfc_solicitante, pkg.id_paquete);
      });
    } catch (e: any) {
      // Persistir el error de cada intento (visible en la bandeja aunque el job siga
      // reintentando). El estado 'error' definitivo lo pone deadPaquete al agotar la DLQ.
      await this.tk.run(async (trx) => trx('fiscal.download_packages').where({ id: packageId })
        .update({ last_error: (e?.message || String(e)).slice(0, 500), updated_at: trx.fn.now() }));
      throw e;
    }

    // FISCAL.4.2: sube el ZIP a R2 (si hay storage) + parsea los XML a fiscal.cfdis.
    // Si la ingesta no está disponible, el paquete queda 'descargado' sin parsear.
    let ingest: { storedRef: string | null; parsed: number; skipped: number; total: number } | null = null;
    if (this.cfdiIngest) {
      ingest = await this.cfdiIngest.ingestPackage({
        tenantId: job.tenant_id, requestId: pkg.request_id, packageId,
        rol: req?.rol ?? null, zip, baseDate: req?.fecha_fin ? new Date(req.fecha_fin) : undefined,
      });
    }

    await this.tk.run(async (trx) => {
      await trx('fiscal.download_packages').where({ id: packageId }).update({
        estado: ingest ? 'parseado' : 'descargado',
        stored_ref: ingest?.storedRef ?? null,
        num_cfdis: ingest?.parsed ?? null,
        downloaded_at: trx.fn.now(),
        parsed_at: ingest ? trx.fn.now() : null,
        last_error: ingest ? null : `ZIP ${zip.length} bytes — ingesta no disponible`,
        updated_at: trx.fn.now(),
      });
      await this.reconcileRequest(trx, pkg.request_id);
    });
    this.logger.log(`Paquete ${pkg.id_paquete}: ${zip.length} bytes${ingest ? `, ${ingest.parsed} CFDI` : ''}.`);
    return { bytes: zip.length, cfdis: ingest?.parsed ?? 0 };
  }

  /** Recalcula el estado del request desde los estados de sus paquetes (idempotente).
   *  Cierra el request cuando ya no quedan paquetes pendientes:
   *   todos 'descargado' → 'descargada'; alguno 'error' → 'descargada' (parcial) o 'error'. */
  private async reconcileRequest(trx: Knex, requestId: string): Promise<void> {
    const pkgs = await trx('fiscal.download_packages').where({ request_id: requestId }).select('estado');
    const total = pkgs.length;
    if (!total) return;
    const done = pkgs.filter((p: any) => p.estado === 'descargado' || p.estado === 'parseado').length;
    const errored = pkgs.filter((p: any) => p.estado === 'error').length;
    if (done + errored < total) {
      await trx('fiscal.download_requests').where({ id: requestId }).update({ packages_done: done, updated_at: trx.fn.now() });
      return;
    }
    const estado = errored === 0 ? 'descargada' : (done === 0 ? 'error' : 'descargada');
    await trx('fiscal.download_requests').where({ id: requestId }).update({
      estado, packages_done: done, updated_at: trx.fn.now(),
      ...(errored > 0 ? { mensaje_sat: `${errored}/${total} paquetes con error` } : {}),
    });
  }

  /** DLQ de solicitud/verificación: el request no puede avanzar → marcarlo en 'error'. */
  private async deadRequest(job: FiscalJob): Promise<void> {
    const requestId = (job.payload as any)?.requestId as string | undefined;
    if (!requestId) return;
    await this.tk.run(async (trx) => trx('fiscal.download_requests').where({ id: requestId }).andWhereNot('estado', 'descargada').update({
      estado: 'error', mensaje_sat: `Paso '${job.type}' agotó reintentos: ${job.last_error ?? ''}`.slice(0, 500), updated_at: trx.fn.now(),
    }));
  }

  /** DLQ de un paquete: marcarlo 'error' y reconciliar el request (evita que quede colgado). */
  private async deadPaquete(job: FiscalJob): Promise<void> {
    const packageId = (job.payload as any)?.packageId as string | undefined;
    if (!packageId) return;
    await this.tk.run(async (trx) => {
      const pkg = await trx('fiscal.download_packages').where({ id: packageId }).first();
      if (!pkg) return;
      await trx('fiscal.download_packages').where({ id: packageId }).update({
        estado: 'error', last_error: `Descarga agotó reintentos: ${job.last_error ?? ''}`.slice(0, 500), updated_at: trx.fn.now(),
      });
      await this.reconcileRequest(trx, pkg.request_id);
    });
  }
}
