import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private authService = inject(AuthService);
  private router = inject(Router);

  loginForm = this.fb.group({
    username: ['', [Validators.required]],
    password: ['', [Validators.required, Validators.minLength(6)]]
  });

  errorMessage: string | null = null;
  isLoading = false;

  onSubmit() {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    this.isLoading = true;
    this.errorMessage = null;

    const credentials = {
      username: this.loginForm.value.username!,
      password: this.loginForm.value.password!
    };

    // Usando HttpClient subscripción estándar
    this.authService.login(credentials).subscribe({
      next: () => {
        this.isLoading = false;
        // Redirigir al selector de proyectos
        this.router.navigate(['/projects']);
      },
      error: (err) => {
        this.isLoading = false;
        if (err.status === 401) {
          this.errorMessage = 'Credenciales no válidas, verifique su usuario o contraseña.';
        } else {
          this.errorMessage = 'Ocurrió un error inesperado al contactar al servidor.';
        }
      }
    });
  }
}
