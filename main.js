/**
 *
 * cec2 adapter
 *
 * //native parameters will be in adapter.config
 *
 * Structure:
 *  create a "device" for every physical address we encounter.
 *      set name to OSD Name -> probably clean up old device if OSD Name != new OSD Name
 *      for device create states:
 *          * power
 *          * activeSource true/false (must set to false, if somebody else gets active.
 *          * vendorId
 *          * device class (derivce from logical address?)
 *          * lastKnownLogicalAddress
 *          * ...
 *          * some Information what works and what not? (like capabilities?)
 *          * some things dependent on device class
 *      for device create channel(s):
 *          * remote buttons -> with buttons for all possible remote buttons to be clicked.
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";


// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

//imports:
//const CEC = require("./lib/cec-functions");
const CEC = require("@senzil/cec-monitor").CEC;
const CECMonitor = require("@senzil/cec-monitor").CECMonitor;
const fs = require('fs').promises;
const fsConstants = require('fs').constants;

const stateDefinitions = {
    active: { //seen this session -> only then LE is valid.
        name: "active",
        type: "boolean",
        write: false,
        role: "indicator.active",
        desc: "device was active, logical address should be right",
        parse: () => true
    },
    lastSeen: {
        name: "lastSeen",
        write: false,
        desc: "last CEC command from device",
        role: "value.time",
        parse: () => Date.now()
    },
    //events exists for them:
    physicalAddress: {
        name: "physicalAddress",
        type: "string",
        desc: "HDMI Ports on route from TV to device",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_PHYSICAL_ADDRESS
    },
    logicalAddress: {
        name: "logicalAddress",
        type: "number",
        write: false,
        desc: "Logical Address (might change)"
    },
    logicalAddressHex: {
        name: "logicalAddressHex",
        type: "string",
        write: false,
        desc: "Logical Address as Hex Number"
    },
    powerState: {
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
            if (data.data.val === CEC.PowerStatus.ON || data.data.val === CEC.PowerStatus.IN_TRANSITION_STANDBY_TO_ON) {
                return true;
            }
            return false;
        },
        pollOpCode: CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
        key: "powerState"
    },
    activeSource: {
        name: "activeSource",
        type: "boolean",
        desc: "switch input to this device and probably switches on TV",
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.SendMessage(device.logicalAddress, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE);
            } else {
                return cec.SendMessage(device.logicalAddress, CEC.LogicalAddress.TV, CEC.Opcode.INACTIVE_SOURCE);
            }
        },
        parse: (data) => data.opcode === CEC.Opcode.ACTIVE_SOURCE ? true : false,
        pollOpCode: CEC.Opcode.REQUEST_ACTIVE_SOURCE
    },
    route: {
        name: "route",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_PHYSICAL_ADDRESS
    },
    routingInfo: {
        name: "routingInfo",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_PHYSICAL_ADDRESS
    },
    recording: {
        name: "recording",
        type: "boolean",
        write: true,
        command: async function(value, device, cec) {
            if (value) {
                return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_TV_SCREEN);
            } else {
                return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.RECORD_OFF);
            }
        }
    },
    cecVersion: {
        name: "cecVersion",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GET_CEC_VERSION
    },
    language: {
        name: "language",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GET_MENU_LANGUAGE,
    },
    menu: {
        name: "menu",
        type: "boolean",
        write: true,
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
        valueList: CEC.DeckStatus,
        command: async function(value, device, cec) {
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
                    this.log.info(value + " not recognized as play command.");
                    return;
            }
            return cec.SendMessage(null, device.logicalAddress, commandOpcode, argument);
        },
        pollOpCode: CEC.Opcode.GIVE_DECK_STATUS
    },
    tuner: {
        name: "tuner",
        type: "string",
        write: false,
        parse: function (data) {
            return JSON.stringify(data); //in order to gather more information...
        },
        pollOpCode: CEC.Opcode.GIVE_TUNER_DEVICE_STATUS
    },
    vendor: {
        name: "vendor",
        type: "string",
        write: false,
        parse: function (data) {
            return data.data.str || "Unknown (" + data.data.val + ")";
        },
        pollOpCode: CEC.Opcode.GIVE_DEVICE_VENDOR_ID
    },
    name: {
        name: "name",
        type: "string",
        write: false,
        pollOpCode: CEC.Opcode.GIVE_OSD_NAME
    },
    volume: {
        name: "volume",
        type: "number",
        write: true,
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
            await cec.SendCommand(null, device.logicalAddress, CEC.Opcode.USER_CONTROL_PRESSED, CECMonitor.EVENTS.REPORT_AUDIO_STATUS, button);
            return cec.SendMessage(null, device.logicalAddress, CEC.Opcode.USER_CONTROL_RELEASE);
        },
        pollOpCode: CEC.Opcode.GIVE_AUDIO_STATUS
    },
    systemAudio: {
        name: "systemAudio",
        type: "boolean",
        write: true,
        command: async function(value, device, cec) {
            //maybe need to do SYSTEM_AUDIO_MODE_REQUEST from LE of active source and physical adress of active source, too?
            return cec.SendCommand(null, device.logicalAddress, CEC.Opcode.SET_SYSTEM_AUDIO_MODE, CECMonitor.EVENTS.SYSTEM_AUDIO_MODE_STATUS, value ? CEC.SystemAudioStatus.ON : CEC.SystemAudioStatus.OFF);
        },
        pollOpCode: CEC.Opcode.GIVE_SYSTEM_AUDIO_MODE_STATUS
    },
    arc: {
        name: "arc",
        type: "boolean",
        write: true,
        parse: (data) => data.opcode === CEC.Opcode.REPORT_ARC_STARTED,
        command: async function(value, device, cec) {
            //evaluate if that works
            return cec.SendMessage(null, CEC.LogicalAddress.BROADCAST, value ? CEC.Opcode.REQUEST_ARC_START : CEC.Opcode.REQUEST_ARC_END);
        }
    }
};

const eventToStateDefinition = {
    0: stateDefinitions.active, //0 === polling.
    "ACTIVE_SOURCE": stateDefinitions.activeSource,
    "INACTIVE_SOURCE": stateDefinitions.activeSource,
    "ROUTING_CHANGE": stateDefinitions.route,
    "ROUTING_INFORMATION": stateDefinitions.routingInfo,
    "RECORD_STATUS": stateDefinitions.recording,
    "CEC_VERSION": stateDefinitions.cecVersion,
    "REPORT_PHYSICAL_ADDRESS": stateDefinitions.physicalAddress,
    "SET_MENU_LANGUAGE": stateDefinitions.language,
    "DECK_STATUS": stateDefinitions.deck,
    "TUNER_DEVICE_STATUS": stateDefinitions.tuner,
    "DEVICE_VENDOR_ID": stateDefinitions.vendor,
    "SET_OSD_NAME": stateDefinitions.name,
    "MENU_STATUS": stateDefinitions.menu,
    "REPORT_POWER_STATUS": stateDefinitions.powerState,
    "POLLING_MESSAGE": stateDefinitions.active,
    "REPORT_AUDIO_STATUS": stateDefinitions.volume,
    "SYSTEM_AUDIO_MODE_STATUS": stateDefinitions.systemAudio,
    "REPORT_ARC_STARTED": stateDefinitions.arc,
    "REPORT_ARC_ENDED": stateDefinitions.arc
};

function buildId(device, stateDef) {
    if (typeof stateDef === "string") {
        stateDef = eventToStateDefinition[stateDef];
    }
    return device.name + "." + stateDef.name;
}

function cleanUpName(name) {
    let newName = name.replace(/[\.'"!?,]/g, "");
    newName = newName.replace(/ /g, "_");
    return newName;
}

function getDeviceNameFromId(id) {
    let lastDot = id.lastIndexOf(".");
    return id.substring(id.lastIndexOf(".", lastDot - 1) + 1, lastDot);
}

function getStateFromId(id) {
    return id.substring(id.lastIndexOf('.') + 1);
}

function stateDefinitionFromId(id) {
    let stateName = getStateFromId(id);
    for (const key of Object.keys(stateDefinitions)) {
        let definition = stateDefinitions[key];
        if (definition.name === stateName) {
            return definition;
        }
    }
}

class CEC2 extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'cec2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.cec = {};
        this.timeouts = {};
        this.logicalAddressToDevice = {};
        this.devices = [];
        this.searchingLogicalAddresses = {};
    }

    async pollPowerStates() {
        if (this.timeouts.pollPowerStates) {
            clearTimeout(this.timeouts.pollPowerStates); //prevent multiple executions.
        }

        try {
            let status = await this.cec.SendCommand(null, CEC.LogicalAddress.TV, CEC.Opcode.GIVE_DEVICE_POWER_STATUS, CECMonitor.EVENTS.REPORT_POWER_STATUS);
            this.log.debug("TV Power is " + status.data.str);
        } catch (e) {
            this.log.debug("TV did not answer to powerRequest: " + e);
        }

        this.timeouts.pollPowerStates = setTimeout(() => this.pollPowerStates(), this.config.pollInterval || 30000);
    }

    async createCECDevice(logicalAddress, data) {
        this.log.debug("============================ Creating device: " + logicalAddress + ": " + JSON.stringify(data));
        //do we have a name already?
        let name = data && data.opcode === CEC.Opcode.SET_OSD_NAME ? data.data.str : false;
        if (!name && logicalAddress === 0) {
            name = "TV"; //TV does not really need to implement OSD Name... not nice. :-(
        }

        //let's find/create a dummy device to store data into.
        let device = this.logicalAddressToDevice[logicalAddress];
        if (!device) {
            this.log.debug("Creating dummy device for " + logicalAddress + " to use during device creation.");
            device = {
                created: false,
                lastGetName: 0,
                getNameTries: 0,
                lastGetPhysAddr: 0,
                getPhysAddrTries: 0,
                logicalAddress: logicalAddress,
                name: name,
                get logicalAddressHex() { return Number(this.logicalAddress).toString(16); }
            };
            this.logicalAddressToDevice[logicalAddress] = device;
        }
        if (!name) {
            name = device.name;
        }
        if (device.created) { //make sure we do the following only once:
            this.log.warn("Device for " + logicalAddress + " already created.");
            return device;
        }

        if(!this.cec.ready) {
            this.log.debug("CEC not yet ready, delay sending messages.");
            return device;
        }

        //ask for name, if we don't have it
        if (!name) {
            if (device.getNameTries < 11) { //try to get name, if tried too often, continue with physicalAddress.
                if (Date.now() - device.lastGetName > 60000) {
                    this.log.debug("No name for logicalAddress " + logicalAddress + ", requesting it.");
                    try {
                        device.getNameTries += 1;
                        device.lastGetName = Date.now();
                        await this.cec.SendMessage(null, logicalAddress, CEC.Opcode.GIVE_OSD_NAME);
                    } catch (e) {
                        this.log.error("Could not get name: " + e);
                    }
                }
                return device; //exit and retry later.
            }
        }

        //if we can not get name, but have physicalAddress already, use it.
        if (!name && device.physicalAddress) {
            device.name = device.physicalAddress.replace(/\./g, "");
            name = device.name;
        }
        //ask for physicalAddress if we do not have it and it did not happen already / too fast / too many times. Exit and retry later.
        if (!name) {
            if (device.getPhysAddrTries < 11) { //try to get physicalAddress, if tried to often continue without it.
                if (Date.now() - device.lastGetPhysAddr > 60000) {
                    this.log.debug("Requesting name failed, try to get physical address for " + logicalAddress);
                    try {
                        device.getPhysAddrTries += 1;
                        device.lastGetPhysAddr = Date.now();
                        await this.cec.SendMessage(null, logicalAddress, CEC.Opcode.GIVE_PHYSICAL_ADDRESS);
                    } catch (e) {
                        this.log.error("Could not get physical address: " + e);
                    }
                }
                return device; //exit and retry later.
            }
        }

        //all failed, we can not get a name... use Logical Address.
        if (!name) {
            this.log.warn("Cound not find a name for device " + logicalAddress);
            name = "Unknown " + Number(logicalAddress).toString((16)).toUpperCase();
        }

        this.log.debug("Device with logicalAddress " + logicalAddress + " seen. Has name " + name);
        name = cleanUpName(name);

        //got a name, let's check if we know that device already.
        let existingDevice = this.devices.find(d => d.name === name);
        if (!existingDevice) {
            //ok, now existing device, let's create it.
            //create device in objectDB:
            await this.createDeviceAsync(name);
            //set physical address:
            await this.setObjectNotExistsAsync(buildId(device, stateDefinitions.name), {
                type: "state",
                common: {
                    type: "string",
                    desciption: "OSD Name of device",
                    name: "Name",
                    read: true,
                    write: false
                },
                native: { def: "name" }
            });
            //set logical address:
            await this.setObjectNotExistsAsync(buildId(device, stateDefinitions.logicalAddress), {
                type: "state",
                common: {
                    type: "string",
                    description: "Current logical address (may change)",
                    name: "Logical Address",
                    read: true,
                    write: false
                },
                native: { def: "logicalAddress" }
            });
            //set active:
            await this.setObjectNotExistsAsync(buildId(device, stateDefinitions.active), {
                type: "state",
                common: {
                    type: "boolean",
                    role: "indicator.active",
                    name: "active",
                    desc: "device was seen this session",
                    read: true,
                    write: false
                },
                native: { def: "active"}
            });
            //last seen:
            await this.setObjectNotExistsAsync(buildId(device, stateDefinitions.lastSeen), {
                type: "state",
                common: {
                    type: "number",
                    role: 'value.time',
                    name: "last seen",
                    desc: "last time device was seen",
                    read: true,
                    write: false
                },
                native: { def: "lastSeen"}
            });
            device.created = true;
        } else {
            //copy data from new device:
            for (const key of Object.keys(device)) {
                existingDevice[key] = device[key];
            }
            device = existingDevice;
            this.log.warn("Already had device with name " + name + " copy new stuff in old device.");
            this.logicalAddressToDevice[logicalAddress] = existingDevice;
        }

        //fill in some data in device:
        device.created = true;
        device.name = name;
        device.active = true;
        device.lastSeen = Date.now();
        device.logicalAddress = logicalAddress;
        for (const key of Object.keys(device)) {
            let stateDef = stateDefinitions[key];
            if (stateDef) {
                await this.processEvent({source: logicalAddress, stateDef: stateDef, parsedData: device[key]});
            }
        }

        this.log.debug("created/found device, returning " + JSON.stringify(device));
        return device;
    }

    async processEvent(data) {
        this.log.debug("============================ Processing Event: " + data.event + ": " + JSON.stringify(data));
        try {
            //REPORT_PHYSICAL_ADDRESS: {"type":"TRAFFIC","number":"17707","flow":"OUT","source":1,"target":15,"opcode":132,"args":[48,0,1],"event":"REPORT_PHYSICAL_ADDRESS","data":{"val":12288,"str":"3.0.0.0"}}
            //DEVICE_VENDOR_ID:        {"type":"TRAFFIC","number":"57985","flow":"IN","source":11,"target":15,"opcode":135,"args":[0,0,0],"event":"DEVICE_VENDOR_ID","data":{"val":0,"str":"UNKNOWN"}}

            //ignore stuff we send.
            if (data.flow === "OUT") {
                return;
            }

            let device = this.logicalAddressToDevice[data.source];
            if (!device || !device.created) {
                this.log.debug("No device for " + data.source + " start device creation");
                await this.createCECDevice(data.source, data);
                device = this.logicalAddressToDevice[data.source];
            }

            let stateDef = data.stateDef;
            if (!stateDef) {
                stateDef = eventToStateDefinition[data.event || data.opcode];
            }

            let value = data.parsedData;
            if (value === undefined) {
                this.log.debug("Parsing data...");
                if (data.data) {
                    value = !!data.data.val;
                }
                if (stateDef.parse) {
                    value = stateDef.parse(data);
                } else if (stateDef.type === "string") {
                    value = data.data.str;
                }
            }
            //store value in device:
            device[stateDef.key || stateDef.name] = value;

            if (device.created) {
                if (stateDef.name === "name" && data.data && data.data.str && cleanUpName(data.data.str) !== device.name) {
                    this.log.warn("Device changed name from " + device.name + " to " + data.data.str);
                    await this.deleteDeviceAsync(device.name);
                    //create new device for new name:
                    device = await this.createCECDevice(data.source, data);
                }
                await this.setStateChangedAsync(buildId(device, stateDefinitions.logicalAddress), device.logicalAddress, true);
                await this.setStateChangedAsync(buildId(device, stateDefinitions.active), true, true);
                await this.setStateAsync(buildId(device, stateDefinitions.lastSeen), Date.now(), true);

                let id = buildId(device, stateDef);
                let states = undefined;
                if (stateDef.valueList) {
                    states = {};
                    Object.keys(stateDef.valueList).forEach(key => {
                        states[stateDef.valuesList[key]] = key;
                    });
                }
                await this.setObjectNotExistsAsync(id, {
                    type: "state",
                    common: {
                        type: stateDef.type,
                        read: true,
                        write: stateDef.write,
                        name: stateDef.name,
                        desc: stateDef.desc,
                        role: stateDef.role,
                        states: states
                    },
                    native: {def: stateDef.key || stateDef.name}
                });

                this.log.debug("Updating " + id + " to " + value);
                await this.setStateChangedAsync(id, value, true);

                if (stateDef.name === "logicalAddress") {
                    stateDef = stateDefinitions.logicalAddressHex;
                    id = buildId(device, stateDef);
                    await this.setObjectNotExistsAsync(id, {
                        type: "state",
                        common: {
                            type: stateDef.type,
                            read: true,
                            write: stateDef.write,
                            name: stateDef.name,
                            role: stateDef.role,
                            desc: stateDef.desc
                        },
                        native: {def: stateDef.key || stateDef.name}
                    });

                    await this.setStateChangedAsync(id, value, true);
                }
            }
        } catch (e) {
            console.log("Error: ", e);
            this.log.error("Error during processing event: " + e + " " + JSON.stringify(data));
        }
    }

    /**
     * initializes cec monitor
     * @param config
     */
    async setupCECMonitor(config) {
        try {
            //let's make sure we can access vchiq, needed for cec-client:
            this.log.debug('Testing access.');
            let result = await fs.access('/dev/vchiq', fsConstants.R_OK);
            this.log.debug('Access resulted in: ' + result);
        } catch (e) {
            this.log.error('Can not access HDMI. Please read requirements part of readme. Error: ' + e);
        }

        this.cec = new CECMonitor(config.osdName, {
            debug: true, //config.cecDebug,
            //hdmiport: config.hdmiPort,
            //processManaged: false, // if false -> will catch uncaught exceptions and exit process. Hm.
            recorder: config.type === "r",
            player: config.type === "p",
            tuner: config.type === "t",
            audio: config.type === "a",
            autorestart: true, //allows auto restart of cec-client.
            command_timeout: 3,
            //user_control_hold_interval: config.userControlHoldInterval
        });

        this.cec.on('_debug', d => this.log.debug(d));
        this.cec.on('_traffic', d => this.log.debug(d));
        this.cec.on('_stop', d => d ? this.log.error('CEC Monitor stopped: ' + d) : this.log.debug("CEC Monitor stopped gracefully."));

        //add listeners for device changes:
        Object.keys(eventToStateDefinition).forEach(k => this.cec.on(k, d => this.processEvent(d)));

        this.log.debug('Starting CEC Monitor.');
        await this.cec.WaitForReady();
        this.log.debug("CEC Monitor ready.");
        this.timeouts.scan = setTimeout(() => this.cec.WriteRawMessage("scan"), 1000);

        if (config.pollPowerStates) {
            this.pollPowerStates();
        }

        //some global states:
        //raw command
        await this.setObjectNotExistsAsync("raw", {
            type: "state",
            common: {
                name: "raw command",
                desc: "send command to cec-client",
                type: "string",
                write: true
            },
            native: {}
        });

        //active-source:
        await this.setObjectNotExistsAsync("active-source", {
            type: "state",
            common: {
                name: "set active source",
                desc: "set physical address of active source",
                type: "string",
                write: true
            },
            native: {}
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info('config osdName: ' + this.config.osdName);
        this.log.info('config type: ' + this.config.type);

        //setup devices:
        let existingDevices = await this.getDevicesAsync();
        for (const device of existingDevices) {
            let id = device._id;
            let existingDevice = {};
            let states = await this.getStatesOfAsync(id);

            for (const state of states) {
                let def = stateDefinitions[state.native.def];
                let value = await this.getStateAsync(state._id);
                if (value) { //unpack val
                    value = value.val;
                }
                existingDevice[def.name] = value; //remember values
            }
            existingDevice.active = false;
            this.devices.push(existingDevice);
        }

        //setup cec system
        await this.setupCECMonitor(this.config);

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates('*');
    }


    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            // The state was changed
            if (!state.ack) {
                try {
                    this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    let stateName = getStateFromId(id);
                    if (stateName === "raw") {
                        if (state.val) {
                            await this.cec.WriteRawMessage(state.val);
                        }
                    } else if (stateName === "active-source") {
                        if (state.val) {
                            if (state.val.length === 1) { //allow single numbers for hdmi port.
                                state.val += ".0.0.0";
                            }
                            let device = this.devices.find(d => d.physicalAddress === state.val);
                            let sender = null;
                            if (device) {
                                sender = device.logicalAddress;
                            }
                            await this.cec.SendMessage(sender, CEC.LogicalAddress.BROADCAST, CEC.Opcode.ACTIVE_SOURCE, state.val);
                        }
                    } else {
                        let stateDefinition = stateDefinitionFromId(id);
                        let deviceName = getDeviceNameFromId(id);
                        let device = this.devices.find(d => d.name === deviceName);
                        if (typeof stateDefinition.command === "function") {
                            this.log.debug("Sending " + state.val + " for id " + id + " to " + deviceName);
                            await stateDefinition.command(state.val, device, this.cec);
                        } else {
                            this.log.warn("Can not write state " + id + " of type " + stateDefinition.name + ". Please do not write read only states!");
                        }
                    }
                } catch (e) {
                    this.log.error("Could not write state " + id + ": " + e);
                }
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    // 	if (typeof obj === 'object' && obj.message) {
    // 		if (obj.command === 'send') {
    // 			// e.g. send email or pushover or whatever
    // 			this.log.info('send command');

    // 			// Send response in callback if required
    // 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    // 		}
    // 	}
    // }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new CEC2(options);
} else {
    // otherwise start the instance directly
    new CEC2();
}
