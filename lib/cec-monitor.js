/**
 * Based loosely on the work of @senzil/cec-monitor but reduced a lot to work for this adapter.
 * https://github.com/senzil/cec-monitor
 *
 * @type {NodeJS.EventEmitter}
 */

'use strict';

const events = require('events');
const CEC = require('./cec-constants');
const spawn = require('child_process').spawn;
const readline = require('readline');

class CECMonitor extends events.EventEmitter {
    /**
     * Constructor
     * @param {string} OSDName name to show in CEC-OSDs
     * @param {object} options
     * @param {boolean} [options.debug=false] will emit debug events on cec-client traffic
     * @param {boolean} [options.autoRestart=false] will restart cec-client if problem happens
     * @param {string}  [options.type='r'] type of device to emulate, defaults to 'r' for 'recording'
     * @param {number}  [options.commandTimeout=3] in seconds how long to wait for an answer for a command
     * @param {string}  [options.comPort=''] com port to use
     * @param {number}  [options.hdmiPort=1] hdmi port to use
     */
    constructor(OSDName, options) {
        super();
        this.setMaxListeners(300); //do we really need that??

        this.user_control_hold_interval_ref = null;
        this.debug = options.debug || false;
        this.ready = false;
        this.autoRestarting = false; //flag to recognize if we are auto restarting or not.
        this.autoRestart = options.autoRestart || false;
        this.activeSource = 0;
        this.activeSourcePhysical = '0.0.0.0';
        this.type = options.type || 'r';
        switch (this.type) {
            default:
            case 'r':
                this.ourLogicalAddress = 1;
                break;
            case 'p':
                this.ourLogicalAddress = 4;
                break;
            case 't':
                this.ourLogicalAddress = 3;
                break;
            case 'a':
                this.ourLogicalAddress = 5;
                break;
        }
        this.commandTimeout = options.commandTimeout || 3;
        this.user_control_hold_interval = 1000;

        this.OSDName = OSDName || 'cec-monitor';
        this.comPort = options.comPort || '';

        this.params = ['-t', this.type, '-o', this.OSDName, '-d', '31', '-p', String(options.hdmiPort || 1), String(this.comPort)];
        process.on('beforeExit', this.stop);
        process.on('exit', this.stop);

        this._initCecClient();
    }

    /**
     * Returns logical address of last seen active source
     * @returns {number}
     */
    getActiveSource() {
        return this.activeSource;
    }

    /**
     * Returns physical address of last known active source
     * @returns {string}
     */
    getActiveSourcePhysical() {
        return this.activeSourcePhysical;
    }

    /**
     * Stops cec-monitor.
     */
    stop() {
        if (this.client) {
            this.client.kill('SIGINT');
            this._onClose();
        }
    }

    /**
     * On Close time. Prepare restart cec-client and/or launch _STOP event
     * @private
     */
    _onClose() {
        this.client = null;
        clearInterval(/** @type {NodeJS.Timeout} */ (this.user_control_hold_interval_ref));
        if (this.readline) {
            this.readline.close();
        }
        if (this.autoRestarting) {
            setTimeout(() => {this._initCecClient();}, 15000);
        } else /*if (!this.reconnectIntent)*/ {
            return this.emit(CECMonitor.EVENTS._STOP);
        }/* else if (this.reconnectIntent) {
            setTimeout(() => {this._initCecClient();}, 10000);
        }*/
    }

    /**
     * Spawns and initializes connection to cec-monitor process
     * @returns {null|import('child_process').ChildProcess}
     * @private
     */
    _initCecClient() {
        this.client = spawn('cec-client', this.params);
        this.readline = readline.createInterface({
            input: this.client.stdout
        });
        this.readline.on('line', (line) => this._processStdOut(line));
        this.client.on('close', () => { this._onClose();});
        this.client.on('error', e => this.emit('_error', e));
        return this.client;
    }

