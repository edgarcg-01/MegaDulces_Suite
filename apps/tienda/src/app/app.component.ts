import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { StickyCartBarComponent } from './shared/sticky-cart-bar.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, StickyCartBarComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {}
