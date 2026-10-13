import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantKnexService, sanitizarNombre, validarAdjunto, type AdjuntoValido } from '@megadulces/platform-core';
import {
  HR_CIUDADES_EMPLEO, HR_FUENTES_EMPLEO, hrPideLicencia, hrVacanteEnCiudad,
  type HrPostulacionPublica, type HrPostulacionResultadoDto, type HrVacantePublicaDto,
} from '@megadulces/contracts';
import { decidirPostulacion, respuestaPublica, type Decision, type ProcesoExistente } from './logic/postulacion';
import { MAX_DOCUMENTO_BYTES, casilleroDe, entradaNueva, vigente, type EntradaDocumento } from './logic/expediente';

/**
 * Fase RH · `[RH.2.4]` — la ENTRADA de candidatos: la web hoy, el bot de WhatsApp en `[RH.3]`, con las mismas
 * reglas (`logic/postulacion.ts`). Es lo único de reclutamiento que recibe datos de internet, así que:
 *
 *   · Valida TODO antes de tocar el bucket; el CV va por FIRMA (PDF o imagen), no por lo que declara el navegador.
 *   · Toma un candado por TELÉFONO dentro de la transacción: dos envíos al mismo tiempo (doble clic, o el bot y la
 *     web a la vez) no pueden crear a la misma persona dos veces.
 *   · Lo que se contesta no dice para qué vacante está la persona ni si está en la lista negra (`respuestaPublica`).
 *   · Si el CV no se usó (rechazada y su proceso ya tenía CV), se borra del bucket.
 *   · Un campo trampa (`website`) que una persona no ve: si llega lleno es un robot; se contesta "recibida" y no se
 *     guarda nada (contestarle error le enseña a evitarlo).
 *   · Reglas del formulario de Mega Talento (`candidate-form.ts`): la ciudad es una del catálogo, la vacante tiene que
 *     aplicar en esa ciudad, «¿dónde te enteraste?» es obligatorio, y Chofer y Logística piden licencia de manejo.
 *   · `source` es DÓNDE SE ENTERÓ (el `fuente` de Mega Talento: Facebook, lona, recomendación…) y `origin` es POR DÓNDE
 *     ENTRÓ (web o WhatsApp). Son dos preguntas distintas y la segunda no sustituye a la primera.
 *
 * El tenant: la página pública no trae sesión. Es la bolsa de trabajo de Mega Dulces —el primer tenant—, salvo que
 * `HR_TALENT_PUBLIC_TENANT_ID` diga otro (mismo criterio que los procesos sin sesión de comercial y finanzas).
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const T = 'talent.candidates';

/** Lo que entra, ya limpio, venga de donde venga. */
export interface EntradaPostulacion {
  phone: string;
  full_name: string | null;
  email: string | null;
  city_branch: string | null;
  job_posting_id: string | null;
  position_interest: string | null;
  relative_in_company: string | null;
  rehire_note: string | null;
  /** Dónde se enteró de la vacante (`HR_FUENTES_EMPLEO`). */
  heard_from: string | null;
  cv: { adjunto: AdjuntoValido; file_name: string } | null;
  license: { adjunto: AdjuntoValido; file_name: string } | null;
}

