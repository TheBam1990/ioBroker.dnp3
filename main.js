'use strict';

const utils = require('@iobroker/adapter-core');
const { MasterConnection, OutstationServer, decodeApplication } = require('./lib/dnp3');

const TYPE_ROLES = {
  binaryInput: { type: 'boolean', role: 'indicator' },
  doubleBitBinaryInput: { type: 'number', role: 'value' },
  binaryOutputStatus: { type: 'boolean', role: 'switch' },
  counter: { type: 'number', role: 'value.counter' },
  frozenCounter: { type: 'number', role: 'value.counter' },
  analogInput: { type: 'number', role: 'value' },
  analogOutputStatus: { type: 'number', role: 'level' },
};

class Dnp3Adapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'dnp3' });
    this.protocol = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.points = new Map();
    this.on('ready', () => this.onReady());
    this.on('stateChange', (id, state) => this.onStateChange(id, state));
    this.on('unload', (callback) => this.onUnload(callback));
  }

  normalizeConfig() {
    const number = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
    return {
      mode: this.config.mode === 'outstation' ? 'outstation' : 'master',
      host: String(this.config.host || '127.0.0.1'),
      bind: String(this.config.bind || '0.0.0.0'),
      port: number(this.config.port, 20000, 1, 65535),
      localAddress: number(this.config.localAddress, 1, 0, 65519),
      remoteAddress: number(this.config.remoteAddress, 1024, 0, 65519),
      pollIntervalMs: number(this.config.pollIntervalMs, 10000, 1000, 3600000),
      reconnectIntervalMs: number(this.config.reconnectIntervalMs, 10000, 1000, 3600000),
      responseTimeoutMs: number(this.config.responseTimeoutMs, 5000, 500, 60000),
      points: Array.isArray(this.config.points) ? this.config.points : [],
    };
  }

  async onReady() {
    this.settings = this.normalizeConfig();
    await this.setStateAsync('info.connection', false, true);
    await this.setStateAsync('info.lastError', '', true);
    for (const point of this.settings.points) await this.registerPoint(point);
    await this.subscribeStatesAsync('points.*');
    if (this.settings.mode === 'master') {
      await this.startMaster();
    } else {
      await this.startOutstation();
    }
  }

  pointId(type, index) {
    return `points.${type}.${index}`;
  }

  async registerPoint(point) {
    const type = TYPE_ROLES[point.type] ? point.type : 'analogInput';
    const index = Math.min(65535, Math.max(0, Number(point.index) || 0));
    const definition = TYPE_ROLES[type];
    const id = this.pointId(type, index);
    const writable =
      this.settings.mode === 'outstation' || type === 'binaryOutputStatus' || type === 'analogOutputStatus';
    await this.extendObjectAsync(id, {
      type: 'state',
      common: {
        name: String(point.name || `${type} ${index}`),
        type: definition.type,
        role: definition.role,
        read: true,
        write: writable,
        unit: point.unit || undefined,
      },
      native: { type, index, class: Number(point.class) || 0 },
    });
    const state = await this.getStateAsync(id);
    const value = state?.val ?? point.initialValue ?? (definition.type === 'boolean' ? false : 0);
    this.points.set(`${type}:${index}`, { ...point, type, index, value });
    if (!state) {
      await this.setStateAsync(id, value, true);
    }
  }

  async startMaster() {
    const master = new MasterConnection({
      host: this.settings.host,
      port: this.settings.port,
      localAddress: this.settings.localAddress,
      remoteAddress: this.settings.remoteAddress,
      timeout: this.settings.responseTimeoutMs,
    });
    this.protocol = master;
    master.on('connect', async () => {
      this.log.info(`Connected to DNP3 outstation ${this.settings.host}:${this.settings.port}`);
      await this.setStateAsync('info.connection', true, true);
      master.integrityPoll();
      this.pollTimer = this.setInterval(() => master.integrityPoll(), this.settings.pollIntervalMs);
    });
    master.on('frame', (frame) => this.handleMasterFrame(frame));
    master.on('error', (error) => this.reportError(error));
    master.on('close', async () => {
      this.clearInterval(this.pollTimer);
      await this.setStateAsync('info.connection', false, true);
      if (!this.reconnectTimer) {
        this.reconnectTimer = this.setTimeout(() => {
          this.reconnectTimer = null;
          this.startMaster().catch((error) => this.reportError(error));
        }, this.settings.reconnectIntervalMs);
      }
    });
    try {
      await master.connect();
    } catch (error) {
      this.reportError(error);
      master.close();
    }
  }

  async handleMasterFrame(frame) {
    try {
      const message = decodeApplication(frame);
      if ((message.control & 0x20) !== 0) {
        this.protocol.confirm(message.control & 0x0f, message.functionCode === 0x82);
      }
      for (const point of message.points) {
        if (!TYPE_ROLES[point.type]) {
          continue;
        }
        const key = `${point.type}:${point.index}`;
        if (!this.points.has(key)) {
          await this.registerPoint(point);
        }
        this.points.set(key, { ...this.points.get(key), ...point });
        await this.setStateAsync(this.pointId(point.type, point.index), point.value, true);
      }
      await this.setStateAsync('info.lastUpdate', new Date().toISOString(), true);
    } catch (error) {
      this.reportError(error);
    }
  }

  async startOutstation() {
    const outstation = new OutstationServer({
      bind: this.settings.bind,
      port: this.settings.port,
      localAddress: this.settings.localAddress,
      remoteAddress: this.settings.remoteAddress,
      points: [...this.points.values()],
    });
    this.protocol = outstation;
    outstation.on('connect', async (address) => {
      this.log.info(`DNP3 master connected from ${address}`);
      await this.setStateAsync('info.connection', true, true);
    });
    outstation.on('disconnect', async () => this.setStateAsync('info.connection', outstation.clients.size > 0, true));
    outstation.on('clientError', (error) => this.reportError(error));
    outstation.on('control', async (point) => {
      const key = `${point.type}:${point.index}`;
      if (!this.points.has(key)) {
        await this.registerPoint(point);
      }
      this.points.set(key, { ...this.points.get(key), ...point });
      await this.setStateAsync(this.pointId(point.type, point.index), point.value, true);
      await this.setStateAsync('info.lastUpdate', new Date().toISOString(), true);
    });
    await outstation.listen();
    this.log.info(`DNP3 outstation listening on ${this.settings.bind}:${this.settings.port}`);
  }

  async onStateChange(id, state) {
    if (!state || state.ack || !id.startsWith(`${this.namespace}.points.`)) {
      return;
    }
    const relative = id.slice(this.namespace.length + 1).split('.');
    const type = relative[1];
    const index = Number(relative[2]);
    const key = `${type}:${index}`;
    const point = this.points.get(key);
    if (!point) {
      return;
    }
    point.value = TYPE_ROLES[type].type === 'boolean' ? Boolean(state.val) : Number(state.val);
    if (this.settings.mode === 'outstation') {
      this.protocol.setPoint(point);
    } else if (type === 'binaryOutputStatus' || type === 'analogOutputStatus') {
      this.protocol.directOperate(type, index, point.value);
    }
    await this.setStateAsync(id, point.value, true);
  }

  reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(message);
    this.setState('info.lastError', message, true);
  }

  onUnload(callback) {
    this.clearInterval(this.pollTimer);
    this.clearTimeout(this.reconnectTimer);
    Promise.resolve(this.protocol?.close()).finally(callback);
  }
}

if (require.main !== module) {
  module.exports = (options) => new Dnp3Adapter(options);
} else {
  new Dnp3Adapter();
}
