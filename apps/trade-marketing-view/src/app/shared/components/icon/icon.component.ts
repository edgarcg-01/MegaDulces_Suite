import { Component, input, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `
    <span [innerHTML]="sanitizedIcon()"></span>
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    :host svg {
      width: 1em;
      height: 1em;
      fill: currentColor;
    }
  `]
})
export class IconComponent {
  name = input.required<string>();
  size = input<'sm' | 'md' | 'lg' | 'xl'>('md');
  private readonly domSanitizer = inject(DomSanitizer);

  // Icon SVG paths from BasicIcons
  private icons: Record<string, string> = {
    // Navigation & Actions
    'chevron-down': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'chevron-up': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 15L12 9L18 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'chevron-left': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'chevron-right': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 18L15 12L9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'plus': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'minus': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'close': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'trash': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6H21M19 6V20C19 21.1046 18.1046 22 17 22H7C5.89543 22 5 21.1046 5 20V6M8 6V4C8 2.89543 8.89543 2 10 2H14C15.1046 2 16 2.89543 16 4V6M10 11V17M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Status & Feedback
    'check-circle': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'times-circle': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 9L9 15M9 9L15 15M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'exclamation-triangle': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 9V13M12 17H12.01M5.07183 19H18.9282C19.5283 19 19.8951 18.3226 19.5989 17.8021L12.6707 5.76716C12.3776 5.25168 11.6224 5.25168 11.3293 5.76716L4.40114 17.8021C4.10493 18.3226 4.47172 19 5.07183 19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Time & Date
    'clock': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7V12L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'refresh': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4V9H4.58152M19.9282 15C19.681 17.3611 17.9416 19.3131 15.6784 19.8826C13.4151 20.4522 11.0311 19.5641 9.54285 17.8465C8.0546 16.129 7.6631 13.6497 8.51703 11.5416C9.37096 9.4335 11.3418 7.92858 13.581 7.65479C15.8202 7.381 18.0983 8.39593 19.4282 10.2361M20 9V14H19.4185" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Files & Documents
    'file-edit': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 4H4C2.89543 4 2 4.89543 2 6V18C2 19.1046 2.89543 20 4 20H16C17.1046 20 18 19.1046 18 18V11M11 4H16L18 6V11M11 4V9H16M15 13L9 19M9 13L15 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Location & Maps
    'map-marker': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 10C21 15.5228 16.9706 20 12 20C7.02944 20 3 15.5228 3 10C3 5.02944 7.02944 1 12 1C16.9706 1 21 5.02944 21 10Z" stroke="currentColor" stroke-width="2"/><path d="M12 6V10L15 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Logistics & Business
    'truck': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 17H5C3.89543 17 3 16.1046 3 15V5C3 3.89543 3.89543 3 5 3H15C16.1046 3 17 3.89543 17 5V9M10 17V9M10 17H14M17 9H20C21.1046 9 22 9.89543 22 11V15C22 16.1046 21.1046 17 20 17H19M17 9V15C17 16.1046 16.1046 17 15 17H14M7 17C7 18.6569 5.65685 20 4 20C2.34315 20 1 18.6569 1 17C1 15.3431 2.34315 14 4 14C5.65685 14 7 15.3431 7 17ZM19 17C19 18.6569 17.6569 20 16 20C14.3431 20 13 18.6569 13 17C13 15.3431 14.3431 14 16 14C17.6569 14 19 15.3431 19 17Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'box': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 16V8C20.9996 7.64928 20.9071 7.30481 20.7315 7.00016C20.556 6.69551 20.302 6.43978 20 6.262L13 2.262C12.705 2.08982 12.3694 1.99918 12.0275 1.99918C11.6856 1.99918 11.35 2.08982 11.055 2.262L4 6.262C3.698 6.43978 3.444 6.69551 3.2685 7.00016C3.09294 7.30481 3.0004 7.64928 3 8V16C3.0004 16.3507 3.09294 16.6952 3.2685 16.9998C3.444 17.3045 3.698 17.5602 4 17.738L11 21.738C11.295 21.9102 11.6306 22.0008 11.9725 22.0008C12.3144 22.0008 12.65 21.9102 12.945 21.738L20 17.738C20.302 17.5602 20.556 17.3045 20.7315 16.9998C20.9071 16.6952 20.9996 16.3507 21 16ZM12 12V22M12 12L4 6.262M12 12L20 6.262M4 6.262V16L12 21.738M20 6.262V16L12 21.738" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'users': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17 21V19C17 17.9391 16.5786 16.9217 15.8284 16.1716C15.0783 15.4214 14.0609 15 13 15H5C3.93913 15 2.92172 15.4214 2.17157 16.1716C1.42143 16.9217 1 17.9391 1 19V21M13 7C13 9.20914 11.2091 11 9 11C6.79086 11 5 9.20914 5 7C5 4.79086 6.79086 3 9 3C11.2091 3 13 4.79086 13 7ZM23 21V19C22.9993 18.1137 22.7044 17.2528 22.1614 16.5523C21.6184 15.8519 20.8581 15.3516 20 15.13M16 7C16.0003 5.88032 15.631 4.79513 14.9491 3.92239C14.2672 3.04964 13.3107 2.43679 12.24 2.18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Data & Storage
    'database': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" stroke-width="2"/><path d="M21 12C21 13.6569 16.9706 15 12 15C7.02944 15 3 13.6569 3 12" stroke="currentColor" stroke-width="2"/><path d="M3 5V19C3 20.6569 7.02944 22 12 22C16.9706 22 21 20.6569 21 19V5" stroke="currentColor" stroke-width="2"/><path d="M21 12C21 13.6569 16.9706 15 12 15C7.02944 15 3 13.6569 3 12V5" stroke="currentColor" stroke-width="2"/></svg>`,
    'shopping-bag': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2L3 6V20C3 20.5304 3.21071 21.0391 3.58579 21.4142C3.96086 21.7893 4.46957 22 5 22H19C19.5304 22 20.0391 21.7893 20.4142 21.4142C20.7893 21.0391 21 20.5304 21 20V6L18 2H6ZM3 6H21M16 10C16 11.0609 15.5786 12.0783 14.8284 12.8284C14.0783 13.5786 13.0609 14 12 14C10.9391 14 9.92172 13.5786 9.17157 12.8284C8.42143 12.0783 8 11.0609 8 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Loading
    'spinner': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2V4M12 20V22M4.929 4.929L6.343 6.343M17.657 17.657L19.071 19.071M2 12H4M20 12H22M4.929 19.071L6.343 17.657M17.657 6.343L19.071 4.929" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    
    // Additional icons
    'replay': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4V9H4.58152M19.9282 15C19.681 17.3611 17.9416 19.3131 15.6784 19.8826C13.4151 20.4522 11.0311 19.5641 9.54285 17.8465C8.0546 16.129 7.6631 13.6497 8.51703 11.5416C9.37096 9.4335 11.3418 7.92858 13.581 7.65479C15.8202 7.381 18.0983 8.39593 19.4282 10.2361M20 9V14H19.4185" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'building': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 21H21M9 6.00001H15M9 10H15M9 14H15M19 22V4C19 2.89543 18.1046 2 17 2H7.00001C5.89544 2 5.00001 2.89543 5.00001 4V22H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'info-circle': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 16V12M12 8H12.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'calculator': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 6H16M8 10H16M8 14H10M14 14H16M8 18H10M14 18H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'exclamation-circle': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8V13M12 16H12.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'check': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'wifi': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.55C7.43 10.12 10.57 8.68 14 8.68C17.43 8.68 20.57 10.12 23 12.55M12 20C12.5523 20 13 19.5523 13 19C13 18.4477 12.5523 18 12 18C11.4477 18 11 18.4477 11 19C11 19.5523 11.4477 20 12 20ZM8.5 16.5C10.15 14.85 12.95 14.85 14.5 16.5M1.5 9C5.5 5 9.5 3 14 3C18.5 3 22.5 5 26.5 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    'wifi-off': `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L23 23M5 12.55C7.43 10.12 10.57 8.68 14 8.68C17.43 8.68 20.57 10.12 23 12.55M12 20C12.5523 20 13 19.5523 13 19C13 18.4477 12.5523 18 12 18C11.4477 18 11 18.4477 11 19C11 19.5523 11.4477 20 12 20ZM8.5 16.5C10.15 14.85 12.95 14.85 14.5 16.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  sanitizedIcon(): SafeHtml {
    const iconSvg = this.icons[this.name()];
    return this.domSanitizer.bypassSecurityTrustHtml(iconSvg || '');
  }

  getSizeClass(): string {
    const sizeClasses = {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
      xl: 'text-lg'
    };
    return sizeClasses[this.size()];
  }
}
