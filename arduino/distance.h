#ifndef DISTANCE_H
#define DISTANCE_H

#include <Arduino.h>

class Distance {
  public:
    Distance(uint8_t trigPin, uint8_t echoPin);
    void begin();
    float readDistance();

  private:
    uint8_t trig, echo;
};

#endif
