import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService, sanitizarNombre, validarAdjunto, type AdjuntoValido } from '@megadulces/platform-core';
import {
  HR_APTITUDES_APROBADO_PCT, HR_CUESTIONARIO_LIDERAZGO, HR_ESTILOS_LIDERAZGO, HR_NIVELES_STAR, hrCalificaLiderazgo, hrPuntajeStar,
  hrResultadoLiderazgo, type HrAptitudesEvalGuardada, type HrAptitudesEvaluacion, type HrCompetenciaStar, type HrNivelStar,
  type HrLiderazgoAvanceDto, type HrLiderazgoRespuesta, type HrLigaContextoDto, type HrLigaCreadaDto, type HrLigaCvSubida,
  type HrLigaFormulario, type HrPostulacionResultadoDto, type HrRespuestasLiderazgo,
} from '@megadulces/contracts';
import { MAX_DOCUMENTO_BYTES, entradaNueva, type EntradaDocumento } from './logic/expediente';
import { puedeAvanzarPorCuestionario, revisarAvance } from './logic/avance';
import { hojaPorKey, hojaPorNombrePuesto } from './data/competencias-puesto';
import { registrarCambioEtapa } from './talent-etapa.db';

/**
 * Fase RH · `[RH.2.4]` — LIGAS PERSONALES para que un candidato haga algo sin cuenta (hoy: subir su CV; después las
 * evaluaciones). Reemplazan las de Mega Talento, que eran `/solicitud/<id del candidato>`: cualquiera con ese número
 * leía y editaba el expediente completo, para siempre.
 *
 *   · La liga es un JWT firmado con un secreto DERIVADO (`<JWT_SECRET>:talent-link`, registrado en `HrModule`): una liga
 *     nunca sirve como sesión de usuario ni una sesión como liga, aunque las dos sean JWT.
 *   · Abre UNA cosa (`f`), de UNA persona (`cid`), y vence (`VIGENCIA_DIAS`). Además se relee al candidato en cada uso:
 *     si ya está en la papelera o es spam, la liga deja de servir aunque no haya vencido.
 *   · Lo que la página pública ve es lo mínimo: el primer nombre, el puesto y si ya mandó CV. Nada del expediente.
 *
 * Hallazgo al portar: en Mega Talento el WhatsApp decía «completa tu Solicitud de Empleo electrónica, son 8 pasos (≈5
 * min)», pero `/solicitud/:id` sólo pide el CV (la solicitud larga la arma el bot por chat). Aquí se llama por lo que es.
 */

export const VIGENCIA_DIAS = 7;
const FORMULARIOS: readonly HrLigaFormulario[] = ['cv', 'liderazgo', 'aptitudes'];

/** Desde dónde la evaluación de aptitudes puede mover SOLA a Psicométricas (compuerta 3 → 4: sólo hacia adelante). */
const ETAPAS_QUE_AVANZA_APTITUDES: readonly (string | null)[] = [null, 'filtro_inicial', 'nuevo', 'entrevista_rh', 'aptitudes'];

/** Las respuestas del cuestionario guardadas en el candidato (la forma de Mega Talento: `{ num: valor }`). */
const respuestasDe = (c: Record<string, unknown>): HrRespuestasLiderazgo =>
  ((c['portal_data'] as Record<string, unknown> | null)?.['cuestionarioLiderazgo'] ?? {}) as HrRespuestasLiderazgo;

/** Las competencias congeladas en el candidato al generar la liga de aptitudes. */
const competenciasDe = (c: Record<string, unknown>): HrCompetenciaStar[] => {
  const v = (c['portal_data'] as Record<string, unknown> | null)?.['competenciasConfig'];
  return Array.isArray(v) ? (v as HrCompetenciaStar[]) : [];
};

