#include "distance.h"

Distance::Distance(uint8_t trigPin, uint8_t echoPin) : trig(trigPin), echo(echoPin) {}

void Distance::begin() {
  pinMode(trig, OUTPUT);
  pinMode(echo, INPUT);
}

float Distance::readDistance() {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  long duration = pulseIn(echo, HIGH);
  return duration * 0.0343 / 2.0; // cm
}
