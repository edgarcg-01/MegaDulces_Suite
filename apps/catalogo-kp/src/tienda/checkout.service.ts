import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import * as crypto from 'crypto';
import { KNEX_KP_CONCENTRADA } from '../kp-concentrada/kp-concentrada.constants';
import { TiendaService } from './tienda.service';
import { CarritoService } from './carrito.service';
import { PagosService } from './pagos.service';
import { AvisosService } from './avisos.service';
import { ColaService } from './cola.service';
import { limiteConfirmacion, cuandoSeAtiende } from './horario';

/**
 * Checkout: convierte un carrito en pedido.
 *
 * El flujo que definió Dirección tiene cuatro pasos, y este servicio cubre los
 * tres primeros:
 *
 *   1. Resumen del pedido            → GET  /carrito/:token  (ya existía)
 *   2. Pago, envío y privacidad      → POST /carrito/:token/checkout
 *   3. Cobro con Mercado Pago        → pendiente: falta habilitar captura manual
 *   4. Comprobante final             → GET  /pedido/:seguimiento
 *
 * DOS FLUJOS DE PAGO, NO UNO
 * Con TARJETA se autoriza el cargo al comprar y se captura al confirmar
 * existencia. Con OXXO o SPEI eso no se puede: en efectivo no existe
 * "reservar ahora y cobrar después". Esos pedidos entran SIN cobrar y la
 * referencia de pago se envía DESPUÉS de confirmar. Sale más limpio, porque
 * no hay reembolsos que procesar si no hay existencia.
 */

/**
 * Versión del aviso de privacidad que el cliente acepta.
 *
 * Se guarda con el pedido porque la ley exige poder demostrar QUÉ texto
 * consintió el titular, no sólo que dijo que sí. Al cambiar el aviso hay que
 * subir esta versión; los pedidos viejos conservan la que aceptaron.
 *
 * PENDIENTE: el texto del aviso lo tiene que redactar la empresa. Aquí sólo se
 * registra la aceptación.
 */
export const PRIVACIDAD_VERSION = '2026-08-v1';

const METODOS = ['TARJETA', 'OXXO', 'SPEI'] as const;
type Metodo = typeof METODOS[number];

const ESTADOS_MX = new Set([
  'AGUASCALIENTES','BAJA CALIFORNIA','BAJA CALIFORNIA SUR','CAMPECHE','CHIAPAS',
  'CHIHUAHUA','CIUDAD DE MEXICO','COAHUILA','COLIMA','DURANGO','ESTADO DE MEXICO',
  'GUANAJUATO','GUERRERO','HIDALGO','JALISCO','MICHOACAN','MORELOS','NAYARIT',
  'NUEVO LEON','OAXACA','PUEBLA','QUERETARO','QUINTANA ROO','SAN LUIS POTOSI',
  'SINALOA','SONORA','TABASCO','TAMAULIPAS','TLAXCALA','VERACRUZ','YUCATAN','ZACATECAS',
]);

const limpio = (v: any) => String(v ?? '').trim();
const sinAcentos = (v: string) =>
  v.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

/** RFC de persona moral (12) o física (13). Valida forma, no existencia. */
const RE_RFC = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/i;

export interface DatosCheckout {
  metodo_pago?:  string;
  direccion?:    any;
  requiere_factura?: boolean;
  datos_fiscales?: any;
  acepta_privacidad?: boolean;
  ip?:           string;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private listo = false;

  constructor(
    @Inject(KNEX_KP_CONCENTRADA) private readonly db: Knex,
    private readonly tienda: TiendaService,
    private readonly carrito: CarritoService,
    private readonly pagos: PagosService,
    private readonly avisos: AvisosService,
    private readonly cola: ColaService,
  ) {
    void this.comprobarMigracion();
  }

