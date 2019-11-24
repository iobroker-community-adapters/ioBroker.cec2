![Logo](admin/cec2.png)
### ioBroker.cec2

Adapter for HDMI CEC

You can monitor / control devices using HDMI CEC. Most modern TVs and multimedia devices support CEC to some extent.
Powering on / off devices should be ok, also switching inputs on the TV should work. If you use ARC, volume up/down
will work, too.
More complex commands might be achievable with the use of remote button emulation. But this is quite device specific
and might not be supported on all devices.

#### Info
Early alpha release, just now only tested on Raspberry Pi.

#### Requirements
cec-client have to be installed. Install the client from [here] (https://github.com/Pulse-Eight/libcec)
and follow the install instruction in the [readme] (https://github.com/Pulse-Eight/libcec/blob/master/README.md) of the libcec project.
The readme has a special section for the Raspberry Pi.

Or you can try this simple [script] (/install-libcec.sh/) as root.

#### Installation
Execute the following command in the iobroker root directory (e.g. in /opt/iobroker)
```
npm install iobroker.cec2
```

Or install from admin webpage.

### License
The MIT License (MIT)

Copyright (c) 2018 Garfonso <garfonso@mobo.info>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
