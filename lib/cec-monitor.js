/**
 * CEC backend using libCEC's cec-client tool.
 * Based loosely on the work of `@senzil/cec-monitor` but reduced a lot to work for this adapter.
 * https://github.com/senzil/cec-monitor
 */

'use strict';

const spawn = require('node:child_process').spawn;
const readline = require('node:readline');
const CEC = require('./cec-constants');
const CecBackend = require('./cec-backend');

/** Time to wait before restarting cec-client after it exited unexpectedly. */
const RESTART_DELAY = 15000;

/** Map device type to the logical address cec-client will usually claim. */
const DEFAULT_LOGICAL_ADDRESS = {
    r: CEC.LogicalAddress.RECORDINGDEVICE1,
    p: CEC.LogicalAddress.PLAYBACKDEVICE1,
    t: CEC.LogicalAddress.TUNER1,
    a: CEC.LogicalAddress.AUDIOSYSTEM,
};

/**
 * Parse a TRAFFIC line of cec-client.
 *
 * @param {string} line - stdout line, i.e. "TRAFFIC: [   12345]	>> 01:90:00"
 * @returns {{incoming: boolean, source: number, target: number, opcode?: number, args: number[]}|null} frame or null
 */
function parseTrafficLine(line) {
    const match = /^TRAFFIC:\s\[\s*\d*\]\s+(<<|>>)\s+([\da-fA-F]{2}(?::[\da-fA-F]{2})*)\s*$/u.exec(line);
    if (!match) {
        return null;
    }
    const bytes = match[2].split(':').map(h => Number.parseInt(h, 16));
    return {
        incoming: match[1] === '>>',
        source: (bytes[0] & 0xf0) >> 4,
        target: bytes[0] & 0x0f,
        opcode: bytes[1],
        args: bytes.slice(2),
    };
}

/**
 * Format a byte as two digit hex string.
 *
 * @param {number} byte - byte to format
 * @returns {string} hex string
 */
function hex(byte) {
    return byte.toString(16).padStart(2, '0');
}

/**
 * CEC backend that spawns cec-client and parses its stdout.
 */
class CECMonitor extends CecBackend {
    /**
     * @param {import('./cec-backend').CecBackendOptions & {debug?: boolean}} options - backend options
     */
    constructor(options) {
        super(options);
        this.type = options.type || 'p';
        this.osdName = (options.osdName || 'ioBroker').substring(0, 14);
        this.debug = !!options.debug;
        this._ready = false;
        this._ownLogicalAddress = DEFAULT_LOGICAL_ADDRESS[this.type] ?? CEC.LogicalAddress.UNKNOWN;
        this.stopRequested = false;
        /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
        this.client = null;
        /** @type {import('node:readline').Interface | null} */
        this.readline = null;
        /** @type {ioBroker.Timeout | undefined} */
        this.restartTimer = undefined;

        this.params = ['-t', this.type, '-o', this.osdName, '-d', '31'];
        if (options.hdmiPort && options.hdmiPort > 0) {
            this.params.push('-p', String(options.hdmiPort));
        }
        if (options.port) {
            this.params.push(options.port);
        }

        this._onProcessExit = () => this.stop();
    }

    /** @returns {boolean} ready state */
    get ready() {
        return this._ready && !!this.client;
    }

    /** @returns {number} own logical address */
    get ownLogicalAddress() {
        return this._ownLogicalAddress;
    }

    /**
     * Spawns cec-client and waits until it is ready.
     *
     * @returns {Promise<void>} resolves when ready, rejects if cec-client can not be started
     */
    start() {
        this.stopRequested = false;
        process.once('exit', this._onProcessExit);
        return new Promise((resolve, reject) => {
            const onReady = () => {
                this.removeListener('fatal', onFatal);
                resolve();
            };
            const onFatal = e => {
                this.removeListener('ready', onReady);
                reject(e);
            };
            this.once('ready', onReady);
            this.once('fatal', onFatal);
            this._spawn();
        });
    }

    /**
     * Stops cec-client, no restart.
     */
    stop() {
        this.stopRequested = true;
        this._ready = false;
        process.removeListener('exit', this._onProcessExit);
        this.timers.clearTimeout(this.restartTimer);
        if (this.client) {
            this.client.kill('SIGINT');
        }
    }

