'use strict';

const { XRApi } = require('./xr-api');

let Service;
let Characteristic;
let UUIDGen;

class RelianceXRPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUIDGen = api.hap.uuid;

    // --- Config ---
    this.host = this.config.host;
    this.username = this.config.username;
    this.pin = this.config.pin;

    this.securityName = this.config.securityName || 'Alarm';
    this.areaIndex = Number(this.config.areaIndex ?? 0);
    this.pollMs = Number(this.config.pollMs ?? 2000);

    this.rollerDoorName = this.config.rollerDoorName || 'Roller Door';
    this.rollerDoorZone = Number(this.config.rollerDoorZone ?? 0);
    this.zoneOpenBank = (this.config.zoneOpenBank === undefined) ? 0 : Number(this.config.zoneOpenBank);
    this.zoneOpenWhenSet = (this.config.zoneOpenWhenSet ?? true) === true;

    // Notifications (pulsed MotionSensor services)
    this.enableEventNotifications = (this.config.enableEventNotifications ?? true) === true;
    this.alarmEventSensorName = this.config.alarmEventSensorName || 'Alarm Events';
    this.doorEventSensorName = this.config.doorEventSensorName || 'Roller Door Events';
    this.eventPulseMs = Number(this.config.eventPulseMs ?? 1500);

    // --- Internals ---
    this.xr = new XRApi({
      log: this.log,
      host: this.host,
      username: this.username,
      pin: this.pin,
    });

    this.accessories = [];

    this.securityService = null;
    this.garageService = null;
    this.alarmEventService = null;
    this.doorEventService = null;

    this.cachedMode = 'UNKNOWN';
    this.cachedDoorOpen = null;

    this._pollTimer = null;
    this._eventResetTimers = new Map();

    api.on('didFinishLaunching', async () => {
      try {
        await this.xr.login();
        this.log.info('[Reliance XR] Platform Loaded');

        this.setupAccessories();
        await this.pollOnceSafe();

        this._pollTimer = setInterval(() => {
          this.pollOnceSafe().catch(() => {});
        }, this.pollMs);
      } catch (e) {
        this.log.error(`[Reliance XR] Startup failed: ${e.message || e}`);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  getOrCreateAccessory(displayName, stableId) {
    const uuid = UUIDGen.generate(stableId);
    const existing = this.accessories.find((a) => a.UUID === uuid);

    if (existing) {
      existing.displayName = displayName;
      return { accessory: existing, isNew: false };
    }

    const acc = new this.api.platformAccessory(displayName, uuid);
    this.accessories.push(acc);
    return { accessory: acc, isNew: true };
  }

  setupAccessories() {
    const toRegister = [];

    // ---- Alarm accessory ----
    {
      const { accessory, isNew } = this.getOrCreateAccessory(
        this.securityName,
        `xr-alarm-${this.host}-a${this.areaIndex}`
      );

      const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
      info
        .setCharacteristic(Characteristic.Manufacturer, 'Aritech / Interlogix')
        .setCharacteristic(Characteristic.Model, 'Reliance XR (xGen)')
        .setCharacteristic(Characteristic.SerialNumber, this.host || 'unknown');

      this.securityService =
        accessory.getService(Service.SecuritySystem) || accessory.addService(Service.SecuritySystem, this.securityName);

      // Only show Away/Stay/Off
      this.securityService.getCharacteristic(Characteristic.SecuritySystemTargetState).setProps({
        validValues: [
          Characteristic.SecuritySystemTargetState.DISARM,
          Characteristic.SecuritySystemTargetState.STAY_ARM,
          Characteristic.SecuritySystemTargetState.AWAY_ARM,
        ],
      });

      this.securityService
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .onSet(async (value) => this.handleSecurityTargetSet(value));

      // Optional: Motion sensor for notifications
      if (this.enableEventNotifications) {
        this.alarmEventService =
          accessory.getService(this.alarmEventSensorName) ||
          accessory.addService(Service.MotionSensor, this.alarmEventSensorName, 'alarm-events');

        this.alarmEventService.updateCharacteristic(Characteristic.MotionDetected, false);
      }

      if (isNew) toRegister.push(accessory);
    }

    // ---- Roller Door accessory ----
    if (this.rollerDoorZone && this.rollerDoorZone > 0) {
      const { accessory, isNew } = this.getOrCreateAccessory(
        this.rollerDoorName,
        `xr-door-${this.host}-z${this.rollerDoorZone}`
      );

      const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
      info
        .setCharacteristic(Characteristic.Manufacturer, 'Aritech / Interlogix')
        .setCharacteristic(Characteristic.Model, 'Reliance XR (zone contact)')
        .setCharacteristic(Characteristic.SerialNumber, `${this.host}-z${this.rollerDoorZone}`);

      // Use GarageDoorOpener service so it can be favourited / show on Home screen
      this.garageService =
        accessory.getService(Service.GarageDoorOpener) ||
        accessory.addService(Service.GarageDoorOpener, this.rollerDoorName);

      // We are NOT controlling the door motor, only reporting open/closed.
      // But HomeKit requires TargetDoorState; we keep it mirrored to current.
      this.garageService.getCharacteristic(Characteristic.TargetDoorState).onSet(async () => {
        // ignore user commands
      });

      if (this.enableEventNotifications) {
        this.doorEventService =
          accessory.getService(this.doorEventSensorName) ||
          accessory.addService(Service.MotionSensor, this.doorEventSensorName, 'door-events');

        this.doorEventService.updateCharacteristic(Characteristic.MotionDetected, false);
      }

      if (isNew) toRegister.push(accessory);
    }

    if (toRegister.length > 0) {
      this.api.registerPlatformAccessories('homebridge-reliance-xr', 'RelianceXR', toRegister);
    }
  }

  async handleSecurityTargetSet(value) {
    if (value === Characteristic.SecuritySystemTargetState.DISARM) {
      this.log.info('[Reliance XR] Sending keyFunction fnum=0');
      await this.xr.keyFunction(0, this.areaIndex);
      return;
    }

    if (value === Characteristic.SecuritySystemTargetState.STAY_ARM) {
      this.log.info('[Reliance XR] Sending keyFunction fnum=1');
      await this.xr.keyFunction(1, this.areaIndex);
      return;
    }

    if (value === Characteristic.SecuritySystemTargetState.AWAY_ARM) {
      this.log.info('[Reliance XR] Sending keyFunction fnum=15');
      await this.xr.keyFunction(15, this.areaIndex);
      return;
    }
  }

  async pollOnceSafe() {
    try {
      await this.pollOnce();
    } catch (e) {
      this.log.warn(`[Reliance XR] Poll error: ${e.message || e}`);
      // Force re-login next time
      this.xr.sess = null;

      // Mark services faulted
      if (this.securityService) {
        this.securityService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
      }
    }
  }

  async pollOnce() {
  const a = await this.xr.status(this.areaIndex);

  const mode = this.xr.decodeAreaModeFromBankstates(a.bankstates, this.areaIndex);
  this.setMode(mode);

  if (this.rollerDoorZone && this.rollerDoorZone > 0) {
    const banks = this.xr.getZoneStateBanks(a.bankstates);
    const isOpen = this.xr.isZoneOpenFromBanks(
      banks,
      this.rollerDoorZone,
      this.zoneOpenBank,
      this.zoneOpenWhenSet
    );
    this.setGarageOpen(isOpen);
   }
  }

  pulseMotion(service, key) {
    if (!service) return;

    service.updateCharacteristic(Characteristic.MotionDetected, true);

    const existing = this._eventResetTimers.get(key);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      service.updateCharacteristic(Characteristic.MotionDetected, false);
      this._eventResetTimers.delete(key);
    }, this.eventPulseMs);

    this._eventResetTimers.set(key, t);
  }

  setMode(mode) {
    if (!mode) mode = 'UNKNOWN';
    if (mode === this.cachedMode) return;
    this.cachedMode = mode;

    this.log.info(`[Reliance XR] MODE CHANGED => ${mode}`);
    this.pulseMotion(this.alarmEventService, 'alarm');

    if (!this.securityService) return;

    let cur;
    if (mode === 'DISARMED') cur = Characteristic.SecuritySystemCurrentState.DISARMED;
    else if (mode === 'STAY') cur = Characteristic.SecuritySystemCurrentState.STAY_ARM;
    else if (mode === 'AWAY') cur = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    else cur = Characteristic.SecuritySystemCurrentState.DISARMED;

    let tgt;
    if (mode === 'DISARMED') tgt = Characteristic.SecuritySystemTargetState.DISARM;
    else if (mode === 'STAY') tgt = Characteristic.SecuritySystemTargetState.STAY_ARM;
    else if (mode === 'AWAY') tgt = Characteristic.SecuritySystemTargetState.AWAY_ARM;
    else tgt = Characteristic.SecuritySystemTargetState.DISARM;

    this.securityService.updateCharacteristic(Characteristic.SecuritySystemCurrentState, cur);
    this.securityService.updateCharacteristic(Characteristic.SecuritySystemTargetState, tgt);
    this.securityService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
  }

  setGarageOpen(isOpen) {
    if (this.cachedDoorOpen === isOpen) return;
    this.cachedDoorOpen = isOpen;

    this.log.info(`[Reliance XR] ${this.rollerDoorName} => ${isOpen ? 'OPEN' : 'CLOSED'}`);
    this.pulseMotion(this.doorEventService, 'door');

    if (!this.garageService) return;

    const cur = isOpen ? Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED;
    const tgt = isOpen ? Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED;

    this.garageService.updateCharacteristic(Characteristic.CurrentDoorState, cur);
    this.garageService.updateCharacteristic(Characteristic.TargetDoorState, tgt);
  }
}

module.exports = {
  RelianceXRPlatform,
};