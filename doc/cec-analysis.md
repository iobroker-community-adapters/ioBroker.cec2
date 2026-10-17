# HDMI-CEC analysis of the adapter (2026-10)

Review of what the adapter does on the CEC bus, compared to the HDMI-CEC specification and to
known device quirks. Basis: code at commit `b035d79`, libCEC master (8.1.7), Linux kernel CEC
framework, Android HDMI-CEC implementation, libCEC issue tracker.

Labels: **[SPEC]** normative (HDMI 1.4b CEC supplement), **[IMPL]** behaviour of libCEC / kernel /
Android source, **[ANECDOTAL]** user reports, **[INFERENCE]** own conclusion, not verified.

## 1. Feasible / spec compliant

- Passive monitoring of cec-client `TRAFFIC` output, device discovery by OSD name.
- TV power polling (`GIVE_DEVICE_POWER_STATUS`, default 30 s).
  - [SPEC] minimum interval is 0.5 s; no further limit.
  - [IMPL] Android playback devices poll the TV every 60 s; libCEC does not poll on a timer,
    it uses a 30 s cache age and updates passively from traffic.
  - [ANECDOTAL] No reports of TVs waking up from this message (wake-ups trace back to
    Active Source / Image View On / Samsung "auto mode").
  - Possible improvement: 60 s default, skip while in transition state, back off on NACK.
- OSD name retries (11 tries, 3 s apart), physical address retries (60 s apart).
  "No name in standby" (Nintendo Switch, FireTV) is a real, known behaviour.
- Power on / standby via cec-client's `on <la>` / `standby <la>`.
- Volume up / down / mute as press/release pairs.

## 2. Not feasible by design

### 2.1 Forged initiator address

The adapter sends messages with another device's logical address as initiator:

| State | Message | Forged initiator |
|---|---|---|
| `activeSource` true | ACTIVE_SOURCE (broadcast) | `device.logicalAddress` |
| `activeSource` false | INACTIVE_SOURCE → TV | `device.logicalAddress` |
| global `active-source` | ACTIVE_SOURCE (broadcast) | logical address of device matching physical address |
| `menuStatus` | MENU_REQUEST → device | TV (0) |
| `systemAudio` | SYSTEM_AUDIO_MODE_REQUEST → 5 | last active source |
| `arc` | START_ARC / END_ARC → TV | Audio system (5) |

- [SPEC] Only a device itself may declare itself active source. Only the ARC receiver (audio
  system) sends Initiate/Terminate ARC. Set Stream Path is TV only.
- [IMPL] Result depends on libCEC backend:
  - Linux kernel CEC (`/dev/cec0`, Raspberry Pi with vc4 KMS = Raspberry Pi OS Bookworm and later):
    kernel rejects with `EINVAL` ("initiator has unknown logical address").
  - Legacy Raspberry Pi firmware backend: firmware substitutes its own logical address.
    Input switching often still works because TVs act on the physical address operand.
  - Pulse-Eight USB adapter: forged header really goes on the wire.
  - libCEC logs the *requested* header before transmitting, so the `<<` TRAFFIC line shows the
    forged initiator even if something else (or nothing) was sent.
- Proposal: send ACTIVE_SOURCE from our own address with the target's physical address; drop
  ARC / menu / system audio spoofing.

### 2.2 CEC version emulation (`maxCECVersionSupported`)

On every GET_CEC_VERSION from a device the adapter answers itself with a decreasing version
(6 → 1). [IMPL] libCEC (and its Linux backend: hard-coded 1.4) answers as well, so the device
gets duplicate answers; what libCEC announces cannot be changed this way. Proposal: remove.

### 2.3 Platform

