import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  ObjectStorageService, SpeechToTextService, TenantKnexService, htmlAPdf, sanitizarNombre, validarAdjunto, type AdjuntoValido,
} from '@megadulces/platform-core';
import type { RecruitmentBotPort, RecruitmentInbound, RecruitmentReply } from '@megadulces/contracts';
import { HrTalentIntakeService, type EntradaPostulacion } from '../talent-intake.service';
import { respuestaPublica, type Decision } from '../logic/postulacion';
import { MAX_DOCUMENTO_BYTES } from '../logic/expediente';
import {
  avanzarRegistro, comandoInformativo, construirMenu, construirSucursales, construirVacantes, faltantesParaIA,
  postulacionDesdeRegistro, preguntaPendiente, type DatosRegistro, type EstadoOrientacion, type Turno, type VacanteBot,
} from './registro';
import { HrRecruitmentInterpreterService } from './interprete-registro.service';
import { PISTA_VOZ, esAlucinacion, mensajeFallaVoz, motivoDe, nombreAudio } from './voz';
import { HrCvValidatorService } from './validar-cv.service';
import { mensajeCvRechazado, sinRevisar, type ValidacionCv } from './validar-cv';
import { COMO_LO_VES, aplicarFoto, avanzarArmado, esEstadoArmado, iniciarArmado, pendienteArmado, type Aplicacion, type TurnoArmado } from './armado';
import { nombreCompleto, type CtxSolicitud } from './solicitud';
import { consentimientoVigente } from './consentimiento';
import { htmlCv } from './cv-html';

/**
 * Fase RH · `[RH.3.2]` — el BOT DE RECLUTAMIENTO de la Suite, detrás de `RECRUITMENT_BOT_PORT`: la conversación de
 * registro por WhatsApp. La lógica es pura (`registro.ts`, `orientacion.ts`, `solicitud.ts`, `armado.ts`); aquí sólo se
 * carga y guarda la conversación (`talent.bot_conversations`), se hace lo que pide red (IA, voz, visión, PDF, bucket) y
 * se llama a las MISMAS reglas de postulación que la web:
 *
 *   · Al confirmar sus datos, se revisan las reglas ANTES de pedirle el CV (si ya está en un proceso, se le dice ya).
 *   · Al llegar el CV, `HrTalentIntakeService.postular(…, 'whatsapp')` decide y crea (o rechaza): el CV es obligatorio.
 *   · `[RH.3.2.2]` Lo que pidió quien fue orientado viaja a la ficha (`portal_data.orientacion`).
 *   · `[RH.3.2.1]` La IA se consulta fuera de la transacción; la lógica pura valida su propuesta.
 *   · `[RH.3.3.1]` Una nota de voz se transcribe y entra como si la hubiera escrito, con el eco de lo entendido.
 *   · `[RH.3.3.2]` El CV que manda se revisa con visión (`portal_data.validacion_cv`).
 *   · `[RH.3.3.3]` A quien no tiene CV, el bot se lo ARMA: la solicitud de empleo por chat (`application`), la foto al
 *     bucket, el CV en PDF (Chromium compartido) que se le manda para revisar, y al aceptarlo se postula con ese PDF y
 *     su solicitud (`candidates.application`). El PDF se arma FUERA de la transacción (tarda segundos).
 *   · Un candado por teléfono: dos mensajes de la misma persona al mismo tiempo no pisan su conversación.
 *
 * No hace: avisarle a RH por WhatsApp (el candidato aparece en el tablero de Reclutamiento).
 */

const T = 'talent.bot_conversations';

interface Conversacion { state: string; data: DatosRegistro; orientation: EstadoOrientacion | null; application: Aplicacion | null }
type Cierre = Partial<Record<'outcome' | 'outcome_reason' | 'candidate_id', string | null>>;
/** Lo que se le contesta: texto, o un mensaje ya armado (el documento del CV). */
type Salida = string | RecruitmentReply;

