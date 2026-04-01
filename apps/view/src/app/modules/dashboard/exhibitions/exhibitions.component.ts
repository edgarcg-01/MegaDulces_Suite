import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';

@Component({ selector: 'app-exhibitions', standalone: true, imports: [CommonModule, TableModule, ButtonModule, TagModule], templateUrl: './exhibitions.component.html', styleUrls: ['./exhibitions.component.css'] })
export class ExhibitionsComponent { exhibitions: any[] = []; }
