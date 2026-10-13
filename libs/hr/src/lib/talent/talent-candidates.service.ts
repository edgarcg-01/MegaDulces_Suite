import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService, sanitizarNombre, validarAdjunto } from '@megadulces/platform-core';
import type {
  HrCandidatoEdicion, HrCandidatoEventoDto, HrCandidatoEventoNuevo, HrCandidatoFichaDto, HrCandidatoFilaDto,
  HrCandidatosListaDto, HrCasilleroDto, HrDocumentoDto, HrDocumentoNuevo, HrDuplicadoGrupoDto, HrFusionResultadoDto, HrReingresoAlertaDto, HrTiempoPorEtapaDto,
} from '@megadulces/contracts';
import {
  ETAPA_INICIAL, SQL_ES_POSTULACION, esApartado, esEtapaDestino, etapaDe, fusion, motivoValido, tieneCv,
  type Apartado,
} from './logic/etapas';
import {
  DOCUMENTOS_EXPEDIENTE, MAX_DOCUMENTO_BYTES, casilleroDe, entradaNueva, esCasillero, faltantes, llaveDocumento,
  retirar, vigente, type EntradaDocumento,
} from './logic/expediente';
import { registrarCambioEtapa } from './talent-etapa.db';

/**
 * Fase RH · `[RH.2.2]` — CANDIDATOS. Traslado de las rutas protegidas de
 * `mega-talento-90/api/src/candidatos.ts` (+ el KPI de fases y los eventos de `kpi.ts`).
 *
 *   · Todo bajo sesión de RH. Lo público (formulario, evaluación) es `[RH.2.4]`, con token firmado:
 *     en Mega Talento `GET`/`PATCH /candidatos/:id` eran públicos con el UUID como única llave.
 *   · Nada se borra. Mega Talento tenía `DELETE /:id/definitivo` y borrar eventos; aquí no.
 *   · Fusionar NO mueve la historia (las bitácoras son de sólo agregar): el absorbido queda en la
 *     papelera con `merged_into_id` y la ficha junta la historia de los dos.
 *   · Cada cambio de etapa deja su renglón con las horas que pasó en la que deja (el KPI de tiempo
 *     por etapa). En Mega Talento ese INSERT estuvo 5 días fallando en silencio dentro de un
 *     `catch`; aquí va en la MISMA transacción: si no se registra, no se mueve.
 *   · Marcar y desmarcar deja nota en la bitácora con quién y por qué (como en Mega Talento).
 *   · Documentos: bucket PRIVADO (Mega Talento subía a Cloudinary SIN firma: cualquier URL era pública),
 *     tipo validado por FIRMA y no por lo que declara el navegador, URL firmada de 10 min en cada
 *     lectura. La subida va FUERA de la transacción; si la transacción falla, se borra del bucket.
 */

const T = 'talent.candidates';

const COLS_FILA = `
  c.id, c.full_name, c.phone, c.phone_key, c.city_branch, c.position_interest, c.stage AS stage_raw,
  c.source, c.traffic_light, c.cv_url, c.documents, c.no_rehire, c.is_spam,
  c.created_at, c.last_activity_at, c.deleted_at, c.deletion_reason`;