    /**
     * Spawn cec-client process.
     */
    _spawn() {
        this.emit('log', 'debug', `Starting cec-client ${this.params.join(' ')}`);
        const client = spawn('cec-client', this.params);
        this.client = client;
        this.readline = readline.createInterface({ input: client.stdout });
        this.readline.on('line', line => this._processLine(line));
        client.on('error', e => {
            if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
                this.stopRequested = true;
                const error = /** @type {NodeJS.ErrnoException} */ (
                    new Error(
                        'cec-client not found. Please make sure cec-utils are installed and cec-client can be run by iobroker user.',
                    )
                );
                error.code = 'ENOENT';
                this.emit('fatal', error);
            } else {
                this.emit('log', 'error', `cec-client error: ${e}`);
            }
        });
        client.on('close', code => this._onClose(client, code));
        client.stdin.on('error', e => this.emit('log', 'debug', `cec-client stdin error: ${e}`));
    }

    /**
     * Called when cec-client exited. Restart it, if not stopped on purpose.
     *
     * @param {import('node:child_process').ChildProcess} client - the process that exited
     * @param {number | null} code - exit code
     */
    _onClose(client, code) {
        if (this.client !== client) {
            return; //old process.
        }
        this.client = null;
        this._ready = false;
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        if (this.stopRequested) {
            this.emit('log', 'debug', 'cec-client stopped.');
            return;
        }
        this.emit(
            'log',
            'warn',
            `cec-client exited unexpectedly (code ${code}), restarting in ${RESTART_DELAY / 1000}s.`,
        );
        this.emit('disconnected');
        this.timers.clearTimeout(this.restartTimer);
        this.restartTimer = this.timers.setTimeout(() => {
            if (!this.stopRequested) {
                this._spawn();
            }
        }, RESTART_DELAY);
    }

    /**
     * Processes a line of cec-client stdout.
     *
     * @param {string} line - stdout line
     */
    _processLine(line) {
        if (line.startsWith('TRAFFIC:')) {
            this.emit('log', 'debug', line);
            const frame = parseTrafficLine(line);
            // outgoing frames are logged by cec-client as requested, not necessarily as sent -> ignore them.
            if (frame && frame.incoming) {
                this._received(frame);
            }
        } else if (line.startsWith('DEBUG:')) {
            if (this.debug) {
                this.emit('log', 'debug', line);
            }
        } else if (line.startsWith('NOTICE:')) {
            this._processNotice(line);
            this.emit('log', 'debug', line);
        } else if (line.startsWith('waiting for input')) {
            this._ready = true;
            this.emit('ready');
        } else if (line.startsWith('WARNING:')) {
            this.emit('log', 'debug', line);
            if (line.includes('COMMAND_REJECTED')) {
                this.emit('log', 'warn', 'cec-client reported COMMAND_REJECTED, restarting cec-client.');
                this._ready = false;
                if (this.client) {
                    this.client.kill('SIGINT'); //will be restarted in _onClose.
                }
            }
        } else if (line.startsWith('ERROR:')) {
            this.emit('log', 'warn', line);
        }
    }

    /**
     * Parse our own logical address from notice line.
     *
     * @param {string} line - notice line
     */
    _processNotice(line) {
        const match = /logical address\(es\) = (?:Recorder|Playback|Tuner|Audio)\s?\d?\s?\((\d+)\)/u.exec(line);
        if (match) {
            this._ownLogicalAddress = Number.parseInt(match[1], 10);
        }
    }

    /**
     * Write a line to cec-client.
     *
     * @param {string} line - cec-client command
     * @returns {Promise<void>} resolves when written
     */
    _write(line) {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.ready) {
                reject(new Error('cec-client is not ready'));
                return;
            }
            this.client.stdin.write(`${line}\n`, 'utf8', err => (err ? reject(err) : resolve()));
        });
    }

    /**
     * @param {number} target - logical address of destination
     * @param {number} opcode - opcode
     * @param {number[]} args - operands
     * @returns {Promise<void>}
     */
    _transmit(target, opcode, args) {
        const bytes = [(this._ownLogicalAddress << 4) | target, opcode, ...args];
        return this._write(`tx ${bytes.map(hex).join(':')}`);
    }

    /**
     * @param {number} logicalAddress - device to power on
     * @returns {Promise<void>}
     */
    _powerOn(logicalAddress) {
        return this._write(`on ${logicalAddress.toString(16)}`);
    }

    /**
     * @param {number} logicalAddress - device to put into standby
     * @returns {Promise<void>}
     */
    _standby(logicalAddress) {
        return this._write(`standby ${logicalAddress.toString(16)}`);
    }

    /**
     * @returns {Promise<void>}
     */
    scan() {
        return this._write('scan');
    }

    /**
     * @param {string} command - cec-client command line
     * @returns {Promise<void>}
     */
    sendRaw(command) {
        return this._write(command);
    }
}

CECMonitor.parseTrafficLine = parseTrafficLine;

module.exports = CECMonitor;
