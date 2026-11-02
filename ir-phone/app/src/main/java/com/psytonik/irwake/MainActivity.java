package com.psytonik.irwake;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** Nothing to do here: starting it once is what lets the receiver be reached from adb. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        text.setText("IR wake is ready. Leave this phone plugged into the Mac and pointed at the TV.");
        text.setPadding(48, 96, 48, 48);
        setContentView(text);
    }
}