interface FilaCruda {
  id: string; full_name: string | null; phone: string | null; phone_key: string | null;
  city_branch: string | null; position_interest: string | null; stage_raw: string | null;
  source: string | null; traffic_light: HrCandidatoFilaDto['traffic_light']; cv_url: string | null;
  documents: unknown; no_rehire: boolean; is_spam: boolean; created_at: Date | string;
  last_activity_at: Date | string | null; deleted_at: Date | string | null;
  deletion_reason: HrCandidatoFilaDto['deletion_reason'];
  [k: string]: unknown;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

function aFila(r: FilaCruda): HrCandidatoFilaDto {
  return {
    id: r.id, full_name: r.full_name, phone: r.phone, phone_key: r.phone_key, city_branch: r.city_branch,
    position_interest: r.position_interest, stage: etapaDe(r.stage_raw), stage_raw: r.stage_raw,
    source: r.source, traffic_light: r.traffic_light, has_cv: tieneCv(r), no_rehire: r.no_rehire,
    is_spam: r.is_spam, created_at: iso(r.created_at) as string, last_activity_at: iso(r.last_activity_at),
    deleted_at: iso(r.deleted_at), deletion_reason: r.deletion_reason,
  };
}

/** El WHERE de cada apartado (alias `c`). */
function whereApartado(q: Knex.QueryBuilder, ap: Apartado): void {
  if (ap === 'papelera') { q.whereNotNull('c.deleted_at'); return; }
  q.whereNull('c.deleted_at');
  if (ap === 'spam') { q.where('c.is_spam', true); return; }
  if (ap === 'no_recontratables') { q.where('c.no_rehire', true); return; }
  q.where('c.is_spam', false);
  if (ap === 'postulados') q.whereRaw(SQL_ES_POSTULACION);
}

/** Las etapas que se cuentan como "esta etapa" al filtrar (las viejas caen en su vigente). */
const LEGADO_A: Record<string, string[]> = {
  filtro_inicial: ['contacto_pendiente', 'nuevo'],
  entrevista_rh: ['entrevista'],
  aptitudes: ['entrevista_jefe'],
  psicometria: ['documental', 'oferta', 'dictamen'],
};

const RE_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Vida de la URL firmada de un documento: una URL reenviada vale eso. */
const VIDA_URL_S = 600;

@Injectable()
export class HrTalentCandidatesService {
  private readonly logger = new Logger(HrTalentCandidatesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Cada entrada del expediente, con su URL firmada si vive en el bucket. Las externas (bot, Cloudinary) tal cual. */
  private async documentos(docs: unknown): Promise<HrDocumentoDto[]> {
    const lista = Array.isArray(docs) ? (docs as EntradaDocumento[]) : [];
    return Promise.all(lista.map(async (d) => {
      const key = (d['storage_key'] as string | undefined) ?? null;
      const url = key ? (await this.storage.signedUrl(key, VIDA_URL_S)) || null : ((d['url'] as string | undefined) ?? null);
      return {
        llave: llaveDocumento(d), slot: casilleroDe(d), file_name: (d['filename'] ?? d['nombre'] ?? null) as string | null,
        content_type: (d['mime_type'] ?? d['mimeType'] ?? null) as string | null, url,
        en_bucket: !!key, origen: (d['origen'] ?? null) as string | null,
        recibido_en: (d['recibido_en'] ?? d['subido_en'] ?? null) as string | null,
        subido_por_nombre: (d['subido_por_nombre'] ?? null) as string | null,
        vigente: vigente(d), retired_at: (d['retired_at'] ?? null) as string | null,
        retired_by_name: (d['retired_by_name'] ?? null) as string | null, retire_reason: (d['retire_reason'] ?? null) as string | null,
      };
    }));
  }

  private quien(): { id: string | null; nombre: string } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? 'RH' };
  }

  private run<R>(fn: (trx: Knex.Transaction) => Promise<R>): Promise<R> {
    return this.tk.run(this.tenantCtx.requireTenantId(), fn);
  }

  private async nota(trx: Knex.Transaction, candidateId: string, note: string): Promise<void> {
    const q = this.quien();
    await trx('talent.candidate_events').insert({
      tenant_id: this.tenantCtx.requireTenantId(), candidate_id: candidateId, event_type: 'nota', channel: 'portal',
      note, actor_id: q.id, actor_name: q.nombre,
    });
  }

  /** La fila tomada para escribir; 404 si no existe. */
  private async tomar(trx: Knex.Transaction, id: string): Promise<FilaCruda> {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException('Candidato no encontrado.');
    const r = await trx(T).where({ id }).forUpdate().first();
    if (!r) throw new NotFoundException('Candidato no encontrado.');
    return { ...r, stage_raw: r.stage } as FilaCruda;
  }

  // ── Lectura ──────────────────────────────────────────────────────────────────────────────

