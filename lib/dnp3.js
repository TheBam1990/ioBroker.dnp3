'use strict';

const net = require('node:net');
const timers = require('node:timers');
const { EventEmitter } = require('node:events');

const START_1 = 0x05;
const START_2 = 0x64;

function crcDnp(buffer) {
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa6bc : crc >>> 1;
    }
  }
  return ~crc & 0xffff;
}

function appendCrc(parts, data) {
  parts.push(data);
  const crc = crcDnp(data);
  parts.push(Buffer.from([crc & 0xff, crc >>> 8]));
}

function encodeFrame({ control, destination, source, userData = Buffer.alloc(0) }) {
  if (userData.length > 250) {
    throw new RangeError('DNP3 user data must not exceed 250 bytes');
  }
  const header = Buffer.alloc(8);
  header[0] = START_1;
  header[1] = START_2;
  header[2] = userData.length + 5;
  header[3] = control;
  header.writeUInt16LE(destination, 4);
  header.writeUInt16LE(source, 6);
  const parts = [];
  appendCrc(parts, header);
  for (let offset = 0; offset < userData.length; offset += 16) {
    appendCrc(parts, userData.subarray(offset, offset + 16));
  }
  return Buffer.concat(parts);
}

function decodeFrame(buffer) {
  if (buffer.length < 10 || buffer[0] !== START_1 || buffer[1] !== START_2) {
    return null;
  }
  const userLength = buffer[2] - 5;
  if (userLength < 0) {
    throw new Error('Invalid DNP3 length');
  }
  const totalLength = 10 + userLength + Math.ceil(userLength / 16) * 2;
  if (buffer.length < totalLength) {
    return null;
  }
  const header = buffer.subarray(0, 8);
  if (crcDnp(header) !== buffer.readUInt16LE(8)) {
    throw new Error('Invalid DNP3 header CRC');
  }
  const chunks = [];
  let wireOffset = 10;
  let remaining = userLength;
  while (remaining > 0) {
    const length = Math.min(16, remaining);
    const chunk = buffer.subarray(wireOffset, wireOffset + length);
    if (crcDnp(chunk) !== buffer.readUInt16LE(wireOffset + length)) {
      throw new Error('Invalid DNP3 data CRC');
    }
    chunks.push(chunk);
    wireOffset += length + 2;
    remaining -= length;
  }
  return {
    bytes: totalLength,
    control: header[3],
    destination: header.readUInt16LE(4),
    source: header.readUInt16LE(6),
    userData: Buffer.concat(chunks),
  };
}

class FrameParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
  }

  push(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const start = this.buffer.indexOf(Buffer.from([START_1, START_2]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        return;
      }
      if (start > 0) {
        this.buffer = this.buffer.subarray(start);
      }
      try {
        const frame = decodeFrame(this.buffer);
        if (!frame) {
          return;
        }
        this.buffer = this.buffer.subarray(frame.bytes);
        this.emit('frame', frame);
      } catch (error) {
        this.emit('error', error);
        this.buffer = this.buffer.subarray(2);
      }
    }
  }
}

function allObjects(group, variation) {
  return Buffer.from([group, variation, 0x06]);
}

function buildReadRequest(sequence, headers) {
  return Buffer.concat([
    Buffer.from([0xc0 | (sequence & 0x0f), 0x01]),
    ...headers.map(({ group, variation }) => allObjects(group, variation)),
  ]);
}

function buildIntegrityPoll(sequence = 0) {
  return buildReadRequest(sequence, [
    { group: 60, variation: 2 },
    { group: 60, variation: 3 },
    { group: 60, variation: 4 },
    { group: 60, variation: 1 },
  ]);
}

const POINT_TYPES = {
  1: 'binaryInput',
  2: 'binaryInput',
  3: 'doubleBitBinaryInput',
  4: 'doubleBitBinaryInput',
  10: 'binaryOutputStatus',
  11: 'binaryOutputStatus',
  20: 'counter',
  21: 'frozenCounter',
  22: 'counter',
  23: 'frozenCounter',
  30: 'analogInput',
  32: 'analogInput',
  40: 'analogOutputStatus',
  42: 'analogOutputStatus',
};

function readUInt48LE(buffer, offset) {
  return buffer.readUInt32LE(offset) + buffer.readUInt16LE(offset + 4) * 0x100000000;
}

