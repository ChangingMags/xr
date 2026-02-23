'use strict';

const fetch = require('node-fetch'); // v2 CommonJS
const tough = require('tough-cookie');
const fetchCookie = require('fetch-cookie');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class XRApi {
  constructor({ log, host, username, pin }) {
    this.log = log;
    this.host = host;
    this.username = username;
    this.pin = pin;

    this.jar = new tough.CookieJar();
    this.fetch = fetchCookie(fetch, this.jar);

    this.sess = null;
    this.loggingIn = null; // prevent parallel logins
  }

  baseUrl(path) {
    if (!this.host) {
      throw new Error('XRApi: host is undefined. Check your config.json "host" value and that the plugin is loading.');
    }
    return `http://${this.host}${path}`;
  }

  looksLikeLoginHtml(text) {
    if (!text) return false;
    const t = String(text).toLowerCase();
    return (
      t.includes('xgen :: secure network') ||
      t.includes('/login.htm') ||
      t.includes('lgname') ||
      t.includes('lgpin')
    );
  }

  extractSessFromHtml(html) {
    if (!html) return null;

    // getSession(){return "CDCDFDFF112F31DB";}
    const m1 = html.match(/getSession\(\)\s*\{\s*return\s*"([A-F0-9]{16})"\s*;\s*\}/i);
    if (m1) return m1[1];

    // fallback patterns
    const m2 = html.match(/sess\s*=\s*"?([A-F0-9]{16})"?/i);
    if (m2) return m2[1];

    return null;
  }

  async login() {
    if (this.loggingIn) return this.loggingIn;

    this.loggingIn = (async () => {
      this.sess = null;

      const url = this.baseUrl('/login.cgi');
      const body = `lgname=${encodeURIComponent(this.username)}&lgpin=${encodeURIComponent(this.pin)}`;

      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      const text = await res.text();
      const sess = this.extractSessFromHtml(text);

      if (!sess) {
        if (this.looksLikeLoginHtml(text)) {
          throw new Error(
            'Login not accepted (panel returned login page again). Check username/pin AND that this user has web/area permissions.'
          );
        }
        throw new Error('Login failed (no sess token found in HTML).');
      }

      this.sess = sess;
      this.log.info(`[Reliance XR] Logged in successfully. sess=${this.sess}`);
    })();

    try {
      await this.loggingIn;
    } finally {
      this.loggingIn = null;
    }
  }

  async ensureLoggedIn() {
    if (this.sess) return;
    await this.login();
  }

  async request(path, { method = 'GET', data = null, expectJson = true, retry = true } = {}) {
    await this.ensureLoggedIn();

    let url = this.baseUrl(path);

    // Most endpoints behave like POST with sess=...
    let body = null;
    let httpMethod = method;

    if (httpMethod !== 'GET') {
      body = data ? `sess=${encodeURIComponent(this.sess)}&${data}` : `sess=${encodeURIComponent(this.sess)}`;
    } else if (data) {
      httpMethod = 'POST';
      body = `sess=${encodeURIComponent(this.sess)}&${data}`;
    }

    const res = await this.fetch(url, {
      method: httpMethod,
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body,
    });

    const text = await res.text();

    // session expired → panel returns login HTML
    if (this.looksLikeLoginHtml(text) && retry) {
      this.log.warn(`[Reliance XR] Session/login HTML returned for ${path}. Re-logging in and retrying...`);
      await sleep(200);
      await this.login();
      return this.request(path, { method, data, expectJson, retry: false });
    }

    if (!expectJson) return text;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Some endpoints return empty or odd responses; surface useful debugging
      throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 120)}`);
    }

    // Some pages return { "error": { "code": 0,"time": "...."} }
    if (parsed && parsed.error) {
      throw new Error(`Panel error response from ${path}: ${JSON.stringify(parsed.error)}`);
    }

    return parsed;
  }

  async status(areaIndex) {
    return this.request('/user/status.json', {
      method: 'POST',
      data: `arsel=${encodeURIComponent(areaIndex)}`,
      expectJson: true,
    });
  }

  async keyFunction(fnum, areaIndex) {
    // mirrors the web UI: /user/keyfunction.cgi fnum=..&start=..&mask=..
    const i = Number(areaIndex ?? 0);
    const mask = 1 << (i % 8);
    const start = Math.floor(i / 8);
    return this.request('/user/keyfunction.cgi', {
      method: 'POST',
      data: `fnum=${encodeURIComponent(fnum)}&start=${encodeURIComponent(start)}&mask=${encodeURIComponent(mask)}`,
      expectJson: true,
    });
  }

  // --- Bankstate decode helpers ---
  _hexByteAt(bankstates, startIndex) {
    const hex = bankstates.substring(startIndex, startIndex + 2);
    if (!hex || hex.length !== 2) return 0;
    return parseInt(hex, 16);
  }

  decodeAreaModeFromBankstates(bankstates, areaIndex) {
    if (!bankstates) return 'UNKNOWN';

    const i = Number(areaIndex ?? 0);
    const mask = 1 << (i % 8);

    // These offsets match what we validated from status.js:
    // starm = substring(6,8)
    // stpartial = substring(4,6)
    // stexit1 = substring(8,10)
    // stexit2 = substring(10,12)
    const stpartial = this._hexByteAt(bankstates, 4);
    const starm = this._hexByteAt(bankstates, 6);
    const stexit1 = this._hexByteAt(bankstates, 8);
    const stexit2 = this._hexByteAt(bankstates, 10);

    const isExit = ((stexit1 & mask) !== 0) || ((stexit2 & mask) !== 0);
    const isAway = (starm & mask) !== 0;
    const isStay = (stpartial & mask) !== 0;

    // During exit delay, many panels already set "arm" bit, so we treat exit separately if you want later.
    if (isAway) return 'AWAY';
    if (isStay) return 'STAY';
    if (!isExit) return 'DISARMED';
    return 'DISARMED';
  }

  // For zones, we’re using the “zone open bank” approach you already tested working.
  // We treat bankstates as a long hex string and slice it into byte arrays per bank.
  getZoneStateBanks(bankstates) {
    // bankstates is 80 hex chars (40 bytes) in your logs
    // We'll expose it as raw so the platform can interpret per "zoneOpenBank"
    return bankstates;
  }

  isZoneOpenFromBanks(bankstates, zoneNumber, zoneOpenBank, zoneOpenWhenSet) {
    if (!bankstates) return false;

    // zoneNumber is 1-based. mask in its byte.
    const z = Number(zoneNumber);
    const zi = z - 1;
    const mask = 1 << (zi % 8);

    // Each “zone bank” in the JS uses zoneStatus[bankIndex].substring(byteStart, 2+byteStart)
    // But we’re not fetching zstate.json; instead you found a stable working mapping:
    // You configured zoneOpenBank and it works (bank 0).
    //
    // So we interpret "bankstates" as a 40-byte (80 hex) status block and pick a byte:
    // byteStart = 2 * floor(zi/8) + (zoneOpenBank*??)
    //
    // Because your chosen mapping works, we keep the same math you were using previously:
    // - zoneOpenBank selects which *bank* slice (0..N)
    // - each bank is 2 chars per byte * 1 byte per 8 zones = 2 chars per 8 zones step
    //
    // In practice with your setup, bank 0 & byteStart = 2*floor(zi/8) worked.
    const byteStart = 2 * Math.floor(zi / 8) + (zoneOpenBank * 0);
    const byte = this._hexByteAt(bankstates, byteStart);

    const bitSet = (byte & mask) !== 0;
    return zoneOpenWhenSet ? bitSet : !bitSet;
  }
}

module.exports = {
  XRApi,
};