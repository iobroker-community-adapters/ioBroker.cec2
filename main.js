'use strict';

/**
 *
 * cec2 adapter
 *
 * Created with `@iobroker/create-adapter` v2.5.0
 *
 * //native parameters will be in adapter.config
 *
 * Structure:
 *  create a "device" for every physical address we encounter.
 *      set name to OSD Name -> probably clean up old device if OSD Name != new OSD Name
 *      for device create states:
 *          power
 *          activeSource true/false (must set to false, if somebody else gets active.
 *          vendorId
 *          device class (device from logical address?)
 *          lastKnownLogicalAddress
 *          ...
 *          some Information what works and what not? (like capabilities?)
 *          some things dependent on device class
 *      for device create folder(s):
 *          remote buttons -> with buttons for all possible remote buttons to be clicked.
 *          poll -> poll buttons for some states
 */

//TODO:
// - add user control as states in device (sub folder)
//      - could also need a state with button press length
// - testing!!!
// - especially setting stuff, everything besides on off needs testing, i.e.:
//          activeSource (on AND off!),
//          recording (do we have a device that can record at all??),
//          deck (what can I control with this?),
//          tuner (can I control TV tuner with that?),
//          menu (can I open menu with that? On TV? On FireTV?),
//  - add more specific polling, i.e. ask audio device for audio status and tuner maybe?
//  - should we add parameter sub folder and allow polling of single states?
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

/**
 * @typedef stateDefinition - imported type.
 * @type {import('./lib/stateDefinitions').stateDefinition}
 */

//imports:
const CEC = require('./lib/cec-constants');
const CECMonitor = require('./lib/cec-monitor');
const protocol = require('./lib/cec-protocol');
const fs = require('node:fs').promises;
const fsConstants = require('node:fs').constants;
const stateDefinitions = /** @type {Record<string, stateDefinition>} */ (require('./lib/stateDefinitions'));

/**
 * Remove forbidden characters from names so I can use them as ID.
 *
 * @type {RegExp}
 */