const NO_TEXTO = 'Por ahora sólo puedo leer *mensajes de texto* 🙏 Escríbeme tu respuesta, por favor.';
const ARCHIVO_ANTES = 'Recibí tu archivo 📎, pero primero necesito terminar tu registro. Cuando te lo pida, me mandas tu CV.';
const ARCHIVO_EN_ARMADO = 'Recibí tu archivo 📎, pero ahora toca contestar la pregunta de tu solicitud.';
const POSTULACION_COMPLETA = '✅ ¡Gracias! Con esto tu *postulación queda completa*. Un reclutador revisará tu información y te contactará. 🙌';
const CV_SUBIDO = '¡Listo! ✅ Subí tu *currículum* a tu postulación. Con esto tu solicitud queda *completa* y un reclutador la va a revisar. ¡Mucha suerte! 🍀';
const SIN_ARMADO = 'Por ahora no puedo armarte el CV desde aquí 🙏 Mándamelo como *PDF* o *foto* (aunque sea sencillo, con tus datos y tus trabajos anteriores).';
const PDF_FALLO = 'Terminé tu solicitud ✅ pero no pude armar el PDF de tu CV en este momento 😕 Escribe *sí* en un rato y lo intento de nuevo; tus respuestas están guardadas.';

@Injectable()
export class HrRecruitmentBotService implements RecruitmentBotPort {
  private readonly logger = new Logger(HrRecruitmentBotService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly intake: HrTalentIntakeService,
    /** `[RH.3.2.1]` Opcional: sin él (o sin `ANTHROPIC_API_KEY`), el registro sigue el camino determinista. */
    @Optional() private readonly interprete?: HrRecruitmentInterpreterService,
    /** `[RH.3.3.1]` Opcional: sin él (o sin `GROQ_API_KEY`), a una nota de voz se le pide que lo escriba. */
    @Optional() private readonly voz?: SpeechToTextService,
    /** `[RH.3.3.2]` Opcional: sin él, el CV se acepta como antes y queda marcado para revisión. */
    @Optional() private readonly validadorCv?: HrCvValidatorService,
    /** `[RH.3.3.3]` Opcional: sin bucket no se puede armar el CV (no hay dónde guardar la foto ni el PDF); se le pide el suyo. */
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  /** `[RH.3.3.3]` El generador de PDF (Chromium compartido). Las pruebas lo sustituyen para no levantar un navegador. */
  pdf: (html: string) => Promise<Buffer> = (html) => htmlAPdf(html, { margin: { top: '0', bottom: '0', left: '0', right: '0' } });

  async handleMessage(msg: RecruitmentInbound): Promise<RecruitmentReply[]> {
    const telefono = String(msg.phone ?? '').replace(/\D/g, '').slice(-10);
    if (telefono.length < 10) {
      this.logger.warn('[RH.3.2] mensaje al número de reclutamiento sin teléfono válido: se ignora.');
      return [];
    }
    const salidas = msg.type === 'image' || msg.type === 'document'
      ? await this.archivo(msg, telefono)
      : msg.type === 'text' || msg.type === 'interactive'
        ? await this.texto(msg, telefono)
        : msg.type === 'audio'
          ? await this.audio(msg, telefono)
          : await this.recordar(msg, telefono, NO_TEXTO);
    return salidas.map((s) => (typeof s === 'string' ? { kind: 'text' as const, body: s } : s));
  }

  // ── `[RH.3.3.1]` Nota de voz: se transcribe y entra como si la hubiera escrito ──────────

  private async audio(msg: RecruitmentInbound, telefono: string): Promise<Salida[]> {
    if (!this.voz?.hasApiKey) return [mensajeFallaVoz('sin_llave')];
    const bajado = msg.descargar ? await msg.descargar() : null;
    if (!bajado || !bajado.buffer.byteLength) return [mensajeFallaVoz('sin_audio')];
    const r = await this.voz.transcribe(Buffer.from(bajado.buffer).toString('base64'), bajado.mime, {
      filename: nombreAudio(bajado.mime), prompt: PISTA_VOZ, temperature: 0,
    });
    if (r.error) return [mensajeFallaVoz(motivoDe(r.error))];
    if (esAlucinacion(r.text)) return [mensajeFallaVoz('vacio')];
    // Siempre se le repite lo que se entendió: si quedó mal, lo ve y lo corrige.
    const eco = `🎤 _Escuché:_ "${r.text}"`;
    const resto = await this.texto({ ...msg, type: 'text', text: r.text }, telefono);
    return typeof resto[0] === 'string' ? [`${eco}\n\n${resto[0]}`, ...resto.slice(1)] : [eco, ...resto];
  }

  // ── Texto: un paso de la conversación ───────────────────────────────────────────────────

  private async texto(msg: RecruitmentInbound, telefono: string): Promise<Salida[]> {
    // `[RH.3.2.1]` La IA se consulta FUERA de la transacción: tarda hasta 8 s y no se debe sostener una conexión ni el
    // candado por teléfono mientras tanto. Al guardar, su propuesta sólo se usa si la conversación sigue donde estaba.
    const previa = await this.tk.run(msg.tenantId, async (trx) => ({ conv: await this.leer(trx, telefono), vacantes: await this.vacantes(trx) }));
    const faltantes = faltantesParaIA(previa.conv.state, previa.conv.data, msg.text);
    const interpretacion = faltantes && this.interprete ? await this.interprete.interpretar(msg.text ?? '', faltantes, previa.vacantes) : null;

    const r = await this.tk.run(msg.tenantId, async (trx): Promise<{ salidas: Salida[]; armado?: TurnoArmado }> => {
      const actual = await this.cargar(trx, msg.tenantId, telefono);
      const vacantes = await this.vacantes(trx);
      const texto = (msg.text ?? '').trim();

      // `[RH.3.3.3]` En el armado manda `armado.ts`, salvo «reiniciar» (vuelve al registro) y los comandos informativos.
      if (esEstadoArmado(actual.state) && texto.toLowerCase() !== 'reiniciar') {
        const ctx = this.ctxSolicitud(actual, telefono);
        const comando = comandoInformativo(texto);
        if (comando && actual.state === 'armando_solicitud') {
          const info = comando === 'menu' ? construirMenu() : comando === 'vacantes' ? construirVacantes(vacantes) : construirSucursales();
          return { salidas: [info + pendienteArmado(actual.state, actual.application ?? this.appVacia(), ctx)] };
        }
        const t = avanzarArmado(actual.state, actual.application ?? this.appVacia(), msg.text, ctx, new Date());
        await this.guardar(trx, msg, { ...actual, state: t.estado, application: t.app }, {});
        return { salidas: t.respuestas, armado: t };
      }

      const mismoPunto = actual.state === previa.conv.state && JSON.stringify(actual.data) === JSON.stringify(previa.conv.data);
      const turno: Turno = avanzarRegistro(actual.state, actual.data, msg.text,
        { vacantes, interpretacion: mismoPunto ? interpretacion : null }, actual.orientation);
      const cierre: Cierre = turno.reiniciado ? { outcome: null, outcome_reason: null, candidate_id: null } : {};
      const conv = (state: string): Conversacion => ({
        state, data: turno.datos, orientation: turno.orientacion, application: turno.reiniciado ? null : actual.application,
      });

      // `[RH.3.3.3]` Dijo que no tiene CV: arranca el armado (si hay dónde guardar la foto y el PDF).
      if (turno.iniciarArmado) {
        if (!this.storage) return { salidas: [SIN_ARMADO] };
        const t = iniciarArmado(this.ctxSolicitud({ ...actual, data: turno.datos }, telefono), new Date(), actual.application);
        await this.guardar(trx, msg, { ...conv(t.estado), application: t.app }, cierre);
        return { salidas: t.respuestas, armado: t };
      }

      if (turno.confirmado) {
        // Las reglas ANTES de pedirle el CV. Si la consulta no puede decidir (vacante despublicada, etc.), se le pide el
        // CV igual: `postular` vuelve a decidir con todo al recibirlo.
        let d: Decision | null = null;
        const p = postulacionDesdeRegistro(turno.datos, vacantes);
        try {
          d = await this.intake.revisarPostulacion(trx, {
            phone: telefono, job_posting_id: p.job_posting_id, position_interest: p.position_interest, city_branch: p.city_branch,
          });
        } catch (err) {
          if (!(err instanceof BadRequestException)) throw err;
        }
        if (d && d.accion === 'rechazar') {
          await this.guardar(trx, msg, conv('rechazada'), { outcome: 'rechazada', outcome_reason: d.motivo, candidate_id: d.candidato_id });
          return { salidas: [respuestaPublica(d, true)] };
        }
      }
      await this.guardar(trx, msg, conv(turno.estado), cierre);
      return { salidas: turno.respuestas };
    });

    // Los efectos del armado, FUERA de la transacción (el PDF tarda; la postulación toma su propia transacción).
    if (r.armado?.efecto === 'armar_cv') return [...r.salidas, ...(await this.armarCv(msg, telefono))];
    if (r.armado?.efecto === 'subir_cv') return this.subirCvArmado(msg, telefono);
    return r.salidas;
  }

  // ── `[RH.3.3.3]` El CV armado ───────────────────────────────────────────────────────────

  /** Arma el PDF con la solicitud y la foto, lo guarda en el bucket y se lo manda para que lo revise. */
  private async armarCv(msg: RecruitmentInbound, telefono: string): Promise<Salida[]> {
    const actual = await this.tk.run(msg.tenantId, (trx) => this.leer(trx, telefono));
    const app = actual.application;
    if (!app || !this.storage) return [PDF_FALLO];
    try {
      const foto = app.foto_key ? await this.storage.getDataUri(app.foto_key) : null;
      const pdf = await this.pdf(htmlCv(app.respuestas, { fotoDataUri: foto }));
      const nombre = `CV ${nombreCompleto(app.respuestas) || 'candidato'}.pdf`.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80);
      const { key } = await this.storage.putBuffer(pdf, 'application/pdf', `talent/${msg.tenantId}/bot-cv`, nombre);
      await this.tk.run(msg.tenantId, async (trx) => {
        const fresca = await this.cargar(trx, msg.tenantId, telefono);
        if (fresca.state !== 'revisando_cv' || !fresca.application) return;
        await this.guardar(trx, msg, { ...fresca, application: { ...fresca.application, cv_key: key } }, {});
      });
      return [{ kind: 'document', base64: pdf.toString('base64'), mime: 'application/pdf', filename: nombre, caption: 'Tu currículum 📄' }, COMO_LO_VES];
    } catch (err) {
      this.logger.error(`[RH.3.3.3] no se pudo armar el CV: ${err instanceof Error ? err.message : String(err)}`);
      return [PDF_FALLO];
    }
  }

