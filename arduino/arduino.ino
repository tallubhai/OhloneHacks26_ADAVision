/**
 * @file arduino.ino
 * @brief ADA Vision hardware loop: buttons select measurement mode, LEDs cue the user, BT sends results.
 *
 * @par Serial contract (high level)
 * The Python bridge and docs often assume a single combined line:
 *   @code *<angle_degrees>|<distance_cm> @endcode
 * The active firmware uses @em mode-specific prefixes per button so operators measure one quantity at a time:
 *   - Door width:  @code |<distance_cm> @endcode
 *   - Door height: @code *<distance_cm> @endcode
 *   - Ramp angle:  @code ~<angle_degrees> @endcode
 *   - Path width:  @code $<distance_cm> @endcode
 *
 * Averaging: each manual mode samples 15 times over ~3 s (200 ms apart) to reduce noise.
 */

#include "imu.h"
#include "distance.h"
#include "bt.h"

#define TRIG_PIN 9
#define ECHO_PIN 10

// Active-low buttons (internal pull-ups)
const int doorWidthButton = 2;
const int doorHeightButton = 3;
const int rampButton = 4;
const int pathWidth = 5;

const int redLED = 6;
const int greenLED = 7;
const int blueLED = 8;

IMU imu;
Distance distance(TRIG_PIN, ECHO_PIN);
BT bt(Serial);

void setup() {
  imu.begin();
  distance.begin();
  bt.begin(9600);

  pinMode(doorWidthButton, INPUT_PULLUP);
  pinMode(doorHeightButton, INPUT_PULLUP);
  pinMode(rampButton, INPUT_PULLUP);
  pinMode(pathWidth, INPUT_PULLUP);
  pinMode(redLED, OUTPUT);
  pinMode(greenLED, OUTPUT);
  pinMode(blueLED, OUTPUT);
}

void loop() {
  float pitch, roll, yaw, angleFromLevel;
  imu.readAngles(pitch, roll, yaw, angleFromLevel);

  // Optional continuous stream (uncomment): unified *angle|distance for bridge testing
  // float dist = distance.readDistance();
  // String output = "*" + String(angleFromLevel, 2) + "|" + String(dist, 2);
  // bt.send(output);
  // delay(250);

  // --- Door width: distance only, leading '|' ---
  if (digitalRead(doorWidthButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);

    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist = 0;
    float total = 0;
    for (int i = 0; i < 15; i++) {
      dist = distance.readDistance();
      total += dist;
      //bt.send(String(dist, 2)); //debug line
      delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send("|" + String(avgDist, 2));
  }

  // --- Door height: distance with '*' prefix (not the combined *angle|distance form) ---
  if (digitalRead(doorHeightButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);

    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist = 0;
    float total = 0;
    for (int i = 0; i < 15; i++) {
      dist = distance.readDistance();
      total += dist;
<<<<<<< HEAD
       //bt.send(String(dist, 2)); //debug line
       delay(200);
=======
      delay(200);
>>>>>>> 4ac21282349a9a67297ceb92f7f72fa1e6e86f28
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send("*" + String(avgDist, 2));
  }

  // --- Ramp: averaged angle from level, '~' prefix ---
  if (digitalRead(rampButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);

    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float ang = 0;
    float total = 0;
    for (int i = 0; i < 15; i++) {
      imu.readAngles(pitch, roll, yaw, angleFromLevel);
      ang = angleFromLevel;
      total += ang;
      delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgAng = total / 15;
    bt.send("~" + String(avgAng, 2));
  }

  // --- Path width: distance, '$' prefix ---
  if (digitalRead(pathWidth) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);

    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist = 0;
    float total = 0;
    for (int i = 0; i < 15; i++) {
      dist = distance.readDistance();
      total += dist;
<<<<<<< HEAD
       //bt.send(String(dist, 2)); //debug line
       delay(200);
=======
      delay(200);
>>>>>>> 4ac21282349a9a67297ceb92f7f72fa1e6e86f28
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send("$" + String(avgDist, 2));
  }
}
