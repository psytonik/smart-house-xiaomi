package com.psytonik.irwake;

/** The frame the TV wakes from standby on (see backend/src/ir.ts): address 0xF, command 0xD5, 38.4 kHz. */
final class WakeFrame {
    static final int CARRIER_HZ = 38400;
    private static final int ADDRESS = 0xF;
    private static final int COMMAND = 0xD5;

    private WakeFrame() {}

    /** Alternating mark/space microseconds, starting with a mark: header, 24 bits (address, inverted command, inverted address, command), closing mark. */
    static int[] pattern() {
        int word = (ADDRESS << 20) | ((~COMMAND & 0xff) << 12) | ((~ADDRESS & 0xf) << 8) | COMMAND;
        int[] t = new int[2 + 48 + 1];
        t[0] = 3960;
        t[1] = 3960;
        for (int i = 0; i < 24; i++) {
            t[2 + 2 * i] = 495;
            t[3 + 2 * i] = ((word >> (23 - i)) & 1) == 1 ? 1980 : 990;
        }
        t[50] = 495;
        return t;
    }
}
