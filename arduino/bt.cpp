/**
 * @file bt.cpp
 * @brief Implementation of serial/Bluetooth line output.
 */

#include "bt.h"

BT::BT(HardwareSerial &serialPort) : serial(serialPort) {}

void BT::begin(long baudRate) {
  serial.begin(baudRate);
}

void BT::send(const String &data) {
  // println so consumers can use readline(); delimiter is the newline, not a custom byte.
  serial.println(data);
}
