'use strict';

/**
 * Abstract interface between the adapter and the library / tool that talks to the CEC bus.
 *
 * The adapter only uses the methods and events defined here. Implementations:
 *  - lib/cec-monitor.js: spawns libCEC's cec-client and parses its output
 *  - (later) libCEC Node.js binding
 *
 * All messages are sent from our own logical address. There is deliberately no way to send with a
 * different initiator, that is not allowed by the CEC spec and rejected by the Linux kernel.
 *
 * Events:
 *  - 'ready'         backend connected, own logical address known
 *  - 'disconnected'  connection lost, implementation tries to reconnect
 *  - 'message'       (CecMessage) decoded message received from another device
 *  - 'log'           (level: 'debug'|'info'|'warn'|'error', message: string)
 *  - 'fatal'         (Error) unrecoverable error, i.e. cec-client not installed
 */

const EventEmitter = require('node:events');
const CEC = require('./cec-constants');
const protocol = require('./cec-protocol');

/**
 * @typedef {import('./cec-protocol').CecMessage} CecMessage
 */

/**
 * Timer functions, usually the adapter instance, so timers are cleaned up on unload.
 *
 * @typedef Timers
 * @type {object}
 * @property {(cb: () => void, ms: number) => ioBroker.Timeout | undefined} setTimeout - start timer
 * @property {(timeout: ioBroker.Timeout | undefined) => void} clearTimeout - stop timer
 */

/**
 * Common options for all backends.
 *
 * @typedef CecBackendOptions
 * @type {object}
 * @property {Timers} timers - timer functions
 * @property {string} [osdName] - name to show in CEC OSDs
 * @property {'p'|'r'|'t'|'a'} [type] - device type to emulate: playback, recording, tuner, audio
 * @property {number} [hdmiPort] - HDMI port of the base device we are connected to, 0 = autodetect
 * @property {string} [port] - device / com port of the CEC adapter, empty = autodetect
 * @property {number} [responseTimeout] - default time in ms to wait for an answer in request()
 */

/** Repetition time for USER_CONTROL_PRESSED while a key is held (spec: 200 - 500 ms, recommended 450 ms). */
const KEY_REPEAT_INTERVAL = 450;

/**
 * Base class of all CEC backends, see top of file.
 */
class CecBackend extends EventEmitter {
    /**
     * @param {CecBackendOptions} options - backend options
     */
    constructor(options) {
        super();
        this.setMaxListeners(100);
        this.options = options;
        this.timers = options.timers;
        this.responseTimeout = options.responseTimeout || 3000;
        /** logical address of last active source seen on the bus */
        this.activeSourceLogical = CEC.LogicalAddress.UNKNOWN;
        /** physical address of last active source seen on the bus, dot notation */
        this.activeSourcePhysical = '';
    }

    // ---------------------------------------------------------------------------------------------
    // Methods to be implemented by backends
    // ---------------------------------------------------------------------------------------------

    /**
     * Connect to the CEC bus.
     *
     * @returns {Promise<void>} resolves when ready, rejects on fatal errors
     */
    async start() {
        throw new Error('start() not implemented');
    }

    /**
     * Disconnect from the CEC bus. No reconnect will be tried.
     */
    stop() {
        throw new Error('stop() not implemented');
    }

    /**
     * True if backend is connected and can send messages.
     *
     * @returns {boolean} ready state
     */
    get ready() {
        return false;
    }

    /**
     * Our own logical address.
     *
     * @returns {number} logical address
     */
    get ownLogicalAddress() {
        return CEC.LogicalAddress.UNKNOWN;
    }

    /**
     * Send a frame from our own logical address. Implementations must override this.
     *
     * @param {number} _target - logical address of destination, already validated
     * @param {number} _opcode - opcode
     * @param {number[]} _args - operands, bytes
     * @returns {Promise<void>} resolves when the frame was handed to the library
     */
    async _transmit(_target, _opcode, _args) {
        throw new Error('_transmit() not implemented');
    }

    /**
     * Power on a device. Implementations must override this.
     *
     * @param {number} _logicalAddress - device to power on, already validated
     * @returns {Promise<void>}
     */
    async _powerOn(_logicalAddress) {
        throw new Error('_powerOn() not implemented');
    }

    /**
     * Put a device into standby. Implementations must override this.
     *
     * @param {number} _logicalAddress - device to put into standby, already validated
     * @returns {Promise<void>}
     */
    async _standby(_logicalAddress) {
        throw new Error('_standby() not implemented');
    }

    /**
     * Scan the bus for devices. Found devices will show up as messages.
     *
     * @returns {Promise<void>}
     */
    async scan() {
        throw new Error('scan() not implemented');
    }

    /**
     * Send a backend specific raw command (i.e. a cec-client command line).
     *
     * @param {string} _command - raw command
     * @returns {Promise<void>}
     */
    async sendRaw(_command) {
        throw new Error('sendRaw() not supported by this backend');
    }

    // ---------------------------------------------------------------------------------------------
    // Common functionality
    // ---------------------------------------------------------------------------------------------

