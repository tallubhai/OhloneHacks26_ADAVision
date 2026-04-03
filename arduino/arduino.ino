#include "imu.h"
#include "distance.h"
#include "bt.h"

#define TRIG_PIN 7
#define ECHO_PIN 6

IMU imu;
Distance distance(TRIG_PIN, ECHO_PIN);
BT bt(Serial);

void setup() {
  imu.begin();
  distance.begin();
  bt.begin(9600);

  bt.send("System Initialized");
}

void loop() {
  float pitch, roll, yaw, angleFromLevel;
  imu.readAngles(pitch, roll, yaw, angleFromLevel);

  float dist = distance.readDistance();

  String output = "Pitch: " + String(pitch, 2) +
                  " | Roll: " + String(roll, 2) +
                  " | Yaw: " + String(yaw, 2) +
                  " | AngleFromLevel: " + String(angleFromLevel, 2) +
                  " | Distance: " + String(dist, 2) + " cm";

  bt.send(output);

  delay(50);
}
