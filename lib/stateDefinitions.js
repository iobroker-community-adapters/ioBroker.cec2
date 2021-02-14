const CEC = require('./cec-constants');
const CECMonitor = require('./cec-monitor');

/**
 * stateDefinition, defines an ioBroker state and how it interacts with CEC
 * @typedef stateDefinition                 - defines an ioBroker state and how it interacts with CEC
 * @type {object}
 * @property {string} name                  - name of the state
 * @property {string} [key]                 - optional key of the state in stateDefinitions-Object,
 *                                               if name differs from key (because name is not suitable for ioBroker id)
 * @property {boolean} [readOnly]           - make readOnly for CEC
 * @property {function} [parse]             - parse CEC event to state
 * @property {string} [idPrefix]            - prefix id of state key with this string for subdirectories.
 * @property {number} [pollOpCode]          - opcode used for polling, will also create a poll-button.
 * @property {number} [pollArgument]        - argument for pollOpCode, if polling is more complex.
 * @property {number} [pollTarget]          - if polling targets a different logical address (especially for global states)
 * @property {function} [command]           - async function that is called if state is written -> i.e. control devices.
 * @property {boolean} [isGlobal]           - belongs to the global device
 *
 * @property {"string" | "number" | "boolean" | "object" | "array" | "mixed" | "file" | undefined} type - ioBroker type, i.e. "string", "number", "boolean", ...
 * @property {boolean} write                - make ioBroker state writable
 * @property {boolean} [read]               - make ioBroker state readable
 * @property {string} role                  - role in object.common
 * @property {string} [desc]                - description in object.common
 * @property {Record<string,number>} [valueList]    - valueList in object.common
 */

/**
 *
 * @type {Record<string, stateDefinition>}
 */
