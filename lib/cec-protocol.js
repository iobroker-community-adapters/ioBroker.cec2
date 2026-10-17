'use strict';

/**
 * Backend independent CEC protocol helpers: address conversion and decoding of CEC frames.
 * Used by all backends, so that every backend emits the same message format.
 */

const CEC = require('./cec-constants');

/**
 * Decoded CEC message as emitted by backends.
 *
 * @typedef CecMessage
 * @type {object}
 * @property {number} source - logical address of initiator
 * @property {number} target - logical address of destination (15 = broadcast)
 * @property {number} [opcode] - CEC opcode, undefined for polling messages
 * @property {Array<number>} args - opcode operands as bytes
 * @property {string} event - opcode name (key of CEC.Opcode), or 'POLLING_MESSAGE'
 * @property {CecMessageData} data - decoded operands, usually {val, str}
 * @property {string} [error] - set if operands are malformed, data is empty then
 */

/**
 * Decoded operands of a CEC message. Content depends on opcode.
 *
 * @typedef CecMessageData
 * @type {object}
 * @property {number|string} [val] - main value
 * @property {string} [str] - string representation of main value
 * @property {boolean} [mute] - REPORT_AUDIO_STATUS: audio is muted
 * @property {number} [reason] - FEATURE_ABORT: abort reason
 * @property {string} [reasonStr] - FEATURE_ABORT: abort reason as string
 * @property {number} [deviceType] - REPORT_PHYSICAL_ADDRESS: device type
 * @property {{val: number, str: string}} [from] - ROUTING_CHANGE: old physical address
 * @property {{val: number, str: string}} [to] - ROUTING_CHANGE: new physical address
 */

/** Event name used for polling messages (frames without opcode). */
const POLLING_MESSAGE = 'POLLING_MESSAGE';

/** Maximum length of an OSD string in SET_OSD_STRING (CEC spec). */
const MAX_OSD_STRING_LENGTH = 13;

/**
 * Determine if provided string matches a hexadecimal number representation
 *
 * @param {string} value - string to test
 * @returns {boolean} true if it matches 0x...
 */
function isHexNumber(value) {
    return /^0[xX][\da-fA-F]+$/u.test(value);
}

/**
 * Determine if provided string matches a CEC physical address
 *
 * @param {string} address - address to test
 * @returns {boolean} true if it matches form 0.0.0.0
 */
function isRoute(address) {
    return /^[\da-fA-F]\.[\da-fA-F]\.[\da-fA-F]\.[\da-fA-F]$/u.test(address);
}

/**
 * Convert integer physical address into dot notation
 *
 * @param {number} address - physical address as 16 bit number
 * @returns {string} physical address in dot notation, i.e. 1.0.0.0
 */
function physicalToRoute(address) {
    return `0000${address.toString(16)}`.slice(-4).split('').join('.');
}

/**
 * Convert dot notation into integer physical address
 *
 * @param {string} address - physical address in dot notation, i.e. 1.0.0.0
 * @returns {number} physical address as 16 bit number
 */
function routeToPhysical(address) {
    return Number.parseInt(address.split('.').join(''), 16);
}

/**
 * Convert two operand bytes into integer physical address
 *
 * @param {number[]} args - operand bytes
 * @returns {number} physical address as 16 bit number
 */
function argsToPhysical(args) {
    return (args[0] << 8) | args[1];
}

/**
 * Convert integer physical address into two operand bytes
 *
 * @param {number} address - physical address as 16 bit number
 * @returns {number[]} operand bytes
 */
function physicalToArgs(address) {
    return [address >> 8, address & 0xff];
}

/**
 * Convert dot notation into two operand bytes
 *
 * @param {string} address - physical address in dot notation, i.e. 1.0.0.0
 * @returns {number[]} operand bytes
 */
function routeToArgs(address) {
    return physicalToArgs(routeToPhysical(address));
}

/**
 * Convert a string to operand bytes, non ASCII characters are replaced by '?'.
 *
 * @param {string} text - text to convert
 * @returns {number[]} operand bytes
 */
function stringToArgs(text) {
    return text.split('').map(c => {
        const code = c.charCodeAt(0);
        return code >= 0x20 && code < 0x7f ? code : 0x3f;
    });
}

/**
 * Convert operand bytes into string
 *
 * @param {number[]} args - operand bytes
 * @returns {string} decoded string
 */
function argsToString(args) {
    return String.fromCharCode(...args);
}

/**
 * Check if a number is a valid logical address (0 - 15).
 *
 * @param {unknown} address - address to check
 * @returns {boolean} true if valid
 */
function isValidLogicalAddress(address) {
    return typeof address === 'number' && Number.isInteger(address) && address >= 0 && address <= 15;
}

/**
 * Decode operands of a CEC frame.
 *
 * @param {{source: number, target: number, opcode?: number, args?: number[]}} frame - raw frame
 * @returns {CecMessage} decoded message
 */
