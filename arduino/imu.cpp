/**
 * @file imu.cpp
 * @brief MPU6050 I2C reads + complementary filter for stable tilt angles.
 */

#include "imu.h"
#include <Wire.h>
#include <math.h>

IMU::IMU(uint8_t addr) : mpu_addr(addr), pitch(0), roll(0), yaw(0), lastTime(0) {}

void IMU::begin() {
  Wire.begin();
  // Wake up MPU6050 (exit sleep)
  Wire.beginTransmission(mpu_addr);
  Wire.write(0x6B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Set accelerometer to ±2g
  Wire.beginTransmission(mpu_addr);
  Wire.write(0x1C);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Set gyroscope to ±250°/s
  Wire.beginTransmission(mpu_addr);
  Wire.write(0x1B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  lastTime = millis();
}

void IMU::readAngles(float &outPitch, float &outRoll, float &outYaw, float &angleFromLevel) {
  unsigned long now = millis();
  float dt = (now - lastTime) / 1000.0;
  lastTime = now;

  // Accelerometer: registers 0x3B..0x40, ±2g → 16384 LSB/g
  int16_t AccX, AccY, AccZ;
  Wire.beginTransmission(mpu_addr);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(mpu_addr, 6, true);
  AccX = (Wire.read() << 8) | Wire.read();
  AccY = (Wire.read() << 8) | Wire.read();
  AccZ = (Wire.read() << 8) | Wire.read();

  float Ax = AccX / 16384.0;
  float Ay = AccY / 16384.0;
  float Az = AccZ / 16384.0;

  // Gyroscope: registers 0x43..0x48, ±250°/s → 131 LSB/(°/s)
  int16_t GyX, GyY, GyZ;
  Wire.beginTransmission(mpu_addr);
  Wire.write(0x43);
  Wire.endTransmission(false);
  Wire.requestFrom(mpu_addr, 6, true);
  GyX = (Wire.read() << 8) | Wire.read();
  GyY = (Wire.read() << 8) | Wire.read();
  GyZ = (Wire.read() << 8) | Wire.read();

  float gx = GyX / 131.0; // deg/s
  float gy = GyY / 131.0;
  float gz = GyZ / 131.0;

  // Complementary filter: trust gyro short-term, accelerometer long-term for pitch/roll
  float pitchAcc = atan2(Ax, sqrt(Ay*Ay + Az*Az)) * 180.0 / PI;
  float rollAcc  = atan2(Ay, sqrt(Ax*Ax + Az*Az)) * 180.0 / PI;

  const float alpha = 0.98;
  pitch = alpha * (pitch + gx * dt) + (1 - alpha) * pitchAcc;
  roll  = alpha * (roll  + gy * dt) + (1 - alpha) * rollAcc;

  // Yaw: no mag reference, so this drifts; still exposed for completeness
  yaw += gz * dt;

  // Angle between gravity vector and vertical: 0° = level, larger = more tilted
  angleFromLevel = acos(Az / sqrt(Ax*Ax + Ay*Ay + Az*Az)) * 180.0 / PI;

  outPitch = pitch;
  outRoll  = roll;
  outYaw   = yaw;
}
