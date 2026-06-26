import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { AuthService } from '../../../core/services/auth.service';
import { AuthStageComponent } from '../ui/auth-stage.component';

@Component({
  selector: 'app-portal-login',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    InputTextModule,
    MessageModule,
    AuthStageComponent,
  ],
  template: `
    <div class="pl-wrap">
      <!-- Hero side (desktop) -->
      <aside class="pl-hero" aria-hidden="true">
        <div class="pl-hero-deco pl-hero-deco-1"></div>
        <div class="pl-hero-deco pl-hero-deco-2"></div>
        <div class="pl-hero-deco pl-hero-deco-3"></div>

        <div class="pl-hero-content">
          <img
            src="/assets/logos/mega-dulces-logo-240.webp"
            alt="Mega Dulces"
            class="pl-hero-logo"
          />
          <h1 class="pl-hero-title">
            Tu dulcería,<br />
            <span class="pl-hero-accent">surtida en minutos.</span>
          </h1>
          <p class="pl-hero-subtitle">
            Catálogo completo, tus precios, pedidos con IA y entrega coordinada.
          </p>

          <ul class="pl-hero-bullets">
            <li><i class="pi pi-check-circle"></i> Tu lista de precios personalizada</li>
            <li><i class="pi pi-check-circle"></i> Pedido conversacional con IA</li>
            <li><i class="pi pi-check-circle"></i> Promociones activas en tiempo real</li>
            <li><i class="pi pi-check-circle"></i> Historial completo de compras</li>
          </ul>
        </div>
      </aside>

      <!-- Form side -->
      <section class="pl-form-side">
        <!-- Escaparate de bienvenida (móvil): producto que cae con GSAP -->
        <portal-auth-stage class="pl-stage" image="/assets/brands/nucita.webp"></portal-auth-stage>

        <header class="pl-form-head">
          <img
            src="/assets/logos/mega-dulces-logo-240.webp"
            alt="Mega Dulces"
            class="pl-form-logo"
          />
          <h1 class="pl-display">Tu dulcería,<br />surtida en <span class="pl-em">minutos.</span></h1>
          <svg class="pl-underline" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
            <path d="M5 9 C 55 2, 145 2, 195 7" fill="none" stroke="var(--action)" stroke-width="3.5" stroke-linecap="round" />
          </svg>
          <span class="pl-form-eyebrow">Portal B2B</span>
          <h2 class="pl-form-title">Bienvenido de vuelta</h2>
          <p class="pl-form-sub">Tu lista de precios, pedidos con IA y entrega coordinada.</p>
        </header>

        <form [formGroup]="form" (ngSubmit)="submit()" class="pl-form" novalidate>
          <div class="pl-field" *ngIf="showTenant()">
            <label for="tenant">Empresa</label>
            <input
              pInputText
              id="tenant"
              formControlName="tenant_slug"
              placeholder="mega_dulces"
              autocomplete="organization"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              inputmode="text"
              enterkeyhint="next"
              [class.pl-input-invalid]="isInvalid('tenant_slug')"
              [attr.aria-invalid]="isInvalid('tenant_slug') ? 'true' : null"
              [attr.aria-describedby]="fieldError('tenant_slug') ? 'tenant-err' : null"
            />
            <small *ngIf="fieldError('tenant_slug')" id="tenant-err" class="pl-field-err" role="alert">
              <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ fieldError('tenant_slug') }}
            </small>
          </div>
          <button
            *ngIf="!showTenant()"
            type="button"
            class="pl-tenant-toggle"
            (click)="showTenant.set(true)"
          >
            <i class="pi pi-building" aria-hidden="true"></i>
            ¿Tu cuenta es de otra empresa? Cambiar
          </button>

          <div class="pl-field">
            <label for="user">Usuario</label>
            <input
              pInputText
              id="user"
              formControlName="username"
              placeholder="Tu nombre de usuario"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              inputmode="text"
              enterkeyhint="next"
              [class.pl-input-invalid]="isInvalid('username')"
              [attr.aria-invalid]="isInvalid('username') ? 'true' : null"
              [attr.aria-describedby]="fieldError('username') ? 'user-err' : null"
            />
            <small *ngIf="fieldError('username')" id="user-err" class="pl-field-err" role="alert">
              <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ fieldError('username') }}
            </small>
          </div>

          <div class="pl-field">
            <div class="pl-label-row">
              <label for="pass">Contraseña</label>
              <button type="button" class="pl-show-pass" (click)="togglePass()">
                {{ showPass() ? 'Ocultar' : 'Mostrar' }}
              </button>
            </div>
            <input
              pInputText
              id="pass"
              [type]="showPass() ? 'text' : 'password'"
              formControlName="password"
              placeholder="Mínimo 4 caracteres"
              autocomplete="current-password"
              enterkeyhint="go"
              [class.pl-input-invalid]="isInvalid('password')"
              [attr.aria-invalid]="isInvalid('password') ? 'true' : null"
              [attr.aria-describedby]="fieldError('password') ? 'pass-err' : null"
            />
            <small *ngIf="fieldError('password')" id="pass-err" class="pl-field-err" role="alert">
              <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ fieldError('password') }}
            </small>
          </div>

          <!-- Error a nivel formulario (HTTP / resumen). aria-live para que el
               lector lo anuncie sin mover el foco. -->
          <div class="pl-error-wrap" aria-live="assertive" role="alert">
            <p-message
              *ngIf="error()"
              severity="error"
              [text]="error()!"
              styleClass="pl-error"
            ></p-message>
          </div>

          <button
            type="submit"
            class="portal-btn-primary portal-btn-block portal-btn-primary-lg pl-submit"
            [disabled]="loading()"
          >
            <i [class]="loading() ? 'pi pi-spin pi-spinner' : 'pi pi-arrow-right'" aria-hidden="true"></i>
            {{ loading() ? 'Ingresando…' : 'Ingresar al portal' }}
          </button>

          <p class="pl-foot">
            ¿No tienes acceso?
            <a href="mailto:soporte@megadulces.com.mx">Solicita tu cuenta</a>
          </p>
        </form>
      </section>
    </div>
  `,
  styles: [
    `
      :host { display: block; }

      .pl-wrap {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 1fr;
        background: var(--surface-ground);
        color: var(--text-main);
      }
      @media (min-width: 960px) {
        .pl-wrap { grid-template-columns: 1.05fr 1fr; }
      }

      /* ── HERO SIDE ──────────────────────────────────────────────── */
      .pl-hero {
        display: none;
        position: relative;
        overflow: hidden;
        background:
          radial-gradient(120% 80% at 0% 0%, rgba(253, 231, 7, 0.08) 0%, transparent 55%),
          linear-gradient(160deg, var(--neutral-900) 0%, var(--neutral-950) 100%);
        color: #fff;
        padding: clamp(2rem, 5vw, 4rem);
        align-items: center;
        justify-content: center;
      }
      @media (min-width: 960px) {
        .pl-hero { display: flex; }
      }

      .pl-hero-deco {
        position: absolute;
        border-radius: 50%;
        filter: blur(0.5px);
        opacity: 0.6;
        pointer-events: none;
      }
      .pl-hero-deco-1 {
        width: 320px; height: 320px;
        top: -120px; right: -80px;
        background: radial-gradient(circle, rgba(255,255,255,0.04), transparent 70%);
      }
      .pl-hero-deco-2 {
        width: 240px; height: 240px;
        bottom: -80px; left: -60px;
        background: radial-gradient(circle, rgba(253, 231, 7, 0.06), transparent 70%);
      }
      .pl-hero-deco-3 { display: none; }

      .pl-hero-content {
        position: relative;
        z-index: 1;
        max-width: 460px;
        animation: fadeInUp 0.6s var(--ease-decelerate) both;
      }
      @keyframes fadeInUp {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .pl-hero-logo {
        width: 88px;
        height: 88px;
        object-fit: contain;
        border-radius: var(--r-lg);
        background: rgba(255,255,255,0.95);
        padding: 10px;
        margin-bottom: 1.5rem;
        box-shadow: 0 12px 40px -8px rgba(0,0,0,0.35);
      }

      .pl-hero-title {
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: clamp(2rem, 3.5vw, 2.75rem);
        font-weight: 700;
        line-height: 1.08;
        margin: 0 0 0.875rem 0;
        letter-spacing: -0.01em;
      }
      .pl-hero-accent {
        color: #fff;
        position: relative;
      }
      .pl-hero-accent::after {
        content: '';
        position: absolute;
        left: 0;
        bottom: -4px;
        width: 64px;
        height: 3px;
        background: var(--brand-500);
        border-radius: 2px;
      }

      .pl-hero-subtitle {
        font-size: var(--fs-h3);
        line-height: 1.5;
        opacity: 0.92;
        margin: 0 0 2rem 0;
        max-width: 380px;
      }

      .pl-hero-bullets {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
      }
      .pl-hero-bullets li {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        font-size: var(--fs-body);
        opacity: 0.95;
      }
      .pl-hero-bullets i {
        color: var(--brand-400);
        font-size: var(--fs-h3);
      }

      /* ── FORM SIDE (móvil = editorial claro: cream + amber, top-aligned) ── */
      .pl-form-side {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        padding: calc(clamp(2.25rem, 9vw, 3.5rem) + env(safe-area-inset-top))
          max(1.5rem, env(safe-area-inset-right))
          calc(2rem + env(safe-area-inset-bottom))
          max(1.5rem, env(safe-area-inset-left));
        background:
          radial-gradient(72% 40% at 100% 0%, rgba(248, 180, 0, 0.10) 0%, transparent 60%),
          var(--surface-ground);
      }
      @media (min-width: 960px) {
        /* Desktop: el hero lleva la marca; el form vuelve a card centrada. */
        .pl-form-side {
          justify-content: center;
          background: var(--card-bg);
          padding: clamp(1.5rem, 5vw, 3rem)
            max(1.25rem, env(safe-area-inset-right))
            calc(clamp(1.5rem, 5vw, 3rem) + env(safe-area-inset-bottom))
            max(1.25rem, env(safe-area-inset-left));
        }
      }

      .pl-form-head {
        max-width: 380px;
        width: 100%;
        margin: 0 auto 1.75rem;
        text-align: left;
      }
      .pl-form-logo {
        width: 56px;
        height: 56px;
        object-fit: contain;
        border-radius: var(--r-md);
        background: var(--neutral-100);
        padding: 6px;
        margin-bottom: 1rem;
      }
      @media (min-width: 960px) {
        /* En desktop, el hero ya muestra el logo grande — el del form es redundante */
        .pl-form-logo { display: none; }
      }
      /* Titular editorial — solo móvil (en desktop manda el hero). */
      .pl-display {
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: clamp(2.1rem, 9vw, 2.6rem);
        font-weight: 800;
        line-height: 1.02;
        letter-spacing: -0.03em;
        margin: 0.25rem 0 0.5rem;
        color: var(--neutral-950);
      }
      .pl-em {
        color: var(--action);
        white-space: nowrap;
      }
      /* Subrayado dibujado (DrawSVG) bajo el titular — acento animado. */
      .pl-underline {
        display: block;
        width: clamp(150px, 52%, 230px);
        height: 13px;
        margin: -2px 0 0;
        overflow: visible;
      }
      @media (min-width: 960px) {
        .pl-underline { display: none; }
      }

      /* Escaparate de bienvenida — solo móvil (en desktop manda el hero). */
      .pl-stage {
        display: block;
        height: 38dvh;
        min-height: 220px;
        margin: -0.5rem 0 0.25rem;
      }
      @media (min-width: 960px) {
        .pl-stage { display: none; }
      }

      .pl-form-eyebrow {
        display: none;
        font-size: var(--fs-micro);
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        padding: 0.25rem 0.625rem;
        border-radius: var(--r-pill);
        margin-bottom: 0.875rem;
      }
      .pl-form-title {
        display: none;
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: var(--fs-h1);
        font-weight: 700;
        line-height: 1.12;
        margin: 0 0 0.375rem 0;
        letter-spacing: -0.01em;
        color: var(--text-main);
      }
      @media (min-width: 960px) {
        .pl-display { display: none; }
        .pl-form-eyebrow { display: inline-block; }
        .pl-form-title { display: block; }
      }
      .pl-form-sub {
        margin: 0;
        font-size: var(--fs-body);
        color: var(--text-muted);
        line-height: 1.45;
      }

      .pl-form {
        max-width: 380px;
        width: 100%;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .pl-field {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .pl-field label {
        font-size: var(--fs-sm);
        font-weight: 600;
        color: var(--text-main);
      }
      .pl-field :deep(input.p-inputtext) {
        width: 100%;
        padding: 0.8rem 0.95rem;
        /* 16px exactos: <16px hace que iOS Safari haga zoom al enfocar. */
        font-size: 16px;
        border-radius: var(--r-md);
        border: 1.5px solid var(--border-color);
        background: var(--card-bg);
        color: var(--text-main);
        transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard);
      }
      .pl-field :deep(input.p-inputtext:hover) {
        border-color: var(--neutral-300);
      }
      .pl-field :deep(input.p-inputtext:focus) {
        border-color: var(--action);
        outline: none;
        box-shadow: 0 0 0 3px var(--action-ring);
      }

      .pl-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .pl-show-pass {
        background: transparent;
        border: none;
        color: var(--text-muted);
        font-size: var(--fs-xs);
        font-weight: 600;
        cursor: pointer;
        padding: 0.5rem 0.75rem;
        min-width: 44px;
        min-height: 44px;
        border-radius: var(--r-sm);
      }
      .pl-show-pass:hover {
        background: var(--neutral-100);
        color: var(--text-main);
      }
      .pl-show-pass:focus-visible {
        outline: 2px solid var(--brand-500);
        outline-offset: 2px;
      }

      .pl-error { width: 100%; }
      .pl-error-wrap:empty { display: none; }

      /* Error inline por campo */
      .pl-field-err {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        color: var(--bad-fg);
        font-size: var(--fs-xs);
        font-weight: 600;
        line-height: 1.3;
      }
      .pl-field-err i { font-size: var(--fs-xs); }

      /* Borde rojo en el input inválido (refuerza el mensaje inline) */
      .pl-field :deep(input.p-inputtext.pl-input-invalid),
      .pl-field :deep(input.p-inputtext.pl-input-invalid:hover) {
        border-color: var(--bad-fg);
      }
      .pl-field :deep(input.p-inputtext.pl-input-invalid:focus) {
        border-color: var(--bad-fg);
        box-shadow: 0 0 0 3px var(--bad-soft-bg);
      }

      /* El submit usa el átomo .portal-btn-primary (sunset). Acá solo el margen. */
      .pl-submit { margin-top: 0.5rem; }

      /* Toggle "otra empresa" — campo Empresa colapsado por default. */
      .pl-tenant-toggle {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        background: transparent;
        border: none;
        color: var(--text-muted);
        font-size: var(--fs-sm);
        font-weight: 600;
        cursor: pointer;
        padding: 0.5rem 0;
        min-height: 44px;
      }
      .pl-tenant-toggle:hover { color: var(--text-main); }
      .pl-tenant-toggle i { font-size: var(--fs-sm); }
      .pl-tenant-toggle:focus-visible {
        outline: 2px solid var(--action);
        outline-offset: 2px;
        border-radius: 6px;
      }

      .pl-foot {
        margin: 1.25rem 0 0;
        text-align: center;
        font-size: var(--fs-sm);
        color: var(--text-muted);
      }
      .pl-foot a {
        color: var(--text-main);
        font-weight: 600;
        text-decoration: underline;
        text-decoration-color: var(--brand-500);
        text-underline-offset: 3px;
      }
      .pl-foot a:hover { text-decoration: underline; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalLoginComponent implements AfterViewInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly zone = inject(NgZone);
  private split?: { revert: () => void };

  ngOnDestroy(): void {
    this.split?.revert?.();
  }

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPass = signal(false);
  /** Campo "Empresa" colapsado por default (beta single-tenant, prefilled mega_dulces). */
  readonly showTenant = signal(false);
  /** Tras el primer intento, mostramos los errores por campo aunque no estén "touched". */
  readonly submitted = signal(false);

  form = this.fb.group({
    tenant_slug: ['mega_dulces', Validators.required],
    username: ['', Validators.required],
    password: ['', [Validators.required, Validators.minLength(4)]],
  });

  /** Mensaje por campo según el primer error de validación. */
  private readonly fieldMessages: Record<string, Record<string, string>> = {
    tenant_slug: { required: 'Ingresa el identificador de tu empresa.' },
    username: { required: 'Ingresa tu usuario.' },
    password: {
      required: 'Ingresa tu contraseña.',
      minlength: 'La contraseña debe tener al menos 4 caracteres.',
    },
  };

  ngAfterViewInit(): void {
    const host = this.host.nativeElement;
    // Auto-focus SOLO en desktop (puntero fino): en móvil dejamos ver el momento
    // de marca antes de abrir el teclado. queueMicrotask evita ExpressionChanged.
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches) {
      queueMicrotask(() => (host.querySelector('#user') as HTMLInputElement | null)?.focus());
    }
    // Entrada escalonada GSAP (lazy, fuera de zona). Apagada en reduced-motion.
    if (typeof window !== 'undefined' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.animateIn(host);
    }
  }

  /**
   * Entrada coreografiada (lazy, fuera de zona): tras el aterrizaje del producto
   * del stage, el logo entra, el titular se arma carácter por carácter
   * (SplitText), el subrayado se dibuja (DrawSVG) y los campos suben escalonados.
   * Estado inicial oculto vía gsap.set SOLO tras importar GSAP ok → si falla, todo
   * queda visible (sin regresión). Apagado bajo prefers-reduced-motion.
   */
  private async animateIn(host: HTMLElement): Promise<void> {
    let gsap: any;
    let SplitText: any = null;
    let DrawSVG: any = null;
    try {
      const mod: any = await import('gsap');
      gsap = mod.gsap || mod.default;
      try {
        SplitText = (await import('gsap/SplitText')).SplitText;
        DrawSVG = (await import('gsap/DrawSVGPlugin')).DrawSVGPlugin;
        gsap.registerPlugin(SplitText, DrawSVG);
      } catch {
        /* plugins opcionales */
      }
    } catch {
      return; // sin GSAP → estático (sin regresión)
    }

    this.zone.runOutsideAngular(() => {
      const display = host.querySelector('.pl-display') as HTMLElement | null;
      const onMobile = !!display && display.offsetParent !== null;
      const logo = host.querySelector('.pl-form-logo');
      const sub = host.querySelector('.pl-form-sub');
      const formKids = Array.from(host.querySelectorAll('.pl-form > *'));
      const headDesktop = Array.from(host.querySelectorAll('.pl-form-eyebrow, .pl-form-title'));
      const underPath = host.querySelector('.pl-underline path');

      let chars: any = null;
      if (SplitText && onMobile && display) {
        try {
          this.split = new SplitText(display, { type: 'chars' });
          chars = (this.split as any).chars;
        } catch {
          /* sin split → animamos el titular entero */
        }
      }

      // Todos los targets que vamos a ocultar — para recuperarlos si algo lanza.
      const hidden = [logo, sub, ...formKids, display, ...headDesktop].filter(Boolean);
      try {
        // Ocultar para evitar flash (solo con GSAP cargado).
        gsap.set([logo, sub, ...formKids].filter(Boolean), { opacity: 0, y: 16 });
        if (chars) gsap.set(chars, { opacity: 0, y: 26, rotateX: -50, transformOrigin: '0 100%' });
        else gsap.set([...(display ? [display] : []), ...headDesktop].filter(Boolean), { opacity: 0, y: 16 });
        if (underPath && DrawSVG) gsap.set(underPath, { drawSVG: '0%' });

        // revert del SplitText al terminar → restaura el DOM del titular.
        const tl = gsap.timeline({ delay: 0.3, onComplete: () => this.split?.revert?.() });
        tl.to(logo, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' });
        if (chars) {
          tl.to(chars, { opacity: 1, y: 0, rotateX: 0, stagger: 0.02, duration: 0.5, ease: 'back.out(1.5)' }, '-=0.15');
          if (underPath && DrawSVG) tl.to(underPath, { drawSVG: '100%', duration: 0.6, ease: 'power2.out' }, '-=0.15');
        } else {
          tl.to([...(display ? [display] : []), ...headDesktop].filter(Boolean), { opacity: 1, y: 0, duration: 0.45, stagger: 0.06, ease: 'power3.out' }, '-=0.1');
        }
        tl.to(sub, { opacity: 1, y: 0, duration: 0.4 }, '-=0.25');
        tl.to(formKids, { opacity: 1, y: 0, duration: 0.45, stagger: 0.05, ease: 'power3.out', clearProps: 'transform,opacity' }, '-=0.2');
      } catch {
        // Si algo falla tras ocultar, garantizar que el form quede visible.
        try { this.split?.revert?.(); } catch { /* noop */ }
        gsap.set(hidden, { clearProps: 'opacity,transform' });
      }
    });
  }

  togglePass(): void {
    this.showPass.update((v) => !v);
  }

  /** ¿El campo debe mostrarse como inválido? (touched o ya hubo submit). */
  isInvalid(name: 'tenant_slug' | 'username' | 'password'): boolean {
    const c = this.form.controls[name];
    return !!c && c.invalid && (c.touched || this.submitted());
  }

  /** Mensaje de error del campo, o null si es válido / aún no procede mostrarlo. */
  fieldError(name: 'tenant_slug' | 'username' | 'password'): string | null {
    const c = this.form.controls[name];
    if (!c || c.valid || (!c.touched && !this.submitted())) return null;
    const key = Object.keys(c.errors ?? {})[0];
    return key ? this.fieldMessages[name]?.[key] ?? 'Revisa este campo.' : null;
  }

  /** Traduce el error HTTP a un mensaje claro y accionable para el cliente. */
  private messageForError(err: { status?: number }): string {
    const status = err?.status ?? 0;
    if (status === 0) return 'Sin conexión. Revisa tu internet e intenta de nuevo.';
    if (status === 401)
      // El backend devuelve un genérico a propósito (anti-enumeración): no revela
      // si falló el usuario o la contraseña. Damos pistas accionables sin filtrar.
      return 'Usuario o contraseña incorrectos. Revisa mayúsculas y que sea la empresa correcta.';
    if (status === 403) return 'Tu cuenta no tiene acceso al portal. Contacta a soporte.';
    if (status === 429) return 'Demasiados intentos. Espera un momento y vuelve a intentar.';
    if (status >= 500) return 'Tuvimos un problema en el servidor. Intenta de nuevo en un momento.';
    return 'No pudimos iniciar sesión. Intenta de nuevo.';
  }

  /** Lleva el foco al primer campo inválido (orden visual). */
  private focusFirstInvalid(): void {
    const order: Array<['tenant_slug' | 'username' | 'password', string]> = [
      ['tenant_slug', 'tenant'],
      ['username', 'user'],
      ['password', 'pass'],
    ];
    for (const [ctrl, id] of order) {
      if (ctrl === 'tenant_slug' && !this.showTenant()) continue;
      if (this.form.controls[ctrl].invalid) {
        (this.host.nativeElement.querySelector('#' + id) as HTMLInputElement | null)?.focus();
        return;
      }
    }
  }

  /**
   * Sincroniza el form con los valores REALES de los inputs. Los gestores de
   * contraseñas / autofill de móvil suelen rellenar el DOM sin disparar el
   * evento que actualiza el form reactivo → sin esto, el form queda "invalid"
   * y el login parece no responder.
   */
  private syncAutofill(): void {
    const host = this.host.nativeElement;
    const grab = (id: string, ctrl: 'username' | 'password' | 'tenant_slug') => {
      const el = host.querySelector('#' + id) as HTMLInputElement | null;
      if (el && el.value && this.form.controls[ctrl].value !== el.value) {
        this.form.controls[ctrl].setValue(el.value);
      }
    };
    grab('user', 'username');
    grab('pass', 'password');
    grab('tenant', 'tenant_slug');
  }

  submit(): void {
    this.submitted.set(true);
    this.syncAutofill();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      // Mensaje resumen arriba; el detalle por campo lo dan los <small> inline.
      const missing = (['tenant_slug', 'username', 'password'] as const).filter(
        (n) => (n !== 'tenant_slug' || this.showTenant()) && this.form.controls[n].invalid,
      );
      this.error.set(
        missing.length === 1
          ? this.fieldError(missing[0])
          : 'Faltan datos. Revisa los campos marcados.',
      );
      this.focusFirstInvalid();
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    const v = this.form.value;
    this.auth
      .loginMt({
        tenant_slug: v.tenant_slug!,
        username: v.username!,
        password: v.password!,
      })
      .subscribe({
        next: (r) => {
          this.loading.set(false);
          if (r.user?.role_name !== 'customer_b2b') {
            this.error.set('Este portal es solo para clientes B2B. Tu cuenta no tiene ese rol.');
            this.auth.logout();
            return;
          }
          this.router.navigateByUrl('/portal/home');
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(this.messageForError(err));
        },
      });
  }
}
