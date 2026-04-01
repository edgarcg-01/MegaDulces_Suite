import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private _isMonochrome = signal<boolean>(false);
  readonly isMonochrome = this._isMonochrome.asReadonly();

  toggleMonochrome() {
    this._isMonochrome.update(v => !v);
    
    // Optional: Add/remove a global class to the body for global styles
    if (this._isMonochrome()) {
      document.body.classList.add('theme-monochrome');
    } else {
      document.body.classList.remove('theme-monochrome');
    }
  }
}