function decodeMeasurement(group, variation, buffer, offset) {
  let flags;
  let value;
  let time;
  const signed = group === 30 || group === 32 || group === 40 || group === 42;
  if (group === 1 || group === 2 || group === 10 || group === 11) {
    flags = buffer[offset++];
    value = (flags & 0x80) !== 0;
    if (group === 2 && (variation === 2 || variation === 3)) {
      const timeLength = variation === 2 ? 6 : 2;
      time = timeLength === 6 ? readUInt48LE(buffer, offset) : buffer.readUInt16LE(offset);
      offset += timeLength;
    }
  } else if (group === 3 || group === 4) {
    flags = buffer[offset++];
    value = (flags >>> 6) & 0x03;
    if (group === 4 && (variation === 2 || variation === 3)) {
      const timeLength = variation === 2 ? 6 : 2;
      time = timeLength === 6 ? readUInt48LE(buffer, offset) : buffer.readUInt16LE(offset);
      offset += timeLength;
    }
  } else {
    const isEvent = group === 22 || group === 23 || group === 32 || group === 42;
    const noFlags = !isEvent && (variation === 3 || variation === 4);
    if (!noFlags) {
      flags = buffer[offset++];
    }
    const valueVariation = isEvent ? ((variation - 1) % 4) + 1 : variation;
    if (valueVariation === 1) {
      value = signed ? buffer.readInt32LE(offset) : buffer.readUInt32LE(offset);
      offset += 4;
    } else if (valueVariation === 2) {
      value = signed ? buffer.readInt16LE(offset) : buffer.readUInt16LE(offset);
      offset += 2;
    } else if (valueVariation === 3) {
      value = buffer.readFloatLE(offset);
      offset += 4;
    } else if (valueVariation === 4) {
      value = buffer.readDoubleLE(offset);
      offset += 8;
    } else {
      throw new Error(`Unsupported DNP3 variation g${group}v${variation}`);
    }
    const timedEvent = isEvent && variation >= 5;
    if (timedEvent) {
      time = readUInt48LE(buffer, offset);
      offset += 6;
    }
  }
  return { value, flags, time, offset };
}

function decodeObjects(buffer, offset = 0) {
  const points = [];
  while (offset < buffer.length) {
    if (offset + 3 > buffer.length) {
      throw new Error('Truncated DNP3 object header');
    }
    const group = buffer[offset++];
    const variation = buffer[offset++];
    const qualifier = buffer[offset++];
    const rangeCode = qualifier & 0x0f;
    const prefixCode = (qualifier >>> 4) & 0x07;
    let count;
    let start = 0;
    if (rangeCode <= 2) {
      const width = 1 << rangeCode;
      if (width === 1) {
        start = buffer[offset++];
        count = buffer[offset++] - start + 1;
      } else if (width === 2) {
        start = buffer.readUInt16LE(offset);
        count = buffer.readUInt16LE(offset + 2) - start + 1;
        offset += 4;
      } else {
        start = buffer.readUInt32LE(offset);
        count = buffer.readUInt32LE(offset + 4) - start + 1;
        offset += 8;
      }
    } else if (rangeCode >= 7 && rangeCode <= 9) {
      const width = 1 << (rangeCode - 7);
      count = width === 1 ? buffer[offset] : width === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
      offset += width;
    } else {
      throw new Error(`Unsupported DNP3 qualifier 0x${qualifier.toString(16)}`);
    }
    for (let item = 0; item < count; item++) {
      let index = start + item;
      if (prefixCode > 0) {
        const width = 1 << (prefixCode - 1);
        index = width === 1 ? buffer[offset] : width === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
        offset += width;
      }
      const decoded = decodeMeasurement(group, variation, buffer, offset);
      offset = decoded.offset;
      points.push({
        group,
        variation,
        type: POINT_TYPES[group] || `group${group}`,
        index,
        value: decoded.value,
        flags: decoded.flags,
        time: decoded.time,
      });
    }
  }
  return points;
}

function decodeApplication(frame) {
  if (frame.userData.length < 3) {
    throw new Error('Truncated DNP3 application fragment');
  }
  const transport = frame.userData[0];
  const control = frame.userData[1];
  const functionCode = frame.userData[2];
  const response = functionCode === 0x81 || functionCode === 0x82;
  if (!response) {
    return { transport, control, functionCode, points: [] };
  }
  if (frame.userData.length < 5) {
    throw new Error('Truncated DNP3 response');
  }
  const firstGroup = frame.userData[5];
  if (firstGroup === 12 || firstGroup === 41) {
    return { transport, control, functionCode, iin: frame.userData.readUInt16LE(3), points: [], commandResponse: true };
  }
  return {
    transport,
    control,
    functionCode,
    iin: frame.userData.readUInt16LE(3),
    points: decodeObjects(frame.userData, 5),
  };
}

