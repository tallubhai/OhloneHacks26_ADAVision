/**
 * @file imu.h
 * @brief MPU6050 IMU: fused pitch/roll/yaw and “angle from level” for ramp checks.
 *
 * Uses I2C; default address 0x68. Angles are in degrees where noted.
 */

#ifndef IMU_H
#define IMU_H

#include <Arduino.h>

/**
 * @class IMU
 * @brief Reads accelerometer + gyroscope, applies complementary filter, exposes angles.
 */
class IMU {
  public:
    /**
     * @brief Construct driver for MPU6050 at given I2C address.
     * @param addr 7-bit I2C address (default 0x68).
     */
    IMU(uint8_t addr = 0x68);

    /** @brief Initialize I2C and sensor registers; call from @c setup(). */
    void begin();

    /**
     * @brief Read current orientation estimates.
     * @param[out] pitch Degrees, complementary filter fusion.
     * @param[out] roll Degrees.
     * @param[out] yaw Degrees (integrated gyro Z; drifts without magnetometer).
     * @param[out] angleFromLevel Degrees between gravity vector and “straight up” (useful for ramp tilt).
     */
    void readAngles(float &pitch, float &roll, float &yaw, float &angleFromLevel);

  private:
    uint8_t mpu_addr;
    float pitch, roll, yaw;
    unsigned long lastTime;
};

#endif
