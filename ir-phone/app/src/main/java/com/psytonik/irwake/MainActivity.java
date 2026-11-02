package com.psytonik.irwake;

import android.app.Activity;
import android.content.Context;
import android.hardware.ConsumerIrManager;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** One button that sends the TV's wake-up frame from this phone's infrared emitter. Also being opened once is what lets adb reach the receiver. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        ConsumerIrManager ir = (ConsumerIrManager) getSystemService(Context.CONSUMER_IR_SERVICE);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(48, 48, 48, 48);

        TextView status = new TextView(this);
        status.setGravity(Gravity.CENTER);
        status.setTextSize(16);
        status.setText(ir != null && ir.hasIrEmitter() ? "Point the top edge of the phone at the TV." : "This phone has no infrared emitter.");

        Button power = new Button(this);
        power.setText("Turn the TV on");
        power.setTextSize(22);
        power.setEnabled(ir != null && ir.hasIrEmitter());
        power.setOnClickListener((v) -> {
            ir.transmit(WakeFrame.CARRIER_HZ, WakeFrame.pattern());
            status.setText("Sent. A sleeping TV may take up to ten seconds, and sometimes misses the frame: wait before pressing again, it is a switch.");
        });

        column.addView(power, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 360));
        column.addView(status, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(column);
    }
}