/** El texto del WhatsApp según lo que abre la liga. */
function mensajeDe(form: HrLigaFormulario, nombre: string, url: string): string {
  const hola = `Hola${nombre ? ` ${nombre}` : ''}, soy de Capital Humano de Mega Dulces.\n\n`;
  const pie = `\n\nEl enlace es personal y vence en ${VIGENCIA_DIAS} días. ¡Gracias!`;
  if (form === 'aptitudes') {
    // Ésta NO va al candidato: la abre el jefe que lo entrevista.
    return `Hola, soy de Capital Humano de Mega Dulces.\n\nTe comparto la evaluación de aptitudes (entrevista por competencias) de ${nombre || 'el candidato'}. `
      + `Califica cada competencia al terminar la entrevista:\n\n${url}${pie}`;
  }
  if (form === 'liderazgo') {
    return `${hola}Para continuar con tu evaluación, contesta el cuestionario de liderazgo desde tu celular en este enlace:\n\n${url}\n\n`
      + `Son ${HR_CUESTIONARIO_LIDERAZGO.length} preguntas breves. Responde con honestidad.${pie}`;
  }
  return `${hola}Para continuar con tu proceso, sube tu CV en este enlace (PDF, o dos fotos: frente y reverso):\n\n${url}${pie}`;
}

interface PayloadLiga { t: 'talent_link'; cid: string; f: HrLigaFormulario; tid: string }

/** Las reglas del CV por liga (las de Mega Talento): un PDF, o dos fotos (frente y reverso). */
export function validarCvDeLiga(b: HrLigaCvSubida | null | undefined): Array<{ adjunto: AdjuntoValido; file_name: string }> {
  const archivos = Array.isArray(b?.files) ? b!.files : [];
  if (!archivos.length) throw new BadRequestException('Adjunta tu CV.');
  if (archivos.length > 2) throw new BadRequestException('Son máximo dos archivos: frente y reverso.');
  const validos = archivos.map((a, i) => {
    const v = validarAdjunto(String(a?.file_base64 ?? ''), MAX_DOCUMENTO_BYTES);
    if (!v.ok) throw new BadRequestException(`Archivo ${i + 1}: ${v.detalle}`);
    return { adjunto: v.adjunto, file_name: sanitizarNombre(a?.file_name, v.adjunto.contentType) };
  });
  const pdfs = validos.filter((x) => x.adjunto.contentType === 'application/pdf').length;
  if (pdfs && validos.length > 1) throw new BadRequestException('Si mandas PDF, que sea un solo archivo.');
  if (!pdfs && validos.length < 2) throw new BadRequestException('Si mandas fotos, son dos: el frente y el reverso de tu CV.');
  return validos;
}

@Injectable()
export class HrTalentLinksService {
  private readonly logger = new Logger(HrTalentLinksService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
    private readonly jwt: JwtService,
  ) {}

  // ── Lado de RH (con sesión) ────────────────────────────────────────────────────────────

  /** Genera la liga para un candidato. `origin` = de dónde vino la petición, si no hay `APP_PUBLIC_URL`. */
  async crear(candidateId: string, form: unknown, origin?: string): Promise<HrLigaCreadaDto> {
    if (!FORMULARIOS.includes(form as HrLigaFormulario)) throw new BadRequestException(`form: ${FORMULARIOS.join(', ')}.`);
    if (!/^[0-9a-f-]{36}$/i.test(String(candidateId))) throw new NotFoundException('Candidato no encontrado.');
    const tenant = this.tenantCtx.requireTenantId();
    const base = (process.env['APP_PUBLIC_URL'] || origin || '').replace(/\/+$/, '');
    if (!base) throw new BadRequestException('No se pudo armar la liga: falta el origen público (APP_PUBLIC_URL).');
    return this.tk.run(tenant, async (trx) => {
      const c = await trx('talent.candidates').where({ id: candidateId }).first('id', 'full_name', 'phone_key', 'deleted_at', 'is_spam', 'job_posting_id', 'position_interest', 'portal_data');
      if (!c) throw new NotFoundException('Candidato no encontrado.');
      if (c.deleted_at || c.is_spam) throw new BadRequestException('No se manda liga a alguien en la papelera o en spam.');
      if (form === 'aptitudes') await this.congelarCompetencias(trx, c);
      const payload: PayloadLiga = { t: 'talent_link', cid: c.id, f: form as HrLigaFormulario, tid: tenant };
      const token = this.jwt.sign(payload, { expiresIn: `${VIGENCIA_DIAS}d` });
      const expires_at = new Date(Date.now() + VIGENCIA_DIAS * 86_400_000).toISOString();
      const url = `${base}/empleo/liga/${token}`;
      const nombre = String(c.full_name ?? '').trim().split(/\s+/)[0] || '';
      // La de aptitudes va al jefe: su nombre completo, para que sepa a quién evalúa.
      const mensaje = mensajeDe(form as HrLigaFormulario, form === 'aptitudes' ? String(c.full_name ?? '').trim() : nombre, url);
      const quien = this.tenantCtx.get();
      await trx('talent.candidate_events').insert({
        tenant_id: tenant, candidate_id: c.id, event_type: 'nota', channel: 'portal', actor_id: quien?.userId ?? null,
        actor_name: quien?.username ?? 'RH',
        note: `Se generó la liga ${form === 'liderazgo' ? 'del cuestionario de liderazgo' : form === 'aptitudes' ? 'de la evaluación de aptitudes (para el jefe que entrevista)' : 'para subir su CV'} (vence en ${VIGENCIA_DIAS} días).`,
      });
      return {
        url, expires_at, mensaje,
        // La de aptitudes NO va al teléfono del candidato: `wa.me` sin número deja elegir al jefe.
        whatsapp_url: form === 'aptitudes' ? `https://wa.me/?text=${encodeURIComponent(mensaje)}`
          : c.phone_key ? `https://wa.me/52${c.phone_key}?text=${encodeURIComponent(mensaje)}` : null,
      };
    });
  }

