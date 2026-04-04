#include "imu.h"
#include "distance.h"
#include "bt.h"

#define TRIG_PIN 9
#define ECHO_PIN 10

IMU imu;
Distance distance(TRIG_PIN, ECHO_PIN);
BT bt(Serial);

void setup() {
  imu.begin();
  distance.begin();
  bt.begin(9600);
}

void loop() {
  float pitch, roll, yaw, angleFromLevel;
  imu.readAngles(pitch, roll, yaw, angleFromLevel);

  float dist = distance.readDistance();

  String output = "*" + String(angleFromLevel, 2) + "|" + String(dist, 2);

  bt.send(output);

  delay(250);
}
