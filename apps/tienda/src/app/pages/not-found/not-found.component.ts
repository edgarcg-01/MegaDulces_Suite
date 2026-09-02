import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <div class="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-24 text-center">
      <h1 class="font-display text-2xl font-bold text-content-main">Página no encontrada</h1>
      <a routerLink="/" class="rounded-full bg-action px-5 py-2 text-sm font-semibold text-white">
        Ir al catálogo
      </a>
    </div>
  `,
})
export class NotFoundComponent {}
