'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crcDnp, decodeFrame, encodeFrame, encodeResponse, decodeApplication, MasterConnection, OutstationServer } = require('../lib/dnp3');

test('CRC matches the canonical DNP3 check vector', () => {
    assert.equal(crcDnp(Buffer.from('056405c401000004', 'hex')), 0xadf1);
});

test('frame encoding round-trips payload and addresses', () => {
    const encoded = encodeFrame({control: 0xc4, destination: 1024, source: 1, userData: Buffer.from('c0c0013c0106', 'hex')});
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.destination, 1024);
    assert.equal(decoded.source, 1);
    assert.equal(decoded.userData.toString('hex'), 'c0c0013c0106');
});

test('outstation response decodes a binary and analog point', () => {
    const wire = encodeResponse({source: 10, destination: 1, sequence: 3, points: [
        {type: 'binaryInput', index: 7, value: true},
        {type: 'analogInput', index: 9, value: -42},
    ]});
    const message = decodeApplication(decodeFrame(wire));
    assert.deepEqual(message.points.map(point => [point.type, point.index, point.value]), [
        ['binaryInput', 7, true],
        ['analogInput', 9, -42],
    ]);
});

test('master and outstation exchange an integrity poll and a control', async () => {
    const outstation = new OutstationServer({
        bind: '127.0.0.1', port: 0, localAddress: 10, remoteAddress: 1,
        points: [{type: 'binaryInput', index: 5, value: true}, {type: 'binaryOutputStatus', index: 6, value: false}],
    });
    await outstation.listen();
    const port = outstation.server.address().port;
    const master = new MasterConnection({host: '127.0.0.1', port, localAddress: 1, remoteAddress: 10});
    const messages = [];
    master.on('frame', frame => messages.push(decodeApplication(frame)));
    await master.connect();
    master.integrityPoll();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(messages[0].points.find(point => point.index === 5).value, true);
    const control = new Promise(resolve => outstation.once('control', resolve));
    master.directOperate('binaryOutputStatus', 6, true);
    assert.deepEqual(await control, {type: 'binaryOutputStatus', index: 6, value: true, flags: 1});
    master.close();
    await outstation.close();
});
