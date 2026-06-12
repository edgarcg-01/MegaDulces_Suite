import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-portal-login',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    InputTextModule,
    MessageModule,
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
        <header class="pl-form-head">
          <img
            src="/assets/logos/mega-dulces-logo-240.webp"
            alt="Mega Dulces"
            class="pl-form-logo"
          />
          <span class="pl-form-eyebrow">Portal B2B</span>
          <h2 class="pl-form-title">Bienvenido de vuelta</h2>
          <p class="pl-form-sub">Ingresa con tu cuenta de cliente para hacer tu pedido.</p>
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
            />
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
            />
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
            />
          </div>

          <p-message
            *ngIf="error()"
            severity="error"
            [text]="error()!"
            styleClass="pl-error"
          ></p-message>

          <button
            type="submit"
            class="portal-btn-primary portal-btn-block portal-btn-primary-lg pl-submit"
            [disabled]="loading() || form.invalid"
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

      /* ── FORM SIDE ──────────────────────────────────────────────── */
      .pl-form-side {
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: clamp(1.5rem, 5vw, 3rem)
          max(1.25rem, env(safe-area-inset-right))
          calc(clamp(1.5rem, 5vw, 3rem) + env(safe-area-inset-bottom))
          max(1.25rem, env(safe-area-inset-left));
        background: var(--card-bg);
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
      .pl-form-eyebrow {
        display: inline-block;
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
        font-family: var(--font-display);
        font-optical-sizing: auto;
        font-size: var(--fs-h1);
        font-weight: 700;
        line-height: 1.12;
        margin: 0 0 0.375rem 0;
        letter-spacing: -0.01em;
        color: var(--text-main);
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
        padding: 0.75rem 0.875rem;
        font-size: var(--fs-body);
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
export class PortalLoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPass = signal(false);
  /** Campo "Empresa" colapsado por default (beta single-tenant, prefilled mega_dulces). */
  readonly showTenant = signal(false);

  form = this.fb.group({
    tenant_slug: ['mega_dulces', Validators.required],
    username: ['', Validators.required],
    password: ['', [Validators.required, Validators.minLength(4)]],
  });

  togglePass(): void {
    this.showPass.update((v) => !v);
  }

  submit(): void {
    if (this.form.invalid) return;
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
          this.error.set(
            err.status === 401
              ? 'Credenciales inválidas. Verifica empresa, usuario y contraseña.'
              : 'Error de conexión.',
          );
        },
      });
  }
}
