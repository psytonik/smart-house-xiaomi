package com.psytonik.irwake;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.hardware.ConsumerIrManager;
import android.util.Log;

/** Sends one infrared frame: extras "carrier" (Hz) and "pattern" (comma-separated mark/space microseconds, starting with a mark). */
public class IrReceiver extends BroadcastReceiver {
    private static final String TAG = "IrWake";

    @Override
    public void onReceive(Context context, Intent intent) {
        ConsumerIrManager ir = (ConsumerIrManager) context.getSystemService(Context.CONSUMER_IR_SERVICE);
        if (ir == null || !ir.hasIrEmitter()) {
            Log.e(TAG, "no infrared emitter");
            setResultCode(2);
            return;
        }
        int carrier = intent.getIntExtra("carrier", 38400);
        String text = intent.getStringExtra("pattern");
        if (text == null || text.isEmpty()) {
            Log.e(TAG, "no pattern");
            setResultCode(3);
            return;
        }
        String[] parts = text.split(",");
        int[] pattern = new int[parts.length];
        for (int i = 0; i < parts.length; i++) pattern[i] = Integer.parseInt(parts[i].trim());
        ir.transmit(carrier, pattern);
        Log.i(TAG, "sent " + pattern.length + " durations at " + carrier + " Hz");
        setResultCode(1);
    }
}
