import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TiendaApiService } from './tienda-api.service';
import { CarritoView } from './models';

const CLAVE_TOKEN = 'tienda_carrito_token';

/**
 * Dueño único del estado del carrito. El total/subtotal/avisos SIEMPRE vienen
 * del servidor — nunca se computan ni se mezclan aquí (mismo criterio que el
 * propio backend documenta en carrito.controller.ts: "para que el frontend
 * nunca tenga que llevar su propia cuenta de los totales").
 */
@Injectable({ providedIn: 'root' })
export class CarritoStateService {
  private readonly api = inject(TiendaApiService);

  readonly carrito = signal<CarritoView | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  private token: string | null = null;
  private iniciado = false;

  /** Carga el carrito existente (si hay token guardado) o no hace nada. Llamar una vez al boot del app. */
  async iniciar(): Promise<void> {
    if (this.iniciado) return;
    this.iniciado = true;
    const guardado = localStorage.getItem(CLAVE_TOKEN);
    if (!guardado) return;
    this.token = guardado;
    await this.refrescar();
  }

  /** Vuelve a pedir el carrito al servidor (precio/existencia revalidados). Llamar antes del paso de revisión del checkout. */
  async refrescar(): Promise<void> {
    if (!this.token) return;
    this.cargando.set(true);
    try {
      const r = await firstValueFrom(this.api.verCarrito(this.token));
      if (r.ok && r.carrito) {
        this.carrito.set(r.carrito);
        this.error.set(null);
      } else {
        // Carrito cancelado/expirado/convertido en pedido: ya no sirve.
        this.limpiar();
        this.error.set(r.error ?? 'El carrito ya no está disponible');
      }
    } finally {
      this.cargando.set(false);
    }
  }

  private async asegurarCarrito(): Promise<string> {
    if (this.token) return this.token;
    const r = await firstValueFrom(this.api.crearCarrito());
    if (!r.ok || !r.token) throw new Error(r.error ?? 'No se pudo crear el carrito');
    this.token = r.token;
    localStorage.setItem(CLAVE_TOKEN, r.token);
    if (r.carrito) this.carrito.set(r.carrito);
    return r.token;
  }

  async agregar(codigo: string, unidad: string, cantidad: number): Promise<{ ok: boolean; error?: string }> {
    this.error.set(null);
    try {
      const token = await this.asegurarCarrito();
      const r = await firstValueFrom(this.api.agregarItem(token, codigo, unidad, cantidad));
      if (r.ok && r.carrito) this.carrito.set(r.carrito);
      else this.error.set(r.error ?? 'No se pudo agregar el producto');
      return { ok: r.ok, error: r.error };
    } catch (e: any) {
      const msg = e?.message ?? 'No se pudo agregar el producto';
      this.error.set(msg);
      return { ok: false, error: msg };
    }
  }

  async cambiarCantidad(itemId: number, cantidad: number): Promise<void> {
    if (!this.token) return;
    const r = await firstValueFrom(this.api.cambiarCantidad(this.token, itemId, cantidad));
    if (r.ok && r.carrito) this.carrito.set(r.carrito);
    else this.error.set(r.error ?? 'No se pudo actualizar la cantidad');
  }

  async quitar(itemId: number): Promise<void> {
    if (!this.token) return;
    const r = await firstValueFrom(this.api.quitarItem(this.token, itemId));
    if (r.ok && r.carrito) this.carrito.set(r.carrito);
    else this.error.set(r.error ?? 'No se pudo quitar el producto');
  }

  async datosCliente(datos: { nombre: string; email: string; tel: string }): Promise<{ ok: boolean; error?: string }> {
    const token = await this.asegurarCarrito();
    const r = await firstValueFrom(this.api.datosCliente(token, datos));
    if (r.ok && r.carrito) this.carrito.set(r.carrito);
    return { ok: r.ok, error: r.error };
  }

  tokenActual(): string | null {
    return this.token;
  }

  /** Se llama al confirmar un checkout exitoso: el token ya no representa un carrito editable. */
  limpiar(): void {
    this.token = null;
    localStorage.removeItem(CLAVE_TOKEN);
    this.carrito.set(null);
  }
}