const stateDefinitions = {
    active: { //seen this session -> only then LE is valid.
        name: 'active',
        type: 'boolean',
        write: false,
        role: 'indicator.reachable',
        desc: 'device was active, logical address should be right',
        parse: () => true,
        idPrefix: 'info'
    },
    lastSeen: {
        name: 'lastSeen',
        'type': 'number',
        write: false,
        desc: 'last CEC command from device',
        role: 'value.time',
        parse: () => Date.now(),
        idPrefix: 'info'
    },
    //events exists for them:
    physicalAddress: {
        //bf:84:22:00:04
        //REPORT_PHYSICAL_ADDRESS: {"type":"TRAFFIC","number":"27086258","flow":"IN","source":11,"target":15,"opcode":132,"args":[34,0,4],"event":"REPORT_PHYSICAL_ADDRESS","data":{"val":8704,"str":"2.2.0.0"}}
        name: 'physicalAddress',
        type: 'string',
        desc: 'HDMI Ports on route from TV to device',
        role: 'info.address',
        write: false,
        pollOpCode: CEC.Opcode.GIVE_PHYSICAL_ADDRESS,
        idPrefix: 'info'
    },
    logicalAddress: {
        name: 'logicalAddress',
        type: 'number',
        role: 'info.address',
        write: false,
        desc: 'Logical Address (might change)',
        idPrefix: 'info'
    },
    logicalAddressHex: {
        name: 'logicalAddressHex',
        type: 'string',
        write: false,
        desc: 'Logical Address as Hex Number',
        role: 'info.address',
        idPrefix: 'info',
        readOnly: true
    },
    powerState: {
        //51:90:00
        //REPORT_POWER_STATUS: {"type":"TRAFFIC","number":"4584594","flow":"IN","source":5,"target":1,"opcode":144,"args":[0],"event":"REPORT_POWER_STATUS","data":{"val":0,"str":"ON"}}
        name: 'state',
        type: 'boolean',
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.writeRawMessage('on ' + device.logicalAddress);
            } else {
                return cec.writeRawMessage('standby ' + device.logicalAddress);
            }
        },
        parse: (data) => {
            return data.data.val === CEC.PowerStatus.ON || data.data.val === CEC.PowerStatus.IN_TRANSITION_STANDBY_TO_ON;
        },
        role: 'switch.power',
        pollOpCode: CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
        key: 'powerState'
    },
    activeSource: {
        //4f:82:21:00
        //ACTIVE_SOURCE: {"type":"TRAFFIC","number":"4602009","flow":"IN","source":4,"target":15,"opcode":130,"args":[33,0],"event":"ACTIVE_SOURCE","data":{"val":8448,"str":"2.1.0.0"}}
        name: 'activeSource',
        type: 'boolean',
        desc: 'switch input to this device and probably switches on TV',
        role: 'switch.enable',
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.sendMessage(device.logicalAddress, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE, device.physicalAddress);
            } else {
                return cec.sendMessage(device.logicalAddress, CEC.LogicalAddress.TV, CEC.Opcode.INACTIVE_SOURCE, device.physicalAddress);
            }
        },
        parse: (data) => data.opcode === CEC.Opcode.ACTIVE_SOURCE,
        pollOpCode: CEC.Opcode.REQUEST_ACTIVE_SOURCE
    },
    recording: {
        name: 'recording',
        type: 'boolean',
        role: 'switch.record',
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.sendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_TV_SCREEN);
            } else {
                return cec.sendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_OFF);
            }
        },

    },
    cecVersion: {
        //01:9e:05
        //CEC_VERSION: {"type":"TRAFFIC","number":"13890","flow":"IN","source":0,"target":1,"opcode":158,"args":[5],"event":"CEC_VERSION","data":{"val":5,"str":"VERSION_1_4"}}
        name: 'cecVersion',
        type: 'string',
        role: 'info.version',
        write: false,
        pollOpCode: CEC.Opcode.GET_CEC_VERSION,
        idPrefix: 'info'
    },
    /*language: {
        //0f:32:00:00:00
        //SET_MENU_LANGUAGE: {"type":"TRAFFIC","number":"4633220","flow":"IN","source":0,"target":15,"opcode":50,"args":[0,0,0],"event":"SET_MENU_LANGUAGE","data":{}}
        name: "language",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GET_MENU_LANGUAGE,
        idPrefix: "info"
    },*/
    menuStatus: {
        //51:8e:01
        //MENU_STATUS: {"type":"TRAFFIC","number":"23300","flow":"IN","source":5,"target":1,"opcode":142,"args":[1],"event":"MENU_STATUS","data":{}}
        //MENU_STATUS: {"type":"TRAFFIC","number":"5054","flow":"IN","source":11,"target":1,"opcode":142,"args":[0],"event":"MENU_STATUS","data":{}}
        name: 'menuStatus',
        type: 'boolean',
        write: true,
        role: 'switch.menu',
        command: async function(value, device, cec) {
            if (device.logicalAddress === CEC.LogicalAddress.TV) {
                await cec.sendMessage(null, device.logicalAddress, CEC.Opcode.MENU_REQUEST, value ? CEC.MenuRequestType.ACTIVATE : CEC.MenuRequestType.DEACTIVATE);
            }
            await cec.sendMessage(CEC.LogicalAddress.TV, device.logicalAddress, CEC.Opcode.MENU_REQUEST, value ? CEC.MenuRequestType.ACTIVATE : CEC.MenuRequestType.DEACTIVATE);
            return cec.sendMessage(null, device.logicalAddress, CEC.Opcode.MENU_REQUEST, CEC.MenuRequestType.QUERY); //query afterwards
        },
        parse: data => {
            return !data.args[0]; //0 = menu is active.
        },
        pollOpCode: CEC.Opcode.MENU_REQUEST,
        pollArgument: CEC.MenuRequestType.QUERY,
    },
    deck: {
        name: 'deck',
        type: 'number',
        write: true,
        role: 'media.state',
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
                    log.info(value + ' not recognized as play command.');
                    return;
            }
            return cec.sendMessage(null, device.logicalAddress, commandOpcode, argument);
        },
        pollOpCode: CEC.Opcode.GIVE_DECK_STATUS,
        pollArgument: CEC.GiveStatus.ON //is on right? Or once? or off? Why do we need to set that parameter here?
    },
    tuner: {
        name: 'tuner',
        type: 'string',
        write: false,
        role: 'media.state',
        parse: function (data) {
            return JSON.stringify(data); //in order to gather more information...
        },
        pollOpCode: CEC.Opcode.GIVE_TUNER_DEVICE_STATUS,
        pollArgument: CEC.GiveStatus.ON //is on right? Or once? or off? Why do we need to set that parameter here?
    },
    vendor: {
        //4f:87:08:00:46
        //DEVICE_VENDOR_ID: {"type":"TRAFFIC","number":"4602390","flow":"IN","source":4,"target":15,"opcode":135,"args":[8,0,70],"event":"DEVICE_VENDOR_ID","data":{"val":524358,"str":"SONY"}}
        //DEVICE_VENDOR_ID: {"type":"TRAFFIC","number":"27086498","flow":"IN","source":11,"target":15,"opcode":135,"args":[0,0,0],"event":"DEVICE_VENDOR_ID","data":{"val":0,"str":"UNKNOWN"}}
        name: 'vendor',
        type: 'string',
        write: false,
        role: 'info.vendor',
        parse: function (data) {
            return data.data.str || 'Unknown (' + data.data.val + ')';
        },
        pollOpCode: CEC.Opcode.GIVE_DEVICE_VENDOR_ID,
        idPrefix: 'info'
    },
    name: {
        //51:47:52:58:2d:56:37:38:31
        //SET_OSD_NAME: {"type":"TRAFFIC","number":"22729","flow":"IN","source":5,"target":1,"opcode":71,"args":[82,88,45,86,55,56,49],"event":"SET_OSD_NAME","data":{"val":"RX-V781","str":"RX-V781"}}
        name: 'name',
        type: 'string',
        write: false,
        pollOpCode: CEC.Opcode.GIVE_OSD_NAME,
        idPrefix: 'info',
        role: 'info.name'
    },
    //uprocessed:
    //5f:81:22:00
    //ROUTING_INFORMATION: {"type":"TRAFFIC","number":"4649954","flow":"IN","source":5,"target":15,"opcode":129,"args":[34,0],"event":"ROUTING_INFORMATION","data":{}}
    //0f:80:00:00:20:00
    //ROUTING_CHANGE: {"type":"TRAFFIC","number":"4649953","flow":"IN","source":0,"target":15,"opcode":128,"args":[0,0,32,0],"event":"ROUTING_CHANGE","data":{"from":{"val":0,"str":"0.0.0.0"},"to":{"val":8192,"str":"2.0.0.0"}}}
    //41:00:70:00
    //undefined: {"type":"TRAFFIC","number":"4529265","flow":"IN","source":4,"target":1,"opcode":0,"args":[112,0]}


    //global states:
    volume: {
        //REPORT_AUDIO_STATUS: {"type":"TRAFFIC","number":"4495","flow":"IN","source":5,"target":1,"opcode":122,"args":[40],"event":"REPORT_AUDIO_STATUS","data":{}}
        name: 'volume',
        type: 'number',
        write: false,
        role: 'level.volume',
        parse: (data) => {
            const vol = parseInt(data.args.join(''), 16);
            const mute = 0x80 & vol;
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
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, button);
            return cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        pollOpCode: CEC.Opcode.GIVE_AUDIO_STATUS,
        pollTarget: CEC.LogicalAddress.AUDIOSYSTEM,
        isGlobal: true
    },
    systemAudio: {
        //SYSTEM_AUDIO_MODE_STATUS: {"type":"TRAFFIC","number":"4656","flow":"IN","source":5,"target":1,"opcode":126,"args":[1],"event":"SYSTEM_AUDIO_MODE_STATUS","data":{}}
        name: 'systemAudio',
        type: 'boolean',
        write: true,
        role: 'media.mode',
        command: async function(_value, _device, cec) {
            //maybe need to do SYSTEM_AUDIO_MODE_REQUEST from LE of active source and physical address of active source, too?
            return cec.sendCommand(cec.getActiveSource(), CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.SYSTEM_AUDIO_MODE_REQUEST, CECMonitor.EVENTS.SET_SYSTEM_AUDIO_MODE, cec.getActiveSourcePhysical());
        },
        parse: (data) => !!data.args[0],
        pollOpCode: CEC.Opcode.GIVE_SYSTEM_AUDIO_MODE_STATUS,
        pollTarget: CEC.LogicalAddress.AUDIOSYSTEM,
        isGlobal: true
    },
    arc: {
        name: 'arc',
        type: 'boolean',
        write: true,
        role: 'media.mode',
        parse: (data) => data.opcode === CEC.Opcode.REPORT_ARC_STARTED,
        command: async function(value, _device, cec) {
            //evaluate if that works
            return cec.sendMessage(CEC.LogicalAddress.AUDIOSYSTEM, CEC.LogicalAddress.TV, value ? CEC.Opcode.START_ARC : CEC.Opcode.END_ARC);
        },
        isGlobal: true
    },
    'raw-command': {
        name: 'raw-command',
        desc: 'send command to cec-client',
        type: 'string',
        write: true,
        role: 'text',
        command: async function (value, _device, cec) {
            await cec.writeRawMessage(value);
        },
        isGlobal: true
    },
    'active-source': {
        //ACTIVE_SOURCE: {"type":"TRAFFIC","number":"4861","flow":"IN","source":11,"target":15,"opcode":130,"args":[34,0],"event":"ACTIVE_SOURCE","data":{"val":8704,"str":"2.2.0.0"}}
        command: async function(value, device, cec) {
            if (!value) {
                return;
            }
            if (value.length === 1) { //allow single numbers for hdmi port.
                value += '.0.0.0';
            }
            let dev = device.devices.find(d => d.physicalAddress === value);
            if (!dev) {
                dev = device.devices.find(d => d.physicalAddress && d.physicalAddress.charAt(0) === value.charAt(0)); //if no full address, just search for first number.
            }
            let sender = null;
            if (dev) {
                sender = dev.logicalAddress;
            }
            await cec.sendMessage(sender, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE, value);
        },
        parse: (e) => e.data.str,
        isGlobal: true,
        name: 'active-source',
        desc: 'physical address of active playback device',
        type: 'string',
        role: 'media.input',
        write: true,
        read: true,
        pollOpCode: CEC.Opcode.REQUEST_ACTIVE_SOURCE
    },
    volumeUp: {
        name: 'volumeUp',
        desc: 'increase volume',
        type: 'boolean',
        write: true,
        read: false,
        role: 'button.volume.up',
        command: async function (_value, _device, cec) {
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CEC.UserControlCode.VOLUME_UP);
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    volumeDown: {
        name: 'volumeDown',
        desc: 'decrease volume',
        type: 'boolean',
        write: true,
        read: false,
        role: 'button.volume.down',
        command: async function (_value, _device, cec) {
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CEC.UserControlCode.VOLUME_DOWN);
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    mute: {
        name: 'mute',
        desc: 'mute audio',
        type: 'boolean',
        write: true,
        read: false,
        role: 'button.mute',
        command: async function (_value, _device, cec) {
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_PRESSED, CEC.UserControlCode.MUTE);
            await cec.sendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        isGlobal: true
    },
    standbyAll: {
        name: 'standbyAll',
        desc: 'switch off all CEC devices',
        type: 'boolean',
        write: true,
        read: false,
        role: 'button.power.off',
        command: async function (_value, _device, cec) {
            await cec.sendMessage(null, CEC.LogicalAddress.BROADCAST, CEC.Opcode.STANDBY);
        },
        isGlobal: true
    },
    //TODO: needs testing (!!) and needs to be implemented(??) -> especially: how to set time parameter?
    'osd-message': {
        name: 'osdMessage',
        desc: 'display osd message on screen',
        type: 'string',
        write: true,
        role: 'text',
        command: async function (value, _device, cec) {
            if (value) {
                const param = [CEC.DisplayControl.DISPLAY_FOR_DEFAULT_TIME].concat(value.split('').map(s => s.charCodeAt(0)));
                await cec.sendMessage(null, CEC.LogicalAddress.TV, CEC.Opcode.SET_OSD_STRING, param);
            }
        },
        isGlobal: true
    },
    'osd-message-clear': {
        name: 'osdClear',
        desc: 'clear previously send osd message',
        type: 'boolean',
        write: true,
        role: 'button',
        command: async function (_value, _device, cec) {
            await cec.sendMessage(null, CEC.LogicalAddress.TV, CEC.Opcode.SET_OSD_STRING, CEC.DisplayControl.CLEAR_PREVIOUS_MESSAGE);
        },
        isGlobal: true
    },
    'createButtons': {
        name: 'createButtons',
        desc: 'create states to send controls to this device. Not supported by all devices.',
        type: 'boolean',
        write: true,
        role: 'button'
    }
};

module.exports = stateDefinitions;