function encodeRequest({ source = 1, destination = 1024, sequence = 0, application }) {
  const transport = Buffer.concat([Buffer.from([0xc0 | (sequence & 0x3f)]), application]);
  return encodeFrame({ control: 0xc4, destination, source, userData: transport });
}

function buildCommand(sequence, type, index, value, functionCode = 0x05) {
  const header = Buffer.alloc(7);
  let data;
  if (type === 'binaryOutputStatus') {
    header.set([12, 1, 0x28]);
    header.writeUInt16LE(1, 3);
    header.writeUInt16LE(index, 5);
    data = Buffer.alloc(11);
    data[0] = value ? 3 : 4;
    data[1] = 1;
  } else if (type === 'analogOutputStatus') {
    header.set([41, 1, 0x28]);
    header.writeUInt16LE(1, 3);
    header.writeUInt16LE(index, 5);
    data = Buffer.alloc(5);
    data.writeInt32LE(Math.round(Number(value)), 0);
  } else {
    throw new Error(`Unsupported DNP3 command type ${type}`);
  }
  return Buffer.concat([Buffer.from([0xc0 | (sequence & 0x0f), functionCode]), header, data]);
}

class MasterConnection extends EventEmitter {
  constructor(options) {
    super();
    this.options = { port: 20000, localAddress: 1, remoteAddress: 1024, timeout: 5000, ...options };
    this.sequence = 0;
    this.socket = null;
    this.parser = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      this.socket = socket;
      this.parser = new FrameParser();
      const timer = timers.setTimeout(() => socket.destroy(new Error('DNP3 connection timeout')), this.options.timeout);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.emit('connect');
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', (data) => this.parser.push(data));
      socket.on('close', () => this.emit('close'));
      this.parser.on('frame', (frame) => this.emit('frame', frame));
      this.parser.on('error', (error) => this.emit('error', error));
    });
  }

  integrityPoll() {
    const sequence = this.sequence++ & 0x0f;
    const frame = encodeRequest({
      source: this.options.localAddress,
      destination: this.options.remoteAddress,
      sequence,
      application: buildIntegrityPoll(sequence),
    });
    this.socket.write(frame);
  }

  directOperate(type, index, value) {
    const sequence = this.sequence++ & 0x0f;
    this.socket.write(
      encodeRequest({
        source: this.options.localAddress,
        destination: this.options.remoteAddress,
        sequence,
        application: buildCommand(sequence, type, index, value),
      }),
    );
  }

  confirm(sequence, unsolicited = false) {
    const transportSequence = this.sequence++ & 0x3f;
    const application = Buffer.from([0xc0 | (unsolicited ? 0x10 : 0) | (sequence & 0x0f), 0x00]);
    this.socket.write(
      encodeRequest({
        source: this.options.localAddress,
        destination: this.options.remoteAddress,
        sequence: transportSequence,
        application,
      }),
    );
  }

  close() {
    this.socket?.destroy();
  }
}

const OUTSTATION_VARIATIONS = {
  binaryInput: [1, 2],
  doubleBitBinaryInput: [3, 2],
  binaryOutputStatus: [10, 2],
  counter: [20, 1],
  frozenCounter: [21, 1],
  analogInput: [30, 1],
  analogOutputStatus: [40, 1],
};

function encodeUInt48LE(value) {
  const buffer = Buffer.alloc(6);
  buffer.writeUInt32LE(value >>> 0, 0);
  buffer.writeUInt16LE(Math.floor(value / 0x100000000) & 0xffff, 4);
  return buffer;
}

