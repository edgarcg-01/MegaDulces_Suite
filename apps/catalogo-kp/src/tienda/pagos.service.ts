import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';

/**
 * Configuración del cobro con Mercado Pago.
 *
 * DÓNDE VIVEN LAS CREDENCIALES, Y POR QUÉ
 * En el .env, no en la base de datos. El Access Token de producción puede
 * mover dinero, así que guardarlo en una tabla que la API lee —y editarlo
 * desde una pantalla web— multiplica por dónde se puede filtrar: bastaría una
 * inyección SQL, un endpoint mal protegido o una sesión robada. El .env ya
 * está fuera de git y del respaldo a Drive, sólo lo lee el proceso de la API,
 * y cambiarlo exige entrar al servidor.
 *
 * Se configura con herramientas\Configurar_mercadopago.ps1 (menú, opción 9).
 *
 * Lo que sí se puede consultar desde el tablero es el ESTADO: si está
 * configurado, con qué cuenta y en qué modo. Eso no revela el token.
 *
 * OJO al desplegar catalogo-kp: `escribirEnv()` reescribe el `.env` del
 * directorio de trabajo del proceso (`process.cwd()`). En este monorepo el
 * `.env` de la raíz es COMPARTIDO con el resto de la Suite — quien despliegue
 * este app on-prem debe correrlo desde su propio directorio (no el root del
 * monorepo) para que las credenciales de Mercado Pago no terminen en el
 * `.env` de otra app.
 */

export type EstadoPagos = {
  configurado:   boolean;
  modo:          'pruebas' | 'produccion' | null;
  cuenta:        string | null;
  /** Últimos 4 caracteres. Identifica el token sin permitir usarlo. */
  token:         string | null;
  reserva_dias:  number;
  captura_manual: boolean;
  /** Métodos que hoy se pueden ofrecer de verdad. */
  metodos:       string[];
  faltante:      string | null;
};

@Injectable()
export class PagosService {
  private readonly logger = new Logger(PagosService.name);

  /** Días que dura la reserva si no se configuró otra cosa. */
  static readonly RESERVA_DIAS_POR_OMISION = 5;

  private get token(): string { return String(process.env.MP_ACCESS_TOKEN || '').trim(); }

  /** ¿Se puede cobrar con tarjeta ahora mismo? */
  get puedeCobrarTarjeta(): boolean {
    return !!this.token && !!String(process.env.MP_PUBLIC_KEY || '').trim();
  }

  get reservaDias(): number {
    const d = Number(process.env.MP_RESERVA_DIAS);
    return Number.isInteger(d) && d > 0 ? d : PagosService.RESERVA_DIAS_POR_OMISION;
  }

  /**
   * Métodos de pago que se pueden ofrecer HOY.
   *
   * OXXO y SPEI se ofrecen aunque Mercado Pago no esté configurado, porque en
   * ese flujo no se cobra nada al comprar: la referencia se genera DESPUÉS de
   * confirmar existencia. La tarjeta sí lo necesita desde el primer momento —
   * hay que apartar el cargo— así que sin credenciales no se ofrece.
   *
   * Ofrecerla igual dejaría entrar pedidos que nadie puede cobrar, y el
   * cliente creería que ya pagó.
   */
  metodosDisponibles(): string[] {
    return this.puedeCobrarTarjeta
      ? ['TARJETA', 'OXXO', 'SPEI']
      : ['OXXO', 'SPEI'];
  }

  /** Estado para el tablero. Nunca incluye el token ni la Public Key. */
  estado(): EstadoPagos {
    const configurado = this.puedeCobrarTarjeta;
    const modo = String(process.env.MP_MODO || '').trim().toLowerCase();
    return {
      configurado,
      modo: modo === 'produccion' ? 'produccion' : modo === 'pruebas' ? 'pruebas' : null,
      cuenta: String(process.env.MP_CUENTA || '').trim() || null,
      token: this.tokenEnmascarado,
      reserva_dias: this.reservaDias,
      // Es manual por decisión de Dirección (24/08/2026). Se deja explícito
      // porque el flujo entero —apartar al comprar, cobrar al confirmar—
      // depende de que la cuenta la tenga habilitada.
      captura_manual: true,
      metodos: this.metodosDisponibles(),
      faltante: configurado
        ? null
        : 'Falta configurar Mercado Pago: ADMINISTRAR.bat, opción 9. ' +
          'Mientras tanto sólo se puede pagar en OXXO o por SPEI.',
    };
  }

  /**
   * Últimos caracteres del token, para que el administrador sepa CUÁL está
   * cargado sin poder leerlo. Es lo mismo que hacen los bancos con las
   * tarjetas: suficiente para identificar, inútil para usar.
   */
  private get tokenEnmascarado(): string | null {
    const t = this.token;
    if (!t) return null;
    const cola = t.slice(-4);
    return `${t.startsWith('TEST-') ? 'TEST-' : 'APP_USR-'}••••${cola}`;
  }

  // ── Configuración desde el tablero ────────────────────────────────────────