  async listar(f: { view?: string; stage?: string; branch?: string; q?: string; limit?: number; offset?: number }): Promise<HrCandidatosListaDto> {
    const vista = f.view == null || f.view === '' ? 'postulados' : f.view;
    if (!esApartado(vista)) throw new BadRequestException('view: postulados, en_proceso, spam, no_recontratables o papelera.');
    const ap: Apartado = vista;
    if (f.stage && !esEtapaDestino(f.stage)) throw new BadRequestException('stage no es una etapa válida.');
    const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
    const offset = Math.max(Number(f.offset) || 0, 0);

    return this.run(async (trx) => {
      const base = () => {
        const q = trx(`${T} as c`);
        whereApartado(q, ap);
        if (f.branch) q.where('c.city_branch', f.branch);
        if (f.q && f.q.trim()) {
          const texto = `%${f.q.trim()}%`;
          const digitos = f.q.replace(/\D/g, '');
          q.where((w) => {
            w.whereILike('c.full_name', texto).orWhereILike('c.position_interest', texto);
            if (digitos.length >= 4) w.orWhere('c.phone_key', 'like', `%${digitos}%`);
          });
        }
        return q;
      };
      const conEtapa = (q: Knex.QueryBuilder) => {
        if (!f.stage) return q;
        const ids = [f.stage, ...(LEGADO_A[f.stage] ?? [])];
        return q.where((w) => {
          w.whereIn('c.stage', ids);
          if (f.stage === ETAPA_INICIAL) w.orWhereNull('c.stage');
        });
      };

      const [{ n }] = await conEtapa(base()).count<{ n: string }[]>('* as n');
      const filas = await conEtapa(base()).select(trx.raw(COLS_FILA))
        .orderBy(ap === 'papelera' ? 'c.deleted_at' : 'c.created_at', 'desc').limit(limit).offset(offset) as FilaCruda[];
      const crudas = await base().select('c.stage').count('* as n').groupBy('c.stage') as Array<{ stage: string | null; n: string }>;
      const por_etapa: Record<string, number> = {};
      for (const r of crudas) {
        const e = etapaDe(r.stage);
        por_etapa[e] = (por_etapa[e] ?? 0) + Number(r.n);
      }
      return { total: Number(n), filas: filas.map(aFila), por_etapa };
    });
  }

