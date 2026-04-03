#ifndef BT_H
#define BT_H

#include <Arduino.h>

class BT {
  public:
    BT(HardwareSerial &serialPort = Serial);
    void begin(long baudRate = 9600);
    void send(const String &data);

  private:
    HardwareSerial &serial;
};

#endif
