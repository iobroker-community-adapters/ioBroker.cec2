"use strict";

function CEC () {
    var _cec = require(__dirname + '/cectypes-h');
    _cec.call(this);

    this.getResponseOpcode = function (cmd) {

        if (cmd.indexOf('tx ') == 0) {
            var opcode = parseInt(cmd.substr(6, 2), 16);
        } else {
            //var opcode = cmd.substr(0,4);
            var opcode = cmd.substr(0, 2);
            return opcode;
        }
        switch (opcode) {
            case this.CEC_OPCODE.REQUEST_ACTIVE_SOURCE:
                return this.CEC_OPCODE.ACTIVE_SOURCE;
            case this.CEC_OPCODE.GET_CEC_VERSION:
                return this.CEC_OPCODE.CEC_VERSION;
            case this.CEC_OPCODE.GIVE_PHYSICAL_ADDRESS:
                return this.CEC_OPCODE.REPORT_PHYSICAL_ADDRESS;
            case this.CEC_OPCODE.GET_MENU_LANGUAGE:
                return this.CEC_OPCODE.SET_MENU_LANGUAGE;
            case this.CEC_OPCODE.GIVE_DECK_STATUS:
                return this.CEC_OPCODE.DECK_STATUS;
            case this.CEC_OPCODE.GIVE_TUNER_DEVICE_STATUS:
                return this.CEC_OPCODE.TUNER_DEVICE_STATUS;
            case this.CEC_OPCODE.GIVE_DEVICE_VENDOR_ID:
                return this.CEC_OPCODE.DEVICE_VENDOR_ID;
            case this.CEC_OPCODE.GIVE_OSD_NAME:
                return this.CEC_OPCODE.SET_OSD_NAME;
            case this.CEC_OPCODE.MENU_REQUEST:
                return this.CEC_OPCODE.MENU_STATUS;
            case this.CEC_OPCODE.GIVE_DEVICE_POWER_STATUS:
                return this.CEC_OPCODE.REPORT_POWER_STATUS;
            case this.CEC_OPCODE.GIVE_AUDIO_STATUS:
                return this.CEC_OPCODE.REPORT_AUDIO_STATUS;
            case this.CEC_OPCODE.GIVE_SYSTEM_AUDIO_MODE_STATUS:
                return this.CEC_OPCODE.SYSTEM_AUDIO_MODE_STATUS;
            case this.CEC_OPCODE.SYSTEM_AUDIO_MODE_REQUEST:
                return this.CEC_OPCODE.SET_SYSTEM_AUDIO_MODE;
            case this.CEC_OPCODE.REQUEST_ARC_START:
                return this.CEC_OPCODE.START_ARC;
            case this.CEC_OPCODE.START_ARC:
                return this.CEC_OPCODE.REPORT_ARC_STARTED;
            case this.CEC_OPCODE.REQUEST_ARC_END:
                return this.CEC_OPCODE.END_ARC;
            case this.CEC_OPCODE.END_ARC:
                return this.CEC_OPCODE.REPORT_ARC_ENDED;
            default:
                break;
        }
        return this.CEC_OPCODE.NONE;
    };

    function objectToMap (objs) {
        var map = new Map();
        for (var i in objs) {
            map.set(objs[i], i);
        }
        map.get = function (key, addhex) {
            var ret = Map.prototype.get.call(this, key);
            if (ret === undefined) {
                ret = typeof key === 'number' ? key.toString(16) : key;
            }
            if (addhex === true) ret += ' (0x' + key.toString(16) + ')';
            return ret;
        };
        return map;
    }

    this.userControlCodes = objectToMap (this.CEC_USER_CONTROL_CODE);
    this.opcodes = objectToMap (this.CEC_OPCODE);
    this.vendorIds = objectToMap (this.CEC_VENDOR);

    this.getOpcodeName = function (code) {
        if (code === undefined) return '';
        if (typeof code !== 'number') {
            code = parseInt(code, 16);
        }
        code = code >> 0;
        return this.opcodes.get(code, true);
    };

    this.deviceTypeNames = {
        0: 'TV',
        1: 'Recording Device',
        2: 'Reserved',
        3: 'Tuner',
        4: 'Playback Device',
        5: 'Audio System'
    };

    var opcodeTable = new Map();
    opcodeTable.set(this.CEC_OPCODE.STANDBY, {args: 0}); //, val: false, func: cecDevices.setPower});
    opcodeTable.set(this.CEC_OPCODE.INACTIVE_SOURCE, {args: 0 }); //, val: false, func: cecDevices.setActive});
    opcodeTable.set(this.CEC_OPCODE.REPORT_POWER_STATUS, {args: 1});
    opcodeTable.set(this.CEC_OPCODE.REPORT_AUDIO_STATUS, {args: 1});
    opcodeTable.set(this.CEC_OPCODE.REPORT_PHYSICAL_ADDRESS, {args: 3});
    opcodeTable.set(this.CEC_OPCODE.SET_OSD_NAME, {args: 1});
    opcodeTable.set(this.CEC_OPCODE.ACTIVE_SOURCE, {args: 2});
    opcodeTable.set(this.CEC_OPCODE.ROUTING_CHANGE, {args: 4});
    opcodeTable.set(this.CEC_OPCODE.ROUTING_INFORMATION, {args: 2});
    opcodeTable.set(this.CEC_OPCODE.SET_SYSTEM_AUDIO_MODE, {args: 1});

    this.responseLength = function (opcode) {
        var o = opcodeTable.get(opcode);
        if (o !== undefined) {
            return o.args;
        }
        return -1;
    };

    return this;
}


module.exports = new CEC();