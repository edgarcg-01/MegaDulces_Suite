import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';
import { HapticService } from '../../../core/services/haptic.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
})
export class LoginComponent implements OnInit {
  private fb = inject(FormBuilder);
  private authService = inject(AuthService);
  private router = inject(Router);
  public themeService = inject(ThemeService);
  private haptic = inject(HapticService);

  loginForm = this.fb.group({
    username: ['', [Validators.required]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  errorMessage: string | null = null;
  isLoading = false;

  ngOnInit() {
    // Theme is managed globally by ThemeService
  }

  toggleTheme() {
    this.haptic.selection();
    this.themeService.toggleMonochrome();
  }

  // Los usuarios del sistema son siempre minúsculas. Coercionamos el valor real
  // del control (no solo visual) para que un usuario que escriba mayúsculas no
  // falle el login por un mismatch invisible.
  onUsernameInput() {
    const ctrl = this.loginForm.get('username');
    const v = ctrl?.value ?? '';
    const lower = v.toLowerCase();
    if (v !== lower) ctrl?.setValue(lower);
  }

  onSubmit() {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isLoading = true;
    this.errorMessage = null;

    // Multi-tenant login (auth-mt). En beta Mega Dulces es el único tenant, así
    // que tenant_slug está hardcoded. El JWT resultante incluye tenant_id, sin
    // el cual todos los endpoints /commercial/* fallan con 500 porque el
    // TenantContextInterceptor del backend no puede resolver el contexto.
    this.authService
      .loginMt({
        tenant_slug: 'mega_dulces',
        username: this.loginForm.value.username!.trim().toLowerCase(),
        password: this.loginForm.value.password!,
      })
      .subscribe({
        next: () => {
          this.isLoading = false;
          this.haptic.notification('success');
          // /projects decide entre selector, auto-redirect (si N=1) o fallback.
          this.router.navigate(['/projects']);
        },
        error: (err) => {
          this.isLoading = false;
          this.haptic.notification('error');
          if (err.status === 401) {
            this.errorMessage =
              'Credenciales incorrectas. Verifica tu usuario y contraseña.';
          } else {
            this.errorMessage = 'Error de conexión. Inténtalo de nuevo.';
          }
        },
      });
  }
}
