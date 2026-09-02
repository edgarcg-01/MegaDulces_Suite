import { DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CarritoStateService } from '../../core/carrito-state.service';
import { TiendaApiService } from '../../core/tienda-api.service';
import { CheckoutOpciones, CheckoutResult, ESTADOS_MX } from '../../core/models';

/**
 * RFC de persona moral (12) o física (13). Espejo EXACTO de RE_RFC en
 * apps/catalogo-kp/src/tienda/checkout.service.ts — no aflojar aquí sin
 * actualizar allá también.
 */
const RE_RFC = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/i;
const RE_CP = /^\d{5}$/;

type Paso = 'contacto' | 'direccion' | 'pago' | 'revision' | 'listo';

@Component({
  selector: 'app-tienda-checkout',
  imports: [ReactiveFormsModule, DecimalPipe, RouterLink],
  templateUrl: './tienda-checkout.component.html',
})
export class TiendaCheckoutComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(TiendaApiService);
  private readonly router = inject(Router);
  protected readonly carritoState = inject(CarritoStateService);

  protected readonly estados = ESTADOS_MX;
  protected readonly paso = signal<Paso>('contacto');
  protected readonly opciones = signal<CheckoutOpciones | null>(null);
  protected readonly enviando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly resultado = signal<CheckoutResult | null>(null);

  protected readonly carrito = this.carritoState.carrito;

  protected readonly contactoForm = this.fb.nonNullable.group({
    nombre: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    tel: ['', Validators.required],
  });

  protected readonly direccionForm = this.fb.nonNullable.group({
    calle: ['', Validators.required],
    numero: ['', Validators.required],
    colonia: ['', Validators.required],
    ciudad: ['', Validators.required],
    estado: ['', Validators.required],
    cp: ['', [Validators.required, Validators.pattern(RE_CP)]],
  });

  protected readonly pagoForm = this.fb.nonNullable.group({
    metodo_pago: ['', Validators.required],
    requiere_factura: [false],
    rfc: [''],
    razon_social: [''],
    regimen: [''],
    uso_cfdi: [''],
    cp_fiscal: [''],
    acepta_privacidad: [false, Validators.requiredTrue],
  });

  protected readonly sinMetodosPago = computed(() =>
    !!this.opciones() && this.opciones()!.metodos_pago.length === 0);

  ngOnInit(): void {
    this.carritoState.iniciar();
    this.api.checkoutOpciones().subscribe(o => this.opciones.set(o));

    const c = this.carritoState.carrito();
    if (c?.cliente_nombre) this.contactoForm.patchValue({
      nombre: c.cliente_nombre, email: c.cliente_email ?? '', tel: c.cliente_tel ?? '',
    });
  }

  private validarFiscales(): boolean {
    if (!this.pagoForm.value.requiere_factura) return true;
    const rfc = (this.pagoForm.value.rfc ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (!rfc || !RE_RFC.test(rfc)) {
      this.error.set(`El RFC "${rfc}" no tiene una forma válida`);
      return false;
    }
    if (!this.pagoForm.value.razon_social?.trim()) { this.error.set('Falta la razón social'); return false; }
    if (!this.pagoForm.value.regimen?.trim()) { this.error.set('Falta el régimen fiscal'); return false; }
    if (!this.pagoForm.value.uso_cfdi?.trim()) { this.error.set('Falta el uso de CFDI'); return false; }
    if (!RE_CP.test(this.pagoForm.value.cp_fiscal ?? '')) {
      this.error.set('El código postal fiscal debe ser de 5 dígitos');
      return false;
    }
    return true;
  }

  async siguienteDesdeContacto(): Promise<void> {
    this.error.set(null);
    if (this.contactoForm.invalid) { this.contactoForm.markAllAsTouched(); return; }
    this.enviando.set(true);
    const r = await this.carritoState.datosCliente(this.contactoForm.getRawValue());
    this.enviando.set(false);
    if (!r.ok) { this.error.set(r.error ?? 'No se pudieron guardar tus datos'); return; }
    this.paso.set('direccion');
  }

  siguienteDesdeDireccion(): void {
    this.error.set(null);
    if (this.direccionForm.invalid) { this.direccionForm.markAllAsTouched(); return; }
    this.paso.set('pago');
  }

  async siguienteDesdePago(): Promise<void> {
    this.error.set(null);
    if (this.pagoForm.get('metodo_pago')!.invalid || this.pagoForm.get('acepta_privacidad')!.invalid) {
      this.pagoForm.markAllAsTouched();
      this.error.set('Elige un método de pago y acepta el aviso de privacidad');
      return;
    }
    if (!this.validarFiscales()) return;
    // Refrescar el carrito justo antes de revisar: el precio/existencia pudo
    // cambiar desde que se armó (el servidor siempre manda, nunca se confía
    // en un total calculado antes).
    this.enviando.set(true);
    await this.carritoState.refrescar();
    this.enviando.set(false);
    if (this.carritoState.carrito()?.hay_avisos) {
      this.error.set('Algo cambió en tu carrito — revísalo antes de continuar.');
      this.router.navigateByUrl('/carrito');
      return;
    }
    this.paso.set('revision');
  }

  async confirmar(): Promise<void> {
    const token = this.carritoState.tokenActual();
    if (!token) return;
    this.enviando.set(true);
    this.error.set(null);

    const pago = this.pagoForm.getRawValue();
    const r = await new Promise<CheckoutResult>((resolve) => {
      this.api.checkout(token, {
        metodo_pago: pago.metodo_pago,
        direccion: this.direccionForm.getRawValue(),
        requiere_factura: pago.requiere_factura,
        acepta_privacidad: true,
        ...(pago.requiere_factura ? {
          datos_fiscales: {
            rfc: pago.rfc.trim().toUpperCase(),
            razon_social: pago.razon_social,
            regimen: pago.regimen,
            uso_cfdi: pago.uso_cfdi,
            cp: pago.cp_fiscal,
          },
        } : {}),
      }).subscribe({ next: resolve, error: () => resolve({ ok: false, error: 'No se pudo generar el pedido' }) });
    });

    this.enviando.set(false);
    if (!r.ok) { this.error.set(r.error ?? 'No se pudo generar el pedido'); return; }
    this.resultado.set(r);
    this.carritoState.limpiar();
    this.paso.set('listo');
  }
}
