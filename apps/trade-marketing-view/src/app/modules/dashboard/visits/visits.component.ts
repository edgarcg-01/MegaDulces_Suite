import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';

@Component({ selector: 'app-visits', standalone: true, imports: [CommonModule, TableModule, ButtonModule, TagModule], templateUrl: './visits.component.html', styleUrls: ['./visits.component.css'] })
export class VisitsComponent { visits: any[] = []; }
