import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, sanitizarNombre, validarAdjunto } from '@megadulces/platform-core';
import type { RecruitmentBotPort, RecruitmentInbound, RecruitmentReply } from '@megadulces/contracts';
import { HrTalentIntakeService, type EntradaPostulacion } from '../talent-intake.service';
import { respuestaPublica, type Decision } from '../logic/postulacion';
import { MAX_DOCUMENTO_BYTES } from '../logic/expediente';
import {
  avanzarRegistro, faltantesParaIA, postulacionDesdeRegistro, preguntaPendiente,
  type DatosRegistro, type EstadoOrientacion, type Turno, type VacanteBot,
} from './registro';
import { HrRecruitmentInterpreterService } from './interprete-registro.service';

/**
 * Fase RH · `[RH.3.2]` — el BOT DE RECLUTAMIENTO de la Suite, detrás de `RECRUITMENT_BOT_PORT`: la conversación de
 * registro por WhatsApp. La lógica es pura (`registro.ts` + `orientacion.ts`); aquí sólo se carga y guarda la
 * conversación (`talent.bot_conversations`) y se llama a las MISMAS reglas de postulación que la web:
 *
 *   · Al confirmar sus datos, se revisan las reglas ANTES de pedirle el CV (si ya está en un proceso, se le dice ya).
 *   · Al llegar el CV, `HrTalentIntakeService.postular(…, 'whatsapp')` decide y crea (o rechaza): el CV es obligatorio,
 *     como en Mega Talento. El archivo se valida por FIRMA y se guarda en el bucket privado.
 *   · `[RH.3.2.2]` Si se le orientó (pidió un puesto que no hay), lo que pidió y lo que se le ofreció viajan a la ficha
 *     (`portal_data.orientacion`): es el único registro de la demanda que no cubrimos.
 *   · Un candado por teléfono: dos mensajes de la misma persona al mismo tiempo no pisan su conversación.
 *
 *   · `[RH.3.2.1]` Si el mensaje puede traer varios datos, consulta a la IA (`HrRecruitmentInterpreterService`) fuera
 *     de la transacción y le pasa la propuesta a la lógica pura, que la valida.
 *
 * No hace: armar el CV, las notas de voz (`[RH.3.3]`), ni avisarle a RH por WhatsApp (el candidato aparece en el
 * tablero de Reclutamiento).
 */

const T = 'talent.bot_conversations';

interface Conversacion { state: string; data: DatosRegistro; orientation: EstadoOrientacion | null }
type Cierre = Partial<Record<'outcome' | 'outcome_reason' | 'candidate_id', string | null>>;

const NO_TEXTO = 'Por ahora sólo puedo leer *mensajes de texto* 🙏 Escríbeme tu respuesta, por favor.';
const ARCHIVO_ANTES = 'Recibí tu archivo 📎, pero primero necesito terminar tu registro. '
  + 'Cuando te lo pida, me mandas tu CV.';
const POSTULACION_COMPLETA = '✅ ¡Gracias! Con esto tu *postulación queda completa*. '
  + 'Un reclutador revisará tu información y te contactará. 🙌';

@Injectable()
export class HrRecruitmentBotService implements RecruitmentBotPort {
  private readonly logger = new Logger(HrRecruitmentBotService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly intake: HrTalentIntakeService,
    /** `[RH.3.2.1]` Opcional: sin él (o sin `ANTHROPIC_API_KEY`), el registro sigue el camino determinista. */
    @Optional() private readonly interprete?: HrRecruitmentInterpreterService,
  ) {}

  async handleMessage(msg: RecruitmentInbound): Promise<RecruitmentReply[]> {
    const telefono = String(msg.phone ?? '').replace(/\D/g, '').slice(-10);
    if (telefono.length < 10) {
      this.logger.warn('[RH.3.2] mensaje al número de reclutamiento sin teléfono válido: se ignora.');
      return [];
    }
    const textos = msg.type === 'image' || msg.type === 'document'
      ? await this.archivo(msg, telefono)
      : msg.type === 'text' || msg.type === 'interactive'
        ? await this.texto(msg, telefono)
        : await this.recordar(msg, telefono, NO_TEXTO);
    return textos.map((body) => ({ kind: 'text' as const, body }));
  }

  // ── Texto: un paso de la conversación ───────────────────────────────────────────────────

