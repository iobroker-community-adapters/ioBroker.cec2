# Changelog

<!--
	PLACEHOLDER for next version:
	## __WORK IN PROGRESS__
-->
## 0.0.8 (2021-02-14)
* Switched from unmaintained dependency to own code to control cec-monitor binary.
* Swtiched from event-stream to readline.
* Probably fixed missed incomming events.

## 0.0.7 (2021-01-24)
* fix warnings

## 0.0.6 (2021-01-02)
* update dependencies

## 0.0.5 (2021-01-01)
* fix button presses
* add default for button press time

## 0.0.4 (2020-12-28)
* Make sure active devices are marked as active.
* make sure all devices have the required states
* fix deactivating devices
* Make sure we deliver incoming update if user did poll.

## 0.0.3 (2020-05-21)
* added 'preventUnnamedDevices' option ot prevent creation of devices that do not report their name. This sometimes happens if devices are talking on CEC bus but are not switched on (depends on device type).
* fixed possible crash on start

## 0.0.2 (2020-01-28)
* fixed a lot of bugs

## 0.0.1 (2020-01-28)
* initial release
