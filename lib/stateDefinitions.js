const CEC = require("@senzil/cec-monitor").CEC;
const CECMonitor = require("@senzil/cec-monitor").CECMonitor;

const stateDefinitions = {
    active: { //seen this session -> only then LE is valid.
        name: "active",
        type: "boolean",
        write: false,
        role: "indicator.reachable",
        desc: "device was active, logical address should be right",
        parse: () => true,
        idPrefix: "info"
    },
    lastSeen: {
        name: "lastSeen",
        write: false,
        desc: "last CEC command from device",
        role: "value.time",
        parse: () => Date.now(),
        idPrefix: "info"
    },
    //events exists for them:
    physicalAddress: {
        name: "physicalAddress",
        type: "string",
        desc: "HDMI Ports on route from TV to device",
        role: "info.address",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_PHYSICAL_ADDRESS,
        idPrefix: "info"
    },
    logicalAddress: {
        name: "logicalAddress",
        type: "number",
        role: "info.address",
        write: false,
        desc: "Logical Address (might change)",
        idPrefix: "info"
    },
    logicalAddressHex: {
        name: "logicalAddressHex",
        type: "string",
        write: false,
        desc: "Logical Address as Hex Number",
        role: "info.address",
        idPrefix: "info",
        readOnly: true
    },
    powerState: {
        //REPORT_POWER_STATUS: {"type":"TRAFFIC","number":"2249","flow":"IN","source":0,"target":1,"opcode":144,"args":[0],"event":"REPORT_POWER_STATUS","data":{"val":0,"str":"ON"}}
        name: "state",
        type: "boolean",
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.WriteRawMessage("on " + device.logicalAddress);
            } else {
                return cec.WriteRawMessage("standby " + device.logicalAddress);
            }
        },
        parse: (data) => {
            return data.data.val === CEC.PowerStatus.ON || data.data.val === CEC.PowerStatus.IN_TRANSITION_STANDBY_TO_ON;
        },
        role: "switch.power",
        pollOpCode: CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
        key: "powerState"
    },
    activeSource: {
        //ACTIVE_SOURCE: {"type":"TRAFFIC","number":"4861","flow":"IN","source":11,"target":15,"opcode":130,"args":[34,0],"event":"ACTIVE_SOURCE","data":{"val":8704,"str":"2.2.0.0"}}
        name: "activeSource",
        type: "boolean",
        desc: "switch input to this device and probably switches on TV",
        role: "switch.enable",
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.SendMessage(device.logicalAddress, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE, device.physicalAddress);
            } else {
                return cec.SendMessage(device.logicalAddress, CEC.LogicalAddress.TV, CEC.Opcode.INACTIVE_SOURCE, device.physicalAddress);
            }
        },
        parse: (data) => data.opcode === CEC.Opcode.ACTIVE_SOURCE,
        pollOpCode: CEC.Opcode.REQUEST_ACTIVE_SOURCE
    },
    recording: {
        name: "recording",
        type: "boolean",
        role: "switch.record",
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_TV_SCREEN);
            } else {
                return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_OFF);
            }
        },

    },
    cecVersion: {
        name: "cecVersion",
        type: "string",
        role: "info.version",
        write: false,
        pollOpCode: CEC.Opcode.GET_CEC_VERSION,
        idPrefix: "info"
    },
    /*language: {
        name: "language",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GET_MENU_LANGUAGE,
        idPrefix: "info"
    },*/
    menuStatus: {
        //MENU_STATUS: {"type":"TRAFFIC","number":"5054","flow":"IN","source":11,"target":1,"opcode":142,"args":[0],"event":"MENU_STATUS","data":{}}
        name: "menuStatus",
        type: "boolean",
        write: true,
        role: "switch.menu",
        command: async function(value, device, cec) {
            if (device.logicalAddress === CEC.LogicalAddress.TV) {
                await cec.SendMessage(null, device.logicalAddress, CEC.Opcode.MENU_REQUEST, value ? CEC.MenuRequestType.ACTIVATE : CEC.MenuRequestType.DEACTIVATE);
            }
            await cec.SendMessage(CEC.LogicalAddress.TV, device.logicalAddress, CEC.Opcode.MENU_REQUEST, value ? CEC.MenuRequestType.ACTIVATE : CEC.MenuRequestType.DEACTIVATE);
            return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.MENU_REQUEST, CEC.MenuRequestType.QUERY); //query afterwards
        },
        parse: data => {
            return !data.args[0]; //0 = menu is active.
        },
        pollOpCode: CEC.Opcode.MENU_REQUEST,
        pollArgument: CEC.MenuRequestType.QUERY,
    },
    deck: {
        name: "deck",
        type: "number",
        write: true,
        role: "media.state",
        valueList: CEC.DeckStatus,
        command: async function(value, device, cec, log) {
            let commandOpcode = CEC.Opcode.DECK_CONTROL;
            let argument;
            //might add "speed" state in order to let user choose min/max/medium speed options?
            switch (value) {
                case CEC.DeckStatus.STOP:
                    argument = CEC.DeckControl.STOP;
                    break;
                case CEC.DeckStatus.SKIP_FOWARD:
                case CEC.DeckStatus.INDEX_SEARCH_FOWARD:
                    argument = CEC.DeckControl.SKIP_FORWARD_WIND;
                    break;
                case CEC.DeckStatus.SKIP_REVERSE:
                case CEC.DeckStatus.INDEX_SEARCH_REVERSE:
                    argument = CEC.DeckControl.SKIP_REVERSE_REWIND;
                    break;
                case CEC.DeckStatus.NO_MEDIA:
                    argument = CEC.DeckControl.EJECT;
                    break;
                case CEC.DeckStatus.PLAY:
                    argument = CEC.Play.PLAY_FORWARD;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.PLAY_REVERSE:
                    argument = CEC.Play.PLAY_REVERSE;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.SLOW:
                    argument = CEC.Play.SLOW_FORWARD_MEDIUM_SPEED;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.SLOW_REVERSE:
                    argument = CEC.Play.SLOW_REVERSE_MEDIUM_SPEED;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.STILL:
                    argument = CEC.Play.PLAY_STILL;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.FAST_FOWARD:
                    argument = CEC.Play.FAST_FORWARD_MEDIUM_SPEED;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.FAST_REVERSE:
                    argument = CEC.Play.FAST_REVERSE_MEDIUM_SPEED;
                    commandOpcode = CEC.Opcode.PLAY;
                    break;
                case CEC.DeckStatus.RECORD:
                    commandOpcode = CEC.Opcode.RECORD_ON;
                    argument = null;
                    break;
                default:
                    log.info(value + " not recognized as play command.");
                    return;
            }
            return cec.SendMessage(null, device.logicalAddress, commandOpcode, argument);
        },
        pollOpCode: CEC.Opcode.GIVE_DECK_STATUS,
        pollArgument: CEC.GiveStatus.ON //is on right? Or once? or off? Why do we need to set that parameter here?
    },
    tuner: {
        name: "tuner",
        type: "string",
        write: false,
        role: "media.state",
        parse: function (data) {
            return JSON.stringify(data); //in order to gather more information...
        },
        pollOpCode: CEC.Opcode.GIVE_TUNER_DEVICE_STATUS,
        pollArgument: CEC.GiveStatus.ON //is on right? Or once? or off? Why do we need to set that parameter here?
    },
    vendor: {
        name: "vendor",
        type: "string",
        write: false,
        role: "info.vendor",
        parse: function (data) {
            return data.data.str || "Unknown (" + data.data.val + ")";
        },
        pollOpCode: CEC.Opcode.GIVE_DEVICE_VENDOR_ID,
        idPrefix: "info"
    },
    name: {
        name: "name",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_OSD_NAME,
        idPrefix: "info",
        role: "info.name"
    },




    //global states:
    volume: {
        //REPORT_AUDIO_STATUS: {"type":"TRAFFIC","number":"4495","flow":"IN","source":5,"target":1,"opcode":122,"args":[40],"event":"REPORT_AUDIO_STATUS","data":{}}
        name: "volume",
        type: "number",
        write: true,
        role: "level.volume",
        parse: (data) => {
            let vol = parseInt(data.args.join(""), 16);
            let mute = 0x80 & vol;
            if (mute) {
                return 0;
            } else {
                return vol;
            }
        },
        command: async function(value, device, cec) {
            let button = CEC.UserControlCode.MUTE;
            if (value > 0) {
                button = value > device.volume ? CEC.UserControlCode.VOLUME_UP : CEC.UserControlCode.VOLUME_DOWN;
            }
            await cec.SendCommand(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CECMonitor.EVENTS.REPORT_AUDIO_STATUS, button);
            return cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        pollOpCode: CEC.Opcode.GIVE_AUDIO_STATUS,
        pollTarget: CEC.LogicalAddress.AUDIOSYSTEM,
        isGlobal: true
    },
    systemAudio: {
        //SYSTEM_AUDIO_MODE_STATUS: {"type":"TRAFFIC","number":"4656","flow":"IN","source":5,"target":1,"opcode":126,"args":[1],"event":"SYSTEM_AUDIO_MODE_STATUS","data":{}}
        name: "systemAudio",
        type: "boolean",
        write: true,
        role: "media.mode",
        command: async function(value, device, cec) {
            //maybe need to do SYSTEM_AUDIO_MODE_REQUEST from LE of active source and physical adress of active source, too?
            return cec.SendCommand(cec.Physical2Logical(cec.GetActiveSource()), CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.SYSTEM_AUDIO_MODE_REQUEST, CECMonitor.EVENTS.SYSTEM_AUDIO_MODE_STATUS, cec.GetActiveSource());
        },
        parse: (data) => !!data.args[0],
        pollOpCode: CEC.Opcode.GIVE_SYSTEM_AUDIO_MODE_STATUS,
        pollTarget: CEC.LogicalAddress.AUDIOSYSTEM,
        isGlobal: true
    },
    arc: {
        name: "arc",
        type: "boolean",
        write: true,
        role: "media.mode",
        parse: (data) => data.opcode === CEC.Opcode.REPORT_ARC_STARTED,
        command: async function(value, device, cec) {
            //evaluate if that works
            return cec.SendMessage(CEC.LogicalAddress.AUDIOSYSTEM, CEC.LogicalAddress.TV, value ? CEC.Opcode.START_ARC : CEC.Opcode.END_ARC);
        },
        isGlobal: true
    },
    "raw-command": {
        name: "raw-command",
        desc: "send command to cec-client",
        type: "string",
        write: true,
        role: "text",
        command: async function (value, device, cec) {
            await cec.WriteRawMessage(value);
        },
        isGlobal: true
    },
    "active-source": {
        //ACTIVE_SOURCE: {"type":"TRAFFIC","number":"4861","flow":"IN","source":11,"target":15,"opcode":130,"args":[34,0],"event":"ACTIVE_SOURCE","data":{"val":8704,"str":"2.2.0.0"}}
        command: async function(value, device, cec, log) {
            if (value.length === 1) { //allow single numbers for hdmi port.
                value += ".0.0.0";
            }
            let dev = device.devices.find(d => d.physicalAddress === value);
            if (!dev) {
                dev = device.devices.find(d => d.physicalAddress && d.physicalAddress.charAt(0) === value.charAt(0)); //if no full address, just search for first number.
            }
            let sender = null;
            if (dev) {
                sender = dev.logicalAddress;
            }
            await cec.SendMessage(sender, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE, value);
        },
        parse: (e) => e.data.str,
        isGlobal: true,
        name: "active-source",
        desc: "physical address of active playback device",
        type: "string",
        role: "media.input",
        write: true,
        read: true,
        pollOpCode: CEC.Opcode.REQUEST_ACTIVE_SOURCE
    },
    volumeUp: {
        name: "volumeUp",
        desc: "increase volume",
        type: "boolean",
        write: true,
        read: false,
        role: "button.volume.up",
        command: async function (value, device, cec) {
            await cec.SendCommand(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CECMonitor.EVENTS.REPORT_AUDIO_STATUS, CEC.UserControlCode.VOLUME_UP);
            await cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    volumeDown: {
        name: "volumeDown",
        desc: "decrease volume",
        type: "boolean",
        write: true,
        read: false,
        role: "button.volume.down",
        command: async function (value, device, cec) {
            await cec.SendCommand(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CECMonitor.EVENTS.REPORT_AUDIO_STATUS, CEC.UserControlCode.VOLUME_DOWN);
            await cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    mute: {
        name: "mute",
        desc: "mute audio",
        type: "boolean",
        write: true,
        read: false,
        role: "button.mute",
        command: async function (value, device, cec) {
            await cec.SendCommand(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CECMonitor.EVENTS.REPORT_AUDIO_STATUS, CEC.UserControlCode.MUTE);
            await cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    standbyAll: {
        name: "standbyAll",
        desc: "switch off all CEC devices",
        type: "boolean",
        write: true,
        read: false,
        role: "button.power.off",
        command: async function (value, device, cec) {
            await cec.SendMessage(null, CEC.LogicalAddress.BROADCAST, CEC.Opcode.STANDBY);
        },
        isGlobal: true
    }
};

module.exports = stateDefinitions;