    /**
     * Processes stdOut of cec-monitor
     * @param {string} data
     * @private
     */
    _processStdOut(data) {
        if (/^TRAFFIC:.*/g.test(data)){
            this._processTraffic(data);
        } else if (/^DEBUG:.*/g.test(data) && this.debug) {
            this.emit(CECMonitor.EVENTS._DEBUG, data);
        } else if (/^NOTICE:.*/g.test(data)){
            this._processNotice(data);
        } else if (/^waiting for input.*/g.test(data)) {
            this.autoRestarting = false;
            this.ready = true;
            this.emit(CECMonitor.EVENTS._READY);
        } else if (/^WARNING:.*/g.test(data)){
            if (/COMMAND_REJECTED/gu.test(data)) {
                this.ready = false;
                this.autoRestarting = true;
                this.stop();
            }
            this.emit(CECMonitor.EVENTS._WARNING, data);
        } else if (/^ERROR:.*/g.test(data)){
            this.emit(CECMonitor.EVENTS._ERROR, data);
        } /*else if (/(^no serial port given\. trying autodetect: FAILED)|(^Connection lost)/gu.test(data)) {
            if (this.no_serial.reconnect) {
                this.reconnectIntent = true;
                this.ready = false;
            }
            this.emit(CECMonitor.EVENTS._NO_SERIAL_PORT);
        }*/

        this.emit(CECMonitor.EVENTS._DATA, data);
    }

    /**
     * Process notice text from cec-client
     * @param {String} data:  notice stdout text
     * @private
     */
    _processNotice(data) {
        const regexLogical = /logical\saddress\(es\)\s=\s((Recorder|Playback|Tuner|Audio)\s\d?\s?\(\d\)\s){1,4}/gu;
        const match = regexLogical.exec(data);
        if (match) {
            const regexAddresses = /(Recorder\s\d\s|Playback\s\d\s|Tuner\s\d\s|Audio\s)\(?(\d)\)/gu;
            const innerMatch = regexAddresses.exec(match[0]);
            if (innerMatch) {
                this.ourLogicalAddress = Number.parseInt(innerMatch[2], 10);
            }
        }
        return this.emit(CECMonitor.EVENTS._NOTICE, data);
    }

    /**
     * Parse the packet info from stdout
     * @param {String} plain stdout text
     * @private
     */
    _readPacket(plain) {
        const regex = /^(TRAFFIC|DEBUG):\s\[\s*(\d*)\]\s(<<|>>)\s(([\d\w]{2}[:]?)+)$/gu;
        const match = regex.exec(plain);
        if (match) {
            const tokens = match[4].split(':').map(h => parseInt(h, 16));
            const packet = {
                type: match[1],
                number: match[2],
                flow: match[3] === '>>' ? 'IN' : 'OUT',
                source: (tokens[0] & 0xF0) >> 4,
                target: tokens[0] & 0x0F,
                opcode: tokens[1],
                args: tokens.slice(2)
            };
            this.emit(CECMonitor.EVENTS._PACKET, packet);
            return packet;
        }
        return null;
    }

    /**
     *
     * @param {String} plain stdout text
     * @private
     */
    _processTraffic(plain) {
        this.emit(CECMonitor.EVENTS._TRAFFIC, plain);
        const packet = this._readPacket(plain);

        if (packet) {
            if (packet.flow === 'IN') {
                this.emit(CECMonitor.EVENTS._RECEIVED, packet);
            } else {
                this.emit(CECMonitor.EVENTS._SEND, packet);
            }
            if (!packet.opcode){
                this.emit(CECMonitor.EVENTS.POLLING_MESSAGE, packet);
            } else {
                this._processEvents(packet);
            }
        }
    }