  /** Aceptó su CV armado: se postula con ese PDF y su solicitud. Si el PDF no estaba, se arma primero. */
  private async subirCvArmado(msg: RecruitmentInbound, telefono: string): Promise<Salida[]> {
    let actual = await this.tk.run(msg.tenantId, (trx) => this.leer(trx, telefono));
    if (!actual.application?.cv_key) {
      const armado = await this.armarCv(msg, telefono);
      actual = await this.tk.run(msg.tenantId, (trx) => this.leer(trx, telefono));
      if (!actual.application?.cv_key) return armado;
    }
    const app = actual.application as Aplicacion;
    const dataUri = this.storage ? await this.storage.getDataUri(app.cv_key as string) : null;
    const v = dataUri ? validarAdjunto(dataUri, MAX_DOCUMENTO_BYTES) : null;
    if (!v || !v.ok) return [PDF_FALLO];
    const r = await this.postularConCv(msg, telefono, actual, v.adjunto, `${nombreCompleto(app.respuestas) || 'cv'}.pdf`,
      { tipo: 'armado_por_bot', motivo: 'CV armado por el bot con la solicitud', revisar: false }, app);
    return [r === POSTULACION_COMPLETA ? CV_SUBIDO : r];
  }

  // ── Archivo: el CV que manda, o la foto del armado ──────────────────────────────────────

