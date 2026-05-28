import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { CardModule } from 'primeng/card';
import { MessageModule } from 'primeng/message';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-portal-login',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    ButtonModule,
    InputTextModule,
    CardModule,
    MessageModule,
  ],
  template: `
    <div class="login-wrap">
      <p-card styleClass="login-card">
        <ng-template pTemplate="header">
          <div class="login-header">
            <i class="pi pi-shopping-cart"></i>
            <h2>Portal B2B</h2>
            <p>Mega Dulces — Acceso clientes</p>
          </div>
        </ng-template>
        <form [formGroup]="form" (ngSubmit)="submit()" class="login-form">
          <div class="form-field">
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
          <div class="form-field">
            <label for="user">Usuario</label>
            <input
              pInputText
              id="user"
              formControlName="username"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              inputmode="text"
              enterkeyhint="next"
            />
          </div>
          <div class="form-field">
            <label for="pass">Contraseña</label>
            <input
              pInputText
              id="pass"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              enterkeyhint="go"
            />
          </div>
          <p-message
            *ngIf="error()"
            severity="error"
            [text]="error()!"
            styleClass="login-error"
          ></p-message>
          <button
            pButton
            type="submit"
            [label]="loading() ? 'Ingresando…' : 'Ingresar'"
            icon="pi pi-sign-in"
            [disabled]="loading() || form.invalid"
            class="login-submit"
          ></button>
        </form>
      </p-card>
    </div>
  `,
  styles: [
    `
      .login-wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, #f0f4ff 0%, #fef3f2 100%);
        padding: 1rem;
      }
      .login-card {
        width: 100%;
        max-width: 380px;
      }
      .login-header {
        text-align: center;
        padding: 1.5rem 1rem 0;
      }
      .login-header i {
        font-size: 2.5rem;
        color: var(--primary-color, #2563eb);
      }
      .login-header h2 {
        margin: 0.5rem 0 0.25rem;
        font-size: 1.5rem;
      }
      .login-header p {
        margin: 0;
        color: var(--text-color-secondary);
        font-size: 0.875rem;
      }
      .login-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .form-field {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .form-field label {
        font-size: 0.875rem;
        color: var(--text-color-secondary);
      }
      .login-error {
        width: 100%;
      }
      .login-submit {
        margin-top: 0.5rem;
      }
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

  form = this.fb.group({
    tenant_slug: ['mega_dulces', Validators.required],
    username: ['', Validators.required],
    password: ['', [Validators.required, Validators.minLength(4)]],
  });

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
          this.router.navigateByUrl('/portal/catalog');
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