    /**
     * Process all received events
     * @param {Object} packet
     * @private
     */
    _processEvents(packet) {
        let data = {};

        // Store opcode name as event property
        packet.event = CEC.OpcodeNames[packet.opcode];

        switch (packet.opcode) {
            case CEC.Opcode.ACTIVE_SOURCE: {
                if (packet.args.length !== 2) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command ACTIVE_SOURCE with bad format address');
                }
                this.activeSource = packet.source; //remember last active source
                const source = argsToPhysical(packet.args);
                const physical = physicalToRoute(source);
                this.activeSourcePhysical = physical;
                data = {
                    val: source,
                    str: physical
                };
                break;
            }

            case CEC.Opcode.CEC_VERSION: {
                if (packet.args.length !== 1) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command CEC_VERSION without version');
                }
                data = {
                    val: packet.args[0],
                    str: CEC.CECVersionNames[packet.args[0]]
                };
                break;
            }

            case CEC.Opcode.DECK_STATUS: {
                if (packet.args.length !== 2) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command DECK_STATUS without Deck Info');
                }
                const status = packet.args[0] << 8 | packet.args[1];
                data = {
                    val: status,
                    str: CEC.DeckStatusNames[status]
                };
                break;
            }

            case CEC.Opcode.DEVICE_VENDOR_ID: {
                if (packet.args.length !== 3) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command DEVICE_VENDOR_ID with bad arguments');
                }
                const vendor = packet.args[0] << 16 | packet.args[1] << 8 | packet.args[2];
                data = {
                    val: vendor,
                    str: CEC.VendorIdNames[vendor] || CEC.VendorIdNames[CEC.VendorId.UNKNOWN]
                };
                break;
            }

            case CEC.Opcode.REPORT_PHYSICAL_ADDRESS: {
                if (packet.args.length !== 3) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command REPORT_PHYSICAL_ADDRESS with bad format address or device type');
                }
                const physical = argsToPhysical(packet.args);
                data = {
                    val: physical,
                    str: physicalToRoute(physical)
                };
                break;
            }

            case CEC.Opcode.REPORT_POWER_STATUS: {
                if (packet.args.length !== 1) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command REPORT_POWER_STATUS with bad format power status');
                }
                const status = packet.args[0];
                data = {
                    val: status,
                    str: CEC.PowerStatusNames[status]
                };
                break;
            }

            case CEC.Opcode.ROUTING_CHANGE: {
                if (packet.args.length !== 4) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command ROUTING_CHANGE with bad format addresses');
                }
                const from = argsToPhysical(packet.args.slice(0, 2));
                const to = argsToPhysical(packet.args.slice(2, 4));
                data = {
                    from: {
                        val: from,
                        str: physicalToRoute(from)
                    },
                    to: {
                        val: to,
                        str: physicalToRoute(to)
                    }
                };
                break;
            }

            case CEC.Opcode.SET_OSD_NAME: {
                if (!packet.args.length) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command SET_OSD_NAME without OSD NAME');
                }
                // Update our records
                const name = argsToOSDName(packet.args);
                data = {
                    val: packet.args,
                    str: name
                };
                break;
            }

            case CEC.Opcode.STANDBY:
            case CEC.Opcode.IMAGE_VIEW_ON:
            case CEC.Opcode.TEXT_VIEW_ON: {
                if (packet.args.length !== 0) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command with bad args');
                }
                break;
            }

            case CEC.Opcode.MENU_REQUEST: {
                if (packet.args.length !== 1) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command MENU_REQUEST with bad args');
                }
                data = {
                    val: packet.args[0],
                    str: CEC.MenuRequestTypeNames[packet.args[0]]
                };
                break;
            }

            case CEC.Opcode.USER_CONTROL_PRESSED: {
                if (packet.args.length !== 1) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command USER_CONTROL_PRESSED with bad args');
                }
                data = {
                    val: packet.args[0],
                    str: CEC.UserControlCodeNames[packet.args[0]]
                };
                clearInterval(/** @type {NodeJS.Timeout} */ (this.user_control_hold_interval_ref));
                this.user_control_hold_interval_ref = setInterval(() => this.emit(CECMonitor.EVENTS._USERCONTROLHOLD, data), this.user_control_hold_interval);
                break;
            }

            case CEC.Opcode.USER_CONTROL_RELEASE: {
                clearInterval(/** @type {NodeJS.Timeout} */(this.user_control_hold_interval_ref));
                if (packet.args.length !== 0) {
                    return this.emit(CECMonitor.EVENTS._ERROR, 'opcode command USER_CONTROL_RELEASE with bad args');
                }
                break;
            }
        }

        packet.data = data;
        if (packet.event !== null) {
            // Emit all OPCODE events to '_opcode' event
            this.emit(CECMonitor.EVENTS._OPCODE, packet);

            return this.emit(packet.event, packet);
        }
    }

    /**
     * Send a 'tx' message on CEC bus and wait for a event like response or timeout
     * @async
     * @param {String|Number|null} source Logical address for source of message (defaults to own address if null)
     * @param {String|Number} target Logical address for target of message (defaults to broadcast if null)
     * @param {String|Number} opcode Opcode for message expressed as a byte value or STRING label
     * @param {String} event to wait for a response
     * @param {String|Number|Array<number>} [args] Optional arguments for opcode, type depending on opcode
     * @example
     * monitor.SendCommand(CEC.LogicalAddress.RECORDER1, CEC.LogicalAddress.TV, CEC.Opcode.GIVE_DEVICE_POWER_STATUS, CECMonitor.EVENTS.REPORT_POWER_STATUS);
     * source, logical, opcode and args work like SendMessage function
     * @see SendMessage
     * @return {Promise} When promise is resolved, the message is sent and get the packet from the event as response, otherwise if rejected, the cec adapter is not ready or the event did timeout
     * @throws CECAdapterNotReadyError
     * @throws CECTimeoutError
     */
    async sendCommand(source, target, opcode, event, args) {
        source = _parseAddress(source, this.ourLogicalAddress);
        target = _parseAddress(target, CEC.LogicalAddress.BROADCAST);

        await this.sendMessage(source, target, opcode, args);
        return this.waitForAnswer(target, event, this.commandTimeout * 1000);
    }

    /**
     * Binds a new listener to this, waiting on for answer 'event' from 'target' for 'millisecondsToWait' or rejects with timeout.
     * @param {number} target logical address of target as number
     * @param {string} event name of event (from EVENTS array)
     * @param millisecondsToWait timeout
     * @returns {Promise<event>}
     */
    waitForAnswer(target, event, millisecondsToWait) {
        let listener, timeout;

        const removeListener = () => {
            this.removeListener(event, listener);
        };

        return new Promise((resolve, reject) => {
            listener = packet => {
                if (packet.source === target){
                    clearTimeout(timeout);
                    removeListener();
                    resolve(packet);
                }
            };
            timeout = setTimeout(() => {
                removeListener();
                reject(new Error(`CEC monitor hasn't gotten response in some time (${millisecondsToWait} ms) from ${target}`));
            }, millisecondsToWait);

            this.on(event, listener);
        });
    }

    /**
     * Send a 'tx' message on CEC bus
     *
     * @param {string|number|null} source Logical address for source of message (defaults to own address if null)
     * @param {string|number} target Logical address for target of message (defaults to broadcast if null)
     * @param {string|number} _opcode Opcode for message expressed as a byte value or STRING label
     * @param {string|number|Array<number>} [args] Optional arguments for opcode, type depending on opcode
     * @example
     * monitor.SendMessage(CEC.LogicalAddress.PLAYBACKDEVICE1, CEC.LogicalAddress.BROADCAST, CEC.Opcode.SET_OSD_NAME,[0x46,0x72,0x69,0x73,0x62,0x65,0x65]);
     * @example
     * monitor.SendMessage(4, 15, 70, [70,114,105,115,98,101,101];
     * @example
     * monitor.SendMessage('0x4', '0xF', '0x46', [0x46,0x72,0x69,0x73,0x62,0x65,0x65]);
     * @example
     * monitor.SendMessage('PLAYBACKDEVICE1','BROADCAST','SET_OSD_NAME','Frisbee');
     * @example
     * monitor.SendMessage('playbackdevice1', 'broadcast', 'set_osd_name','Frisbee');
     * @example
     * // Can specify physical address as string, using dot notation
     * monitor.SendMessage(CEC.LogicalAddress.UNREGISTERED, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE,'2.0.0.0');
     * // Or as an array of bytes
     * monitor.SendMessage(CEC.LogicalAddress.UNREGISTERED, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE,[0x20,0x0]);
     * @example
     * // Default source is the client - default destination is broadcast
     * monitor.SendMessage(null,null, 'set_osd_name','Frisbee');
     * @see cec
     * @see WriteMessage
     * @return {Promise} When promise is resolved, the message is sent, otherwise if rejected, the cec adapter is not ready
     * @throws CECAdapterNotReadyError
     */
    async sendMessage(source, target, _opcode, _args) {
        const _source = _parseAddress(source, this.ourLogicalAddress);
        const _target = _parseAddress(target, CEC.LogicalAddress.BROADCAST);

        let opcode = _opcode;
        if (typeof _opcode === 'string') {
            if (isHexNumber(_opcode)){
                opcode = Number.parseInt(_opcode, 16);
            } else if (CEC.Opcode[_opcode.toUpperCase()]) {
                opcode = CEC.Opcode[_opcode.toUpperCase()];
            }
        }

        let args = _args;
        if (typeof _args === 'string') {
            // If a physical address
            if (isRoute(_args)) {
                args = routeToArgs(_args);
            }
            else if (isHexNumber(_args)){
                args = Number.parseInt(_args, 16);
            }
            // Otherwise treat as string argument
            else {
                args = _args.split('').map(s => s.charCodeAt(0));
            }
        }
        return this.writeMessage(_source, _target, opcode, args);
    }

    /**
     * Write string to cec-monitor
     * @param {string} raw - needs to be valid cec-monitor command
     * @returns {Promise<boolean>}
     */
    async writeRawMessage(raw) {
        if (this.client && this.ready) {
            try {
                return this.client.stdin.write(raw + '\n');
            } catch (e) {
                console.log('Is not possible write messages to the cec adapter right now');
                console.log(e);
                throw e;
            }
        }
        console.log('the cec adapter is not ready');
        throw new Error('The CEC adapter is not ready to receive massages');
    }

    /**
     * Build and write message to cec-monitor
     * @param {number} source
     * @param {number} target
     * @param {number} opcode
     * @param {Array<number>|number|undefined} args
     * @returns {Promise<boolean>}
     */
    async writeMessage(source, target, opcode, args) {
        const msg = `tx ${[((source << 4) + target), opcode].concat(args || []).map(h => `0${h.toString(16)}`.substr(-2)).join(':')}`;
        return this.writeRawMessage(msg);
    }

    /**
     * Will resolve, when cec-client if finally ready.
     * @returns {Promise<void>}
     */
    async waitForReady() {
        return new Promise((resolve) => {
            this.once(CECMonitor.EVENTS._READY, () => {
                resolve();
            });
        });
    }
}