  async ficha(id: string): Promise<HrCandidatoFichaDto> {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException('Candidato no encontrado.');
    return this.run(async (trx) => {
      const r = await trx(`${T} as c`).where('c.id', id).first('c.*', trx.raw('c.stage AS stage_raw'));
      if (!r) throw new NotFoundException('Candidato no encontrado.');
      const absorbidos = await trx(T).where({ merged_into_id: id }).orderBy('created_at')
        .select('id', 'full_name', 'created_at') as Array<{ id: string; full_name: string | null; created_at: Date }>;
      const ids = [id, ...absorbidos.map((a) => a.id)];
      const transiciones = await trx('talent.candidate_stage_transitions').whereIn('candidate_id', ids).orderBy('changed_at')
        .select('id', 'candidate_id', 'stage_from', 'stage_to', 'hours_in_from', 'changed_by_name', 'changed_at');
      const eventos = await trx('talent.candidate_events').whereIn('candidate_id', ids).orderBy('occurred_at')
        .select('id', 'candidate_id', 'event_type', 'channel', 'note', 'actor_name', 'occurred_at');
      const mismo = r.phone_key
        ? await trx(T).where({ phone_key: r.phone_key }).whereNot({ id }).whereNull('deleted_at').orderBy('created_at')
          .select('id', 'full_name', 'created_at', 'no_rehire')
        : [];
      const fila = aFila(r as FilaCruda);
      return {
        ...fila,
        email: r.email, legacy_portal_id: r.legacy_portal_id, job_posting_id: r.job_posting_id, origin: r.origin,
        bot_state: r.bot_state, commute_time: r.commute_time, availability: r.availability,
        previous_employer: r.previous_employer, desired_salary: r.desired_salary, rfc: r.rfc, nss: r.nss,
        relative_in_company: r.relative_in_company, rehire_note: r.rehire_note, cv_url: r.cv_url,
        cv_back_url: r.cv_back_url, cv_format: r.cv_format, license_url: r.license_url,
        documents: await this.documentos(r.documents),
        documentos_faltantes: faltantes(Array.isArray(r.documents) ? r.documents : [], !!(r.cv_url && String(r.cv_url).trim())),
        requested_documents: Array.isArray(r.requested_documents) ? r.requested_documents : [],
        application: r.application ?? null, aptitude_rubric: r.aptitude_rubric ?? null, aptitude_eval: r.aptitude_eval ?? null,
        portal_data: r.portal_data ?? {}, no_rehire_reason: r.no_rehire_reason, no_rehire_by_name: r.no_rehire_by_name,
        no_rehire_at: iso(r.no_rehire_at), spam_reason: r.spam_reason, spam_by_name: r.spam_by_name, spam_at: iso(r.spam_at),
        merged_into_id: r.merged_into_id,
        absorbidos: absorbidos.map((a) => ({ id: a.id, full_name: a.full_name, created_at: iso(a.created_at) as string })),
        transiciones: transiciones.map((t: Record<string, unknown>) => ({
          ...t, hours_in_from: t['hours_in_from'] == null ? null : Number(t['hours_in_from']), changed_at: iso(t['changed_at'] as Date),
        })) as HrCandidatoFichaDto['transiciones'],
        eventos: eventos.map((e: Record<string, unknown>) => ({ ...e, occurred_at: iso(e['occurred_at'] as Date) })) as HrCandidatoEventoDto[],
        mismo_telefono: (mismo as Array<{ id: string; full_name: string | null; created_at: Date; no_rehire: boolean }>)
          .map((m) => ({ ...m, created_at: iso(m.created_at) as string })),
      };
    });
  }

  // ── Escritura ────────────────────────────────────────────────────────────────────────────

