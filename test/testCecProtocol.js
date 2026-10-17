'use strict';

const { expect } = require('chai');
const CEC = require('../lib/cec-constants');
const protocol = require('../lib/cec-protocol');
const CECMonitor = require('../lib/cec-monitor');

describe('cec-protocol', () => {
    describe('decodeMessage', () => {
        it('decodes polling messages', () => {
            const message = protocol.decodeMessage({ source: 4, target: 4 });
            expect(message.event).to.equal(protocol.POLLING_MESSAGE);
            expect(message.opcode).to.be.undefined;
        });

        it('decodes FEATURE_ABORT instead of treating it as poll', () => {
            const message = protocol.decodeMessage({
                source: 0,
                target: 4,
                opcode: CEC.Opcode.FEATURE_ABORT,
                args: [CEC.Opcode.GIVE_DEVICE_POWER_STATUS, CEC.AbortReason.REFUSED],
            });
            expect(message.event).to.equal('FEATURE_ABORT');
            expect(message.data.val).to.equal(CEC.Opcode.GIVE_DEVICE_POWER_STATUS);
            expect(message.data.str).to.equal('GIVE_DEVICE_POWER_STATUS');
            expect(message.data.reasonStr).to.equal('REFUSED');
        });

        it('decodes audio status volume and mute bit', () => {
            const volume = protocol.decodeMessage({
                source: 5,
                target: 4,
                opcode: CEC.Opcode.REPORT_AUDIO_STATUS,
                args: [0x28],
            });
            expect(volume.data.val).to.equal(40);
            expect(volume.data.mute).to.be.false;

            const muted = protocol.decodeMessage({
                source: 5,
                target: 4,
                opcode: CEC.Opcode.REPORT_AUDIO_STATUS,
                args: [0xa8],
            });
            expect(muted.data.val).to.equal(40);
            expect(muted.data.mute).to.be.true;
        });

        it('decodes one byte deck status', () => {
            const message = protocol.decodeMessage({
                source: 4,
                target: 1,
                opcode: CEC.Opcode.DECK_STATUS,
                args: [CEC.DeckStatus.PLAY],
            });
            expect(message.error).to.be.undefined;
            expect(message.data.str).to.equal('PLAY');
        });

        it('decodes physical addresses', () => {
            const message = protocol.decodeMessage({
                source: 4,
                target: 15,
                opcode: CEC.Opcode.ACTIVE_SOURCE,
                args: [0x21, 0x00],
            });
            expect(message.data.str).to.equal('2.1.0.0');
        });

        it('decodes OSD name', () => {
            const message = protocol.decodeMessage({
                source: 5,
                target: 1,
                opcode: CEC.Opcode.SET_OSD_NAME,
                args: [82, 88, 45, 86, 55, 56, 49],
            });
            expect(message.data.str).to.equal('RX-V781');
        });

        it('marks malformed messages', () => {
            const message = protocol.decodeMessage({
                source: 0,
                target: 4,
                opcode: CEC.Opcode.REPORT_POWER_STATUS,
                args: [],
            });
            expect(message.error).to.be.a('string');
        });
    });

    describe('address conversion', () => {
        it('converts physical addresses', () => {
            expect(protocol.routeToArgs('2.1.0.0')).to.deep.equal([0x21, 0x00]);
            expect(protocol.physicalToRoute(0x2100)).to.equal('2.1.0.0');
            expect(protocol.isRoute('2.1.0.0')).to.be.true;
            expect(protocol.isRoute('2')).to.be.false;
        });

        it('validates logical addresses', () => {
            expect(protocol.isValidLogicalAddress(0)).to.be.true;
            expect(protocol.isValidLogicalAddress(15)).to.be.true;
            expect(protocol.isValidLogicalAddress(-1)).to.be.false;
            expect(protocol.isValidLogicalAddress(16)).to.be.false;
            expect(protocol.isValidLogicalAddress(null)).to.be.false;
        });

        it('replaces non ASCII characters in strings', () => {
            expect(protocol.stringToArgs('aä')).to.deep.equal([0x61, 0x3f]);
        });
    });

    describe('cec-client traffic lines', () => {
        it('parses incoming frames', () => {
            const frame = CECMonitor.parseTrafficLine('TRAFFIC: [          123441]\t>> 01:90:00');
            expect(frame).to.deep.equal({ incoming: true, source: 0, target: 1, opcode: 0x90, args: [0] });
        });

        it('parses outgoing frames', () => {
            const frame = CECMonitor.parseTrafficLine('TRAFFIC: [          123441]\t<< 10:8f');
            expect(frame?.incoming).to.be.false;
        });

        it('parses polls without opcode', () => {
            const frame = CECMonitor.parseTrafficLine('TRAFFIC: [          123441]\t>> 44');
            expect(frame?.opcode).to.be.undefined;
        });

        it('ignores other lines', () => {
            expect(CECMonitor.parseTrafficLine('DEBUG: [  1]\tsomething')).to.be.null;
        });
    });
});
