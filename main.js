/**
 *
 * cec2 adapter
 *
 * Created with @iobroker/create-adapter v1.20.0
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
 *      for device create folder(s):
 *          * remote buttons -> with buttons for all possible remote buttons to be clicked.
 *          * poll -> poll buttons for some states
 */


//TODO:
// - add user control as states in device (subfolder)
//      - could also need a state with button press lenght
// - testing!!!
// - especially setting stuff, everything besides on off needs testing, i.e.:
//          activeSource (on AND off!),
//          recording (do we have a device that can record at all??),
//          deck (what can I control with this?),
//          tuner (can I control TV tuner with that?),
//          menu (can I open menu with that? On TV? On FireTV?),
//  - add more specific polling, i.e. ask audio device for audio status and tuner maybe?
//  - should we add parameter subfolder and allow polling of single states?

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

/**
 * @typedef stateDefinition - imported type..
 * @type {import('./lib/stateDefinitions').stateDefinition}
 */

//imports:
const CEC = require('@senzil/cec-monitor').CEC;
const CECMonitor = require('@senzil/cec-monitor').CECMonitor;
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const stateDefinitions = /** @type {Record<string, stateDefinition>} */ (require('./lib/stateDefinitions'));


/**
 * Remove forbidden characters from names so I can use them as ID.
 * @type {RegExp}
 */
