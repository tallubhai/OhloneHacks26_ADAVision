#include <Wire.h>
#define MPU_ADDR 0x68;
#define Accel_ADDR 0x3B;
int16_t AccX, AccY, AccZ;


void setup() {
  Wire.begin();
  Serial.begin(9600);

  //initialize MPU6050
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B); //write to PWR_MGMT_1 register
  Wire.write(0x00); //write 0 to 0x6B (set sleep to 0)
  Wire.endTransmission(true);
  
}

void loop() {
  // put your main code here, to run repeatedly:

}
