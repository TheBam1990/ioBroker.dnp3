# ioBroker.dnp3

DNP3 (IEEE 1815) over TCP adapter for ioBroker. It can operate as either:

- a **master** (TCP client), polling an external DNP3 outstation and exposing received measurements as ioBroker states;
- an **outstation** (TCP server), exposing configured ioBroker states to a DNP3 master.

## Configuration

Select the operating mode and configure the TCP endpoint plus the local and remote 16-bit DNP3 link addresses. TCP port `20000` is the conventional default. In master mode, an integrity poll runs after connecting and at the configured interval. Received points are discovered and created below `points.<type>.<index>`.

In outstation mode, add the points that should be exposed. Writes to their ioBroker states update the outstation database.

## Supported measurements

- Binary and double-bit binary inputs
- Binary output status
- Counters and frozen counters
- Analog inputs and analog output status
- Static and common event variations, including absolute timestamps
- Class 0/1/2/3 integrity polling and unsolicited-response confirmation

The first release uses DNP3 over plain TCP. TLS and Secure Authentication are not enabled yet.

## Changelog

### 0.0.1 (2026-07-14)

- Initial DNP3 master and outstation implementation.

## License

Copyright (c) 2026 TheBam1990

MIT License.
