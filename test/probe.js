'use strict';

const { MasterConnection, decodeApplication } = require('../lib/dnp3');

const remoteAddress = Number(process.argv[2] || 1024);
const localAddress = Number(process.argv[3] || 1);
const master = new MasterConnection({ host: '192.168.2.213', localAddress, remoteAddress });
master.on('frame', (frame) => {
  console.log(
    JSON.stringify({
      source: frame.source,
      destination: frame.destination,
      control: frame.control,
      data: frame.userData.toString('hex'),
    }),
  );
  try {
    console.log(JSON.stringify(decodeApplication(frame)));
  } catch (error) {
    console.error(`decode: ${error.message}`);
  }
  const appControl = frame.userData[1];
  const functionCode = frame.userData[2];
  if ((appControl & 0x20) !== 0 && (functionCode === 0x81 || functionCode === 0x82)) {
    console.log(`confirming application sequence ${appControl & 0x0f}`);
    master.confirm(appControl & 0x0f, functionCode === 0x82);
  }
});
master.on('error', (error) => console.error(error.message));
master
  .connect()
  .then(() => {
    console.log(`connected, polling from master ${localAddress} to outstation ${remoteAddress}`);
    setTimeout(() => master.integrityPoll(), 250);
    setTimeout(() => master.close(), 3000);
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
