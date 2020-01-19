/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

module.exports = function CECDevice(physicalAddressIn, activeIn = false) {
    //private stuff:
    let power = CEC.CEC_POWER_STATUS.UNKNOWN;
    let OSDName;
    let physicalAddress = physicalAddressIn;
    let currentLogicalAddress;
    let active = activeIn;
    let lastSeen;

    return {
        //public API

        //returns CEC Power status
        getPowerStatus: function () {
            return power;
        },

        //returns OSD Name
        getOSDName: function () {
            return OSDName;
        },

        //returns physicalAddress
        getPhysicalAddress: function () {
            return physicalAddress;
        },

        //returns logical address. Beaware: Logical address might change!
        getlogicalAddress: function() {
            return currentLogicalAddress;
        },

        getLastSeen: function () {
            return lastSeen;
        },

        isActive: function () {
            return active;
        },

        //processes a packet from this device on CEC Bus
        processPacket: function (packet) {

        }
    };
};