  private async comprobarMigracion() {
    try {
      const r = await this.q<any>(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='tienda' AND table_name='pedidos'
           AND column_name='metodo_pago'`);
      this.listo = r.length > 0;
    } catch { this.listo = false; }
    // Aqui se mira this.listo directamente, NO estaListo(): esta funcion es a
    // la que estaListo() llama, y usarla aqui la haria llamarse a si misma.
    if (!this.listo) {
      this.logger.warn(
        'Checkout DESACTIVADO: falta la migracion 004_checkout.sql. ' +
        'Se reintenta solo en la siguiente peticion; no hace falta reiniciar.');
    }
  }

  /**
   * Igual que en CarritoService: la comprobacion se REINTENTA en vez de hacerse
   * una sola vez al arrancar. El 31/08/2026 la API arranco un segundo antes de
   * que volviera la base y los tres servicios de la tienda quedaron apagados
   * con sus migraciones puestas, hasta que alguien reinicio a mano.
   */
  private ultimaRevision = 0;
  private static readonly REVISAR_CADA_MS = 30_000;

  private async estaListo(): Promise<boolean> {
    if (this.listo) return true;
    if (Date.now() - this.ultimaRevision < CheckoutService.REVISAR_CADA_MS) return false;
    this.ultimaRevision = Date.now();
    await this.comprobarMigracion();
    return this.listo;
  }

  private async q<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const r = await this.db.raw(sql, params ?? []);
    return r.rows as T[];
  }

  // ── Token de seguimiento ──────────────────────────────────────────────────
  // Mismo esquema que el carrito. El folio NO sirve como llave de acceso:
  // es consecutivo, así que cualquiera podría ir probando folios y leer los
  // datos de otros clientes.

  private firma(id: number): string {
    const secreto = process.env.CATALOGO_KP_JWT_SECRET;
    if (!secreto) throw new Error('CATALOGO_KP_JWT_SECRET no configurado');
    return crypto.createHmac('sha256', secreto)
      .update(`pedido:${id}`).digest('base64url').slice(0, 32);
  }

  private seguimiento(id: number): string { return `${id}.${this.firma(id)}`; }

  private idDeSeguimiento(token: string): number | null {
    const t = String(token || '');
    const punto = t.indexOf('.');
    if (punto < 1) return null;
    const id = Number(t.slice(0, punto));
    if (!Number.isInteger(id) || id <= 0) return null;
    const dada = Buffer.from(t.slice(punto + 1));
    let esperada: Buffer;
    try { esperada = Buffer.from(this.firma(id)); } catch { return null; }
    if (dada.length !== esperada.length) return null;
    return crypto.timingSafeEqual(dada, esperada) ? id : null;
  }

  // ── Validaciones ──────────────────────────────────────────────────────────

  /** Revisa la dirección de envío. Devuelve el error o null si está bien. */
  private validarDireccion(d: any): string | null {
    if (!d || typeof d !== 'object') return 'Falta la dirección de envío';

    const faltantes: string[] = [];
    for (const [campo, etiqueta] of [
      ['calle', 'la calle'], ['numero', 'el número'], ['colonia', 'la colonia'],
      ['ciudad', 'la ciudad'], ['estado', 'el estado'], ['cp', 'el código postal'],
    ] as const) {
      if (!limpio(d[campo])) faltantes.push(etiqueta);
    }
    if (faltantes.length) {
      return `Falta ${faltantes.join(', ')} en la dirección de envío`;
    }

    if (!/^\d{5}$/.test(limpio(d.cp))) {
      return 'El código postal debe ser de 5 dígitos';
    }
    if (!ESTADOS_MX.has(sinAcentos(limpio(d.estado)))) {
      return `"${limpio(d.estado)}" no es un estado de la República`;
    }
    return null;
  }

  /**
   * Revisa los datos fiscales. Sólo se exigen si el cliente pide factura.
   *
   * No se valida contra el SAT: eso lo hace quien da de alta al cliente en
   * Kepler. Aquí se comprueba la forma para atajar el error de dedo, que es lo
   * que hace perder un día persiguiendo al cliente por teléfono.
   */
  private validarFiscales(f: any): string | null {
    if (!f || typeof f !== 'object') return 'Faltan los datos de facturación';

    const rfc = limpio(f.rfc).toUpperCase().replace(/[\s-]/g, '');
    if (!rfc) return 'Falta el RFC';
    if (!RE_RFC.test(rfc)) return `El RFC "${rfc}" no tiene una forma válida`;

    if (!limpio(f.razon_social)) return 'Falta la razón social';
    if (!limpio(f.regimen))      return 'Falta el régimen fiscal';
    if (!limpio(f.uso_cfdi))     return 'Falta el uso de CFDI';

    const cp = limpio(f.cp);
    if (!/^\d{5}$/.test(cp)) return 'El código postal fiscal debe ser de 5 dígitos';

    return null;
  }

  // ── Checkout ──────────────────────────────────────────────────────────────

  /**
   * Convierte el carrito en pedido.
   *
   * Todo se valida ANTES de tocar la base: si algo falta, el carrito queda
   * intacto y el cliente puede corregir sin perder lo que llevaba.
   */
  async checkout(token: string, d: DatosCheckout) {
    if (!(await this.estaListo())) {
      return { ok: false, error: 'El checkout no está disponible: falta aplicar la migración 004_checkout.sql (ADMINISTRAR.bat, opción 8).' };
    }

    // 1. El carrito debe existir, tener producto y estar todo disponible.
    const vista: any = await this.carrito.ver(token);
    if (!vista.ok) return vista;

    const c = vista.carrito;
    if (!c.partidas) return { ok: false, error: 'El carrito está vacío' };

    const noDisponibles = c.items.filter((i: any) => !i.disponible);
    if (noDisponibles.length) {
      return {
        ok: false,
        error: 'Hay productos que ya no están disponibles. Revisa tu carrito.',
        items: noDisponibles.map((i: any) => ({ codigo: i.codigo, aviso: i.aviso })),
      };
    }
    // Si un precio cambió, el cliente tiene que verlo antes de pagar. No se
    // cobra un total distinto al que aceptó, aunque la diferencia lo favorezca.
    if (c.hay_avisos) {
      return {
        ok: false,
        error: 'Algunos precios cambiaron. Revisa tu carrito antes de continuar.',
        items: c.items.filter((i: any) => i.aviso)
          .map((i: any) => ({ codigo: i.codigo, aviso: i.aviso })),
      };
    }

    // 2. Aviso de privacidad. Sin esto no se puede tratar el dato personal.
    if (d.acepta_privacidad !== true) {
      return { ok: false, error: 'Hay que aceptar el aviso de privacidad para continuar' };
    }

    // 3. Método de pago.
    const metodo = limpio(d.metodo_pago).toUpperCase() as Metodo;
    if (!METODOS.includes(metodo)) {
      return { ok: false, error: `Método de pago no válido. Opciones: ${METODOS.join(', ')}` };
    }
    // La tarjeta necesita apartar el cargo AL COMPRAR. Sin credenciales de
    // Mercado Pago eso no se puede, y aceptar el pedido igual dejaría entrar
    // uno que nadie puede cobrar mientras el cliente cree que ya pagó.
    // OXXO y SPEI sí pasan: ahí no se cobra nada hasta confirmar existencia.
    if (!this.pagos.metodosDisponibles().includes(metodo)) {
      return {
        ok: false,
        error: 'El pago con tarjeta no está disponible por ahora. ' +
               'Puedes pagar en OXXO o por transferencia (SPEI).',
      };
    }

    // 4. Dirección.
    const errDir = this.validarDireccion(d.direccion);
    if (errDir) return { ok: false, error: errDir };

    // 5. Facturación, sólo si la pide.
    const factura = d.requiere_factura === true;
    if (factura) {
      const errFis = this.validarFiscales(d.datos_fiscales);
      if (errFis) return { ok: false, error: errFis };
    }

    // 6. Contacto: sin correo no hay forma de avisarle nada.
    const id = this.carrito.idDe(token);
    if (!id) return { ok: false, error: 'Carrito no válido' };

    const datos = await this.q<any>(
      `SELECT cliente_nombre, cliente_email FROM tienda.pedidos WHERE id = $1`, [id]);
    if (!limpio(datos[0]?.cliente_email)) {
      return { ok: false, error: 'Falta el correo de contacto' };
    }
    if (!limpio(datos[0]?.cliente_nombre)) {
      return { ok: false, error: 'Falta el nombre de quien compra' };
    }

    // ── Todo validado. Ahora sí se convierte. ──────────────────────────────
    const ahora = new Date();
    const limite = limiteConfirmacion(ahora);
    const atencion = cuandoSeAtiende(ahora);

    let resultado: any;
    try {
      resultado = await this.db.transaction(async (trx) => {
        // El folio se asigna aquí, no al crear el carrito: un carrito abandonado
        // no debe consumir folio ni dejar huecos en el consecutivo.
        const f = await trx.raw(`SELECT nextval('tienda.folio_seq') AS n`);
        const folio = `MD-${ahora.getFullYear()}-${String(f.rows[0].n).padStart(5, '0')}`;

        const upd = await trx.raw(
          `UPDATE tienda.pedidos
           SET estado = 'PENDIENTE_CONFIRMACION',
               folio = $2,
               metodo_pago = $3,
               direccion = $4,
               requiere_factura = $5,
               datos_fiscales = $6,
               privacidad_version = $7,
               privacidad_aceptada_en = NOW(),
               privacidad_ip = $8,
               confirmar_antes_de = $9
           WHERE id = $1 AND estado = 'CARRITO'
           RETURNING id, folio, subtotal, envio, total`,
          [id, folio, metodo, JSON.stringify(d.direccion), factura,
           factura ? JSON.stringify(this.normalizarFiscales(d.datos_fiscales)) : null,
           PRIVACIDAD_VERSION, limpio(d.ip) || null, limite]);

        if (!upd.rows.length) {
          throw { controlado: 'Ese carrito ya no se puede convertir en pedido' };
        }

        await trx.raw(
          `INSERT INTO tienda.pedido_eventos (pedido_id, estado_de, estado_a, actor, detalle, datos)
           VALUES ($1,'CARRITO','PENDIENTE_CONFIRMACION','cliente',$2,$3)`,
          [id, `Pedido ${folio} creado. Pago: ${metodo}.`,
           JSON.stringify({ metodo, factura, privacidad: PRIVACIDAD_VERSION })]);

        // El acuse va DENTRO de la transacción, para que no exista un pedido sin
        // su aviso programado. El envío en sí ocurre después, por la cola: que
        // Gmail tarde no puede hacer que el checkout falle.
        const aviso = await this.avisos.programar(
          id, 'PEDIDO_CREADO', String(datos[0].cliente_email), trx);

        return { p: upd.rows[0], aviso };
      });
    } catch (e: any) {
      if (e?.controlado) return { ok: false, error: e.controlado as string };
      this.logger.error(`Error en checkout del carrito ${id}: ${e.message}`);
      return { ok: false, error: 'No se pudo generar el pedido' };
    }

    // Se encola FUERA de la transacción y sin await bloqueante: si esto
    // falla, el pedido ya está guardado y lo peor que pasa es que el acuse
    // salga tarde. Nunca al revés.
    if (resultado.aviso) {
      this.cola.encolar('aviso_cliente', { aviso_id: resultado.aviso })
        .catch(e => this.logger.warn(`No se pudo encolar el acuse del pedido ${resultado.p.folio}: ${e.message}`));
    }

    const p = resultado.p;
    return {
      ok: true,
      folio: p.folio,
      seguimiento: this.seguimiento(id),
      total: Number(p.total),
      metodo_pago: metodo,
      // Lo que sigue depende del método. Con tarjeta hay que cobrar ahora;
      // con efectivo, la referencia se genera al confirmar existencia.
      siguiente_paso: metodo === 'TARJETA' ? 'AUTORIZAR_PAGO' : 'ESPERAR_CONFIRMACION',
      confirmar_antes_de: limite.toISOString(),
      atencion: atencion.texto,
      mensaje: metodo === 'TARJETA'
        ? 'Tu pedido quedó registrado. El cargo se retiene ahora y se cobra al confirmar existencia.'
        : 'Tu pedido quedó registrado. Al confirmar existencia te enviamos la referencia de pago.',
    };
  }

  /** Deja los datos fiscales en forma canónica antes de guardarlos. */
  private normalizarFiscales(f: any) {
    return {
      rfc:          limpio(f.rfc).toUpperCase().replace(/[\s-]/g, ''),
      razon_social: limpio(f.razon_social),
      regimen:      limpio(f.regimen),
      uso_cfdi:     limpio(f.uso_cfdi).toUpperCase(),
      cp:           limpio(f.cp),
    };
  }

  // ── Comprobante ───────────────────────────────────────────────────────────

  /**
   * Comprobante del pedido. Es el paso 4 del flujo: lo que el cliente ve al
   * terminar y lo que puede volver a consultar después.
   */
  async verPedido(seguimiento: string) {
    if (!(await this.estaListo())) {
      return { ok: false, error: 'Falta aplicar la migración 004_checkout.sql' };
    }
    const id = this.idDeSeguimiento(seguimiento);
    if (!id) return { ok: false, error: 'Pedido no válido' };

    const p = await this.q<any>(
      `SELECT p.id, p.folio, p.estado, e.descripcion AS estado_texto,
              p.cliente_nombre, p.cliente_email, p.cliente_tel,
              p.metodo_pago, p.entrega, p.direccion,
              p.requiere_factura, p.datos_fiscales,
              p.subtotal, p.envio, p.total,
              p.confirmar_antes_de, p.confirmado_en,
              p.capturado_en, p.creado_en,
              p.cancelado_motivo
       FROM tienda.pedidos p
       LEFT JOIN tienda.estados e ON e.estado = p.estado
       WHERE p.id = $1`, [id]);
    if (!p.length) return { ok: false, error: 'Pedido no encontrado' };
    if (p[0].estado === 'CARRITO') {
      return { ok: false, error: 'Ese pedido todavía no se ha confirmado' };
    }

    const items = await this.q<any>(
      `SELECT codigo, nombre, unidad, piezas_por_unidad, cantidad,
              precio_unitario, importe, cantidad_surtida
       FROM tienda.pedido_items
       WHERE pedido_id = $1 AND activo ORDER BY id`, [id]);

    const r = p[0];
    return {
      ok: true,
      pedido: {
        folio:  r.folio,
        estado: r.estado,
        estado_texto: r.estado_texto,
        creado_en: r.creado_en,
        cliente: {
          nombre: r.cliente_nombre,
          email:  r.cliente_email,
          tel:    r.cliente_tel,
        },
        entrega:    r.entrega,
        direccion:  r.direccion,
        metodo_pago: r.metodo_pago,
        requiere_factura: r.requiere_factura,
        datos_fiscales:   r.datos_fiscales,
        items: items.map(i => ({
          codigo: i.codigo, nombre: i.nombre, unidad: i.unidad,
          piezas_por_unidad: Number(i.piezas_por_unidad),
          cantidad: Number(i.cantidad),
          precio_unitario: Number(i.precio_unitario),
          importe: Number(i.importe),
          surtido: i.cantidad_surtida === null ? null : Number(i.cantidad_surtida),
        })),
        subtotal: Number(r.subtotal),
        envio:    Number(r.envio),
        total:    Number(r.total),
        confirmar_antes_de: r.confirmar_antes_de,
        confirmado_en:      r.confirmado_en,
        pagado_en:          r.capturado_en,
        cancelado_motivo:   r.cancelado_motivo,
      },
    };
  }
}