const corto = (v: unknown, max = 200): string | null => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/** Valida y limpia lo que manda el formulario web. Lanza 400 con el primer problema. */
export function limpiarPostulacionWeb(b: HrPostulacionPublica | null | undefined): EntradaPostulacion {
  const digitos = String(b?.phone ?? '').replace(/\D/g, '');
  if (digitos.length < 10) throw new BadRequestException('Escribe tu teléfono a 10 dígitos.');
  const full_name = corto(b?.full_name, 150);
  if (!full_name || full_name.split(' ').length < 2) throw new BadRequestException('Escribe tu nombre completo.');
  const city_branch = corto(b?.city_branch);
  if (!city_branch || !HR_CIUDADES_EMPLEO.includes(city_branch)) throw new BadRequestException('Elige la ciudad donde te gustaría trabajar.');
  const job_posting_id = corto(b?.job_posting_id, 36);
  if (job_posting_id && !/^[0-9a-f-]{36}$/i.test(job_posting_id)) throw new BadRequestException('Vacante no válida.');
  const position_interest = corto(b?.position_interest);
  if (!job_posting_id && !position_interest) throw new BadRequestException('Elige el puesto que te interesa.');
  const email = corto(b?.email, 150);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Revisa tu correo.');
  const heard_from = corto(b?.heard_from);
  if (!heard_from || !(HR_FUENTES_EMPLEO as readonly string[]).includes(heard_from)) throw new BadRequestException('Dinos dónde te enteraste de la vacante.');
  if (b?.privacy_accepted !== true) throw new BadRequestException('Para postularte hay que aceptar el aviso de privacidad.');
  // El CV es obligatorio por la web (regla de Mega Talento: sin CV entraban postulaciones vacías).
  const v = validarAdjunto(String(b?.cv_base64 ?? ''), MAX_DOCUMENTO_BYTES);
  if (!v.ok) throw new BadRequestException(v.error === 'no_es_data_uri' && !b?.cv_base64 ? 'Adjunta tu CV para postularte.' : `Tu CV: ${v.detalle}`);
  // La licencia se valida si viene; si el puesto la pide y no viene, lo dice `postular` (necesita la vacante).
  let license: EntradaPostulacion['license'] = null;
  if (b?.license_base64) {
    const l = validarAdjunto(String(b.license_base64), MAX_DOCUMENTO_BYTES);
    if (!l.ok) throw new BadRequestException(`Tu licencia: ${l.detalle}`);
    license = { adjunto: l.adjunto, file_name: sanitizarNombre(b.license_file_name, l.adjunto.contentType) };
  }
  return {
    phone: digitos.slice(-10), full_name, email, city_branch, job_posting_id, position_interest,
    relative_in_company: corto(b?.relative_in_company, 300), rehire_note: corto(b?.rehire_note, 300), heard_from,
    cv: { adjunto: v.adjunto, file_name: sanitizarNombre(b?.cv_file_name, v.adjunto.contentType) }, license,
  };
}

@Injectable()
export class HrTalentIntakeService {
  private readonly logger = new Logger(HrTalentIntakeService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly storage: ObjectStorageService,
  ) {}

  private tenant(): string {
    return process.env['HR_TALENT_PUBLIC_TENANT_ID'] || MEGA;
  }

  /** Las vacantes publicadas, sólo con lo que se publica. */
  async vacantesPublicas(): Promise<HrVacantePublicaDto[]> {
    return this.tk.run(this.tenant(), async (trx) =>
      trx('talent.job_postings').where({ is_active: true }).orderBy(['sort_order', 'name'])
        .select('id', 'name', 'area', 'branch_codes', 'branches_text', 'salary_text', 'schedule_text', 'requirements', 'description', 'image_url'));
  }

  /** La web: valida, aplica las reglas y contesta sin decir de más. */
  async postularWeb(b: HrPostulacionPublica): Promise<HrPostulacionResultadoDto> {
    if (String(b?.website ?? '').trim()) {
      this.logger.warn('[RH.2.4] postulación con el campo trampa lleno: se descarta (robot).');
      return { resultado: 'recibida', mensaje: respuestaPublica({ accion: 'crear', en_lista_negra: false }, false) };
    }
    const entrada = limpiarPostulacionWeb(b);
    const d = await this.postular(entrada, 'web');
    return { resultado: d.accion === 'crear' ? 'recibida' : 'rechazada', mensaje: respuestaPublica(d, false) };
  }