  // ── Lado público (sin sesión) ──────────────────────────────────────────────────────────

  /** Verifica la firma y relee al candidato. Cualquier falla dice lo mismo: no se revela si la persona existe. */
  private async resolver(token: string, trx: Knex.Transaction | null = null): Promise<{ p: PayloadLiga; c: Record<string, unknown> }> {
    let p: PayloadLiga;
    try {
      p = this.jwt.verify<PayloadLiga>(String(token ?? ''));
    } catch {
      throw new ForbiddenException('Este enlace ya no sirve. Pide uno nuevo a Capital Humano.');
    }
    if (p?.t !== 'talent_link' || !p.cid || !p.tid || !FORMULARIOS.includes(p.f)) {
      throw new ForbiddenException('Este enlace ya no sirve. Pide uno nuevo a Capital Humano.');
    }
    const leer = (x: Knex.Transaction) => x('talent.candidates').where({ id: p.cid }).first();
    const c = trx ? await leer(trx) : await this.tk.run(p.tid, leer);
    if (!c || c.deleted_at || c.is_spam) throw new ForbiddenException('Este enlace ya no sirve. Pide uno nuevo a Capital Humano.');
    return { p, c };
  }

  async contexto(token: string): Promise<HrLigaContextoDto> {
    const { p, c } = await this.resolver(token);
    const docs = Array.isArray(c['documents']) ? (c['documents'] as EntradaDocumento[]) : [];
    const ya = !!(c['cv_url'] && String(c['cv_url']).trim()) || docs.some((d) => !d['retired_at'] && (d['slot'] ?? d['tipo']) === 'cv');
    let vence: string | null = null;
    try { vence = new Date(((this.jwt.decode(token) as { exp?: number } | null)?.exp ?? 0) * 1000).toISOString(); } catch { vence = null; }
    const base: HrLigaContextoDto = {
      form: p.f, nombre: String(c['full_name'] ?? '').trim().split(/\s+/)[0] || null,
      puesto: (c['position_interest'] as string | null) ?? null, ya_tiene_cv: ya, vence,
    };
    if (p.f === 'aptitudes') {
      const ev = (c['aptitude_eval'] ?? null) as Partial<HrAptitudesEvalGuardada> | null;
      return {
        ...base, candidato_nombre: (c['full_name'] as string | null) ?? null, competencias: competenciasDe(c),
        rubrica: (c['aptitude_rubric'] ?? null) as Record<string, HrNivelStar> | null,
        evaluacion: ev ? { evaluador: ev.evaluador ?? '', cargoEvaluador: ev.cargoEvaluador ?? '', tiempo: ev.tiempo ?? '', observaciones: ev.observaciones ?? '' } : null,
      };
    }
    if (p.f !== 'liderazgo') return base;
    const r = hrResultadoLiderazgo(respuestasDe(c));
    // Sus propias respuestas (para retomar), nunca el puntaje.
    return { ...base, respuestas: respuestasDe(c), terminado: r.contestadas === r.total };
  }

