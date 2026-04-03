#include "bt.h"

BT::BT(HardwareSerial &serialPort) : serial(serialPort) {}

void BT::begin(long baudRate) {
  serial.begin(baudRate);
}

void BT::send(const String &data) {
  serial.println(data);
}