  /**
   * El núcleo, común a la web y al bot. Devuelve la decisión (el que llama decide qué contestar).
   */
  async postular(e: EntradaPostulacion, canal: 'web' | 'whatsapp'): Promise<Decision> {
    const tenant = this.tenant();
    // Los archivos se suben ANTES de la transacción (no retener una conexión por la red) y se borran si no se usaron.
    const carpeta = `talent/${tenant}/postulaciones`;
    let cvKey: string | null = null;
    let licKey: string | null = null;
    let cvUsado = false;
    let licUsada = false;
    try {
      if (e.cv) cvKey = (await this.storage.putBuffer(e.cv.adjunto.buffer, e.cv.adjunto.contentType, carpeta, e.cv.file_name)).key;
      if (e.license) licKey = (await this.storage.putBuffer(e.license.adjunto.buffer, e.license.adjunto.contentType, carpeta, e.license.file_name)).key;
      const d = await this.tk.run(tenant, async (trx) => {
        // Un candado por teléfono: dos envíos simultáneos de la misma persona se forman en fila.
        await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`talent:${tenant}:${e.phone}`]);
        const vacante = e.job_posting_id
          ? await trx('talent.job_postings').where({ id: e.job_posting_id, is_active: true }).first('id', 'name', 'branch_codes')
          : null;
        if (e.job_posting_id && !vacante) throw new BadRequestException('Esa vacante ya no está publicada.');
        if (vacante && e.city_branch && !hrVacanteEnCiudad(vacante.branch_codes, e.city_branch)) {
          throw new BadRequestException(`Esa vacante no está en ${e.city_branch}.`);
        }
        const nueva = { job_posting_id: vacante?.id ?? null, job_posting_name: vacante?.name ?? null, position_interest: vacante?.name ?? e.position_interest };
        if (canal === 'web' && hrPideLicencia(nueva.position_interest) && !e.license) {
          throw new BadRequestException(`Para ${nueva.position_interest} adjunta tu licencia de manejo vigente.`);
        }
        const existentes = await this.existentes(trx, e.phone);
        const decision = decidirPostulacion(existentes, nueva);
        const origen = canal === 'web' ? 'la web' : 'WhatsApp';
        const doc = (slot: string, key: string | null, a: EntradaPostulacion['cv']): EntradaDocumento | null => (key && a ? entradaNueva({
          slot, file_name: a.file_name, content_type: a.adjunto.contentType, size_bytes: a.adjunto.sizeBytes,
          storage_key: key, por_id: null, por_nombre: canal === 'web' ? 'portal' : 'bot', ahora: new Date().toISOString(),
        }) : null);
        const cvDoc = doc('cv', cvKey, e.cv);
        const licDoc = doc('licencia', licKey, e.license);

        if (decision.accion === 'crear') {
          const docs = [cvDoc, licDoc].filter((d): d is EntradaDocumento => !!d);
          const [nuevo] = await trx(T).insert({
            tenant_id: tenant, phone: e.phone, full_name: e.full_name, email: e.email, city_branch: e.city_branch,
            job_posting_id: nueva.job_posting_id, position_interest: nueva.position_interest, relative_in_company: e.relative_in_company,
            rehire_note: e.rehire_note, source: e.heard_from, origin: canal, stage: 'filtro_inicial',
            documents: JSON.stringify(docs), last_activity_at: trx.fn.now(),
          }).returning('id');
          cvUsado = !!cvDoc;
          licUsada = !!licDoc;
          await this.nota(trx, tenant, nuevo.id ?? nuevo, canal, `Se postuló por ${origen}${nueva.position_interest ? ` para ${nueva.position_interest}` : ''}.`);
          if (decision.en_lista_negra) {
            await this.nota(trx, tenant, nuevo.id ?? nuevo, canal, 'Su teléfono coincide con alguien marcado como NO RECONTRATABLE (ver Revisiones).');
          }
          return decision;
        }

        // Rechazada: no se crea nada. Si sigue en proceso, lo que traiga y a su proceso le falte se le agrega.
        const motivo = decision.motivo === 'cerrada_hace_poco'
          ? `antes de ${new Date(decision.puede_desde ?? '').toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })} no puede volver a esta vacante`
          : 'ya está en un proceso';
        let rellenados: string[] = [];
        if (decision.motivo !== 'cerrada_hace_poco') {
          const r = await this.completar(trx, decision.candidato_id, e, cvDoc, licDoc);
          rellenados = r.rellenados;
          cvUsado = r.cvUsado;
          licUsada = r.licUsada;
        }
        await this.nota(trx, tenant, decision.candidato_id, canal,
          `Intentó postularse otra vez por ${origen}${nueva.position_interest ? ` (para ${nueva.position_interest})` : ''}: rechazado, ${motivo}.`
          + (rellenados.length ? ` Se completó: ${rellenados.join(', ')}.` : ''));
        return decision;
      });
      return d;
    } finally {
      for (const [key, usado] of [[cvKey, cvUsado], [licKey, licUsada]] as const) {
        if (!key || usado) continue;
        try { await this.storage.remove(key); } catch (err) {
          this.logger.warn(`No se pudo borrar ${key} del bucket: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** Todo lo que hay con ese teléfono, con su vacante y cuándo se cerró. */
  private async existentes(trx: Knex.Transaction, phone: string): Promise<ProcesoExistente[]> {
    const r = await trx.raw(`
      SELECT c.id, c.stage, c.job_posting_id, c.position_interest, j.name AS job_posting_name,
             c.deleted_at, c.is_spam, c.no_rehire, c.created_at,
             (SELECT max(t.changed_at) FROM talent.candidate_stage_transitions t
               WHERE t.candidate_id = c.id AND t.stage_to IN ('rechazado','contratado')) AS cerrado_en
        FROM talent.candidates c
        LEFT JOIN talent.job_postings j ON j.tenant_id = c.tenant_id AND j.id = c.job_posting_id
       WHERE c.phone_key = ?`, [phone]);
    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
    return (r.rows as Array<Record<string, unknown>>).map((x) => ({
      id: x['id'] as string, stage: x['stage'] as string | null, job_posting_id: x['job_posting_id'] as string | null,
      position_interest: x['position_interest'] as string | null, job_posting_name: x['job_posting_name'] as string | null,
      deleted_at: iso(x['deleted_at']), is_spam: !!x['is_spam'], no_rehire: !!x['no_rehire'],
      cerrado_en: iso(x['cerrado_en']), created_at: iso(x['created_at']) as string,
    }));
  }

  /**
   * Rellena SÓLO lo vacío del proceso abierto, y le pone el CV o la licencia si no tiene uno vigente. Nunca pisa un
   * dato. `source` (dónde se enteró) entra en la lista: el bot no lo pregunta, la web sí.
   */
  private async completar(trx: Knex.Transaction, id: string, e: EntradaPostulacion, cv: EntradaDocumento | null, lic: EntradaDocumento | null):
    Promise<{ rellenados: string[]; cvUsado: boolean; licUsada: boolean }> {
    const c = await trx(T).where({ id }).forUpdate().first();
    if (!c) return { rellenados: [], cvUsado: false, licUsada: false };
    const cambios: Record<string, unknown> = {};
    const rellenados: string[] = [];
    const vacio = (v: unknown) => v == null || String(v).trim() === '';
    for (const k of ['full_name', 'email', 'city_branch', 'relative_in_company', 'rehire_note'] as const) {
      if (vacio(c[k]) && e[k]) { cambios[k] = e[k]; rellenados.push(k); }
    }
    if (vacio(c.source) && e.heard_from) { cambios['source'] = e.heard_from; rellenados.push('dónde se enteró'); }
    const docs = Array.isArray(c.documents) ? (c.documents as EntradaDocumento[]) : [];
    const tiene = (slot: string) => docs.some((d) => vigente(d) && casilleroDe(d) === slot);
    const nuevos: EntradaDocumento[] = [];
    const cvUsado = !!cv && !(c.cv_url && String(c.cv_url).trim()) && !tiene('cv');
    if (cvUsado && cv) { nuevos.push(cv); rellenados.push('CV'); }
    const licUsada = !!lic && !(c.license_url && String(c.license_url).trim()) && !tiene('licencia');
    if (licUsada && lic) { nuevos.push(lic); rellenados.push('licencia'); }
    if (nuevos.length) cambios['documents'] = JSON.stringify([...docs, ...nuevos]);
    if (Object.keys(cambios).length) await trx(T).where({ id }).update({ ...cambios, last_activity_at: trx.fn.now(), updated_at: trx.fn.now() });
    return { rellenados, cvUsado, licUsada };
  }

  private async nota(trx: Knex.Transaction, tenant: string, candidateId: string, canal: 'web' | 'whatsapp', note: string): Promise<void> {
    await trx('talent.candidate_events').insert({
      tenant_id: tenant, candidate_id: candidateId, event_type: 'nota', channel: canal === 'web' ? 'portal' : 'whatsapp',
      note, actor_name: canal === 'web' ? 'portal' : 'bot',
    });
  }
}
