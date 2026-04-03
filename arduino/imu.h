#ifndef IMU_H
#define IMU_H

#include <Arduino.h>

class IMU {
  public:
    IMU(uint8_t addr = 0x68);
    void begin();
    void readAngles(float &pitch, float &roll, float &yaw, float &angleFromLevel);

  private:
    uint8_t mpu_addr;
    float pitch, roll, yaw;
    unsigned long lastTime;
};

#endif