    /**
     * Send a frame from our own logical address.
     *
     * @param {number} target - logical address of destination (15 = broadcast)
     * @param {number} opcode - opcode
     * @param {number|number[]} [args] - operands
     * @returns {Promise<void>}
     * @throws {Error} if target is not a valid logical address or backend is not ready
     */
    async transmit(target, opcode, args = []) {
        this._checkTarget(target);
        const bytes = Array.isArray(args) ? args : [args];
        if (bytes.some(b => !Number.isInteger(b) || b < 0 || b > 0xff)) {
            throw new Error(`Invalid operands ${JSON.stringify(bytes)}`);
        }
        return this._transmit(target, opcode, bytes);
    }

    /**
     * Power on a device.
     *
     * @param {number} logicalAddress - device to power on
     * @returns {Promise<void>}
     */
    async powerOn(logicalAddress) {
        this._checkTarget(logicalAddress);
        return this._powerOn(logicalAddress);
    }

    /**
     * Put a device into standby.
     *
     * @param {number} logicalAddress - device to put into standby
     * @returns {Promise<void>}
     */
    async standby(logicalAddress) {
        this._checkTarget(logicalAddress);
        return this._standby(logicalAddress);
    }

    /**
     * Send a frame and wait for the answer.
     *
     * @param {number} target - logical address of destination
     * @param {number} opcode - opcode
     * @param {number|number[]} args - operands
     * @param {number} responseOpcode - opcode of the expected answer
     * @param {number} [timeout] - time to wait in ms
     * @returns {Promise<CecMessage>} answer, rejects on timeout or FEATURE_ABORT
     */
    async request(target, opcode, args, responseOpcode, timeout = this.responseTimeout) {
        /** @type {(message: CecMessage) => void} */
        let listener = () => {};
        /** @type {ioBroker.Timeout | undefined} */
        let timer;
        const answer = new Promise((resolve, reject) => {
            listener = message => {
                if (message.source !== target) {
                    return;
                }
                if (message.opcode === responseOpcode) {
                    resolve(message);
                } else if (message.opcode === CEC.Opcode.FEATURE_ABORT && message.data.val === opcode) {
                    reject(new Error(`${CEC.OpcodeNames[opcode]} refused by ${target}: ${message.data.reasonStr}`));
                }
            };
            timer = this.timers.setTimeout(
                () => reject(new Error(`No answer from ${target} to ${CEC.OpcodeNames[opcode]} within ${timeout} ms`)),
                timeout,
            );
            this.on('message', listener);
        });
        // prevent unhandled rejection warnings while transmit is still running, result is awaited below.
        answer.catch(() => undefined);
        try {
            await this.transmit(target, opcode, args);
            return await answer;
        } finally {
            this.timers.clearTimeout(timer);
            this.removeListener('message', listener);
        }
    }

    /**
     * Press a remote control key on a device, repeat it while held and release it afterwards.
     *
     * @param {number} target - logical address of destination
     * @param {number} key - user control code
     * @param {number} [duration] - time in ms the key is held, 0 = release immediately
     * @returns {Promise<void>} resolves after the key was released
     */
    async sendKeyPress(target, key, duration = 0) {
        await this.transmit(target, CEC.Opcode.USER_CONTROL_PRESSED, key);
        let held = 0;
        while (held + KEY_REPEAT_INTERVAL < duration) {
            await this._sleep(KEY_REPEAT_INTERVAL);
            held += KEY_REPEAT_INTERVAL;
            await this.transmit(target, CEC.Opcode.USER_CONTROL_PRESSED, key);
        }
        if (duration > held) {
            await this._sleep(duration - held);
        }
        await this.transmit(target, CEC.Opcode.USER_CONTROL_RELEASE);
    }

    /**
     * Last active source seen on the bus.
     *
     * @returns {{logicalAddress: number, physicalAddress: string}} active source
     */
    getActiveSource() {
        return { logicalAddress: this.activeSourceLogical, physicalAddress: this.activeSourcePhysical };
    }

    /**
     * To be called by implementations for every received frame. Decodes and emits it.
     *
     * @param {{source: number, target: number, opcode?: number, args?: number[]}} frame - raw frame
     */
    _received(frame) {
        const message = protocol.decodeMessage(frame);
        if (message.error) {
            this.emit('log', 'debug', `Ignoring malformed message from ${message.source}: ${message.error}`);
            return;
        }
        if (message.opcode === CEC.Opcode.ACTIVE_SOURCE) {
            this.activeSourceLogical = message.source;
            this.activeSourcePhysical = message.data.str || '';
        }
        this.emit('message', message);
    }

    /**
     * Throws if target is not a valid logical address or backend is not ready.
     *
     * @param {number} target - logical address
     */
    _checkTarget(target) {
        if (!protocol.isValidLogicalAddress(target)) {
            throw new Error(`Invalid target logical address ${target}, device not active?`);
        }
        if (!this.ready) {
            throw new Error('CEC backend not ready');
        }
    }

    /**
     * Wait some time using adapter timers.
     *
     * @param {number} ms - time to wait
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise(resolve => this.timers.setTimeout(resolve, ms));
    }
}

CecBackend.KEY_REPEAT_INTERVAL = KEY_REPEAT_INTERVAL;

module.exports = CecBackend;
