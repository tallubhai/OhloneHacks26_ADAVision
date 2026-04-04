/**
 * @file bt.h
 * @brief Bluetooth / serial transport for sending measurement strings to the host.
 *
 * Wraps Arduino HardwareSerial so firmware can print one line per reading; the Python
 * bridge (pyBridge) reads the same stream as a serial monitor would.
 */

#ifndef BT_H
#define BT_H

#include <Arduino.h>

/**
 * @class BT
 * @brief Thin wrapper around @c HardwareSerial for newline-terminated output.
 */
class BT {
  public:
    /**
     * @brief Construct a transport bound to a serial port (often the default @c Serial
     *        wired to a Bluetooth module).
     * @param serialPort Reference to the UART used for TX (e.g. @c Serial).
     */
    BT(HardwareSerial &serialPort = Serial);

    /**
     * @brief Start the UART at the given baud rate; must match the paired device / bridge.
     * @param baudRate Bits per second (commonly 9600).
     */
    void begin(long baudRate = 9600);

    /**
     * @brief Send one line over serial (adds newline). The receiver should read line-by-line.
     * @param data Payload string (e.g. a compact measurement line).
     */
    void send(const String &data);

  private:
    HardwareSerial &serial;
};

#endif
