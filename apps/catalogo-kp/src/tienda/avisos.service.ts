import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import * as nodemailer from 'nodemailer';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { pgRaw } from '../kp-concentrada/pg-raw.util';

/**
 * Avisos por correo al cliente.
 *
 * QUE PROBLEMA RESUELVE
 * Hasta ahora el cliente hacía su pedido y no volvía a saber nada hasta que le
 * llegaba el paquete. No sabía si se había confirmado, si había existencia, ni
 * cuándo salió. Cada una de esas dudas termina en una llamada que alguien del
 * departamento tiene que atender.
 *
 * COMO SE MANDAN
 * Nunca en la misma petición que atiende al cliente. Se **encolan**: si Gmail
 * tarda tres segundos o no responde, eso no puede hacer que confirmar un
 * pedido falle. El trabajador de la cola lo reintenta solo.
 *
 * NO SE REPITEN
 * `tienda.avisos` tiene un índice único por (pedido, tipo). Si alguien
 * confirma dos veces, o el worker reintenta, el cliente recibe un solo correo.
 *
 * Usa las mismas credenciales SMTP que las alertas internas, configuradas con
 * ADMINISTRAR.bat opción 6. Sin ellas, los avisos se registran como pendientes
 * y no se pierde nada: al configurar el correo se pueden reenviar.
 */

export type TipoAviso =
  | 'PEDIDO_CREADO'
  | 'CONFIRMADO'
  | 'REFERENCIA_PAGO'
  | 'ENVIADO'
  | 'CANCELADO';

const escapar = (v: any) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pesos = (n: any) =>
  '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

@Injectable()
export class AvisosService {
  private readonly logger = new Logger(AvisosService.name);

