import { Directive, ElementRef, AfterViewInit, inject } from '@angular/core';

/**
 * Focuses and selects the host input as soon as it's rendered. Native `autofocus` only fires
 * once per document navigation, so it silently stops working the second time an element with
 * it is inserted (e.g. re-opening an inline rename input) — this re-fires every time.
 */
@Directive({
  selector: '[appAutofocusSelect]',
  standalone: true,
})
export class AutofocusSelectDirective implements AfterViewInit {
  private readonly el = inject(ElementRef<HTMLInputElement>);

  ngAfterViewInit(): void {
    const input = this.el.nativeElement;
    input.focus();
    input.select();
  }
}