function encodePointValue(type, value, flags = 0x01) {
  if (type === 'binaryInput' || type === 'binaryOutputStatus') {
    return Buffer.from([(flags & 0x7f) | (value ? 0x80 : 0)]);
  }
  if (type === 'doubleBitBinaryInput') {
    return Buffer.from([(flags & 0x3f) | ((Number(value) & 0x03) << 6)]);
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = flags;
  if (type === 'analogInput' || type === 'analogOutputStatus') {
    buffer.writeInt32LE(Math.round(Number(value)), 1);
  } else {
    buffer.writeUInt32LE(Math.max(0, Math.round(Number(value))) >>> 0, 1);
  }
  return buffer;
}

function encodeStaticPoint(point) {
  const variation = OUTSTATION_VARIATIONS[point.type];
  if (!variation) {
    throw new Error(`Unsupported outstation point type ${point.type}`);
  }
  const header = Buffer.alloc(7);
  header[0] = variation[0];
  header[1] = variation[1];
  header[2] = 0x01;
  header.writeUInt16LE(point.index, 3);
  header.writeUInt16LE(point.index, 5);
  return Buffer.concat([header, encodePointValue(point.type, point.value, point.flags)]);
}

function encodeResponse({ source, destination, sequence, points = [], iin = 0 }) {
  const application = Buffer.concat([
    Buffer.from([0xc0 | (sequence & 0x0f), 0x81, iin & 0xff, iin >>> 8]),
    ...points.map(encodeStaticPoint),
  ]);
  const transport = Buffer.concat([Buffer.from([0xc0 | (sequence & 0x3f)]), application]);
  return encodeFrame({ control: 0x44, destination, source, userData: transport });
}

class OutstationServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = { bind: '0.0.0.0', port: 20000, localAddress: 1024, remoteAddress: 1, ...options };
    this.points = new Map();
    for (const point of options.points || []) this.setPoint(point);
    this.clients = new Set();
    this.server = null;
  }

  setPoint(point) {
    this.points.set(`${point.type}:${point.index}`, { flags: 0x01, value: 0, ...point });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.accept(socket));
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.bind, () => {
        this.server.removeListener('error', reject);
        this.emit('listening');
        resolve();
      });
    });
  }

  accept(socket) {
    const parser = new FrameParser();
    this.clients.add(socket);
    this.emit('connect', socket.remoteAddress);
    socket.on('data', (data) => parser.push(data));
    socket.on('close', () => {
      this.clients.delete(socket);
      this.emit('disconnect', socket.remoteAddress);
    });
    socket.on('error', (error) => this.emit('clientError', error));
    parser.on('error', (error) => this.emit('clientError', error));
    parser.on('frame', (frame) => this.handleFrame(socket, frame));
  }

  handleFrame(socket, frame) {
    if (frame.destination !== this.options.localAddress && frame.destination < 0xfff0) {
      return;
    }
    if (frame.userData.length < 3) {
      return;
    }
    const sequence = frame.userData[1] & 0x0f;
    const functionCode = frame.userData[2];
    this.emit('request', { functionCode, frame });
    if (functionCode === 0x01) {
      socket.write(
        encodeResponse({
          source: this.options.localAddress,
          destination: frame.source,
          sequence,
          points: [...this.points.values()],
        }),
      );
    } else if (functionCode >= 0x03 && functionCode <= 0x06) {
      this.handleCommand(socket, frame, sequence, functionCode);
    }
  }

  handleCommand(socket, frame, sequence, functionCode) {
    const request = frame.userData.subarray(3);
    if (request.length < 12) {
      return;
    }
    const group = request[0];
    const variation = request[1];
    const qualifier = request[2];
    if (qualifier !== 0x28 || request.readUInt16LE(3) !== 1) {
      return;
    }
    const index = request.readUInt16LE(5);
    let type;
    let value;
    let statusOffset;
    if (group === 12 && variation === 1 && request.length >= 18) {
      type = 'binaryOutputStatus';
      value = request[7] === 1 || request[7] === 3;
      statusOffset = 17;
    } else if (group === 41 && variation === 1 && request.length >= 12) {
      type = 'analogOutputStatus';
      value = request.readInt32LE(7);
      statusOffset = 11;
    } else {
      return;
    }
    const responseObject = Buffer.from(request);
    responseObject[statusOffset] = 0;
    const application = Buffer.concat([Buffer.from([0xc0 | sequence, 0x81, 0, 0]), responseObject]);
    const transport = Buffer.concat([Buffer.from([0xc0 | sequence]), application]);
    socket.write(
      encodeFrame({ control: 0x44, destination: frame.source, source: this.options.localAddress, userData: transport }),
    );
    if (functionCode !== 0x03) {
      const point = { ...(this.points.get(`${type}:${index}`) || {}), type, index, value, flags: 0x01 };
      this.setPoint(point);
      this.emit('control', point);
    }
  }

  close() {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
  }
}

module.exports = {
  FrameParser,
  MasterConnection,
  OutstationServer,
  allObjects,
  buildIntegrityPoll,
  buildCommand,
  buildReadRequest,
  crcDnp,
  decodeFrame,
  decodeApplication,
  decodeObjects,
  encodeFrame,
  encodeResponse,
  encodeStaticPoint,
  encodeRequest,
  encodeUInt48LE,
};
