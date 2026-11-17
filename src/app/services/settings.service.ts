import { Injectable, signal } from '@angular/core';

const PREREQS_ENABLED_KEY = 'osrs-prereqs-enabled';
const SPLICE_ON_DROP_KEY = 'osrs-splice-on-drop';
const THEME_KEY = 'osrs-theme';

/** 'default' is the app's own look; 'in-game' dresses the canvas and sidebar in OSRS interface
 *  art (panel and slot images, RuneScape pixel fonts). */
export type Theme = 'default' | 'in-game';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  /** When disabled, connections stop gating: no lock badge, no dimming, no dashed-until-done
   *  edges, and "Mark Complete" is never blocked. The connections themselves aren't touched —
   *  turning this back on just resumes reading them as prereqs. */
  readonly prereqsEnabled = signal<boolean>(
    localStorage.getItem(PREREQS_ENABLED_KEY) !== 'false'
  );

  setPrereqsEnabled(enabled: boolean): void {
    this.prereqsEnabled.set(enabled);
    localStorage.setItem(PREREQS_ENABLED_KEY, String(enabled));
  }

  /** When enabled, holding a dragged node/group on a connection and then dropping inserts it
   *  between that connection's ends (A → B becomes A → dragged → B). */
  readonly spliceOnDropEnabled = signal<boolean>(
    localStorage.getItem(SPLICE_ON_DROP_KEY) !== 'false'
  );

  setSpliceOnDropEnabled(enabled: boolean): void {
    this.spliceOnDropEnabled.set(enabled);
    localStorage.setItem(SPLICE_ON_DROP_KEY, String(enabled));
  }

  readonly theme = signal<Theme>(localStorage.getItem(THEME_KEY) === 'in-game' ? 'in-game' : 'default');

  constructor() {
    this.applyTheme();
  }

  setTheme(theme: Theme): void {
    this.theme.set(theme);
    localStorage.setItem(THEME_KEY, theme);
    this.applyTheme();
  }

  /** Themes are styled with a class on <html> (components match it with :host-context). */
  private applyTheme(): void {
    document.documentElement.classList.toggle('theme-in-game', this.theme() === 'in-game');
  }
}