  /**
   * Guarda las credenciales.
   *
   * REGLA QUE NO SE ROMPE: el token se puede ESCRIBIR desde el tablero, pero
   * NUNCA se puede LEER. Ningún endpoint lo devuelve, ni completo ni parcial
   * más allá de los últimos cuatro caracteres. Así, una sesión de
   * administrador robada podría cambiar la configuración —cosa que se nota de
   * inmediato porque los cobros fallan— pero no llevarse el token para cobrar
   * a nombre de Mega Dulces desde otro lado, que es el daño grave.
   *
   * Se guarda en .env y no en la base por lo mismo: una inyección SQL no
   * alcanza un archivo del sistema.
   */
  async guardar(d: {
    modo?: string; public_key?: string; access_token?: string; reserva_dias?: number;
  }): Promise<{ ok: boolean; error?: string; cuenta?: string; modo?: string }> {

    const modo = String(d.modo || '').trim().toLowerCase();
    if (modo !== 'pruebas' && modo !== 'produccion') {
      return { ok: false, error: 'El modo debe ser "pruebas" o "produccion"' };
    }

    const publica = String(d.public_key || '').trim();
    const token   = String(d.access_token || '').trim();
    if (!publica) return { ok: false, error: 'Falta la Public Key' };
    if (!token)   return { ok: false, error: 'Falta el Access Token' };

    const dias = Number(d.reserva_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 30) {
      return { ok: false, error: 'Los días de reserva deben ser un entero entre 1 y 30' };
    }

    // Mercado Pago prefija sus tokens. Atajar la mezcla aquí evita el error de
    // configurar producción con un token de prueba y descubrirlo el día que un
    // cliente intenta pagar de verdad.
    const esPrueba = token.startsWith('TEST-');
    if (modo === 'produccion' && esPrueba) {
      return { ok: false, error: 'Ese Access Token es de pruebas (empieza con TEST-), no de producción' };
    }

    // Se comprueba contra Mercado Pago ANTES de guardar. Guardar credenciales
    // sin verificar deja la tienda "configurada" y rota a la vez.
    let cuenta: any;
    try {
      const r = await fetch('https://api.mercadopago.com/users/me', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        return { ok: false, error: `Mercado Pago rechazó el Access Token (HTTP ${r.status})` };
      }
      cuenta = await r.json();
    } catch (e: any) {
      return { ok: false, error: `No se pudo verificar con Mercado Pago: ${e.message}` };
    }

    if (cuenta?.site_id && cuenta.site_id !== 'MLM') {
      return {
        ok: false,
        error: `Esa cuenta es de ${cuenta.site_id}, no de México (MLM). Los precios están en pesos mexicanos.`,
      };
    }

    const valores: Record<string, string> = {
      MP_MODO:         modo,
      MP_PUBLIC_KEY:   publica,
      MP_ACCESS_TOKEN: token,
      MP_RESERVA_DIAS: String(dias),
      MP_CUENTA:       String(cuenta?.nickname || ''),
    };

    try {
      this.escribirEnv(valores);
    } catch (e: any) {
      return { ok: false, error: `No se pudo guardar en .env: ${e.message}` };
    }

    // Se aplica en caliente para no exigir reinicio: la tienda empieza a
    // ofrecer tarjeta en la siguiente petición.
    for (const [k, v] of Object.entries(valores)) process.env[k] = v;

    // A la bitácora va la cuenta y el modo, NUNCA el token.
    this.logger.log(
      `Mercado Pago configurado desde el tablero: cuenta ${valores.MP_CUENTA}, ` +
      `modo ${modo}, reserva ${dias} dias.`);

    return { ok: true, cuenta: valores.MP_CUENTA, modo };
  }

  /** Reescribe las claves en .env conservando lo demás y sin BOM. */
  private escribirEnv(valores: Record<string, string>) {
    const ruta = join(process.cwd(), '.env');
    const previas = fs.existsSync(ruta)
      ? fs.readFileSync(ruta, 'utf8').split(/\r?\n/)
      : [];

    const puestas = new Set<string>();
    const salida = previas.map(l => {
      for (const k of Object.keys(valores)) {
        if (new RegExp(`^\\s*${k}\\s*=`).test(l)) {
          puestas.add(k);
          return `${k}=${valores[k]}`;
        }
      }
      return l;
    });

    const faltan = Object.keys(valores).filter(k => !puestas.has(k)).sort();
    if (faltan.length) {
      if (salida.length && salida[salida.length - 1] !== '') salida.push('');
      salida.push('# Mercado Pago. NO versionar ni respaldar a la nube.');
      for (const k of faltan) salida.push(`${k}=${valores[k]}`);
    }

    fs.writeFileSync(ruta, salida.join('\n'), { encoding: 'utf8' });
  }

  /**
   * Aviso al arrancar. Que la tienda no pueda cobrar con tarjeta es algo que
   * hay que ver en la bitácora, no descubrirlo porque un cliente se quejó.
   */
  avisarSiFalta() {
    if (!this.puedeCobrarTarjeta) {
      this.logger.warn(
        'Mercado Pago NO configurado: la tienda no ofrece pago con tarjeta. ' +
        'Configurar con ADMINISTRAR.bat, opcion 9.');
    } else {
      const modo = String(process.env.MP_MODO || 'pruebas');
      this.logger.log(
        `Mercado Pago configurado en modo ${modo}, reserva de ${this.reservaDias} dias.`);
    }
  }
}
