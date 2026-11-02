# ir-phone

A tiny Android app that sends one infrared frame on request. It wakes the TV from deep sleep, which nothing on the network can do.

A phone with an infrared emitter (a Redmi Note 14 here) lies next to the TV, its IR window pointing at it, plugged into this computer by USB.
The backend (`backend/src/ir.ts`) asks it over adb; the phone does the sending.

- Build: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug`
- Install: `adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk`, then open the app once (Android keeps a never-opened package stopped).
- Set `TV_IR_PHONE=<serial>` in `backend/.env`. Without a cable: `adb -s <serial> tcpip 5555`, `adb connect <phone ip>:5555`, then `TV_IR_PHONE=<phone ip>:5555` (reserve that address in the router; a reboot of the phone resets this).
- The app itself has one button, "Turn the TV on", that sends the same frame without the computer (to find where to put the phone).
- Try it by hand: `adb -s <serial> shell am broadcast -f 32 -n com.psytonik.irwake/.IrReceiver --ei carrier 38400 --es pattern "<comma-separated microseconds>"`;
  the receiver answers `result=1` when it sent, `2` when the phone has no emitter, `3` when the pattern is missing.

The receiver is exported so adb can reach it: any app on the phone can make it send an infrared frame. It needs no other permission.
Uninstall: `adb uninstall com.psytonik.irwake`.