  private async texto(msg: RecruitmentInbound, telefono: string): Promise<string[]> {
    // `[RH.3.2.1]` La IA se consulta FUERA de la transacción: tarda hasta 8 s y no se debe sostener una conexión ni el
    // candado por teléfono mientras tanto. Al guardar, su propuesta sólo se usa si la conversación sigue donde estaba.
    const previa = await this.tk.run(msg.tenantId, async (trx) => ({ conv: await this.leer(trx, telefono), vacantes: await this.vacantes(trx) }));
    const faltantes = faltantesParaIA(previa.conv.state, previa.conv.data, msg.text);
    const interpretacion = faltantes && this.interprete ? await this.interprete.interpretar(msg.text ?? '', faltantes, previa.vacantes) : null;

    return this.tk.run(msg.tenantId, async (trx) => {
      const actual = await this.cargar(trx, msg.tenantId, telefono);
      const vacantes = await this.vacantes(trx);
      const mismoPunto = actual.state === previa.conv.state && JSON.stringify(actual.data) === JSON.stringify(previa.conv.data);
      const turno: Turno = avanzarRegistro(actual.state, actual.data, msg.text,
        { vacantes, interpretacion: mismoPunto ? interpretacion : null }, actual.orientation);
      const cierre: Cierre = turno.reiniciado ? { outcome: null, outcome_reason: null, candidate_id: null } : {};
      const conv = (state: string): Conversacion => ({ state, data: turno.datos, orientation: turno.orientacion });

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
          await this.guardar(trx, msg, conv('rechazada'),
            { outcome: 'rechazada', outcome_reason: d.motivo, candidate_id: d.candidato_id });
          return [respuestaPublica(d, true)];
        }
      }
      await this.guardar(trx, msg, conv(turno.estado), cierre);
      return turno.respuestas;
    });
  }

  // ── Archivo: el CV, si es su momento ────────────────────────────────────────────────────

  private async archivo(msg: RecruitmentInbound, telefono: string): Promise<string[]> {
    const { actual, vacantes } = await this.tk.run(msg.tenantId, async (trx) => ({
      actual: await this.cargar(trx, msg.tenantId, telefono), vacantes: await this.vacantes(trx),
    }));
    if (actual.state !== 'esperando_cv') return this.recordar(msg, telefono, ARCHIVO_ANTES, actual);

    const bajado = msg.descargar ? await msg.descargar() : null;
    if (!bajado) return ['No pude abrir tu archivo 😕 ¿Me lo mandas de nuevo, en *PDF* o *foto*?'];
    const v = validarAdjunto(`data:${bajado.mime};base64,${Buffer.from(bajado.buffer).toString('base64')}`, MAX_DOCUMENTO_BYTES);
    if (!v.ok) return [`No pude usar ese archivo: ${v.detalle}. Mándame tu CV en *PDF* o como *foto*, por favor.`];

    const entrada: EntradaPostulacion = {
      phone: telefono, ...postulacionDesdeRegistro(actual.data, vacantes), heard_from: null,
      cv: { adjunto: v.adjunto, file_name: sanitizarNombre(msg.media?.filename ?? null, v.adjunto.contentType) }, license: null,
      portal_data: actual.orientation ? { orientacion: actual.orientation } : null,
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
      await this.cargar(trx, msg.tenantId, telefono); // toma el candado por teléfono
      if (d.accion === 'crear') {
        await this.guardar(trx, msg, { ...actual, state: 'postulada' },
          { outcome: 'postulada', outcome_reason: null, candidate_id: d.candidato_id ?? null });
      } else {
        await this.guardar(trx, msg, { ...actual, state: 'rechazada' },
          { outcome: 'rechazada', outcome_reason: d.motivo, candidate_id: d.candidato_id });
      }
    });
    return [d.accion === 'crear' ? POSTULACION_COMPLETA : respuestaPublica(d, true)];
  }

  /** Lo que no se puede atender (audio, ubicación, un archivo antes de tiempo): se dice y se le recuerda qué tocaba. */
  private async recordar(msg: RecruitmentInbound, telefono: string, aviso: string, ya?: Conversacion): Promise<string[]> {
    const actual = ya ?? await this.tk.run(msg.tenantId, (trx) => this.cargar(trx, msg.tenantId, telefono));
    return [aviso + preguntaPendiente(actual.state, actual.data, actual.orientation)];
  }

  // ── Persistencia ────────────────────────────────────────────────────────────────────────

  /** La conversación de ese teléfono (o una nueva), con el candado por teléfono tomado hasta el fin de la transacción. */
  private async cargar(trx: Knex.Transaction, tenantId: string, telefono: string): Promise<Conversacion> {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`talent-bot:${tenantId}:${telefono}`]);
    return this.leer(trx, telefono);
  }

  /** La conversación sin tomar el candado (para decidir si consultar a la IA). */
  private async leer(trx: Knex.Transaction, telefono: string): Promise<Conversacion> {
    const fila = await trx(T).where({ phone_key: telefono }).first('state', 'data', 'orientation');
    if (!fila) return { state: 'nuevo', data: {}, orientation: null };
    const objeto = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
    return {
      state: String(fila.state),
      data: objeto(fila.data) ? (fila.data as DatosRegistro) : {},
      orientation: objeto(fila.orientation) ? (fila.orientation as EstadoOrientacion) : null,
    };
  }

  private async guardar(trx: Knex.Transaction, msg: RecruitmentInbound, c: Conversacion, extra: Cierre): Promise<void> {
    const cambios = {
      state: c.state, data: JSON.stringify(c.data), orientation: c.orientation ? JSON.stringify(c.orientation) : null,
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
