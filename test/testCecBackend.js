'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const CEC = require('../lib/cec-constants');
const CecBackend = require('../lib/cec-backend');

/**
 * Backend that records transmitted frames instead of sending them.
 */
class FakeBackend extends CecBackend {
    constructor() {
        super({
            timers: {
                // node timers instead of adapter timers, types differ
                setTimeout: (cb, ms) => /** @type {ioBroker.Timeout} */ (/** @type {unknown} */ (globalThis.setTimeout(cb, ms))),
                clearTimeout: t => globalThis.clearTimeout(/** @type {NodeJS.Timeout} */ (/** @type {unknown} */ (t))),
            },
            responseTimeout: 1000,
        });
        /** @type {Array<{target: number, opcode: number, args: number[]}>} */
        this.sent = [];
    }

    get ready() {
        return true;
    }

    get ownLogicalAddress() {
        return 4;
    }

    async _transmit(target, opcode, args) {
        this.sent.push({ target, opcode, args });
    }
}

describe('cec-backend', () => {
    /** @type {FakeBackend} */
    let backend;
    /** @type {sinon.SinonFakeTimers} */
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        backend = new FakeBackend();
    });

    afterEach(() => {
        clock.restore();
    });

    describe('transmit', () => {
        it('refuses invalid target addresses instead of broadcasting', async () => {
            let error;
            try {
                await backend.transmit(CEC.LogicalAddress.UNKNOWN, CEC.Opcode.GIVE_OSD_NAME);
            } catch (e) {
                error = e;
            }
            expect(error).to.be.an('error');
            expect(backend.sent).to.be.empty;
        });

        it('accepts single byte and array operands', async () => {
            await backend.transmit(0, CEC.Opcode.MENU_REQUEST, CEC.MenuRequestType.QUERY);
            await backend.transmit(15, CEC.Opcode.ACTIVE_SOURCE, [0x21, 0x00]);
            expect(backend.sent).to.deep.equal([
                { target: 0, opcode: CEC.Opcode.MENU_REQUEST, args: [CEC.MenuRequestType.QUERY] },
                { target: 15, opcode: CEC.Opcode.ACTIVE_SOURCE, args: [0x21, 0x00] },
            ]);
        });
    });

    describe('sendKeyPress', () => {
        it('sends release without operands', async () => {
            await backend.sendKeyPress(0, CEC.UserControlCode.SELECT);
            expect(backend.sent).to.deep.equal([
                { target: 0, opcode: CEC.Opcode.USER_CONTROL_PRESSED, args: [CEC.UserControlCode.SELECT] },
                { target: 0, opcode: CEC.Opcode.USER_CONTROL_RELEASE, args: [] },
            ]);
        });

        it('repeats the key while it is held', async () => {
            const done = backend.sendKeyPress(0, CEC.UserControlCode.UP, 1000);
            await clock.tickAsync(1000);
            await done;
            const opcodes = backend.sent.map(f => f.opcode);
            expect(opcodes).to.deep.equal([
                CEC.Opcode.USER_CONTROL_PRESSED,
                CEC.Opcode.USER_CONTROL_PRESSED,
                CEC.Opcode.USER_CONTROL_PRESSED,
                CEC.Opcode.USER_CONTROL_RELEASE,
            ]);
        });
    });

    describe('request', () => {
        it('resolves with the answer of the target', async () => {
            const answer = backend.request(
                0,
                CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
                [],
                CEC.Opcode.REPORT_POWER_STATUS,
            );
            await clock.tickAsync(10);
            backend._received({ source: 5, target: 4, opcode: CEC.Opcode.REPORT_POWER_STATUS, args: [1] });
            backend._received({ source: 0, target: 4, opcode: CEC.Opcode.REPORT_POWER_STATUS, args: [0] });
            const message = await answer;
            expect(message.source).to.equal(0);
            expect(message.data.str).to.equal('ON');
        });

        it('rejects on FEATURE_ABORT', async () => {
            const answer = backend.request(
                0,
                CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
                [],
                CEC.Opcode.REPORT_POWER_STATUS,
            );
            await clock.tickAsync(10);
            backend._received({
                source: 0,
                target: 4,
                opcode: CEC.Opcode.FEATURE_ABORT,
                args: [CEC.Opcode.GIVE_DEVICE_POWER_STATUS, CEC.AbortReason.REFUSED],
            });
            let error;
            try {
                await answer;
            } catch (e) {
                error = e;
            }
            expect(error?.message).to.contain('refused');
        });

        it('rejects on timeout', async () => {
            const answer = backend.request(
                0,
                CEC.Opcode.GIVE_DEVICE_POWER_STATUS,
                [],
                CEC.Opcode.REPORT_POWER_STATUS,
            );
            const result = answer.then(
                () => 'resolved',
                () => 'rejected',
            );
            await clock.tickAsync(1001);
            expect(await result).to.equal('rejected');
        });
    });

    it('tracks the active source', () => {
        backend._received({ source: 8, target: 15, opcode: CEC.Opcode.ACTIVE_SOURCE, args: [0x21, 0x00] });
        expect(backend.getActiveSource()).to.deep.equal({ logicalAddress: 8, physicalAddress: '2.1.0.0' });
    });

    it('does not emit malformed messages', () => {
        const listener = sinon.spy();
        backend.on('message', listener);
        backend._received({ source: 0, target: 4, opcode: CEC.Opcode.REPORT_POWER_STATUS, args: [] });
        expect(listener.called).to.be.false;
    });
});