const forbiddenCharacters = /[\][*,;'"`<>\\\s?]/g;

/** Default interval for polling the TV power state in ms. */
const DEFAULT_POLL_INTERVAL = 60000;

/** Default time a remote button is held in ms. */
const DEFAULT_BUTTON_PRESS_TIME = 500;

/**
 * Translate Event IDs to stateDefinitions.
 *
 * @type {Record<number|string, stateDefinition>}
 */
const eventToStateDefinition = {
    ACTIVE_SOURCE: stateDefinitions.activeSource,
    INACTIVE_SOURCE: stateDefinitions.activeSource,
    //'ROUTING_CHANGE': stateDefinitions.route,
    //'ROUTING_INFORMATION': stateDefinitions.routingInfo,
    //'SET_MENU_LANGUAGE': stateDefinitions.language,
    RECORD_STATUS: stateDefinitions.recording,
    CEC_VERSION: stateDefinitions.cecVersion,
    REPORT_PHYSICAL_ADDRESS: stateDefinitions.physicalAddress,
    DECK_STATUS: stateDefinitions.deck,
    TUNER_DEVICE_STATUS: stateDefinitions.tuner,
    DEVICE_VENDOR_ID: stateDefinitions.vendor,
    SET_OSD_NAME: stateDefinitions.name,
    MENU_STATUS: stateDefinitions.menuStatus,
    REPORT_POWER_STATUS: stateDefinitions.powerState,
    [protocol.POLLING_MESSAGE]: stateDefinitions.active,
    REPORT_AUDIO_STATUS: stateDefinitions.volume,
    SYSTEM_AUDIO_MODE_STATUS: stateDefinitions.systemAudio,
    SET_SYSTEM_AUDIO_MODE: stateDefinitions.systemAudio,
    REPORT_ARC_STARTED: stateDefinitions.arc,
    REPORT_ARC_ENDED: stateDefinitions.arc,
};

/**
 * Build ID from device and stateDefinition, i.e. needs to be in device folder and maybe also poll sub folder.
 *
 * @param {cecDevice|string} device - device or device name
 * @param {stateDefinition} stateDef - state definition of state
 * @param {boolean} [poll] - true if in polling folder.
 * @returns {string} the full ioBroker state ID
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
    return `${name}.${stateDef.idPrefix ? `${stateDef.idPrefix}.` : ''}${poll ? 'poll.' : ''}${stateDef.name}`;
}

/**
 * Cleanup name to create ID from it. Also contains hack for FireTV devices.
 *
 * @param {string} name - raw device name from CEC bus
 * @returns {string} sanitized name suitable for use as ioBroker ID
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
 *
 * @param {string} id - full ioBroker state ID
 * @returns {string} device name portion of the ID (third segment)
 */
function getDeviceIdFromId(id) {
    const parts = id.split('.');
    return parts[2]; //0 == adapter, 1 == instance -> return 2.
}

/**
 * Returns state part of ioBroker id (in device or poll folder)
 *
 * @param {string} id - full ioBroker state ID
 * @returns {string} last segment of the ID (state name)
 */
function getStateFromId(id) {
    return id.substring(id.lastIndexOf('.') + 1);
}

/**
 * Get a stateDefinition from ioBroker ID
 *
 * @param {string} id - full ioBroker state ID
 * @returns {stateDefinition} matching state definition
 * @throws {Error} if no stateDefinition found for ID (should never happen!)
 */
function stateDefinitionFromId(id) {
    const stateName = getStateFromId(id);
    for (const key of Object.keys(stateDefinitions)) {
        const definition = stateDefinitions[key];
        if (definition.name === stateName) {
            return definition;
        }
    }
    throw new Error(`Could not find stateDefinition for ${id}`);
}

/**
 * @typedef cecDevice
 * @type {object}
 * @property {Array<string>} createdStates - states created for this device
 * @property {string} name - name of device - cleaned up to be ID
 * @property {number} logicalAddress - logicalAddress on bus. Negative for invalid.
 * @property {string} logicalAddressHex - Hex version of logicalAddress
 * @property {string} [physicalAddress] - Physical Address of device in 0.0.0.0 format
 * @property {number} [lastGetName] - last time we asked for a name.
 * @property {number} [getNameTries] - how often we have tried to get a name.
 * @property {number} [lastGetPhysAddr] - last time we asked for a physical address
 * @property {number} [getPhysAddrTries] - how often we have tried to get physical address
 * @property {boolean} [physicalAddressReallyChanged] - true if physicalAddress really changed, i.e. device answered and name differs.
 * @property {Record<string, boolean>} didPoll - true if device did just poll this state ref so next update will be forced to iobroker.
 * @property {boolean} [active] - active state value
 * @property {number} [lastSeen] - last seen since value
 * @property {boolean} [activeSource] - activeSource state value
 * @property {number} [volume] - volume (only on global device)
 * @property {boolean} [volumeUp] - volumeUp state (only on global device)
 * @property {boolean} [volumeDown] - volumeDown state (only on global device)
 * @property {boolean} [mute] - mute state (only on global device)
 * @property {boolean} [arc] - arc state (only on global device)
 * @property {boolean} [systemAudio] - systemAudio state (only on global device)
 * @property {Array<cecDevice>} [devices] - Array of all devices (only on global device?)
 * @property {number} [currentButtonPressTime] - Time in milliseconds a button is held.
 * @property {boolean} created - if device was created in ioBroker or not.
 * @property {boolean} ignored - if device is ignored (because no name & config setting)
 */

class CEC2 extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - adapter options passed to super
     */
    constructor(options) {
        super({
            ...options,
            name: 'cec2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        /**
         * Backend for CEC communication, created in setupCECMonitor before it is used.
         *
         * @type {import('./lib/cec-backend')}
         */
        this.cec = /** @type {import('./lib/cec-backend')} */ (/** @type {unknown} */ (null));
        /** @type {Record<string, ioBroker.Timeout | undefined>} */
        this.timeouts = {};
        /** @type {Record<number, cecDevice>} */
        this.logicalAddressToDevice = {};
        /** @type {Array<cecDevice>} */
        this.devices = [];
        /** @type {cecDevice} */
        this.globalDevice = {
            name: 'Global',
            logicalAddress: CEC.LogicalAddress.BROADCAST,
            get logicalAddressHex() {
                return Number(this.logicalAddress).toString(16);
            },
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
            didPoll: {},
        };
        this.devices.push(this.globalDevice);
    }

    /**
     * Poll PowerStates of cec devices (currently only TV is polled -> too much polling seems no good idea).
     *
     * @returns {Promise<void>}
     */
    async pollPowerStates() {
        if (this.timeouts.pollPowerStates) {
            this.clearTimeout(this.timeouts.pollPowerStates); //prevent multiple executions.
        }

        try {
            const status = await this.cec.request(
                CEC.LogicalAddress.TV,
                CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
                [],
                CEC.Opcode.REPORT_POWER_STATUS,
            );
            this.log.debug(`TV Power is ${status.data.str}`);
        } catch (e) {
            this.log.debug(`TV did not answer to powerRequest: ${e}`);
        }

        this.timeouts.pollPowerStates = this.setTimeout(
            () => this.pollPowerStates(),
            this.config.pollInterval || DEFAULT_POLL_INTERVAL,
        );
    }

    /**
     * create a state in device based on state definition and set value.
     *
     * @param {cecDevice} device - the CEC device to create the state in
     * @param {stateDefinition} stateDefinition - definition of the state to create
     * @returns {Promise<void>}
     */
    async createStateInDevice(device, stateDefinition) {
        if (device.createdStates.find(s => s === (stateDefinition.key ? stateDefinition.key : stateDefinition.name))) {
            this.log.debug(`State ${stateDefinition.name} already created in ${device.name}`);
            return;
        }

        let states = undefined;
        if (stateDefinition.valueList) {
            states = {};
            Object.keys(stateDefinition.valueList).forEach(key => {
                if (stateDefinition.valueList && stateDefinition.valueList[key]) {
                    states[stateDefinition.valueList[key]] = key;
                }
            });
        }

        const id = buildId(device, stateDefinition);
        if (id.includes('undefined')) {
            this.log.error(
                `Creating state undefined: ${JSON.stringify(stateDefinition)} in device${JSON.stringify(device)} id ${
                    id
                }`,
            );
            throw new Error(`State undefined: ${id}`);
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
                states: states,
            },
            native: { def: stateDefinition.key || stateDefinition.name },
        });
        device.createdStates.push(stateDefinition.name);

        //don't set val here, will set all values when adapter start. We do not really want that. And we do not need that here, do we?
        //await this.setStateChangedAsync(id, val, true);

        //create poll states:
        if (stateDefinition.pollOpCode) {
            const id = buildId(device, stateDefinition, true);
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: {
                    type: 'boolean',
                    desc: `poll ${stateDefinition.name}`,
                    name: `poll ${stateDefinition.name}`,
                    role: 'button',
                    read: false,
                    write: true,
                },
                native: { def: stateDefinition.key || stateDefinition.name, poll: true },
            });
        }
    }

    /**
     * Get a device from our devices array by name.
     *
     * @param {string} name - raw device name (will be cleaned up internally)
     * @returns {cecDevice|undefined} matching device or undefined if not found
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
     *
     * @param {cecDevice} device - the CEC device to update
     * @param {boolean} active - whether the device is now active
     * @param {number} logicalAddress - new logical Address
     * @returns {Promise<void>}
     */
    async setDeviceActive(device, active, logicalAddress) {
        device.active = active;
        device.logicalAddress = logicalAddress;
        if (device.name !== 'Global') {
            await this.setStateAsync(buildId(device, stateDefinitions.active), active, true);
            await this.setStateAsync(buildId(device, stateDefinitions.logicalAddress), device.logicalAddress, true);
            await this.setStateAsync(
                buildId(device, stateDefinitions.logicalAddressHex),
                device.logicalAddressHex,
                true,
            );
        }
    }

    /**
     * Creates default states in device, ie states all devices should have.
     *
     * @param {cecDevice} device - the CEC device to create default states for
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

        if (device.logicalAddress === 0) {
            //TV always has 0.0.0.0, but does not necessarily report that.
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
     *
     * @param {number} logicalAddress - logical address of detected device
     * @param {event} data - incoming CEC message
     * @returns {Promise<cecDevice>} the created or existing device
     */
    async createCECDevice(logicalAddress, data) {
        this.log.debug(`============================ Creating device: ${logicalAddress}: ${JSON.stringify(data)}`);
        //do we have a name already?
        let name = data && data.opcode === CEC.Opcode.SET_OSD_NAME && data.data ? cleanUpName(data.data.str || '') : '';
        if (!name && logicalAddress === 0) {
            name = 'TV'; //TV does not really need to implement OSD Name... not nice. :-(
        }
        //do we know the device already?
        let device = this.getDeviceByName(name);
        if (device && !this.logicalAddressToDevice[logicalAddress]) {
            this.logicalAddressToDevice[logicalAddress] = device; //we do not fill this from existing devices in ioBroker, do that here.
            if (!device.active) {
                await this.setDeviceActive(device, true, logicalAddress);
            }
        }

        //do we have a device for the logicalAddress?
        if (!device) {
            device = this.logicalAddressToDevice[logicalAddress];
        }
        if (!device) {
            this.log.debug(`Creating dummy device for ${logicalAddress} to use during device creation.`);
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
                get logicalAddressHex() {
                    return Number(this.logicalAddress).toString(16);
                },
                createdStates: [],
                didPoll: {},
            };
            this.logicalAddressToDevice[logicalAddress] = device;
        }
        if (!name) {
            name = device.name;
        }
        if (device.created) {
            //make sure we do the following only once:
            this.log.info(`Device for ${logicalAddress} already created.`);
            return device;
        }

        if (!this.cec.ready) {
            this.log.debug('CEC not yet ready, delay sending messages.');
            return device;
        }

        //ask for name, if we don't have it
        if (!name) {
            //no device can not be undefined here... :-(
            // @ts-expect-error optional property may be undefined initially
            if (device.getNameTries < 11) {
                //try to get name, if tried too often, continue with physicalAddress.
                // @ts-expect-error optional property may be undefined initially
                if (Date.now() - device.lastGetName > 3000) {
                    this.log.info(`No name for logicalAddress ${logicalAddress}, requesting it.`);
                    try {
                        // @ts-expect-error optional property may be undefined initially
                        device.getNameTries += 1;
                        device.lastGetName = Date.now();
                        await this.cec.transmit(logicalAddress, CEC.Opcode.GIVE_OSD_NAME);
                        this.clearTimeout(this.timeouts[`createTimeout${logicalAddress}`]);
                        this.timeouts[`createTimeout${logicalAddress}`] = this.setTimeout(() => {
                            this.createCECDevice(logicalAddress, data);
                        }, 10000);
                    } catch (e) {
                        this.log.error(`Could not get name: ${e} - ${e.stack}`);
                    }
                }
                return device; //exit and retry later.
            }
        }

        if (!name && this.config.preventUnnamedDevices) {
            device.ignored = true;
            this.log.info(`Ignoring device ${device.logicalAddressHex} because did not get a name.`);
            return device;
        }

        //if we can not get name, but have physicalAddress already, use it.
        if (!name && device.physicalAddress) {
            device.name = device.physicalAddress.replace(/\./g, '');
            name = device.name;
        }
        //ask for physicalAddress if we do not have it and it did not happen already / too fast / too many times. Exit and retry later.
        if (!name) {
            //no device can not be undefined here... :-(
            // @ts-expect-error optional property may be undefined initially
            if (device.getPhysAddrTries < 11) {
                //try to get physicalAddress, if tried to often continue without it.
                // @ts-expect-error optional property may be undefined initially
                if (Date.now() - device.lastGetPhysAddr > 60000) {
                    this.log.debug(`Requesting name failed, try to get physical address for ${logicalAddress}`);
                    try {
                        // @ts-expect-error optional property may be undefined initially
                        device.getPhysAddrTries += 1;
                        device.lastGetPhysAddr = Date.now();
                        await this.cec.transmit(logicalAddress, CEC.Opcode.GIVE_PHYSICAL_ADDRESS);
                        this.clearTimeout(this.timeouts[`createTimeout${logicalAddress}`]);
                        this.timeouts[`createTimeout${logicalAddress}`] = this.setTimeout(() => {
                            this.createCECDevice(logicalAddress, data);
                        }, 10000);
                    } catch (e) {
                        this.log.error(`Could not get physical address: ${e} - ${e.stack}`);
                    }
                }
                return device; //exit and retry later.
            }
        }

        //all failed, we can not get a name... use Logical Address.
        if (!name) {
            this.log.warn(`Could not find a name for device ${logicalAddress}`);
            name = `Unknown_${Number(logicalAddress).toString(16).toUpperCase()}`;
        }

        name = cleanUpName(name);
        this.log.info(`Device with logicalAddress ${logicalAddress} seen. Has name ${name}`);
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
            this.log.info(`Already knew device ${name}. Update values.`);
        }

        //set all fields in ioBroker, might have some stuff that was received before CEC Ready.
        for (const key of Object.keys(device)) {
            if (device[key] !== undefined && device[key] !== null) {
                const stateDef = stateDefinitions[key];
                if (stateDef) {
                    await this.processEvent({ source: logicalAddress, stateDef: stateDef, parsedData: device[key] });
                } else {
                    if (
                        key !== 'created' &&
                        key !== 'physicalAddressReallyChanged' &&
                        key !== 'createdStates' &&
                        key !== 'lastGetName' &&
                        key !== 'getNameTries' &&
                        key !== 'lastGetPhysAddr' &&
                        key !== 'getPhysAddrTries' &&
                        key !== 'didPoll' &&
                        key !== 'ignored'
                    ) {
                        this.log.warn(`No state definition for ${key}`);
                    }
                }
            }
        }

        //poll some more:
        for (const def of [
            stateDefinitions.deck,
            stateDefinitions.tuner,
            stateDefinitions.menuStatus,
            stateDefinitions.powerState,
        ]) {
            await this.cec.transmit(logicalAddress, /** @type {number} */ (def.pollOpCode), def.pollArgument);
        }

        this.log.info(`Creation of device ${device.name} finished.`);
        return existingDevice || device;
    }

    /**
     * Received CEC message or internal update of a state.
     *
     * @typedef event
     * @type {object}
     * @property {number} source - source logical address
     * @property {number} [target] - target logical address
     * @property {number} [opcode] - CEC opcode
     * @property {Array<number>} [args] - opcode arguments
     * @property {string} [event] - event name string
     * @property {import('./lib/cec-protocol').CecMessageData} [data] - parsed data, usually value and string representation
     * @property {stateDefinition} [stateDef] - associated state definition
     * @property {ioBroker.StateValue} [parsedData] - additional parsed data
     */

    /**
     * Process CEC Event - update ioBroker states based on the incoming CEC message.
     *
     * @param {event} data - CEC event
     * @returns {Promise<void>}
     */
    async processEvent(data) {
        try {
            //REPORT_PHYSICAL_ADDRESS: {"type":"TRAFFIC","number":"17707","flow":"OUT","source":1,"target":15,"opcode":132,"args":[48,0,1],"event":"REPORT_PHYSICAL_ADDRESS","data":{"val":12288,"str":"3.0.0.0"}}
            //DEVICE_VENDOR_ID:        {"type":"TRAFFIC","number":"57985","flow":"IN","source":11,"target":15,"opcode":135,"args":[0,0,0],"event":"DEVICE_VENDOR_ID","data":{"val":0,"str":"UNKNOWN"}}

            this.log.debug(`============================ Processing Event: ${data.event}: ${JSON.stringify(data)}`);

            let stateDef = data.stateDef;
            if (!stateDef && data.event) {
                stateDef = eventToStateDefinition[data.event];
            }
            if (!stateDef) {
                this.log.warn(`No stateDef for ${JSON.stringify(data)}`);
                return;
            }
            let device = this.logicalAddressToDevice[data.source];
            if (stateDef.isGlobal) {
                this.log.debug(`State ${stateDef.name} is global, use global device.`);
                device = this.globalDevice;
            }

            if (device && device.ignored) {
                this.log.debug('Ignoring message from ignored device.');
                return;
            }

            if (!device || !device.created) {
                this.log.debug(`No device for ${data.source} start device creation`);
                await this.createCECDevice(data.source, data);
                device = this.logicalAddressToDevice[data.source];
            }

            if (stateDef.name === stateDefinitions.name.name) {
                if (data && data.data && data.data.str) {
                    data.data.str = cleanUpName(data.data.str);
                }
                if (device.created && data.data && data.data.str && data.data.str !== device.name) {
                    this.log.warn(
                        `New device with name ${data.data.str} for logicalAddress ${device.logicalAddressHex}`,
                    );
                    //deactivate old device:
                    await this.setDeviceActive(device, false, CEC.LogicalAddress.UNKNOWN);
                    delete this.logicalAddressToDevice[data.source];

                    //rerun method:
                    return this.processEvent(data);
                }
            }

            if (stateDef.name === stateDefinitions.physicalAddress.name) {
                if (data && data.data && data.data.str) {
                    if (
                        device.created &&
                        device.physicalAddress !== data.data.str &&
                        !device.physicalAddressReallyChanged
                    ) {
                        this.log.info(
                            `Device with unexpected physical address came online on logical address ${
                                device.logicalAddressHex
                            }`,
                        );
                        if (device.active) {
                            await this.setDeviceActive(device, false, CEC.LogicalAddress.UNKNOWN);
                            delete this.logicalAddressToDevice[data.source];
                        }
                        device.physicalAddressReallyChanged = true; //prevent endless loop, if physical address really changed.

                        //this should create the new device:
                        try {
                            await this.cec.request(data.source, CEC.Opcode.GIVE_OSD_NAME, [], CEC.Opcode.SET_OSD_NAME);
                        } catch (e) {
                            this.log.debug(`Could not get name of device with new physical address: ${e}`);
                        }
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
                } else if (stateDef.type === 'string' && data.data) {
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
                if (!device.active) {
                    await this.setDeviceActive(device, true, data.source);
                }

                if (device.name !== 'Global') {
                    await this.setStateAsync(buildId(device, stateDefinitions.active), true, true);
                    await this.setStateAsync(buildId(device, stateDefinitions.lastSeen), Date.now(), true);
                }

                const id = buildId(device, stateDef);
                this.log.debug(`Updating ${id} to ${value}`);
                await this.createStateInDevice(device, stateDef);
                if (device.didPoll[stateDef.name]) {
                    await this.setStateAsync(id, value ?? null, true);
                    device.didPoll[stateDef.name] = false;
                } else {
                    await this.setStateAsync(id, value ?? null, true);
                }

                //set global active source here:
                if (data.opcode === CEC.Opcode.ACTIVE_SOURCE && data.data && data.data.str) {
                    this.log.debug(`Setting activeSource to ${data.data.str}`);
                    await this.setStateAsync(
                        buildId(this.globalDevice, stateDefinitions['active-source']),
                        data.data.str,
                        true,
                    );
                    for (const otherDevice of this.devices) {
                        if (
                            otherDevice.name !== 'Global' &&
                            otherDevice.created &&
                            otherDevice.activeSource &&
                            otherDevice.name !== device.name
                        ) {
                            otherDevice.activeSource = false;
                            await this.setStateAsync(buildId(otherDevice, stateDef), false, true);
                        }
                    }
                }
                if (stateDef.name === stateDefinitions.volume.name) {
                    await this.setStateAsync(buildId(this.globalDevice, stateDefinitions.volume), value ?? null, true);
                }
            }
        } catch (e) {
            console.log('Error: ', e);
            this.log.error(`Error during processing event: ${e} ${JSON.stringify(data)} - ${e.stack}`);
        }
    }

    /**
     * Check if we can access the CEC device nodes and log hints if not.
     *
     * @param {string} [port] - configured device, if any
     * @returns {Promise<void>}
     */
    async checkDeviceAccess(port) {
        /** @type {Array<string>} */
        let devices = [];
        if (port) {
            devices = [port];
        } else {
            const entries = await fs.readdir('/dev').catch(() => /** @type {Array<string>} */ ([]));
            devices = entries.filter(e => /^cec\d+$/u.test(e)).map(e => `/dev/${e}`);
            if (!devices.length && entries.includes('vchiq')) {
                devices = ['/dev/vchiq']; //old Raspberry Pi firmware driver.
            }
        }
        if (!devices.length) {
            this.log.info(
                'No CEC device (/dev/cec*) found. This is fine for USB adapters, otherwise please read the requirements part of the readme.',
            );
            return;
        }
        for (const device of devices) {
            try {
                await fs.access(device, fsConstants.R_OK | fsConstants.W_OK);
                this.log.debug(`Access to ${device} ok.`);
            } catch (e) {
                if (e.code === 'EACCES') {
                    this.log.error(
                        `Can not access ${device}, please make sure the iobroker user is in the group owning it (usually 'video', for USB adapters 'dialout'): 'sudo usermod -a -G video iobroker'`,
                    );
                } else {
                    this.log.error(`Can not access ${device}. Please read requirements part of readme. Error: ${e}`);
                }
            }
        }
    }

    /**
     * Process message received from CEC bus.
     *
     * @param {import('./lib/cec-protocol').CecMessage} message - decoded message
     */
    onCecMessage(message) {
        if (message.opcode === CEC.Opcode.FEATURE_ABORT) {
            this.log.debug(`Device ${message.source} refused ${message.data.str}: ${message.data.reasonStr}`);
            return;
        }
        if (eventToStateDefinition[message.event]) {
            void this.processEvent(message);
        }
    }

    /**
     * initializes cec backend
     *
     * @param {ioBroker.AdapterConfig} config - adapter configuration (native section)
     */
    async setupCECMonitor(config) {
        await this.checkDeviceAccess(config.port);

        this.log.debug('Starting CEC Monitor.');
        this.cec = new CECMonitor({
            timers: this,
            debug: true,
            osdName: config.osdName,
            type: /** @type {'p'|'r'|'t'|'a'} */ (config.type),
            hdmiPort: Number(config.hdmiPort) || 0,
            port: config.port,
            responseTimeout: 3000,
        });

        this.cec.on('log', (level, message) => this.log[level](message));
        this.cec.on('message', message => this.onCecMessage(message));
        this.cec.on('disconnected', () => this.setStateChangedAsync('info.connection', false, true));
        this.cec.on('ready', () => this.setStateChangedAsync('info.connection', true, true));

        try {
            await this.cec.start();
        } catch (e) {
            this.log.error(`Could not start CEC: ${e.message}`);
            await this.setStateChangedAsync('info.connection', false, true);
            if (e.code === 'ENOENT') {
                this.terminate(utils.EXIT_CODES.INVALID_DEPENDENCY_VERSION);
            }
            return;
        }
        this.cec.on('fatal', e => {
            this.log.error(e.message);
            this.terminate(utils.EXIT_CODES.INVALID_DEPENDENCY_VERSION);
        });

        this.log.debug('CEC Monitor ready.');
        this.timeouts.scan = this.setTimeout(
            () => this.cec.scan().catch(e => this.log.info(`Could not scan bus: ${e}`)),
            10000,
        );

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
        this.timeouts.pollAudio = this.setTimeout(async () => {
            const polls = [
                //volume, mute and so on
                { target: CEC.LogicalAddress.AUDIOSYSTEM, opcode: CEC.Opcode.GIVE_AUDIO_STATUS },
                //do we use audio at all?
                { target: CEC.LogicalAddress.AUDIOSYSTEM, opcode: CEC.Opcode.GIVE_SYSTEM_AUDIO_MODE_STATUS },
                //who is active:
                { target: CEC.LogicalAddress.BROADCAST, opcode: CEC.Opcode.REQUEST_ACTIVE_SOURCE },
            ];
            for (const poll of polls) {
                try {
                    await this.cec.transmit(poll.target, poll.opcode);
                } catch (e) {
                    this.log.info(`Could not poll ${CEC.OpcodeNames[poll.opcode]}: ${e}`);
                }
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
        this.log.info(`config osdName: ${this.config.osdName}`);
        this.log.info(`config type: ${this.config.type}`);

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
                get logicalAddressHex() {
                    return Number(this.logicalAddress).toString(16);
                },
                didPoll: {},
            };
            const states = await this.getStatesOfAsync(id);

            for (const stateObject of states) {
                if (stateObject.native.def === 'maxCecVersionSupported') {
                    //CEC version emulation was removed, clean up old state.
                    await this.delObjectAsync(stateObject._id);
                    continue;
                }
                if (!stateObject.native.poll) {
                    //skipp poll states
                    const defString = /** @type {string} */ (stateObject.native.def);
                    /** @type {stateDefinition} */
                    const def = stateDefinitions[defString];
                    const state = await this.getStateAsync(stateObject._id);
                    if (state && def && !def.readOnly) {
                        //unpack val
                        existingDevice[def.key || def.name] = state.val; //remember values
                    }
                    existingDevice.createdStates.push(defString);
                }
            }
            if (device.common.name !== 'Global') {
                const commonName = device.common.name;
                const name =
                    typeof commonName === 'string'
                        ? commonName
                        : commonName.en ||
                          commonName.de ||
                          commonName.uk ||
                          commonName.es ||
                          commonName.ru ||
                          commonName.fr ||
                          commonName.it ||
                          commonName.nl ||
                          commonName.pl ||
                          commonName.pt ||
                          commonName['zh-cn'] ||
                          existingDevice.name;
                await this.setStateChangedAsync(buildId(name, stateDefinitions.active), false, true);
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
     *
     * @param {() => void} callback - callback must be called under any circumstances
     */
    onUnload(callback) {
        try {
            if (this.cec) {
                this.cec.stop();
            }
            for (const key of Object.keys(this.timeouts)) {
                this.clearTimeout(this.timeouts[key]);
            }
            this.log.debug('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - full ioBroker state ID that changed
     * @param {ioBroker.State | null | undefined} state - new state value, or null/undefined if deleted
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
                        this.log.error(`No device for name ${deviceName} created.`);
                        return;
                    }
                    if (isPoll) {
                        const stateDefinition = stateDefinitionFromId(id);
                        if (stateDefinition.pollOpCode !== undefined) {
                            device.didPoll[stateDefinition.name] = true;
                            let target = device.logicalAddress;
                            if (stateDefinition.pollTarget !== undefined) {
                                target = stateDefinition.pollTarget;
                            } else if (stateDefinition.isGlobal) {
                                target = CEC.LogicalAddress.BROADCAST;
                            }
                            await this.cec.transmit(target, stateDefinition.pollOpCode, stateDefinition.pollArgument);
                        } else {
                            this.log.error(`Can not poll ${stateDefinition.name}. Please report error.`);
                        }
                    } else if (id.includes(stateDefinitions.createButtons.name)) {
                        this.log.debug(`Creating buttons for ${device.name}`);
                        for (const key of Object.keys(CEC.UserControlCode)) {
                            await this.setObjectNotExistsAsync(`${device.name}.buttons.${key}`, {
                                type: 'state',
                                common: { name: key, write: true, read: false, role: 'button', type: 'boolean' },
                                native: { isButton: true },
                            });
                        }
                        await this.setObjectNotExistsAsync(`${device.name}.buttons.time`, {
                            type: 'state',
                            common: {
                                def: DEFAULT_BUTTON_PRESS_TIME,
                                name: 'Set time for next button press',
                                unit: 'ms',
                                write: true,
                                read: false,
                                role: 'level.timer',
                                type: 'number',
                            },
                            native: { isButton: true },
                        });
                    } else if (id.includes('.buttons.time')) {
                        if (!state.val || Number(state.val) < 50) {
                            state.val = 50;
                            this.log.warn('Button presses below 50ms not supported. Increased time.');
                        }
                        device.currentButtonPressTime = Math.max(50, /** @type {number} */ (state.val));
                    } else if (id.includes('.buttons.')) {
                        const name = id.substring(id.lastIndexOf('.') + 1);
                        const code = CEC.UserControlCode[name];
                        if (code !== undefined) {
                            if (device.currentButtonPressTime === undefined) {
                                const timeState = await this.getStateAsync(`${device.name}.buttons.time`);
                                device.currentButtonPressTime = Math.max(
                                    50,
                                    Number(timeState?.val) || DEFAULT_BUTTON_PRESS_TIME,
                                );
                            }
                            await this.cec.sendKeyPress(device.logicalAddress, code, device.currentButtonPressTime);
                        }
                    } else {
                        const stateDefinition = stateDefinitionFromId(id);
                        if (typeof stateDefinition.command === 'function') {
                            this.log.debug(`Sending ${state.val} for id ${id} to ${deviceName}`);
                            await stateDefinition.command(state.val, device, this.cec, this.log);
                        } else {
                            this.log.warn(
                                `Can not write state ${id} of type ${
                                    stateDefinition.name
                                }. Please do not write read only states!`,
                            );
                        }
                    }
                } catch (e) {
                    this.log.error(`Could not write state ${id}: ${e} ${e.stack}`);
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

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - adapter options
     */
    module.exports = options => new CEC2(options);
} else {
    // otherwise start the instance directly
    new CEC2();
}