  constructor(@Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex) {}

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return pgRaw<T>(this.db, sql, params);
  }

  get configurado(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  /**
   * Registra que hay que avisar. NO envía: eso lo hace el trabajador de la
   * cola, para que un correo lento nunca retrase una respuesta al cliente.
   *
   * Devuelve el id del aviso, o null si ya se había registrado ese mismo aviso
   * para ese pedido.
   *
   * `trx` es la transacción Knex en curso (equivalente al `cli: PoolClient`
   * del original) para que el aviso se registre SOLO si esa transacción se
   * confirma — así no existe un pedido sin su aviso programado.
   */
  async programar(pedidoId: number, tipo: TipoAviso, destino: string,
                  trx?: Knex): Promise<number | null> {
    const correo = String(destino || '').trim();
    if (!correo) return null;

    const ejecutor = trx ?? this.db;
    // ON CONFLICT y no un SELECT previo: dos confirmaciones simultáneas
    // pasarían las dos la comprobación y mandarían el correo dos veces.
    const r = await pgRaw<any>(ejecutor,
      `INSERT INTO tienda.avisos (pedido_id, tipo, destino)
       VALUES ($1, $2, $3)
       ON CONFLICT (pedido_id, tipo) DO NOTHING
       RETURNING id`, [pedidoId, tipo, correo]);
    return r.length ? Number(r[0].id) : null;
  }

  /** Arma el correo de un aviso, con los datos del pedido al momento de enviar. */
  private async redactar(pedidoId: number, tipo: TipoAviso) {
    const p = (await this.q<any>(
      `SELECT folio, cliente_nombre, metodo_pago, total, estado,
              paqueteria, guia, cancelado_motivo, direccion
       FROM tienda.pedidos WHERE id = $1`, [pedidoId]))[0];
    if (!p) return null;

    const nombre = escapar(p.cliente_nombre || 'cliente');
    const folio  = escapar(p.folio);
    const total  = pesos(p.total);

    // Cada aviso dice UNA cosa y qué sigue. Un correo que no dice qué esperar
    // genera la llamada que intentaba evitar.
    const plantillas: Record<TipoAviso, { asunto: string; cuerpo: string }> = {
      PEDIDO_CREADO: {
        asunto: `Recibimos tu pedido ${folio}`,
        cuerpo:
          `Hola ${nombre}:\n\n` +
          `Recibimos tu pedido ${folio} por ${total}.\n\n` +
          `Ahora lo revisamos para confirmar que tenemos todo lo que pediste. ` +
          `Te avisamos en cuanto esté confirmado.\n\n` +
          (p.metodo_pago === 'TARJETA'
            ? `El monto quedó apartado en tu tarjeta, pero AÚN NO SE COBRA: ` +
              `el cargo se aplica hasta que confirmemos la existencia.\n\n`
            : `Cuando lo confirmemos te enviamos los datos para pagar.\n\n`),
      },
      CONFIRMADO: {
        asunto: `Tu pedido ${folio} está confirmado`,
        cuerpo:
          `Hola ${nombre}:\n\n` +
          `Confirmamos tu pedido ${folio} por ${total}. Tenemos todo lo que pediste.\n\n` +
          (p.metodo_pago === 'TARJETA'
            ? `Ya se aplicó el cargo a tu tarjeta.\n\n`
            : `En seguida te enviamos los datos para pagar.\n\n`) +
          `Te avisamos otra vez cuando salga tu paquete.\n\n`,
      },
      REFERENCIA_PAGO: {
        asunto: `Datos para pagar tu pedido ${folio}`,
        cuerpo:
          `Hola ${nombre}:\n\n` +
          `Tu pedido ${folio} por ${total} está confirmado y listo. ` +
          `Falta el pago.\n\n`,
      },
      ENVIADO: {
        asunto: `Tu pedido ${folio} va en camino`,
        cuerpo:
          `Hola ${nombre}:\n\n` +
          `Tu pedido ${folio} salió hoy.\n\n` +
          (p.paqueteria && p.guia
            ? `  Paquetería: ${escapar(p.paqueteria)}\n` +
              `  Número de guía: ${escapar(p.guia)}\n\n` +
              `Con ese número puedes rastrearlo en el sitio de ` +
              `${escapar(p.paqueteria)}.\n\n`
            : ''),
      },
      CANCELADO: {
        asunto: `Se canceló tu pedido ${folio}`,
        cuerpo:
          `Hola ${nombre}:\n\n` +
          `Tuvimos que cancelar tu pedido ${folio}.\n\n` +
          (p.cancelado_motivo ? `Motivo: ${escapar(p.cancelado_motivo)}\n\n` : '') +
          (p.metodo_pago === 'TARJETA'
            ? `Si el monto estaba apartado en tu tarjeta, se libera solo. ` +
              `No se te cobró nada.\n\n`
            : `No se te cobró nada.\n\n`),
      },
    };

    const t = plantillas[tipo];
    if (!t) return null;

    return {
      asunto: t.asunto,
      cuerpo: t.cuerpo +
        `Cualquier duda, responde a este correo.\n\n` +
        `Mega Dulces de los Altos\n`,
    };
  }

  /**
   * Envía un aviso ya programado. Lo llama el trabajador de la cola.
   *
   * Devuelve `true` si se envió o si ya estaba enviado. Un `false` hace que la
   * cola reintente.
   */
  async enviar(avisoId: number): Promise<boolean> {
    const a = (await this.q<any>(
      `SELECT id, pedido_id, tipo, destino, enviado_en
       FROM tienda.avisos WHERE id = $1`, [avisoId]))[0];
    if (!a) {
      this.logger.warn(`Aviso ${avisoId} no existe; nada que enviar.`);
      return true;   // no tiene sentido reintentar algo que no está
    }
    if (a.enviado_en) return true;   // ya se mandó

    if (!this.configurado) {
      // No es un fallo del aviso: es que falta configurar el correo. Se deja
      // pendiente para poder reenviarlo cuando se configure, y NO se reintenta
      // en vano cada pocos segundos.
      await this.q(
        `UPDATE tienda.avisos SET ultimo_error = $2 WHERE id = $1`,
        [avisoId, 'Correo no configurado (ADMINISTRAR.bat, opcion 6)']);
      this.logger.warn(`Aviso ${avisoId} sin enviar: falta configurar el correo.`);
      return true;
    }

    const texto = await this.redactar(Number(a.pedido_id), a.tipo);
    if (!texto) {
      await this.q(`UPDATE tienda.avisos SET ultimo_error = $2 WHERE id = $1`,
        [avisoId, 'No se pudo armar el mensaje']);
      return true;
    }

    try {
      const envio = nodemailer.createTransport({
        host: String(process.env.SMTP_HOST),
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,           // 587 usa STARTTLS, no TLS directo
        auth: {
          user: String(process.env.SMTP_USER),
          pass: String(process.env.SMTP_PASS),
        },
      });

      await envio.sendMail({
        from: `"Mega Dulces" <${process.env.SMTP_USER}>`,
        to: a.destino,
        subject: texto.asunto,
        text: texto.cuerpo,
      });

      await this.q(
        `UPDATE tienda.avisos
         SET enviado_en = NOW(), asunto = $2, intentos = intentos + 1, ultimo_error = NULL
         WHERE id = $1`, [avisoId, texto.asunto]);
      this.logger.log(`Aviso ${a.tipo} enviado a ${a.destino} (pedido ${a.pedido_id}).`);
      return true;
    } catch (e: any) {
      await this.q(
        `UPDATE tienda.avisos SET intentos = intentos + 1, ultimo_error = $2 WHERE id = $1`,
        [avisoId, String(e.message).slice(0, 400)]);
      this.logger.warn(`No se pudo enviar el aviso ${avisoId}: ${e.message}`);
      return false;   // que la cola reintente
    }
  }

  /** Avisos que quedaron sin enviar, para el tablero. */
  async pendientes() {
    const filas = await this.q<any>(
      `SELECT a.id, a.tipo, a.destino, a.intentos, a.ultimo_error, a.creado_en,
              p.folio
       FROM tienda.avisos a
       JOIN tienda.pedidos p ON p.id = a.pedido_id
       WHERE a.enviado_en IS NULL
       ORDER BY a.creado_en`);
    return { total: filas.length, avisos: filas };
  }
}
