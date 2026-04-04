#include "imu.h"
#include "distance.h"
#include "bt.h"

#define TRIG_PIN 9
#define ECHO_PIN 10


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

  // float dist = distance.readDistance();
  // String output = "*" + String(angleFromLevel, 2) + "|" + String(dist, 2);
  // bt.send(output);
  // delay(250);

//measure door width
  if (digitalRead(doorWidthButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);
    
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist;
    float total = 0;
    //get average over 3 seconds
    for(int i= 0; i<15; i++){
      dist = distance.readDistance();
      total += dist;
      delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send( "|" + String(avgDist, 2));

  }

//measure door height
  if (digitalRead(doorHeightButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);
    
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist;
    float total = 0;
    for(int i= 0; i<15; i++){
      dist = distance.readDistance();
      total += dist;
       delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send( "*" + String(avgDist, 2));

  }

//measure ramp angle
  if (digitalRead(rampButton) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);
    
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float ang;
    float total = 0;
    for(int i= 0; i<15; i++){
      imu.readAngles(pitch, roll, yaw, angleFromLevel);
      ang = angleFromLevel;
      total += ang;
       delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgAng = total / 15;
    bt.send( "~" + String(avgAng, 2));
  }

//measure path width
  if (digitalRead(pathWidth) == LOW) {
    digitalWrite(redLED, HIGH);
    delay(2000);
    
    digitalWrite(redLED, LOW);
    digitalWrite(greenLED, HIGH);
    float dist;
    float total = 0;
    for(int i= 0; i<15; i++){
      dist = distance.readDistance();
      total += dist;
       delay(200);
    }
    digitalWrite(greenLED, LOW);
    float avgDist = total / 15;
    bt.send( "$" + String(avgDist, 2));

  }
}