  async editar(id: string, b: HrCandidatoEdicion): Promise<HrCandidatoFichaDto> {
    const permitidos: Array<keyof HrCandidatoEdicion> = ['full_name', 'phone', 'email', 'city_branch', 'position_interest', 'job_posting_id'];
    const cambios: Record<string, unknown> = {};
    for (const k of permitidos) {
      if (b?.[k] === undefined) continue;
      const v = b[k] == null ? null : String(b[k]).trim() || null;
      cambios[k] = v;
    }
    if (!Object.keys(cambios).length) throw new BadRequestException('Nada que cambiar.');
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      await trx(T).where({ id }).update({ ...cambios, updated_at: trx.fn.now() });
    });
    return this.ficha(id);
  }

  /**
   * Mover de etapa. Las horas en la etapa que deja = desde su última transición o, si nunca se
   * movió, desde su alta. Si no tenía etapa (llegó por el bot), la que deja es Filtro Inicial —
   * misma regla de Mega Talento, para que la transición más común aparezca en el tiempo por etapa.
   */
  async moverEtapa(id: string, stage: unknown): Promise<HrCandidatoFichaDto> {
    if (!esEtapaDestino(stage)) throw new BadRequestException('Etapa no válida.');
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      const desde = etapaDe(c.stage_raw);
      if (desde === stage && c.stage_raw === stage) throw new ConflictException('Ya está en esa etapa.');
      const q = this.quien();
      await registrarCambioEtapa(trx, { candidateId: id, desde: c.stage_raw ?? ETAPA_INICIAL, hacia: stage, quienId: q.id, quienNombre: q.nombre });
    });
    return this.ficha(id);
  }

  async registrarEvento(id: string, b: HrCandidatoEventoNuevo): Promise<HrCandidatoEventoDto> {
    const tipos = ['contacto', 'entrevista', 'contratacion', 'nota'];
    const canales = ['llamada', 'whatsapp', 'presencial', 'bot', 'portal'];
    if (!tipos.includes(String(b?.event_type))) throw new BadRequestException(`event_type: ${tipos.join(', ')}.`);
    if (b.channel != null && !canales.includes(String(b.channel))) throw new BadRequestException(`channel: ${canales.join(', ')}.`);
    if (b.occurred_at != null && !RE_HORA.test(String(b.occurred_at))) throw new BadRequestException('occurred_at: yyyy-MM-ddTHH:mm.');
    const note = b.note == null ? null : String(b.note).trim().slice(0, 2000) || null;
    if (b.event_type === 'nota' && !note) throw new BadRequestException('Una nota sin texto no dice nada.');
    return this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      const q = this.quien();
      const [ev] = await trx('talent.candidate_events').insert({
        tenant_id: this.tenantCtx.requireTenantId(), candidate_id: id, event_type: b.event_type, channel: b.channel ?? null,
        note, actor_id: q.id, actor_name: q.nombre,
        occurred_at: b.occurred_at ? trx.raw(`(?::timestamp AT TIME ZONE 'America/Mexico_City')`, [b.occurred_at]) : trx.fn.now(),
      }).returning(['id', 'candidate_id', 'event_type', 'channel', 'note', 'actor_name', 'occurred_at']);
      await trx(T).where({ id }).update({ last_activity_at: trx.fn.now() });
      return { ...ev, occurred_at: iso(ev.occurred_at) } as HrCandidatoEventoDto;
    });
  }

  /** Marca de «no vuelve a entrar». El motivo es obligatorio: le cierra la puerta a una persona. */
  async marcarNoRecontratable(id: string, b: { mark?: boolean; reason?: string }): Promise<HrCandidatoFichaDto> {
    const marcar = b?.mark !== false;
    const motivo = motivoValido(b?.reason);
    if (marcar && !motivo) throw new BadRequestException('Escribe el motivo: sin él, nadie va a poder sostener esta decisión después.');
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      const q = this.quien();
      await trx(T).where({ id }).update(marcar
        ? { no_rehire: true, no_rehire_reason: motivo, no_rehire_by: q.id, no_rehire_by_name: q.nombre, no_rehire_at: trx.fn.now(), updated_at: trx.fn.now() }
        : { no_rehire: false, no_rehire_reason: null, no_rehire_by: null, no_rehire_by_name: null, no_rehire_at: null, updated_at: trx.fn.now() });
      await this.nota(trx, id, marcar ? `Marcado como NO RECONTRATABLE: ${motivo}` : `Se le quitó la marca de no recontratable.${motivo ? ` ${motivo}` : ''}`);
    });
    return this.ficha(id);
  }

  async marcarSpam(id: string, b: { mark?: boolean; reason?: string }): Promise<HrCandidatoFichaDto> {
    const marcar = b?.mark !== false;
    const motivo = motivoValido(b?.reason) ?? (marcar ? 'Marcado como spam por RH' : null);
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      const q = this.quien();
      await trx(T).where({ id }).update(marcar
        ? { is_spam: true, spam_reason: motivo, spam_by: q.id, spam_by_name: q.nombre, spam_at: trx.fn.now(), updated_at: trx.fn.now() }
        : { is_spam: false, spam_reason: null, spam_by: null, spam_by_name: null, spam_at: null, updated_at: trx.fn.now() });
      await this.nota(trx, id, marcar ? `Enviado a SPAM: ${motivo}` : 'Se sacó de SPAM.');
    });
    return this.ficha(id);
  }

  /** A la papelera (`manual` o `cierre_seguimiento`). Nada se borra. */
  async aPapelera(id: string, b: { reason?: string }): Promise<HrCandidatoFichaDto> {
    const motivo = b?.reason ?? 'manual';
    if (motivo !== 'manual' && motivo !== 'cierre_seguimiento') throw new BadRequestException('reason: manual o cierre_seguimiento.');
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Ya está en la papelera.');
      await trx(T).where({ id }).update({ deleted_at: trx.fn.now(), deleted_by: this.quien().id, deletion_reason: motivo, updated_at: trx.fn.now() });
      await this.nota(trx, id, motivo === 'cierre_seguimiento' ? 'Cierre de seguimiento (a la papelera).' : 'Enviado a la papelera.');
    });
    return this.ficha(id);
  }

  /**
   * Sacar de la papelera. Si estaba fusionado, vuelve a ser su propio registro y su historia deja de
   * aparecer en la ficha del otro. ⚠️ Lo que la fusión COPIÓ al que quedó (huecos rellenados, documentos
   * unidos) se queda ahí: no se sabe si alguien lo corrigió después, así que no se adivina.
   */
  async restaurar(id: string): Promise<HrCandidatoFichaDto> {
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (!c.deleted_at) throw new ConflictException('No está en la papelera.');
      const fusionado = c['merged_into_id'];
      await trx(T).where({ id }).update({ deleted_at: null, deleted_by: null, deletion_reason: null, merged_into_id: null, updated_at: trx.fn.now() });
      await this.nota(trx, id, fusionado ? `Restaurado: se deshizo la fusión con ${fusionado}.` : 'Restaurado de la papelera.');
    });
    return this.ficha(id);
  }

  /**
   * Fusionar dos registros de la misma persona (el bot y el portal la abren por separado; al
   * 03-ago-2026 eran 15). Rellena huecos del que se conserva, el absorbido va a la papelera con
   * `merged_into_id`, y nada de su historia se mueve.
   */
  async fusionar(conservarId: string, absorberId: string): Promise<HrFusionResultadoDto> {
    if (!absorberId) throw new BadRequestException('Falta absorb_id.');
    if (conservarId === absorberId) throw new BadRequestException('No se puede fusionar un registro consigo mismo.');
    return this.run(async (trx) => {
      // Tomar los dos en orden fijo: dos fusiones cruzadas no se bloquean entre sí.
      const [primero, segundo] = [conservarId, absorberId].sort();
      const filas: Record<string, FilaCruda> = {};
      filas[primero] = await this.tomar(trx, primero);
      filas[segundo] = await this.tomar(trx, segundo);
      const a = filas[conservarId], b = filas[absorberId];
      if (a.deleted_at) throw new ConflictException('El registro a conservar está en la papelera.');
      if (b.deleted_at) throw new ConflictException('El registro a absorber ya está en la papelera.');
      if (a.no_rehire !== b.no_rehire) {
        // La marca la decide una persona con motivo: la fusión no la pone ni la quita sola.
        throw new ConflictException('Uno de los dos está marcado como no recontratable y el otro no: decide la marca antes de fusionar.');
      }
      const { cambios, rellenados } = fusion({ ...a, stage: a.stage_raw }, { ...b, stage: b.stage_raw });
      const json = (v: unknown) => JSON.stringify(v);
      await trx(T).where({ id: conservarId }).update({
        ...cambios,
        portal_data: json(cambios['portal_data']), documents: json(cambios['documents']),
        ...(cambios['application'] !== undefined ? { application: json(cambios['application']) } : {}),
        ...(cambios['aptitude_rubric'] !== undefined ? { aptitude_rubric: json(cambios['aptitude_rubric']) } : {}),
        ...(cambios['aptitude_eval'] !== undefined ? { aptitude_eval: json(cambios['aptitude_eval']) } : {}),
        updated_at: trx.fn.now(),
      });
      // El id viejo de Firestore lo hereda el que queda (rellenado arriba); se le quita al absorbido
      // para que las ligas viejas abran al registro vivo.
      await trx(T).where({ id: absorberId }).update({
        deleted_at: trx.fn.now(), deleted_by: this.quien().id, deletion_reason: 'fusionado', merged_into_id: conservarId,
        ...(rellenados.includes('legacy_portal_id') ? { legacy_portal_id: null } : {}),
        updated_at: trx.fn.now(),
      });
      const alta = iso(b.created_at)?.slice(0, 10) ?? '?';
      await this.nota(trx, conservarId,
        `Se fusionó el registro duplicado de ${b.full_name || 'sin nombre'} (alta ${alta}).` +
        (rellenados.length ? ` Datos recuperados: ${rellenados.join(', ')}.` : ' No tenía datos que el otro no tuviera.'));
      return { conservado: conservarId, absorbido: absorberId, rellenados };
    });
  }

  // ── Expediente ───────────────────────────────────────────────────────────────────────────

  /** El catálogo de casilleros (lo que la pantalla pinta). */
  casilleros(): readonly HrCasilleroDto[] {
    return DOCUMENTOS_EXPEDIENTE;
  }

  /**
   * Subir un documento al expediente. Valida TODO antes de tocar el bucket; sube fuera de la
   * transacción; si la transacción falla (el candidato no existe, está en la papelera), lo borra.
   */
  async subirDocumento(id: string, b: HrDocumentoNuevo): Promise<HrCandidatoFichaDto> {
    if (!esCasillero(b?.slot)) throw new BadRequestException(`slot: ${DOCUMENTOS_EXPEDIENTE.map((d) => d.key).join(', ')} u otro.`);
    const v = validarAdjunto(String(b?.file_base64 ?? ''), MAX_DOCUMENTO_BYTES);
    if (!v.ok) throw new BadRequestException(v.detalle);
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException('Candidato no encontrado.');
    const nombre = sanitizarNombre(b.file_name, v.adjunto.contentType);
    const { key } = await this.storage.putBuffer(v.adjunto.buffer, v.adjunto.contentType,
      `talent/${this.tenantCtx.requireTenantId()}/${id}`, nombre);
    try {
      await this.run(async (trx) => {
        const c = await this.tomar(trx, id);
        if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
        const q = this.quien();
        const docs = Array.isArray(c.documents) ? (c.documents as EntradaDocumento[]) : [];
        const nueva = entradaNueva({
          slot: b.slot, file_name: nombre, content_type: v.adjunto.contentType, size_bytes: v.adjunto.sizeBytes,
          storage_key: key, por_id: q.id, por_nombre: q.nombre, ahora: new Date().toISOString(),
        });
        await trx(T).where({ id }).update({ documents: JSON.stringify([...docs, nueva]), last_activity_at: trx.fn.now(), updated_at: trx.fn.now() });
        await this.nota(trx, id, `Subió ${b.slot === 'otro' ? 'un documento' : `el documento «${b.slot}»`}: ${nombre}.`);
      });
    } catch (e) {
      try { await this.storage.remove(key); } catch (err) {
        this.logger.warn(`No se pudo borrar ${key} del bucket tras un fallo: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw e;
    }
    return this.ficha(id);
  }

  /** Retirar un documento (equivocado, ilegible, de otra persona). No se borra: deja de contar, con motivo. */
  async retirarDocumento(id: string, b: { llave?: string; reason?: string }): Promise<HrCandidatoFichaDto> {
    const motivo = motivoValido(b?.reason);
    if (!motivo) throw new BadRequestException('Escribe por qué se retira el documento.');
    if (!b?.llave) throw new BadRequestException('Falta llave (la del documento en la ficha).');
    await this.run(async (trx) => {
      const c = await this.tomar(trx, id);
      if (c.deleted_at) throw new ConflictException('Está en la papelera: restáuralo primero.');
      const q = this.quien();
      const r = retirar(Array.isArray(c.documents) ? (c.documents as EntradaDocumento[]) : [], String(b.llave), {
        motivo, por_id: q.id, por_nombre: q.nombre, ahora: new Date().toISOString(),
      });
      if (!r) throw new NotFoundException('Ese documento no está (o ya se retiró).');
      await trx(T).where({ id }).update({ documents: JSON.stringify(r.docs), updated_at: trx.fn.now() });
      await this.nota(trx, id, `Retiró el documento «${casilleroDe(r.retirada) ?? 'sin casillero'}» (${r.retirada['filename'] ?? 'sin nombre'}): ${motivo}`);
    });
    return this.ficha(id);
  }

  // ── Revisiones ───────────────────────────────────────────────────────────────────────────

  /**
   * Grupos de registros EN PROCESO con el mismo teléfono (lo que hay que fusionar). Un proceso cerrado
   * (rechazado o contratado) no es un duplicado: desde `[RH.2.4]` la misma persona puede volver a postularse.
   */
  async duplicados(): Promise<HrDuplicadoGrupoDto[]> {
    const abiertos = (q: Knex.QueryBuilder, a = '') => q.whereNull(`${a}deleted_at`).whereNotNull(`${a}phone_key`)
      .where(`${a}is_spam`, false).where((w) => w.whereNull(`${a}stage`).orWhereNotIn(`${a}stage`, ['rechazado', 'contratado']));
    return this.run(async (trx) => {
      const filas = await abiertos(trx(`${T} as c`), 'c.')
        .whereIn('c.phone_key', abiertos(trx(T)).groupBy('phone_key').havingRaw('count(*) > 1').select('phone_key'))
        .orderBy(['c.phone_key', 'c.created_at']).select(trx.raw(COLS_FILA)) as FilaCruda[];
      const grupos = new Map<string, HrDuplicadoGrupoDto>();
      for (const r of filas) {
        const f = aFila(r);
        const g = grupos.get(r.phone_key as string) ?? { phone_key: r.phone_key as string, candidatos: [] };
        g.candidatos.push({ id: f.id, full_name: f.full_name, source: f.source, created_at: f.created_at, has_cv: f.has_cv, stage: f.stage });
        grupos.set(g.phone_key, g);
      }
      return [...grupos.values()];
    });
  }

  /**
   * Quién se volvió a postular: vivos en proceso que comparten teléfono con alguien marcado.
   * Una lista negra que hay que ir a consultar no evita nada; esto la cruza al revés.
   */
  async reingresos(): Promise<HrReingresoAlertaDto[]> {
    return this.run(async (trx) => {
      const r = await trx.raw(`
        SELECT c.id, c.full_name, c.phone, c.stage AS stage_raw, c.created_at,
               m.id AS marcado_id, m.full_name AS marcado_nombre, m.no_rehire_reason AS motivo,
               m.no_rehire_by_name AS marcado_por, m.no_rehire_at AS marcado_en
          FROM talent.candidates c
          JOIN talent.candidates m ON m.no_rehire AND m.id <> c.id AND m.phone_key = c.phone_key
         WHERE c.deleted_at IS NULL AND NOT c.no_rehire AND coalesce(c.stage, '') <> 'rechazado'
         ORDER BY c.created_at DESC`);
      return (r.rows as Array<Record<string, unknown>>).map((x) => ({
        id: x['id'] as string, full_name: x['full_name'] as string | null, phone: x['phone'] as string | null,
        stage: etapaDe(x['stage_raw'] as string | null), created_at: iso(x['created_at'] as Date) as string,
        marcado_id: x['marcado_id'] as string, marcado_nombre: x['marcado_nombre'] as string | null,
        motivo: x['motivo'] as string | null, marcado_por: x['marcado_por'] as string | null,
        marcado_en: iso(x['marcado_en'] as Date),
      }));
    });
  }

  /** Tiempo promedio en cada etapa, desde la bitácora de etapas (el KPI de fases). */
  async tiempoPorEtapa(): Promise<{ fases: HrTiempoPorEtapaDto[]; total: number }> {
    return this.run(async (trx) => {
      const r = await trx.raw(`
        SELECT stage_from AS etapa, count(*)::int AS n,
               round(avg(hours_in_from)::numeric, 1) AS avg_horas,
               round(min(hours_in_from)::numeric, 1) AS min_horas,
               round(max(hours_in_from)::numeric, 1) AS max_horas
          FROM talent.candidate_stage_transitions
         WHERE stage_from IS NOT NULL AND hours_in_from IS NOT NULL
         GROUP BY stage_from`);
      const fases = (r.rows as Array<Record<string, unknown>>).map((x) => ({
        etapa: x['etapa'] as string, n: Number(x['n']), avg_horas: Number(x['avg_horas']) || 0,
        min_horas: Number(x['min_horas']) || 0, max_horas: Number(x['max_horas']) || 0,
      }));
      return { fases, total: fases.reduce((s, f) => s + f.n, 0) };
    });
  }
}

