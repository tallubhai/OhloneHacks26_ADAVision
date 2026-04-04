/**
 * @file distance.h
 * @brief HC-SR04-style ultrasonic distance measurement (cm).
 *
 * Drives TRIG, measures ECHO pulse width, converts to centimeters for door/path sizing.
 */

#ifndef DISTANCE_H
#define DISTANCE_H

#include <Arduino.h>

/**
 * @class Distance
 * @brief Ultrasonic ranger: pulse trigger, time echo, return distance in cm.
 */
class Distance {
  public:
    /**
     * @brief Associate instance with trigger and echo GPIO pins.
     * @param trigPin OUTPUT pin connected to sensor TRIG.
     * @param echoPin INPUT pin connected to sensor ECHO.
     */
    Distance(uint8_t trigPin, uint8_t echoPin);

    /** @brief Configure pin modes; call once from @c setup(). */
    void begin();

    /**
     * @brief Single shot read in centimeters.
     * @return Distance in cm (depends on @c pulseIn quality and speed of sound constant).
     */
    float readDistance();

  private:
    uint8_t trig, echo;
};

#endif