function decodeMessage(frame) {
    const args = frame.args || [];
    /** @type {CecMessage} */
    const message = {
        source: frame.source,
        target: frame.target,
        opcode: frame.opcode,
        args: args,
        event:
            frame.opcode === undefined ? POLLING_MESSAGE : CEC.OpcodeNames[frame.opcode] || `UNKNOWN_${frame.opcode}`,
        data: {},
    };
    if (frame.opcode === undefined) {
        return message;
    }

    /**
     * Mark message as malformed.
     *
     * @param {string} reason - description of the problem
     * @returns {CecMessage} message with error set
     */
    const malformed = reason => {
        message.error = `${message.event} ${reason}: ${JSON.stringify(args)}`;
        message.data = {};
        return message;
    };

    switch (frame.opcode) {
        case CEC.Opcode.FEATURE_ABORT: {
            if (args.length !== 2) {
                return malformed('with bad arguments');
            }
            message.data = {
                val: args[0],
                str: CEC.OpcodeNames[args[0]] || `UNKNOWN_${args[0]}`,
                reason: args[1],
                reasonStr: CEC.AbortReasonNames[args[1]] || `UNKNOWN_${args[1]}`,
            };
            break;
        }

        case CEC.Opcode.ACTIVE_SOURCE:
        case CEC.Opcode.INACTIVE_SOURCE:
        case CEC.Opcode.ROUTING_INFORMATION:
        case CEC.Opcode.SET_STREAM_PATH: {
            if (args.length !== 2) {
                return malformed('with bad format address');
            }
            const physical = argsToPhysical(args);
            message.data = { val: physical, str: physicalToRoute(physical) };
            break;
        }

        case CEC.Opcode.REPORT_PHYSICAL_ADDRESS: {
            if (args.length !== 3) {
                return malformed('with bad format address or device type');
            }
            const physical = argsToPhysical(args);
            message.data = { val: physical, str: physicalToRoute(physical), deviceType: args[2] };
            break;
        }

        case CEC.Opcode.ROUTING_CHANGE: {
            if (args.length !== 4) {
                return malformed('with bad format addresses');
            }
            const from = argsToPhysical(args.slice(0, 2));
            const to = argsToPhysical(args.slice(2, 4));
            message.data = {
                from: { val: from, str: physicalToRoute(from) },
                to: { val: to, str: physicalToRoute(to) },
            };
            break;
        }

        case CEC.Opcode.CEC_VERSION: {
            if (args.length !== 1) {
                return malformed('without version');
            }
            message.data = { val: args[0], str: CEC.CECVersionNames[args[0]] };
            break;
        }

        case CEC.Opcode.DECK_STATUS: {
            if (args.length !== 1) {
                return malformed('without deck info');
            }
            message.data = { val: args[0], str: CEC.DeckStatusNames[args[0]] };
            break;
        }

        case CEC.Opcode.DEVICE_VENDOR_ID: {
            if (args.length !== 3) {
                return malformed('with bad arguments');
            }
            const vendor = (args[0] << 16) | (args[1] << 8) | args[2];
            message.data = {
                val: vendor,
                str: CEC.VendorIdNames[vendor] || CEC.VendorIdNames[CEC.VendorId.UNKNOWN],
            };
            break;
        }

        case CEC.Opcode.REPORT_POWER_STATUS: {
            if (args.length !== 1) {
                return malformed('with bad format power status');
            }
            message.data = { val: args[0], str: CEC.PowerStatusNames[args[0]] };
            break;
        }

        case CEC.Opcode.REPORT_AUDIO_STATUS: {
            if (args.length !== 1) {
                return malformed('with bad audio status');
            }
            // bit 7: mute, bits 0-6: volume 0 - 100 (0x7f = unknown)
            message.data = { val: args[0] & 0x7f, str: String(args[0] & 0x7f), mute: (args[0] & 0x80) !== 0 };
            break;
        }

        case CEC.Opcode.SET_SYSTEM_AUDIO_MODE:
        case CEC.Opcode.SYSTEM_AUDIO_MODE_STATUS: {
            if (args.length !== 1) {
                return malformed('with bad status');
            }
            message.data = { val: args[0], str: CEC.SystemAudioStatusNames[args[0]] };
            break;
        }

        case CEC.Opcode.MENU_STATUS: {
            if (args.length !== 1) {
                return malformed('with bad status');
            }
            message.data = { val: args[0], str: CEC.MenuStatusNames[args[0]] };
            break;
        }

        case CEC.Opcode.SET_OSD_NAME: {
            if (!args.length) {
                return malformed('without OSD name');
            }
            const name = argsToString(args);
            message.data = { val: name, str: name };
            break;
        }

        case CEC.Opcode.MENU_REQUEST: {
            if (args.length !== 1) {
                return malformed('with bad args');
            }
            message.data = { val: args[0], str: CEC.MenuRequestTypeNames[args[0]] };
            break;
        }

        case CEC.Opcode.USER_CONTROL_PRESSED: {
            if (args.length < 1) {
                return malformed('without key code');
            }
            message.data = { val: args[0], str: CEC.UserControlCodeNames[args[0]] };
            break;
        }
    }
    return message;
}

module.exports = {
    POLLING_MESSAGE,
    MAX_OSD_STRING_LENGTH,
    isHexNumber,
    isRoute,
    isValidLogicalAddress,
    physicalToRoute,
    routeToPhysical,
    argsToPhysical,
    physicalToArgs,
    routeToArgs,
    stringToArgs,
    argsToString,
    decodeMessage,
};