/**
 * Possible Events of CECMonitor.
 * @type {Record<String, String>}
 */
CECMonitor.EVENTS = {
    _DATA: '_data',
    _DEBUG: '_debug',
    _ERROR: '_error',
    _NOTICE: '_notice',
    _PACKET: '_packet',
    _READY: '_ready',
    _RECEIVED: '_received',
    _SEND: '_send',
    _STOP: '_stop',
    _TRAFFIC: '_traffic',
    _OPCODE: '_opcode',
    _WARNING: '_warning',
    _NO_SERIAL_PORT: '_no_serial_port',
    _NO_HDMI_CORD: '_no_hdmi_cord',
    _EXPIRED_CACHE: '_expired_cache',
    _UPDATEDCACHE: '_updated_cache',
    _USERCONTROLHOLD: '_user_control_hold',
    ABORT: 'ABORT',
    ACTIVE_SOURCE: 'ACTIVE_SOURCE',
    CEC_VERSION: 'CEC_VERSION',
    CLEAR_ANALOGUE_TIMER: 'CLEAR_ANALOGUE_TIMER',
    CLEAR_DIGITAL_TIMER: 'CLEAR_ANALOGUE_TIMER',
    CLEAR_EXTERNAL_TIMER: 'CLEAR_EXTERNAL_TIMER',
    DECK_CONTROL: 'DECK_CONTROL',
    DECK_STATUS: 'DECK_STATUS',
    DEVICE_VENDOR_ID: 'DEVICE_VENDOR_ID',
    FEATURE_ABORT: 'FEATURE_ABORT',
    GET_CEC_VERSION: 'GET_CEC_VERSION',
    GET_MENU_LANGUAGE: 'GET_MENU_LANGUAGE',
    GIVE_AUDIO_STATUS: 'GIVE_AUDIO_STATUS',
    GIVE_DECK_STATUS: 'GIVE_DECK_STATUS',
    GIVE_DEVICE_POWER_STATUS: 'GIVE_DEVICE_POWER_STATUS',
    GIVE_DEVICE_VENDOR_ID: 'GIVE_DEVICE_VENDOR_ID',
    GIVE_OSD_NAME: 'GIVE_OSD_NAME',
    GIVE_PHYSICAL_ADDRESS: 'GIVE_PHYSICAL_ADDRESS',
    GIVE_SYSTEM_AUDIO_MODE_STATUS: 'GIVE_SYSTEM_AUDIO_MODE_STATUS',
    GIVE_TUNER_DEVICE_STATUS: 'GIVE_TUNER_DEVICE_STATUS',
    IMAGE_VIEW_ON: 'IMAGE_VIEW_ON',
    INACTIVE_SOURCE: 'INACTIVE_SOURCE',
    MENU_REQUEST: 'MENU_REQUEST',
    MENU_STATUS: 'MENU_STATUS',
    PLAY: 'PLAY',
    POLLING_MESSAGE: 'POLLING_MESSAGE',
    RECORD_OFF: 'RECORD_OFF',
    RECORD_ON: 'RECORD_ON',
    RECORD_STATUS: 'RECORD_STATUS',
    RECORD_TV_SCREEN: 'RECORD_TV_SCREEN',
    REPORT_AUDIO_STATUS: 'REPORT_AUDIO_STATUS',
    REPORT_PHYSICAL_ADDRESS: 'REPORT_PHYSICAL_ADDRESS',
    REPORT_POWER_STATUS: 'REPORT_POWER_STATUS',
    REQUEST_ACTIVE_SOURCE: 'REQUEST_ACTIVE_SOURCE',
    ROUTING_CHANGE: 'ROUTING_CHANGE',
    ROUTING_INFORMATION: 'ROUTING_INFORMATION',
    SELECT_ANALOGUE_SERVICE: 'SELECT_ANALOGUE_SERVICE',
    SELECT_DIGITAL_SERVICE: 'SELECT_DIGITAL_SERVICE',
    SET_ANALOGUE_TIMER: 'SET_ANALOGUE_TIMER',
    SET_AUDIO_RATE: 'SET_AUDIO_RATE',
    SET_DIGITAL_TIMER: 'SET_DIGITAL_TIMER',
    SET_EXTERNAL_TIMER: 'SET_EXTERNAL_TIMER',
    SET_MENU_LANGUAGE: 'SET_MENU_LANGUAGE',
    SET_OSD_NAME: 'SET_OSD_NAME',
    SET_OSD_STRING: 'SET_OSD_STRING',
    SET_STREAM_PATH: 'SET_STREAM_PATH',
    SET_SYSTEM_AUDIO_MODE: 'SET_SYSTEM_AUDIO_MODE',
    SET_TIMER_PROGRAM_TITLE: 'SET_TIMER_PROGRAM_TITLE',
    STANDBY: 'STANDBY',
    SYSTEM_AUDIO_MODE_REQUEST: 'SYSTEM_AUDIO_MODE_REQUEST',
    SYSTEM_AUDIO_MODE_STATUS: 'SYSTEM_AUDIO_MODE_STATUS',
    TEXT_VIEW_ON: 'TEXT_VIEW_ON',
    TIMER_CLEARED_STATUS: 'TIMER_CLEARED_STATUS',
    TIMER_STATUS: 'TIMER_STATUS',
    TUNER_DEVICE_STATUS: 'TUNER_DEVICE_STATUS',
    TUNER_STEP_DECREMENT: 'TUNER_STEP_DECREMENT',
    TUNER_STEP_INCREMENT: 'TUNER_STEP_INCREMENT',
    USER_CONTROL_PRESSED: 'USER_CONTROL_PRESSED',
    USER_CONTROL_RELEASE: 'USER_CONTROL_RELEASE',
    VENDOR_COMMAND: 'VENDOR_COMMAND',
    VENDOR_COMMAND_WITH_ID: 'VENDOR_COMMAND_WITH_ID',
    VENDOR_REMOTE_BUTTON_DOWN: 'VENDOR_REMOTE_BUTTON_DOWN',
    VENDOR_REMOTE_BUTTON_UP: 'VENDOR_REMOTE_BUTTON_UP'
};

