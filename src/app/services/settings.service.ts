import { Injectable, computed, signal } from '@angular/core';

const PREREQS_ENABLED_KEY = 'osrs-prereqs-enabled';
const SPLICE_ON_DROP_KEY = 'osrs-splice-on-drop';
const THEME_KEY = 'osrs-theme';
const SMART_LAYOUT_KEY = 'osrs-smart-layout';
const SMART_LAYOUT_ON_KEY = 'osrs-smart-layout-on';

/** 'default' is the app's own look; 'in-game' dresses the canvas and sidebar in OSRS interface
 *  art (panel and slot images, RuneScape pixel fonts). */
export type Theme = 'default' | 'in-game';

export type SmartLayoutFeature = 'autoOrganise' | 'spacing' | 'reorder' | 'resize' | 'detect';
export type SmartLayoutSettings = Record<SmartLayoutFeature, boolean>;

/** Saved settings over all-on defaults (a missing or unreadable entry counts as on). */
function loadSmartLayout(): SmartLayoutSettings {
  const all: SmartLayoutSettings = { autoOrganise: true, spacing: true, reorder: true, resize: true, detect: true };
  try {
    const saved = JSON.parse(localStorage.getItem(SMART_LAYOUT_KEY) ?? '{}');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(all) as SmartLayoutFeature[]) if (typeof saved[k] === 'boolean') all[k] = saved[k];
    }
  } catch { /* keep defaults */ }
  return all;
}

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

  /** Smart layout features, each switched on/off on its own (all on by default):
   *  - autoOrganise: the "Auto organise" right-click option
   *  - spacing: drag the bars between organised items to re-space them
   *  - reorder: drag an organised item's circle to move it to another slot
   *  - resize: drag the organised outline's edges/handles to change items per row
   *  - detect: selecting nodes that are already evenly arranged brings the handles back */
  readonly smartLayout = signal<SmartLayoutSettings>(loadSmartLayout());

  setSmartLayout(feature: SmartLayoutFeature, enabled: boolean): void {
    this.smartLayout.update(s => ({ ...s, [feature]: enabled }));
    localStorage.setItem(SMART_LAYOUT_KEY, JSON.stringify(this.smartLayout()));
  }

  /** Master switch for smart layout: off disables every feature, whatever its own switch says
   *  (their own settings are kept for when it's back on). */
  readonly smartLayoutOn = signal<boolean>(localStorage.getItem(SMART_LAYOUT_ON_KEY) !== 'false');

  setSmartLayoutOn(on: boolean): void {
    this.smartLayoutOn.set(on);
    localStorage.setItem(SMART_LAYOUT_ON_KEY, String(on));
  }

  /** Which smart-layout features are actually in effect: each one's own switch, under the master. */
  readonly smartLayoutActive = computed<SmartLayoutSettings>(() => {
    const s = this.smartLayout();
    if (this.smartLayoutOn()) return s;
    return { autoOrganise: false, spacing: false, reorder: false, resize: false, detect: false };
  });

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
