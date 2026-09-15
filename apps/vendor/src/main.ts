import { bootstrapApplication } from '@angular/platform-browser';
import { installNumberWheelGuard } from '@megadulces/ui-web';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// DESIGN.md D.5: la rueda del mouse NO cambia el valor de un input numérico. Un solo listener
// cubre toda la app, incluida la pantalla que se escriba mañana.
installNumberWheelGuard(document);

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