/** Internal functions **/

/**
 * Determine if provided string matches a hexadecimal number representation
 * @param {String} address Address to test
 * @return {Boolean} True if it matches form 0.0.0.0 otherwise false
 */
function isHexNumber(address) {
    return /^0[xX][\da-fA-F]+$/giu.test(address);
}

/**
 * Determine if provided string matches a CEC physical address
 * @param {String} address Address to test
 * @return {Boolean} True if it matches form 0.0.0.0 otherwise false
 */
function isRoute(address) {
    return /^\d\.\d\.\d\.\d$/gui.test(address);
}

/**
 * Convert integer CEC protocol notation into string formatted physical address
 * @param {Number} address An array of byte values
 * @return {string} Physical address in . notation ie 0.0.0.0
 */
function physicalToRoute(address) {
    return (`0000${address.toString(16)}`).slice(-4).split('').join('.');
}

/**
 * Convert array of values from CEC into Number formatted physical address
 * @param {number[]} args An array of byte values
 * @return {Number} Physical address in integer CEC protocol notation
 */
function argsToPhysical(args) {
    return args[0] << 8 | args[1];
}

/**
 * Convert array of values from CEC into OSD Name
 * @param {Number[]} args An array of byte values
 * @return {String} OSD Name
 */
function argsToOSDName(args) {
    return String.fromCharCode.apply(null, args);
}