const forbiddenCharacters = /[\][*,;'"`<>\\\s?]/g;

/**
 * Translate Event IDs to stateDefinitions.
 * @type {Record<number|string, stateDefinition>}
 */
const eventToStateDefinition = {
    0: stateDefinitions.active, //0 === polling.
    'ACTIVE_SOURCE': stateDefinitions.activeSource,
    'INACTIVE_SOURCE': stateDefinitions.activeSource,
    //'ROUTING_CHANGE': stateDefinitions.route,
    //'ROUTING_INFORMATION': stateDefinitions.routingInfo,
    //'SET_MENU_LANGUAGE': stateDefinitions.language,
    'RECORD_STATUS': stateDefinitions.recording,
    'CEC_VERSION': stateDefinitions.cecVersion,
    'REPORT_PHYSICAL_ADDRESS': stateDefinitions.physicalAddress,
    'DECK_STATUS': stateDefinitions.deck,
    'TUNER_DEVICE_STATUS': stateDefinitions.tuner,
    'DEVICE_VENDOR_ID': stateDefinitions.vendor,
    'SET_OSD_NAME': stateDefinitions.name,
    'MENU_STATUS': stateDefinitions.menuStatus,
    'REPORT_POWER_STATUS': stateDefinitions.powerState,
    'POLLING_MESSAGE': stateDefinitions.active,
    'REPORT_AUDIO_STATUS': stateDefinitions.volume,
    'SYSTEM_AUDIO_MODE_STATUS': stateDefinitions.systemAudio,
    'REPORT_ARC_STARTED': stateDefinitions.arc,
    'REPORT_ARC_ENDED': stateDefinitions.arc
};

/**
 * Build ID from device and stateDefinition, i.e. needs to be in device folder and maybe also poll subfolder.
 * @param {cecDevice|string} device - device
 * @param {stateDefinition} stateDef - state definition of state
 * @param {boolean} [poll] - true if in polling folder.
 * @returns {string}
 */
function buildId(device, stateDef, poll = false) {
    let name;
    if (typeof device === 'string') {
        name = device;
    } else {
        name = device.name;
    }
    if (typeof stateDef === 'string') {
        stateDef = eventToStateDefinition[stateDef];
    }
    return name + '.' + (stateDef.idPrefix ? stateDef.idPrefix + '.' : '') + (poll ? 'poll.' : '') + stateDef.name;
}

/**
 * Cleanup name to create ID from it. Also contains hack for FireTV devices.
 * @param {string} name
 * @returns {string}
 */
function cleanUpName(name) {
    //hack, somehow FireTV reports different name, when off...
    if (name === 'AFTR') {
        return 'Amazon_FireTV';
    }
    let newName = name.replace(/ /g, '_');
    newName = newName.replace(forbiddenCharacters, '');
    return newName;
}

/**
 * Get device part of ioBroker Id
 * @param {string} id
 * @returns {string}
 */
function getDeviceIdFromId(id) {
    const parts = id.split('.');
    return parts[2]; //0 == adapter, 1 == instance -> return 2.
}

/**
 * Returns state part of ioBroker id (in device or poll folder)
 * @param {string} id
 * @returns {string}
 */
function getStateFromId(id) {
    return id.substring(id.lastIndexOf('.') + 1);
}

/**
 * Get a stateDefinition from ioBroker ID
 * @param {string} id
 * @returns {stateDefinition}
 * @throws error if no stateDefinition found for ID (should never happen!)
 */
function stateDefinitionFromId(id) {
    const stateName = getStateFromId(id);
    for (const key of Object.keys(stateDefinitions)) {
        /** @type {stateDefinition} */
        const definition = stateDefinitions[key];
        if (definition.name === stateName) {
            return definition;
        }
    }
    throw new Error('Could not find stateDefinition for ' + id);
}

/**
 * @typedef cecDevice
 * @type {object}
 * @property {Array<string>} createdStates      states created for this device
 * @property {string} name                      name of device - cleaned up to be ID
 * @property {number} logicalAddress            logicalAddress on bus. Negative for invalid.
 * @property {string} logicalAddressHex         Hex version of logicalAddress
 * @property {string} [physicalAddress]         Physical Address of device in 0.0.0.0 format
 * @property {number} [lastGetName]             last time we asked for a name.
 * @property {number} [getNameTries]            how often we have tried to get a name.
 * @property {number} [lastGetPhysAddr]         last time we asked for a physical address
 * @property {number} [getPhysAddrTries]        how often we have tried to get phyiscal address
 * @property {boolean} [physicalAddressReallyChanged] true if physicalAddress really changed, i.e. device answered and name differs.
 * @property {Record<String, boolean>} didPoll true if device did just poll this stateref so next update will be forced to iobroker.
 *
 * @property {boolean} [active]                 active state value
 * @property {number} [lastSeen]                last seen since value
 * @property {boolean} [activeSource]           activeSource state value
 * @property {number} [volume]                  volume (only on global device)
 * @property {boolean} [volumeUp]               volumeUp state (only on global device)
 * @property {boolean} [volumeDown]             volumeDown state (only on global device)
 * @property {boolean} [mute]                   mute state (only on global device)
 * @property {boolean} [arc]                    arc state (only on global device)
 * @property {boolean} [systemAudio]            systemAudio state (only on global device)
 * @property {Array<cecDevice>} [devices]       Array of all devices (only on global device?)
 * @property {number} [currentButtonPressTime]  Time in millisecondes for the next button press to wait.
 *
 * @property {boolean} created                  if device was created in ioBroker or not.
 * @property {boolean} ignored                  if device is ignored (because no name & config setting)
 */

class CEC2 extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
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
        /** @type {Record<string, NodeJS.Timeout>} */
        this.timeouts = {};
        /** @type {Record<number, cecDevice>} */
        this.logicalAddressToDevice = {};
        /** @type {Array<cecDevice>} */
        this.devices = [];
        /** @type {cecDevice} */
        this.globalDevice = {
            name: 'Global',
            logicalAddress: CEC.LogicalAddress.BROADCAST,
            get logicalAddressHex() { return Number(this.logicalAddress).toString(16); },
            volume: 0,
            volumeUp: false,
            volumeDown: false,
            mute: false,
            arc: false,
            systemAudio: false,
            devices: this.devices,
            created: true,
            ignored: false,
            createdStates: [],
            didPoll: {}
        };
        this.devices.push(this.globalDevice);
    }

    /**
     * Poll PowerStates of cec devices (currently only TV is polled -> too much polling seems no good idea).
     * @returns {Promise<void>}
     */
    async pollPowerStates() {
        if (this.timeouts.pollPowerStates) {
            clearTimeout(this.timeouts.pollPowerStates); //prevent multiple executions.
        }

        try {
            const status = await this.cec.SendCommand(null, CEC.LogicalAddress.TV, CEC.Opcode.GIVE_DEVICE_POWER_STATUS, CECMonitor.EVENTS.REPORT_POWER_STATUS);
            this.log.debug('TV Power is ' + status.data.str);
        } catch (e) {
            this.log.debug('TV did not answer to powerRequest: ' + e + ' - ' + e.stack);
        }

        this.timeouts.pollPowerStates = setTimeout(() => this.pollPowerStates(), this.config.pollInterval || 30000);
    }

    /**
     * create a state in device based on state definition and set value.
     * @param {cecDevice} device
     * @param {stateDefinition} stateDefinition
     * @returns {Promise<void>}
     */
    async createStateInDevice(device, stateDefinition) {
        if (device.createdStates.find(s => s === (stateDefinition.key ? stateDefinition.key : stateDefinition.name))) {
            this.log.debug('State ' + stateDefinition.name + ' already created in ' + device.name);
            return;
        }

        let states = undefined;
        if (stateDefinition.valueList) {
            states = {};
            Object.keys(stateDefinition.valueList).forEach(key => {
                states[stateDefinition.valueList[key]] = key;
            });
        }

        const id = buildId(device, stateDefinition);
        if (id.includes('undefined')) {
            this.log.error('Creating state undefined: ' + JSON.stringify(stateDefinition) + ' in device' + JSON.stringify(device) + ' id ' + id);
            throw new Error('State undefined: ' + id);
        }

        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                type: stateDefinition.type,
                desc: stateDefinition.desc,
                name: stateDefinition.name,
                read: stateDefinition.read === undefined ? true : stateDefinition.read,
                write: stateDefinition.write,
                role: stateDefinition.role,
                states: states
            },
            native: { def: stateDefinition.key || stateDefinition.name }
        });
        device.createdStates.push(stateDefinition.name);

        //don't set val here, will set all vals when adapter start. We do not really want that. And we do not need that here, do we?
        //await this.setStateChangedAsync(id, val, true);

        //create poll states:
        if (stateDefinition.pollOpCode) {
            const id = buildId(device, stateDefinition, true);
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: {
                    type: 'boolean',
                    desc: 'poll ' + stateDefinition.name,
                    name: 'poll ' + stateDefinition.name,
                    role: 'button',
                    read: false,
                    write: true
                },
                native: { def: stateDefinition.key || stateDefinition.name, poll: true }
            });
        }
    }

    /**
     * Get a device from our devices aray by name.
     * @param {string} name
     * @returns {cecDevice|undefined}
     */
    getDeviceByName(name) {
        if (name) {
            name = cleanUpName(name);
            return this.devices.find(d => d.name === name);
        }
        return undefined;
    }

    /**
     * Make a device active / inactive. Sets all necessary states.
     * @param {cecDevice} device
     * @param {boolean} active
     * @param {number} logicalAddress - new logical Address
     * @returns {Promise<void>}
     */
    async setDeviceActive(device, active, logicalAddress) {
        device.active = active;
        device.logicalAddress = logicalAddress;
        if (device.name !== 'Gobal') {
            await this.setStateChangedAsync(buildId(device, stateDefinitions.active), active, true);
            await this.setStateChangedAsync(buildId(device, stateDefinitions.logicalAddress), device.logicalAddress, true);
            await this.setStateChangedAsync(buildId(device, stateDefinitions.logicalAddressHex), device.logicalAddressHex, true);
        }
    }

    /**
     * Creates default states in device, ie states all devices should have.
     * @param {cecDevice} device
     * @returns {Promise<void>}
     */
    async createDefaultDeviceStates(device) {
        //set physical address:
        await this.createStateInDevice(device, stateDefinitions.name);
        //set logical address:
        await this.createStateInDevice(device, stateDefinitions.logicalAddress);
        await this.createStateInDevice(device, stateDefinitions.logicalAddressHex);
        //set active:
        await this.createStateInDevice(device, stateDefinitions.active);
        //last seen:
        await this.createStateInDevice(device, stateDefinitions.lastSeen);
        //menu status:
        await this.createStateInDevice(device, stateDefinitions.menuStatus);
        //power state:
        await this.createStateInDevice(device, stateDefinitions.powerState);
        //active source state:
        await this.createStateInDevice(device, stateDefinitions.activeSource);
        //create buttons button
        await this.createStateInDevice(device, stateDefinitions.createButtons);

        if (device.logicalAddress === 0) { //TV always has 0.0.0.0, but does not necessarily report that.
            device.physicalAddress = '0.0.0.0';
            await this.createStateInDevice(device, stateDefinitions.physicalAddress);
        }

        switch (device.logicalAddress) {
            /*case CEC.LogicalAddress.PLAYBACKDEVICE1:
            case CEC.LogicalAddress.PLAYBACKDEVICE2:
            case CEC.LogicalAddress.PLAYBACKDEVICE3:
                this.createStateInDevice(device, stateDefinitions.deck);
                break;
            case CEC.LogicalAddress.TUNER1:
            case CEC.LogicalAddress.TUNER2:
            case CEC.LogicalAddress.TUNER3:
            case CEC.LogicalAddress.TUNER4:
                this.createStateInDevice(device, stateDefinitions.deck);
                this.createStateInDevice(device, stateDefinitions.tuner);
                break;*/
            case CEC.LogicalAddress.RECORDINGDEVICE1:
            case CEC.LogicalAddress.RECORDINGDEVICE2:
            case CEC.LogicalAddress.RECORDINGDEVICE3:
                await this.createStateInDevice(device, stateDefinitions.recording);
                break;
        }
    }

    /**
     * Create ioBroker Device for detected CEC device. Might return without creating if no name yet.
     * @param {number} logicalAddress of detected device
     * @param {event} data - incomming CEC message
     * @returns {Promise<cecDevice>}
     */
    async createCECDevice(logicalAddress, data) {
        this.log.debug('============================ Creating device: ' + logicalAddress + ': ' + JSON.stringify(data));
        //do we have a name already?
        let name = data && data.opcode === CEC.Opcode.SET_OSD_NAME ? cleanUpName(data.data.str) : '';
        if (!name && logicalAddress === 0) {
            name = 'TV'; //TV does not really need to implement OSD Name... not nice. :-(
        }
        //do we know the device already?
        let device = this.getDeviceByName(name);
        if (device && !this.logicalAddressToDevice[logicalAddress]) {
            this.logicalAddressToDevice[logicalAddress] = device; //we do not fill this from existing devices in ioBroker, do that here.
            if(!device.active) {
                await this.setDeviceActive(device, true, logicalAddress);
            }
        }

        //do we have a device for the logicalAddress?
        if (!device) {
            device = this.logicalAddressToDevice[logicalAddress];
        }
        if (!device) {
            this.log.debug('Creating dummy device for ' + logicalAddress + ' to use during device creation.');
            /** @type {cecDevice} */
            device = {
                created: false,
                ignored: false,
                lastGetName: 0,
                getNameTries: 0,
                lastGetPhysAddr: 0,
                getPhysAddrTries: 0,
                logicalAddress: logicalAddress,
                name: name ? cleanUpName(name) : '',
                get logicalAddressHex() { return Number(this.logicalAddress).toString(16); },
                createdStates: [],
                didPoll: {}
            };
            this.logicalAddressToDevice[logicalAddress] = device;
        }
        if (!name) {
            name = device.name;
        }
        if (device.created) { //make sure we do the following only once:
            this.log.info('Device for ' + logicalAddress + ' already created.');
            return device;
        }

        if(!this.cec.ready) {
            this.log.debug('CEC not yet ready, delay sending messages.');
            return device;
        }

        //ask for name, if we don't have it
        if (!name) {
            if (device.getNameTries < 11) { //try to get name, if tried too often, continue with physicalAddress.
                if (Date.now() - device.lastGetName > 3000) {
                    this.log.info('No name for logicalAddress ' + logicalAddress + ', requesting it.');
                    try {
                        device.getNameTries += 1;
                        device.lastGetName = Date.now();
                        await this.cec.SendMessage(null, logicalAddress, CEC.Opcode.GIVE_OSD_NAME);
                        clearTimeout(this.timeouts['createTimeout' + logicalAddress]);
                        this.timeouts['createTimeout' + logicalAddress] = setTimeout(() => {
                            this.createCECDevice(logicalAddress, data);
                        }, 10000);
                    } catch (e) {
                        this.log.error('Could not get name: ' + e + ' - ' + e.stack);
                    }
                }
                return device; //exit and retry later.
            }
        }

        if (!name && this.config.preventUnnamedDevices) {
            device.ignored = true;
            this.log.info('Ignoring device ' + device.logicalAddressHex + ' because did not get a name.');
            return device;
        }

        //if we can not get name, but have physicalAddress already, use it.
        if (!name && device.physicalAddress) {
            device.name = device.physicalAddress.replace(/\./g, '');
            name = device.name;
        }
        //ask for physicalAddress if we do not have it and it did not happen already / too fast / too many times. Exit and retry later.
        if (!name) {
            if (device.getPhysAddrTries < 11) { //try to get physicalAddress, if tried to often continue without it.
                if (Date.now() - device.lastGetPhysAddr > 60000) {
                    this.log.debug('Requesting name failed, try to get physical address for ' + logicalAddress);
                    try {
                        device.getPhysAddrTries += 1;
                        device.lastGetPhysAddr = Date.now();
                        await this.cec.SendMessage(null, logicalAddress, CEC.Opcode.GIVE_PHYSICAL_ADDRESS);
                        clearTimeout(this.timeouts['createTimeout' + logicalAddress]);
                        this.timeouts['createTimeout' + logicalAddress] = setTimeout(() => {
                            this.createCECDevice(logicalAddress, data);
                        }, 10000);
                    } catch (e) {
                        this.log.error('Could not get physical address: ' + e + ' - ' + e.stack);
                    }
                }
                return device; //exit and retry later.
            }
        }

        //all failed, we can not get a name... use Logical Address.
        if (!name) {
            this.log.warn('Cound not find a name for device ' + logicalAddress);
            name = 'Unknown_' + Number(logicalAddress).toString((16)).toUpperCase();
        }

        name = cleanUpName(name);
        this.log.info('Device with logicalAddress ' + logicalAddress + ' seen. Has name ' + name);
        device.name = name; //make sure we store clean name in device!

        //got a name, let's check if we know that device already.
        const existingDevice = this.devices.find(d => d.name === name);
        if (!existingDevice) {
            //ok, no existing device, let's create it.
            device.active = true;
            device.lastSeen = Date.now();
            device.created = true;
            device.logicalAddress = logicalAddress;
            this.logicalAddressToDevice[logicalAddress] = device;
            this.devices.push(device);

            //create device in objectDB:
            await this.createDeviceAsync(name);
            await this.createDefaultDeviceStates(device);
        } else {
            this.logicalAddressToDevice[logicalAddress] = existingDevice;
            existingDevice.created = true;
            await this.setDeviceActive(device, true, logicalAddress);

            //copy data from old device:
            this.log.info('Already knew device ' + name + '. Update values.');
        }

        //set all fields in ioBroker, might have some stuff that was received before CEC Ready.
        for (const key of Object.keys(device)) {
            if (device[key] !== undefined && device[key] !== null) {
                const stateDef = stateDefinitions[key];
                if (stateDef) {
                    await this.processEvent({source: logicalAddress, stateDef: stateDef, parsedData: device[key]});
                } else {
                    if (key !== 'created' && key !== 'physicalAddressReallyChanged' && key !== 'createdStates' &&
                        key !== 'lastGetName' && key !== 'getNameTries' && key !== 'lastGetPhysAddr' && key !== 'getPhysAddrTries' &&
                        key !== 'didPoll' && key !== 'ignored') {
                        this.log.warn('No state definition for ' + key);
                    }
                }
            }
        }

        //poll some more:
        await this.cec.SendMessage(null, logicalAddress, stateDefinitions.deck.pollOpCode, stateDefinitions.deck.pollArgument);
        await this.cec.SendMessage(null, logicalAddress, stateDefinitions.tuner.pollOpCode, stateDefinitions.tuner.pollArgument);
        await this.cec.SendMessage(null, logicalAddress, stateDefinitions.menuStatus.pollOpCode, stateDefinitions.menuStatus.pollArgument);
        await this.cec.SendMessage(null, logicalAddress, stateDefinitions.powerState.pollOpCode);

        this.log.info('Creation of device ' + device.name + ' finished.');
        return existingDevice || device;
    }

    /**
     * @typedef event
     * @type {object}
     * @property {number} source
     * not parsed:
     * @property {string} [type]
     * @property {string} [number]
     * @property {"OUT"|"IN"} [flow]
     * @property {number} [target]
     * @property {number} [opcode]
     * @property {Array<number>} [args]
     * @property {string} [event]
     * @property {{val: number, str: string}} [data]
     * parsed:
     * @property {stateDefinition} [stateDef]
     * @property {any} [parsedData]
     *
     * Process CEC Event
     * @param {event} data - CEC event
     * @returns {Promise<undefined|*>}
     */
    async processEvent(data) {
        try {
            //REPORT_PHYSICAL_ADDRESS: {"type":"TRAFFIC","number":"17707","flow":"OUT","source":1,"target":15,"opcode":132,"args":[48,0,1],"event":"REPORT_PHYSICAL_ADDRESS","data":{"val":12288,"str":"3.0.0.0"}}
            //DEVICE_VENDOR_ID:        {"type":"TRAFFIC","number":"57985","flow":"IN","source":11,"target":15,"opcode":135,"args":[0,0,0],"event":"DEVICE_VENDOR_ID","data":{"val":0,"str":"UNKNOWN"}}

            //ignore stuff we send.
            if (data.flow === 'OUT') {
                return;
            }
            this.log.debug('============================ Processing Event: ' + data.event + ': ' + JSON.stringify(data));

            let stateDef = data.stateDef;
            if (!stateDef) {
                stateDef = eventToStateDefinition[data.event || data.opcode];
            }
            if (!stateDef) {
                if (data.opcode !== CEC.Opcode.SET_MENU_LANGUAGE && data.opcode !== CEC.Opcode.ROUTING_CHANGE && data.opcode !== CEC.Opcode.ROUTING_INFORMATION) {
                    this.log.warn('No stateDef for ' + JSON.stringify(data));
                }
                return;
            }
            let device = this.logicalAddressToDevice[data.source];
            if (stateDef.isGlobal) {
                this.log.debug('State ' + stateDef.name + ' is global, use global device.');
                device = this.globalDevice;
            }

            if (device && device.ignored) {
                this.log.debug('Ignoring message from ignored device.');
                return;
            }

            if (!device || !device.created) {
                this.log.debug('No device for ' + data.source + ' start device creation');
                await this.createCECDevice(data.source, data);
                device = this.logicalAddressToDevice[data.source];
            }

            if (stateDef.name === stateDefinitions.name.name) {
                if (data && data.data && data.data.str) {
                    data.data.str = cleanUpName(data.data.str);
                }
                if (device.created && data.data && data.data.str && data.data.str !== device.name) {
                    this.log.warn('New device with name ' + data.data.str + ' for logicalAddress ' + device.logicalAddressHex);
                    //deactivate old device:
                    await this.setDeviceActive(device, false, CEC.LogicalAddress.UNKNOWN);
                    delete this.logicalAddressToDevice[data.source];

                    //rerun method:
                    return this.processEvent(data);
                }
            }

            if (stateDef.name === stateDefinitions.physicalAddress.name) {
                if (data && data.data && data.data.str) {
                    if (device.created && device.physicalAddress !== data.data.str && !device.physicalAddressReallyChanged) {
                        this.log.info('Device with unexpected physical address came online on logical address ' + device.logicalAddressHex);
                        if (device.active) {
                            await this.setDeviceActive(device, false, CEC.LogicalAddress.UNKNOWN);
                            delete this.logicalAddressToDevice[data.source];
                        }
                        device.physicalAddressReallyChanged = true; //prevent endless loop, if physical address really changed.

                        //this should create the new device:
                        await this.cec.SendCommand(null, data.source, CEC.Opcode.GIVE_OSD_NAME, CECMonitor.EVENTS.SET_OSD_NAME);
                        //add physical address to device:
                        return this.processEvent(data);
                    }
                }
            }

            let value = data.parsedData;
            if (value === undefined) {
                this.log.debug('Parsing data...');
                if (data.data) {
                    value = !!data.data.val;
                }
                if (stateDef.parse) {
                    value = stateDef.parse(data);
                } else if (stateDef.type === 'string') {
                    value = data.data.str;
                }
            }
            //store value in device:
            if (device.created && device[stateDef.key || stateDef.name] === undefined) {
                await this.createStateInDevice(device, stateDef);
            }
            if (!stateDef.readOnly) {
                device[stateDef.key || stateDef.name] = value;
            }

            if (device.created) {
                if(!device.active) {
                    await this.setDeviceActive(device, true, data.source);
                }

                if (device.name !== 'Global') {
                    await this.setStateChangedAsync(buildId(device, stateDefinitions.active), true, true);
                    await this.setStateAsync(buildId(device, stateDefinitions.lastSeen), Date.now(), true);
                }

                const id = buildId(device, stateDef);
                this.log.debug('Updating ' + id + ' to ' + value);
                await this.createStateInDevice(device, stateDef);
                if (device.didPoll[stateDef.name]) {
                    await this.setStateAsync(id, value, true);
                    device.didPoll[stateDef.name] = false;
                } else {
                    await this.setStateChangedAsync(id, value, true);
                }

                //set global active source here:
                if (stateDef.name === stateDefinitions.activeSource.name && data.data && data.data.str) {
                    this.log.debug('Setting activeSource to ' + data.data.str);
                    await this.setStateChangedAsync(buildId(this.globalDevice, stateDefinitions['active-source']), data.data.str, true);
                    for (const otherDevice of this.devices) {
                        if (otherDevice.name !== 'Global' && otherDevice.activeSource && otherDevice.name !== device.name) {
                            await this.setStateChangedAsync(buildId(device, stateDef), false, true);
                        }
                    }
                }
                if (stateDef.name === stateDefinitions.volume.name) {
                    await this.setStateChangedAsync(buildId(this.globalDevice, stateDefinitions.volume), value, true);
                }
            }
        } catch (e) {
            console.log('Error: ', e);
            this.log.error('Error during processing event: ' + e + ' ' + JSON.stringify(data) + ' - ' + e.stack);
        }
    }

    /**
     * initializes cec monitor
     * @param {ioBroker.AdapterConfig} config
     */
    async setupCECMonitor(config) {
        try {
            //let's make sure we can access vchiq, needed for cec-client:
            this.log.debug('Testing access.');
            const result = await fs.access('/dev/vchiq', fsConstants.R_OK);
            this.log.debug('Access resulted in: ' + result);
        } catch (e) {
            if (e.code === 'EACCES') {
                this.log.error("Can not access HDMI-CEC, please make sure iobroker user can access /dev/vchiq. On Raspian run this command: 'sudo usermod -a -G video iobroker'");
            } else {
                this.log.error('Can not access HDMI. Please read requirements part of readme. Error: ' + e + ' - ' + e.stack);
            }
        }

        this.cec = new CECMonitor(config.osdName, {
            debug: true, //config.cecDebug,
            //hdmiport: config.hdmiPort,
            //processManaged: false, // if false -> will catch uncaught exceptions and exit process. Hm.
            recorder: config.type === 'r',
            player: config.type === 'p',
            tuner: config.type === 't',
            audio: config.type === 'a',
            autorestart: true, //allows auto restart of cec-client.
            command_timeout: 3,
            //user_control_hold_interval: config.userControlHoldInterval
        });

        this.cec.on('_debug', d => this.log.debug(d));
        this.cec.on('_traffic', d => this.log.debug(d));
        this.cec.on('_stop', d => d ? this.log.error('CEC Monitor stopped: ' + d) : this.log.debug('CEC Monitor stopped gracefully.'));

        //add listeners for device changes:
        Object.keys(eventToStateDefinition).forEach(k => this.cec.on(k, d => this.processEvent(d)));

        this.log.debug('Starting CEC Monitor.');
        try {
            await this.cec.WaitForReady();
            await this.setStateChangedAsync('info.connection', true, true);
        } catch (e) {
            this.log.error('Could not start CEC adapter: ' + e + ' - ' + e.stack);
            await this.setStateChangedAsync('info.connection', false, true);
            if (e.code === 'ENOENT') {
                this.log.error('cec-client not found. Please make sure cec-utils are installed and cec-client can be run by iobroker user.');
                return;  //can not do the rest of the stuff.
            }
        }

        this.log.debug('CEC Monitor ready.');
        this.timeouts.scan = setTimeout(() => this.cec.WriteRawMessage('scan'), 10000);

        if (config.pollPowerStates) {
            await this.pollPowerStates();
        }

        //some global states:
        await this.createDeviceAsync(this.globalDevice.name);
        //raw command
        await this.createStateInDevice(this.globalDevice, stateDefinitions['raw-command']);
        //active-source:
        await this.createStateInDevice(this.globalDevice, stateDefinitions['active-source']);
        //osd:
        await this.createStateInDevice(this.globalDevice, stateDefinitions['osd-message']);
        await this.createStateInDevice(this.globalDevice, stateDefinitions['osd-message-clear']);
        //volume:
        await this.createStateInDevice(this.globalDevice, stateDefinitions.volume);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.volumeUp);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.volumeDown);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.mute);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.systemAudio);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.arc);
        await this.createStateInDevice(this.globalDevice, stateDefinitions.standbyAll);
        //poll audio stuff:
        this.timeouts.pollAudio = setTimeout(async () => {
            //volume, mute and so on
            try {
                await this.cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.GIVE_AUDIO_STATUS);
            } catch (e) {
                this.log.info('Could not poll audio status: ' + e);
            }
            //do we use audio at all?
            try {
                await this.cec.SendMessage(null, CEC.LogicalAddress.AUDIOSYSTEM, CEC.Opcode.GIVE_SYSTEM_AUDIO_MODE_STATUS);
            } catch (e) {
                this.log.info('Could not poll audio system status: ' + e);
            }
            //who is active:
            try {
                await this.cec.SendMessage(null, CEC.LogicalAddress.BROADCAST, CEC.Opcode.REQUEST_ACTIVE_SOURCE);
            } catch (e) {
                this.log.info('Could not poll active source: ' + e);
            }
        }, 2000);
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
        const existingDevices = await this.getDevicesAsync();
        for (const device of existingDevices) {
            const id = device._id;
            const existingDevice = {
                /** @type {Array<string>} */
                createdStates: [],
                active: false,
                name: '',
                created: true,
                ignored: false,
                logicalAddress: CEC.LogicalAddress.UNKNOWN,
                get logicalAddressHex() { return Number(this.logicalAddress).toString(16); },
                didPoll: {}
            };
            const states = await this.getStatesOfAsync(id);

            for (const stateObject of states) {
                if (!stateObject.native.poll) { //skipp poll states
                    const defString = /** @type {string} */ (stateObject.native.def);
                    /** @type {stateDefinition} */
                    const def = stateDefinitions[defString];
                    const state = await this.getStateAsync(stateObject._id);
                    if (state && def && !def.readOnly) { //unpack val
                        existingDevice[def.key || def.name] = state.val; //remember values
                    }
                    existingDevice.createdStates.push(defString);
                }
            }
            if (device.common.name !== 'Global') {
                await this.setStateChangedAsync(buildId(device.common.name, stateDefinitions.active), false, true);
            }
            this.devices.push(existingDevice);

            //make sure all states that should exist do exist.
            if (existingDevice.name) {
                await this.createDefaultDeviceStates(existingDevice);
            }
        }

        //setup cec system
        await this.setupCECMonitor(this.config);

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates('*');
    }


    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {function} callback
     */
    onUnload(callback) {
        try {
            this.cec.Stop();
            for (const key of Object.keys(this.timeouts)) {
                clearTimeout(this.timeouts[key]);
            }
            this.log.debug('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} _id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(_id, obj) {
        if (obj) {
            // The object was changed
            //this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            //this.log.info(`object ${id} deleted`);
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
                    this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    const isPoll = id.includes('.poll.');
                    const deviceName = getDeviceIdFromId(id);
                    const device = this.devices.find(d => d && d.name === deviceName);
                    if (!device) {
                        this.log.error('No device for name ' + deviceName + ' created.');
                        return;
                    }
                    if (isPoll) {
                        const stateDefinition = stateDefinitionFromId(id);
                        if (stateDefinition.pollOpCode) {
                            device.didPoll[stateDefinition.name] = true;
                            await this.cec.SendMessage(null, device.logicalAddress, stateDefinition.pollOpCode);
                            await this.cec.SendMessage(null, stateDefinition.pollTarget || device.logicalAddress, stateDefinition.pollOpCode, stateDefinition.pollArgument);
                        } else {
                            this.log.error('Can not poll ' + stateDefinition.name + '. Please report error.');
                        }
                    } else if (id.includes(stateDefinitions.createButtons.name)) {
                        this.log.debug('Creating buttons for ' + device.name);
                        for (const key of Object.keys(CEC.UserControlCode)) {
                            await this.setObjectNotExistsAsync(`${device.name}.buttons.${key}`, {type: 'state', common: {name: key, write: true, read: false, role: 'button', type: 'boolean'}, native: {isButton: true}});
                        }
                        await this.setObjectNotExistsAsync(`${device.name}.buttons.time`, {type: 'state', common: {def: 500, name: 'Set time for next button press', unit: 'ms', write: true, read: false, role: 'level.timer', type: 'number'}, native: {isButton: true}});
                    } else if (id.includes('.buttons.time')) {
                        if (!state.val || state.val < 50) {
                            state.val = 50;
                            this.log.warn('Button presses below 50ms not supported. Increased time.');
                        }
                        device.currentButtonPressTime = Math.max(50, /** @type {number} */ (state.val));
                    } else if (id.includes('.buttons.')) {
                        const name = id.substring(id.lastIndexOf('.') + 1);
                        const code = CEC.UserControlCode[name];
                        if (code) {
                            await this.cec.SendMessage(null, device.logicalAddress, CEC.Opcode.USER_CONTROL_PRESSED, code);
                            setTimeout(async () => {
                                await this.cec.SendMessage(null, device.logicalAddress, CEC.Opcode.USER_CONTROL_RELEASE, code);
                            }, device.currentButtonPressTime);
                        }
                    } else {
                        const stateDefinition = stateDefinitionFromId(id);
                        if (typeof stateDefinition.command === 'function') {
                            this.log.debug('Sending ' + state.val + ' for id ' + id + ' to ' + deviceName);
                            await stateDefinition.command(state.val, device, this.cec, this.log);
                        } else {
                            this.log.warn('Can not write state ' + id + ' of type ' + stateDefinition.name + '. Please do not write read only states!');
                        }
                    }
                } catch (e) {
                    this.log.error('Could not write state ' + id + ': ' + e + ' ' + e.stack);
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
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new CEC2(options);
} else {
    // otherwise start the instance directly
    new CEC2();
}