  /**
   * Una respuesta del cuestionario. Se guarda al momento (RH puede estar viéndolo en vivo, como en Mega Talento). Al
   * completar las 12, el SERVIDOR calcula el resultado y decide si pasa solo a Aptitudes (compuerta 2 → 3: calificó,
   * va en Filtro o Entrevista Orientación, y cumple los mínimos). En Mega Talento esto lo hacía el navegador del
   * candidato, que además escribía su propia etapa. Una vez completo, el cuestionario se cierra.
   */
  async responderLiderazgo(token: string, b: HrLiderazgoRespuesta): Promise<HrLiderazgoAvanceDto> {
    const num = Number(b?.num), valor = Number(b?.valor);
    if (!HR_CUESTIONARIO_LIDERAZGO.some((q) => q.num === num)) throw new BadRequestException('Pregunta no válida.');
    if (!Number.isInteger(valor) || valor < 1 || valor > 5) throw new BadRequestException('Respuesta no válida.');
    const { p } = await this.resolver(token);
    if (p.f !== 'liderazgo') throw new ForbiddenException('Este enlace no es para el cuestionario.');
    return this.tk.run(p.tid, async (trx) => {
      await trx('talent.candidates').where({ id: p.cid }).forUpdate().first('id');
      const { c } = await this.resolver(token, trx);
      const antes = hrResultadoLiderazgo(respuestasDe(c));
      if (antes.contestadas === antes.total) throw new ConflictException('Ya contestaste el cuestionario. ¡Gracias!');
      const respuestas = { ...respuestasDe(c), [num]: valor };
      const portal = { ...((c['portal_data'] as Record<string, unknown>) ?? {}), cuestionarioLiderazgo: respuestas, ultimaActividadCuestionario: new Date().toISOString() };
      await trx('talent.candidates').where({ id: p.cid }).update({ portal_data: JSON.stringify(portal), updated_at: trx.fn.now() });
      const r = hrResultadoLiderazgo(respuestas);
      if (r.contestadas === r.total) await this.alTerminarLiderazgo(trx, p, c, r);
      return { contestadas: r.contestadas, total: r.total, terminado: r.contestadas === r.total };
    });
  }

  /**
   * La hoja de competencias del candidato, CONGELADA al generar la liga (`portal_data.competenciasConfig`, la clave de
   * Mega Talento): el jefe evalúa exactamente lo que RH definió aunque el puesto cambie después. Primero la hoja que RH
   * le asignó a la vacante; si no, la que coincide con el nombre del puesto. Sin hoja no hay liga.
   */
  private async congelarCompetencias(trx: Knex.Transaction, c: Record<string, unknown>): Promise<void> {
    const vacante = c['job_posting_id']
      ? await trx('talent.job_postings').where({ id: c['job_posting_id'] }).first('name', 'competencies_sheet') as { name: string; competencies_sheet: string | null } | undefined
      : undefined;
    const hoja = hojaPorKey(vacante?.competencies_sheet ?? undefined)
      ?? hojaPorNombrePuesto(vacante?.name ?? (c['position_interest'] as string | undefined));
    if (!hoja) throw new BadRequestException('Este puesto no tiene hoja de competencias. Asígnala en Vacantes («Hoja de competencias»).');
    const portal = { ...((c['portal_data'] as Record<string, unknown>) ?? {}), competenciasConfig: hoja.competencias, hojaCompetencias: hoja.key };
    await trx('talent.candidates').where({ id: c['id'] }).update({ portal_data: JSON.stringify(portal), updated_at: trx.fn.now() });
  }