/**
 * Convert a Number formatted physical address into array of values to CEC
 * @param {Number} address a Physical address in integer CEC protocol notation
 * @return {Number[]} An array of byte values
 */
function physicalToArgs(address) {
    return [address >> 8, address & 0xFF];
}

/**
 * Convert string formatted physical address into integer CEC protocol notation
 * @param {String} address Physical address in . notation ie 0.0.0.0
 * @return {Number} Physical address in integer CEC protocol notation
 */
function routeToPhysical(address) {
    return Number.parseInt(address.split('.').join(''), 16);
}

/**
 * Convert string formatted physical address of form 0.0.0.0 to two-byte array
 *
 * @param {string} address Physical address to convert
 * @return {number[]} A two-byte encoded version represented as an array
 */
function routeToArgs(address) {
    return physicalToArgs(routeToPhysical(address));
}

/**
 * Parse any address format and convert to logical address
 * @param {number|string|null} address Address to parse/convert to logical address
 * @param {number} def Default logical address if address invalid
 * @returns {number}
 */
function _parseAddress(address, def) {
    let addr = /** @type number */ (address);
    if (typeof address === 'string') {
        if (isHexNumber(address)) {
            addr = Number.parseInt(address, 16);
        } else if (CEC.LogicalAddress[address.toUpperCase()]) {
            addr = CEC.LogicalAddress[address.toUpperCase()];
        } else {
            addr = Number.parseInt(address, 10);
        }
    }

    if (Number.isNaN(addr) || addr === null) {
        addr = def;
    } else if (addr > 15 || addr < 0) {
        addr = def;
    }
    return addr;
}

module.exports = CECMonitor;