- Startup check looks at `/dev/vchiq` (legacy firmware). Current Raspberry Pi OS uses the kernel
  driver (`/dev/cec0`). [IMPL] libCEC maintainer: firmware backend no longer compatible with
  recent Pi firmware (libCEC #642).
- `-p 1` (HDMI port) is hard-coded, `comPort` never passed.
- Default device type is recorder (`r`). [ANECDOTAL] libCEC #567: LG OLED disconnects with
  recorder, works with playback. [IMPL] libCEC switches recorder to playback for Panasonic.
  Proposal: default to playback.
- [ANECDOTAL] Pi with KMS: when booted with TV off, physical address is f.f.f.f until TV is on.

## 3. Bugs found in the code

| # | Location | Problem | Effect |
|---|---|---|---|
| 1 | `main.js` button handler | USER_CONTROL_RELEASE sent with key code as argument. Own outgoing frame is echoed by cec-client, parsed, fails "RELEASE with bad args" check in `cec-monitor.js`, emits `_error` → adapter terminates. | Probably every button press restarts the adapter |
| 2 | `stateDefinitions.js` volume `parse` | `parseInt(args.join(''), 16)` on already numeric args | Wrong volume ≥ 10 (40 → 64), mute bit detection wrong |
| 3 | button press time | `currentButtonPressTime` undefined until state written, `common.def: 500` never applied | Release sent immediately |
| 4 | `_parseAddress` | unknown logical address (-1) as target falls back to broadcast | Buttons / polls for inactive devices go to all devices |
| 5 | `_processTraffic` | `!packet.opcode` treats FEATURE_ABORT (0x00) as polling message | Refusals never seen |
| 6 | `osd-message` | no length limit ([SPEC] 1–13 chars) | Long strings rejected by TV |
| 7 | `main.js` active-source loop | writes `false` to `device` instead of `otherDevice` | Wrong activeSource states |
| 8 | `_error` handler | any malformed frame (also our own OUT frames) or `ERROR:` line terminates the adapter | Very fragile |
| 9 | ENOENT handling | terminates twice; ENOENT branch after `waitForReady` unreachable | Cosmetic |
| 10 | `autoRestart` option | stored but never read | Dead code |
| 11 | buttons | no repeated USER_CONTROL_PRESSED while holding ([SPEC] 200–500 ms, recommended 450 ms; follower safety timeout ≥ 550 ms) | Long presses not possible |

## 4. Relevant spec numbers

- Bus ~400 bit/s; response: desired ≤ 200 ms, required ≤ 1 s.
- Retransmission up to 5 times, only for transport errors, never after Feature Abort.
- After Feature Abort "Unrecognized opcode": do not send the same message to that device again.
- Give Device Power Status / Report Audio Status: not more often than every 0.5 s.
- User Control Pressed repetition 200–500 ms (recommended 450 ms); follower timeout ≥ 550 ms;
  libCEC releases keys after 500 ms.
- OSD String 1–13 bytes, OSD Name 1–14 bytes.
- Broadcast Standby only on explicit user request. Some displays only accept Standby from the
  active source.
- CEC 2.0: devices broadcast Report Power Status on change; Android skips polling between
  CEC 2.0 devices. libCEC's Linux backend registers as 1.4, so the kernel drops those broadcasts
  (only visible in monitor mode).

## 5. Vendor quirks (from libCEC implementations and issues)

- **Samsung**: "auto mode" may randomly wake 2017+ TVs (libCEC disables it); 2016+ mirror TV power
  state onto sources; vendor command 0x23 expects 0x24.
- **LG**: does not always answer Get CEC Version; players ignore `<Play>`, only user control key;
  TV confused when non-active source claims "on"; recorder type issues (#567).
- **Sony**: treats any source not shown as off; 2016+ cut power to sources in standby; forgets
  sources while off (re-announce physical address on wake); #744 power key suspends device.
- **Philips**: sometimes ignores Image View On; key presses without release.
- **Panasonic**: recorder → playback; power-on key spam broke remote routing (#722).
- **AVRs**: active-source answers can re-wake AVRs (#403); libCEC 8 no longer announces active
  source while the TV is off.
- **General** (kernel docs): Image View On must be the first message; some displays drop HPD in
  standby but keep CEC; sending broadcasts twice is "probably wise".

## 6. libCEC 8.x notes

- 8.0: lists all `/dev/cec*` nodes, configurable vendor ID, cec-client exits on stdin EOF, Linux
  backend reconnects when the node disappears.
- 8.1.0: Debian package renamed to `libcec8`; native Node.js N-API binding (`libcec` on npm).
- 8.1.2: vendor quirks selected by TV model year from EDID.
- cec-client log format (unchanged): `TRAFFIC: [<ms>]\t<< 10:82:10:00` (sent as requested) /
  `>> 01:90:00` (received). Log levels: 1 error, 2 warning, 4 notice, 8 traffic, 16 debug, 31 all.

## 7. Evaluation: libCEC Node.js binding (`libcec` on npm)

Package `libcec` 8.1.6 / 8.1.7 (published 2026-08 / 2026-09 by the libCEC maintainer, Pulse-Eight).
Native N-API addon over libCEC's C API (`cecc.h`), ~37 kB C++ plus a thin JS wrapper with typings.

### What it offers

- `CecAdapter` (EventEmitter) with options matching cec-client: `deviceName`, `deviceType`,
  `physicalAddress`, `baseDevice`, `hdmiPort`, `monitorOnly`, `cecVersion`, `activateSource`.
- Events: `command` (`{initiator, destination, opcode, parameters, ack, eom, ...}`), `keyPress`,
  `sourceActivated`, `alert`, `configurationChanged`, `menuStateChanged`, `log`.
  Structured frames incl. `ack` flag: no stdout parsing, NACK detection possible.
- Control: `transmit`, `powerOnDevices`, `standbyDevices`, `setActiveSource`, `setInactiveView`,
  `volumeUp/Down`, `muteAudio`, `sendKeypress` / `sendKeyRelease` (libCEC handles timing),
  `sendPlay`, `setOSDString`, `setStreamPathPhysical/Logical`.
- Queries (use libCEC's device cache): `getActiveSource`, `getDevicePowerStatus`,
  `getDeviceVendorId`, `getDevicePhysicalAddress`, `getDeviceCecVersion`, `getDeviceOSDName`,
  `getActiveDevices`, `pollDevice`, `rescanDevices`, `detectAdapters`.
- Would replace most of `lib/cec-monitor.js` and the self-made device discovery / retry logic.

### Blockers / risks

- **Requires libCEC ≥ 8 headers at install time.** The addon is compiled on the user's machine
  (`node-gyp rebuild`, `pkg-config libcec`). It calls `libcec_send_play`, which only exists in
  libCEC 8 (diff of `cecc.h` 7.0.0 → 8.1.7: `libcec_send_play`, `libcec_system_audio_mode*`,
  `libcec_get_stats` added, `libcec_disabled_callbacks` renamed), so it does not build against 6 or 7.
  Debian: bookworm 6.0.2, **trixie (current stable) 7.0.0**, forky/sid 8.1.7. Raspberry Pi OS
  follows Debian. Today most users would have to build libCEC 8 from source.
- Needs a C++17 toolchain, Python 3, `make` on the target.
- npm 12 blocks dependency install scripts unless allowed (observed here with npm 12.2:
  "install scripts blocked because they are not covered by allowScripts"). Unclear how
  js-controller installs would handle this.
- **All queries are synchronous** (no AsyncWorker): `open()` blocks up to 10 s, `getDevice*` may
  block up to libCEC's transmit timeout (~1 s per call) on the event loop.
- `commandHandler` / `menuStateChanged` are observe-only: libCEC's default answers cannot be
  overridden from JS (fine, we should not override anyway).
- License GPL-2.0-or-later (adapter is MIT). Using it as a dependency needs a license decision.
- Not tested here: no libCEC and no CEC hardware on the development machine.

### Conclusion

Technically the better base (structured frames, ack, libCEC device cache and key handling),
but not deployable for the majority of users until libCEC 8 is in Debian stable / Raspberry Pi
OS (forky, expected ~2027). Options:

- A: Keep cec-client for now, fix the bugs, but put a backend interface between adapter logic
  and `cec-monitor.js` so a binding backend can be added later.
- B: Additionally load `libcec` as `optionalDependencies` and use it if it loads, else fall back
  to cec-client.

## 8. Suggested order

1. ~~Evaluate the libCEC Node binding~~ done, see section 7.
2. Bug fixes from section 3.
3. Remove forged initiators and version emulation, default to playback, configurable HDMI port,
   check `/dev/cec0`.

## Sources

- HDMI 1.4 spec incl. CEC supplement (unofficial copy): https://file-host.wiki-power.com/circuit-design/%E8%AE%BE%E8%AE%A1%E8%A7%84%E8%8C%83/%E5%90%84%E7%B1%BB%E9%80%9A%E4%BF%A1%E4%B8%8E%E6%8E%A5%E5%8F%A3%E5%8D%8F%E8%AE%AE%E6%A0%87%E5%87%86/HDMI1.4%E6%A0%87%E5%87%86.pdf
- libCEC: https://github.com/Pulse-Eight/libcec (issues #403, #459, #567, #642, #665, #722, #744, #753)
- Kernel CEC: https://www.kernel.org/doc/html/latest/admin-guide/media/cec.html,
  `drivers/media/cec/core/cec-adap.c`
- v4l-utils (cec-follower, cec-compliance): https://git.linuxtv.org/v4l-utils.git
- Android HDMI-CEC: https://source.android.com/docs/devices/tv/hdmi-cec,
  `frameworks/base/services/core/java/com/android/server/hdmi/`
- Pi KMS f.f.f.f report: https://archlinuxarm.org/forum/viewtopic.php?p=73923
- Nintendo Switch input change fix: https://tomshardware.com/news/nintendo-switch-update-hdmi-cec-software,34836.html
- Home Assistant hdmi_cec.update: https://www.home-assistant.io/actions/hdmi_cec.update/
- ioBroker forum test thread: https://forum.iobroker.net/topic/29491/test-adapter-cec2/7