  /**
   * El jefe guarda la evaluación. Se puede corregir (como en Mega Talento). Si queda «aprobado» (≥ Recomendable,
   * 76.7%), el SERVIDOR lo pasa a Psicométricas — sólo hacia adelante y, además, con los mínimos del expediente. En
   * Mega Talento lo hacía el navegador del jefe y sin revisar los mínimos: aquí se aplica el mismo principio que Mega
   * Talento escribió para el cuestionario («al sistema se le prohíbe avanzar solo si no cumple»).
   */
  async evaluarAptitudes(token: string, b: HrAptitudesEvaluacion): Promise<HrPostulacionResultadoDto> {
    const evaluador = String(b?.evaluador ?? '').trim().slice(0, 150);
    if (evaluador.length < 3) throw new BadRequestException('Escribe el nombre de quien evalúa.');
    const { p } = await this.resolver(token);
    if (p.f !== 'aptitudes') throw new ForbiddenException('Este enlace no es para la evaluación de aptitudes.');
    return this.tk.run(p.tid, async (trx) => {
      await trx('talent.candidates').where({ id: p.cid }).forUpdate().first('id');
      const { c } = await this.resolver(token, trx);
      const competencias = competenciasDe(c);
      if (!competencias.length) throw new ConflictException('Esta liga no tiene competencias. Pide una nueva a Capital Humano.');
      const niveles = new Set(HR_NIVELES_STAR.map((n) => n.id));
      const rubrica: Record<string, HrNivelStar> = {};
      for (const comp of competencias) {
        const v = b?.rubrica?.[comp.key];
        if (v && niveles.has(v)) rubrica[comp.key] = v;
      }
      const calc = hrPuntajeStar(rubrica, competencias);
      if (!calc.completa) throw new BadRequestException(`Faltan ${calc.total - calc.calificadas} competencia(s) por calificar.`);
      const aprobado = calc.pct >= HR_APTITUDES_APROBADO_PCT;
      const evalGuardada: HrAptitudesEvalGuardada = {
        evaluador, cargoEvaluador: String(b?.cargo_evaluador ?? '').trim().slice(0, 150), tiempo: String(b?.tiempo ?? '').trim().slice(0, 50),
        observaciones: String(b?.observaciones ?? '').trim().slice(0, 2000), puntaje: calc.puntaje, max: calc.max, pct: calc.pct,
        banda: calc.banda, aprobado, completadaEn: new Date().toISOString(),
      };
      await trx('talent.candidates').where({ id: p.cid }).update({
        aptitude_rubric: JSON.stringify(rubrica), aptitude_eval: JSON.stringify(evalGuardada), updated_at: trx.fn.now(),
      });
      let desenlace = 'No llegó a Recomendable: se queda para que RH lo revise.';
      if (aprobado) {
        const stage = (c['stage'] as string | null) ?? null;
        if (!ETAPAS_QUE_AVANZA_APTITUDES.includes(stage)) {
          desenlace = 'Aprobado; ya iba más adelante, no se le mueve.';
        } else {
          const rev = revisarAvance({
            stage, cv_url: c['cv_url'] as string | null, documents: c['documents'], bot_state: c['bot_state'] as string | null,
            position_interest: c['position_interest'] as string | null, portal_data: c['portal_data'] as Record<string, unknown> | null,
          });
          if (rev.ok) {
            await registrarCambioEtapa(trx, { candidateId: p.cid, desde: stage, hacia: 'psicometria', quienId: null, quienNombre: 'sistema (evaluación de aptitudes)' });
            desenlace = 'Aprobado: pasó solo a Psicométricas.';
          } else {
            desenlace = `Aprobado, pero no avanza solo: ${rev.motivos.join(' ')} RH decide.`;
          }
        }
      }
      await trx('talent.candidate_events').insert({
        tenant_id: p.tid, candidate_id: p.cid, event_type: 'entrevista', channel: 'presencial', actor_name: evaluador,
        note: `Evaluación de aptitudes: ${calc.puntaje}/${calc.max} (${calc.pct}%, ${calc.banda}). ${desenlace}`,
      });
      return { resultado: 'recibida', mensaje: 'Gracias. La evaluación quedó guardada y Capital Humano ya la puede ver.' };
    });
  }

