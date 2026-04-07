'use strict';

/**
 * TampermonkeyMock
 *
 * Installs and tracks Tampermonkey GM_* global functions so userscripts can be
 * loaded and executed in Jest / jsdom without modification.
 *
 * Usage in tests:
 *   const tm = new TampermonkeyMock();
 *   tm.install();
 *   // ...load and run your script...
 *   expect(tm.downloads[0].filename).toBe('route.gpx');
 *   tm.uninstall();
 */
class TampermonkeyMock {
  constructor() {
    this.reset();
    this._originals = {};
  }

  // ── state ────────────────────────────────────────────────────────────────

  reset() {
    this.downloads = [];
    this.notifications = [];
    this.xmlHttpRequests = [];
    this.storage = {};
    this.clipboardText = null;
  }

  // ── GM_* implementations ─────────────────────────────────────────────────

  GM_download(urlOrDetails, filename) {
    if (typeof urlOrDetails === 'object') {
      this.downloads.push({ ...urlOrDetails });
    } else {
      this.downloads.push({ url: urlOrDetails, filename });
    }
  }

  GM_notification(details, ondone) {
    this.notifications.push({ ...details, ondone });
  }

  GM_getValue(key, defaultValue) {
    return Object.prototype.hasOwnProperty.call(this.storage, key)
      ? this.storage[key]
      : defaultValue;
  }

  GM_setValue(key, value) {
    this.storage[key] = value;
  }

  GM_deleteValue(key) {
    delete this.storage[key];
  }

  GM_listValues() {
    return Object.keys(this.storage);
  }

  GM_setClipboard(text) {
    this.clipboardText = text;
  }

  GM_xmlhttpRequest(details) {
    this.xmlHttpRequests.push({ ...details });
    // Return a fake abort handle.
    return { abort() {} };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Install all GM_* mocks as global (window) properties, saving any
   * pre-existing values so they can be restored by uninstall().
   */
  install() {
    const apis = [
      'GM_download',
      'GM_notification',
      'GM_getValue',
      'GM_setValue',
      'GM_deleteValue',
      'GM_listValues',
      'GM_setClipboard',
      'GM_xmlhttpRequest',
    ];

    for (const name of apis) {
      this._originals[name] = global[name];
      global[name] = (...args) => this[name](...args);
    }
  }

  /** Restore the global namespace to its pre-install state. */
  uninstall() {
    for (const [name, original] of Object.entries(this._originals)) {
      if (original === undefined) {
        delete global[name];
      } else {
        global[name] = original;
      }
    }
    this._originals = {};
  }
}

module.exports = TampermonkeyMock;
