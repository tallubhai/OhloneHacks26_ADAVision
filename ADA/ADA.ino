#include <Wire.h>
#include <math.h>

#define MPU_ADDR 0x68

int16_t AccX, AccY, AccZ;

void setup() {
  Wire.begin();
  Serial.begin(9600);

  // Wake up MPU6050
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Set accelerometer to ±2g
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x1C);
  Wire.write(0x00);
  Wire.endTransmission(true);

  Serial.println("MPU6050 Initialized");
}

void loop() {
  // Request accelerometer data
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B); // ACCEL_XOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 6, true);

  AccX = (Wire.read() << 8) | Wire.read();
  AccY = (Wire.read() << 8) | Wire.read();
  AccZ = (Wire.read() << 8) | Wire.read();

  // Convert to g
  float Ax = AccX / 16384.0;
  float Ay = AccY / 16384.0;
  float Az = AccZ / 16384.0;

  // Pitch & Roll
  float pitch = atan2(Ax, sqrt(Ay*Ay + Az*Az)) * 180.0 / PI;
  float roll  = atan2(Ay, sqrt(Ax*Ax + Az*Az)) * 180.0 / PI;

  // Tilt from level ground (0° = flat, 90° = vertical)
  float tilt = acos(Az / sqrt(Ax*Ax + Ay*Ay + Az*Az)) * 180.0 / PI;

  Serial.print("Pitch: "); Serial.print(pitch);
  Serial.print(" | Roll: "); Serial.print(roll);
  Serial.print(" | Tilt from level: "); Serial.println(tilt);

  delay(200);
}
