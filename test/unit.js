const path = require('path');
const { tests } = require('@iobroker/testing');

const sinon_1 = require('sinon');

// Run unit tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.unit(path.join(__dirname, '..'), {
    defineMockBehavior(database, adapter) {
        adapter.getDevicesAsync = sinon_1.stub();
        adapter.getDevicesAsync.returns(Promise.resolve([]));
    }
});