  private async archivo(msg: RecruitmentInbound, telefono: string): Promise<Salida[]> {
    const actual = await this.tk.run(msg.tenantId, (trx) => this.cargar(trx, msg.tenantId, telefono));
    if (actual.state === 'armando_solicitud') return this.fotoDelArmado(msg, telefono, actual);
    if (actual.state !== 'esperando_cv') return this.recordar(msg, telefono, esEstadoArmado(actual.state) ? ARCHIVO_EN_ARMADO : ARCHIVO_ANTES, actual);

    const bajado = msg.descargar ? await msg.descargar() : null;
    if (!bajado) return ['No pude abrir tu archivo 😕 ¿Me lo mandas de nuevo, en *PDF* o *foto*?'];
    const v = validarAdjunto(`data:${bajado.mime};base64,${Buffer.from(bajado.buffer).toString('base64')}`, MAX_DOCUMENTO_BYTES);
    if (!v.ok) return [`No pude usar ese archivo: ${v.detalle}. Mándame tu CV en *PDF* o como *foto*, por favor.`];

    // `[RH.3.3.2]` ¿Es un CV? Lo que claramente no lo es no entra (ni completa la postulación); sin validador, o si no
    // se pudo revisar, se acepta y queda marcado para que RH lo mire.
    const revision: ValidacionCv = this.validadorCv ? await this.validadorCv.validar(v.adjunto.buffer, v.adjunto.contentType) : sinRevisar('sin validador');
    if (!revision.valido) return [mensajeCvRechazado(revision)];
    return [await this.postularConCv(msg, telefono, actual, v.adjunto, sanitizarNombre(msg.media?.filename ?? null, v.adjunto.contentType),
      { tipo: revision.tipo, motivo: revision.motivo, revisar: revision.revisar }, null)];
  }

