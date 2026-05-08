import { Directive, Input, TemplateRef, ViewContainerRef, OnInit, effect } from '@angular/core';
import { PermissionsService } from '../../core/services/permissions.service';
import type { Action, AppSubject } from '../../core/services/permissions.service';

@Directive({
  selector: '[canDo]',
  standalone: true,
})
export class CanDoDirective implements OnInit {
  @Input() canDo!: Action;
  @Input() canDoOn!: AppSubject;

  constructor(
    private tpl: TemplateRef<any>,
    private vcr: ViewContainerRef,
    private perms: PermissionsService,
  ) {}

  ngOnInit() {
    effect(() => {
      this.vcr.clear();
      if (this.perms.can(this.canDo, this.canDoOn)) {
        this.vcr.createEmbeddedView(this.tpl);
      }
    });
  }
}