  /** El cuestionario quedó completo: se anota el resultado y, si procede, avanza solo a Aptitudes. */
  private async alTerminarLiderazgo(trx: Knex.Transaction, p: PayloadLiga, c: Record<string, unknown>, r: ReturnType<typeof hrResultadoLiderazgo>): Promise<void> {
    const resumen = `${r.porcentaje}% (${r.nivel.replace(/-/g, ' ')}, ${HR_ESTILOS_LIDERAZGO[r.estilo].nombre})`;
    let desenlace: string;
    if (!hrCalificaLiderazgo(r)) {
      desenlace = 'No llegó al 66%: se queda donde está para que RH lo revise.';
    } else {
      const abiertos = await trx('talent.job_postings').where({ is_active: true }).pluck('name') as string[];
      const rev = puedeAvanzarPorCuestionario({
        stage: (c['stage'] as string | null) ?? null, cv_url: c['cv_url'] as string | null, documents: c['documents'],
        bot_state: c['bot_state'] as string | null, position_interest: c['position_interest'] as string | null,
        portal_data: c['portal_data'] as Record<string, unknown> | null,
      }, abiertos);
      if (rev.ok) {
        await registrarCambioEtapa(trx, { candidateId: p.cid, desde: (c['stage'] as string | null) ?? null, hacia: 'aptitudes', quienId: null, quienNombre: 'sistema (cuestionario de liderazgo)' });
        desenlace = 'Calificó y cumple los mínimos: pasó solo a Aptitudes y Entrevista Técnica.';
      } else {
        desenlace = `Calificó, pero no avanza solo: ${rev.motivos.join(' ')} RH decide.`;
      }
    }
    await trx('talent.candidate_events').insert({
      tenant_id: p.tid, candidate_id: p.cid, event_type: 'nota', channel: 'portal', actor_name: 'candidato',
      note: `Contestó el cuestionario de liderazgo: ${resumen}. ${desenlace}`,
    });
  }

  /** Subir el CV desde la liga. Los archivos se suben antes de la transacción y se borran si algo falla. */
  async subirCv(token: string, b: HrLigaCvSubida): Promise<HrPostulacionResultadoDto> {
    const { p } = await this.resolver(token);
    if (p.f !== 'cv') throw new ForbiddenException('Este enlace no es para subir tu CV.');
    const archivos = validarCvDeLiga(b);
    const keys: string[] = [];
    try {
      for (const a of archivos) {
        keys.push((await this.storage.putBuffer(a.adjunto.buffer, a.adjunto.contentType, `talent/${p.tid}/${p.cid}`, a.file_name)).key);
      }
      await this.tk.run(p.tid, async (trx) => {
        const { c } = await this.resolver(token, trx);
        await trx('talent.candidates').where({ id: c['id'] }).forUpdate().first('id');
        const docs = Array.isArray(c['documents']) ? (c['documents'] as EntradaDocumento[]) : [];
        const ahora = new Date().toISOString();
        const nuevos = archivos.map((a, i) => entradaNueva({
          slot: 'cv', file_name: archivos.length > 1 ? `${i === 0 ? 'Frente' : 'Reverso'} — ${a.file_name}` : a.file_name,
          content_type: a.adjunto.contentType, size_bytes: a.adjunto.sizeBytes, storage_key: keys[i],
          por_id: null, por_nombre: 'candidato (liga)', ahora,
        }));
        await trx('talent.candidates').where({ id: c['id'] }).update({
          documents: JSON.stringify([...docs, ...nuevos]), last_activity_at: trx.fn.now(), updated_at: trx.fn.now(),
        });
        await trx('talent.candidate_events').insert({
          tenant_id: p.tid, candidate_id: c['id'], event_type: 'nota', channel: 'portal', actor_name: 'candidato',
          note: `Subió su CV desde la liga (${archivos.length > 1 ? 'dos fotos' : archivos[0].adjunto.contentType === 'application/pdf' ? 'PDF' : 'una foto'}).`,
        });
      });
      return { resultado: 'recibida', mensaje: 'Recibimos tu CV. Capital Humano de Mega Dulces te contactará pronto para los siguientes pasos.' };
    } catch (e) {
      for (const k of keys) {
        try { await this.storage.remove(k); } catch (err) {
          this.logger.warn(`No se pudo borrar ${k} del bucket: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw e;
    }
  }
}