  /** La foto del CV (sólo cuando la pregunta en turno es la foto): validada por firma, al bucket, y sigue. */
  private async fotoDelArmado(msg: RecruitmentInbound, telefono: string, actual: Conversacion): Promise<Salida[]> {
    const ctx = this.ctxSolicitud(actual, telefono);
    const app = actual.application ?? this.appVacia();
    const bajado = msg.descargar ? await msg.descargar() : null;
    const v = bajado ? validarAdjunto(`data:${bajado.mime};base64,${Buffer.from(bajado.buffer).toString('base64')}`, MAX_DOCUMENTO_BYTES) : null;
    const esImagen = !!v && v.ok && v.adjunto.contentType.startsWith('image/');
    if (!esImagen || !this.storage) return [ARCHIVO_EN_ARMADO + pendienteArmado('armando_solicitud', app, ctx)];
    if (!aplicarFoto(app, 'pendiente', ctx, new Date())) return [ARCHIVO_EN_ARMADO + pendienteArmado('armando_solicitud', app, ctx)];
    const adj = (v as { adjunto: AdjuntoValido }).adjunto;
    const { key } = await this.storage.putBuffer(adj.buffer, adj.contentType, `talent/${msg.tenantId}/bot-fotos`, sanitizarNombre(null, adj.contentType));
    const r = await this.tk.run(msg.tenantId, async (trx) => {
      const fresca = await this.cargar(trx, msg.tenantId, telefono);
      const t = fresca.state === 'armando_solicitud' ? aplicarFoto(fresca.application ?? this.appVacia(), key, this.ctxSolicitud(fresca, telefono), new Date()) : null;
      if (!t) return null;
      await this.guardar(trx, msg, { ...fresca, state: t.estado, application: t.app }, {});
      return t;
    });
    if (!r) {
      await this.storage.remove(key).catch(() => undefined);
      return [ARCHIVO_EN_ARMADO];
    }
    return r.efecto === 'armar_cv' ? [...r.respuestas, ...(await this.armarCv(msg, telefono))] : r.respuestas;
  }

  /** Postula con un CV (el que mandó o el armado) y cierra la conversación con el resultado. */
  private async postularConCv(msg: RecruitmentInbound, telefono: string, actual: Conversacion, adjunto: AdjuntoValido, archivo: string,
    validacion: { tipo: string; motivo: string; revisar: boolean }, app: Aplicacion | null): Promise<string> {
    const vacantes = await this.tk.run(msg.tenantId, (trx) => this.vacantes(trx));
    const entrada: EntradaPostulacion = {
      phone: telefono, ...postulacionDesdeRegistro(actual.data, vacantes), heard_from: null,
      cv: { adjunto, file_name: archivo }, license: null,
      portal_data: { ...(actual.orientation ? { orientacion: actual.orientation } : {}), validacion_cv: validacion },
      application: app ? { ...app } : null,
    };
    let d: Decision;
    try {
      d = await this.intake.postular(entrada, 'whatsapp', msg.tenantId);
    } catch (err) {
      // La vacante se despublicó (o dejó de estar en su ciudad) mientras conversaba: entra como puesto de interés.
      if (!(err instanceof BadRequestException) || !entrada.job_posting_id) throw err;
      d = await this.intake.postular({ ...entrada, job_posting_id: null }, 'whatsapp', msg.tenantId);
    }
    await this.tk.run(msg.tenantId, async (trx) => {
      const fresca = await this.cargar(trx, msg.tenantId, telefono); // toma el candado por teléfono
      if (d.accion === 'crear') {
        await this.guardar(trx, msg, { ...fresca, state: 'postulada' }, { outcome: 'postulada', outcome_reason: null, candidate_id: d.candidato_id ?? null });
      } else {
        await this.guardar(trx, msg, { ...fresca, state: 'rechazada' }, { outcome: 'rechazada', outcome_reason: d.motivo, candidate_id: d.candidato_id });
      }
    });
    return d.accion === 'crear' ? POSTULACION_COMPLETA : respuestaPublica(d, true);
  }

