/**
 * @file distance.cpp
 * @brief Ultrasonic distance read implementation.
 */

#include "distance.h"

Distance::Distance(uint8_t trigPin, uint8_t echoPin) : trig(trigPin), echo(echoPin) {}

void Distance::begin() {
  pinMode(trig, OUTPUT);
  pinMode(echo, INPUT);
}

float Distance::readDistance() {
  // Standard HC-SR04 timing: short low, 10 µs high pulse on TRIG, then measure ECHO HIGH width.
  digitalWrite(trig, LOW);
  delayMicroseconds(2);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  long duration = pulseIn(echo, HIGH);
  // Round-trip time → one-way distance: (duration_us * speed_cm/us) / 2; 0.0343 cm/µs is common approximation.
  return duration * 0.0343 / 2.0; // cm
}