  /** Lo que no se puede atender (audio, ubicación, un archivo antes de tiempo): se dice y se le recuerda qué tocaba. */
  private async recordar(msg: RecruitmentInbound, telefono: string, aviso: string, ya?: Conversacion): Promise<Salida[]> {
    const actual = ya ?? await this.tk.run(msg.tenantId, (trx) => this.cargar(trx, msg.tenantId, telefono));
    if (esEstadoArmado(actual.state)) {
      return [aviso + pendienteArmado(actual.state, actual.application ?? this.appVacia(), this.ctxSolicitud(actual, telefono))];
    }
    return [aviso + preguntaPendiente(actual.state, actual.data, actual.orientation)];
  }

  private ctxSolicitud(c: Pick<Conversacion, 'data'>, telefono: string): CtxSolicitud {
    return { registro: c.data, telefono, consentimiento: consentimientoVigente() };
  }

  private appVacia(): Aplicacion {
    return { respuestas: {}, iniciada_en: new Date().toISOString() };
  }

  // ── Persistencia ────────────────────────────────────────────────────────────────────────

  /** La conversación de ese teléfono (o una nueva), con el candado por teléfono tomado hasta el fin de la transacción. */
  private async cargar(trx: Knex.Transaction, tenantId: string, telefono: string): Promise<Conversacion> {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`talent-bot:${tenantId}:${telefono}`]);
    return this.leer(trx, telefono);
  }

  /** La conversación sin tomar el candado (para decidir si consultar a la IA). */
  private async leer(trx: Knex.Transaction, telefono: string): Promise<Conversacion> {
    const fila = await trx(T).where({ phone_key: telefono }).first('state', 'data', 'orientation', 'application');
    if (!fila) return { state: 'nuevo', data: {}, orientation: null, application: null };
    const objeto = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
    return {
      state: String(fila.state),
      data: objeto(fila.data) ? (fila.data as DatosRegistro) : {},
      orientation: objeto(fila.orientation) ? (fila.orientation as EstadoOrientacion) : null,
      application: objeto(fila.application) ? (fila.application as Aplicacion) : null,
    };
  }

  private async guardar(trx: Knex.Transaction, msg: RecruitmentInbound, c: Conversacion, extra: Cierre): Promise<void> {
    const cambios = {
      state: c.state, data: JSON.stringify(c.data), orientation: c.orientation ? JSON.stringify(c.orientation) : null,
      application: c.application ? JSON.stringify(c.application) : null,
      profile_name: msg.profileName ?? null, last_inbound_at: trx.fn.now(), updated_at: trx.fn.now(), ...extra,
    };
    // Actualizar o insertar, NO `ON CONFLICT … DO UPDATE`: Postgres valida los CHECK sobre la fila propuesta del INSERT
    // antes de resolver el conflicto, y un «hola» de alguien ya postulado (estado final, sin traer su cierre) se caía.
    // Es seguro porque `cargar` ya tomó el candado por teléfono en esta transacción.
    const telefono = String(msg.phone).replace(/\D/g, '').slice(-10);
    const n = await trx(T).where({ phone_key: telefono }).update(cambios);
    if (!n) await trx(T).insert({ tenant_id: msg.tenantId, phone: msg.phone, ...cambios });
  }

  private async vacantes(trx: Knex.Transaction): Promise<VacanteBot[]> {
    return trx('talent.job_postings').where({ is_active: true }).orderBy(['sort_order', 'name'])
      .select('id', 'name', 'salary_text', 'branch_codes', 'branches_text', 'sort_order', 'schedule_text', 'requirements');
  }
}
