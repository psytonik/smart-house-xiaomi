import { useEffect, useRef, useState } from "react";
import { AuthError, api, currentToken, fetchFrame } from "../api";
import { MAX_AUTO_RECONNECTS, reconnectDelay } from "../reconnect";
import { TALK_MAX_MS, talkBlockedReason } from "../talk";

export type Mode = "webrtc" | "hls" | "frames";
export type PlayerState = { status: "connecting" | "live" | "error"; message?: string };

interface Props {
  mode: Mode;
  attempt: number;
  onState: (s: PlayerState) => void;
  onAuthError: () => void;
}

export function Player({ mode, attempt, onState, onAuthError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const cb = useRef({ onState, onAuthError });
  cb.current = { onState, onAuthError };
  // Automatic reconnects since the last good picture. A ref, so counting does not re-run the effect;
  // `tick` is what re-runs it. Manual retry and a mode change start counting from zero again.
  const autoCount = useRef(0);
  const [tick, setTick] = useState(0);

  // Sound from the camera (off until you ask: browsers do not autoplay sound) and talking to the camera.
  // Talking is a second, send-only WebRTC connection that publishes the microphone to the backend (/api/talk);
  // the backend turns it into what the camera's speaker takes. It exists only while talking.
  const talkPc = useRef<RTCPeerConnection | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const [hasAudio, setHasAudio] = useState(false); // WebRTC is connected and the camera sends sound
  const [listening, setListening] = useState(false);
  const [talking, setTalking] = useState(false);
  const [talkError, setTalkError] = useState<string>();
  const blocked = talkBlockedReason({ secure: window.isSecureContext, hasMic: !!navigator.mediaDevices?.getUserMedia });

  const closeTalk = () => {
    // Tell the backend too: otherwise its bridge to the camera stays up and the next one plays over it (crackling).
    if (talkPc.current) void api("/api/talk", { method: "DELETE" }).catch(() => {});
    talkPc.current?.close();
    talkPc.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
  };
  const stopTalking = () => {
    closeTalk();
    setTalking(false);
  };
  const startTalking = async () => {
    setTalkError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      mic.current = stream;
      const pc = new RTCPeerConnection({ iceServers: [] });
      talkPc.current = pc;
      pc.addTrack(stream.getAudioTracks()[0]!, stream);
      pc.onconnectionstatechange = () => {
        if (talkPc.current === pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) stopTalking();
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 1500);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(t);
            resolve();
          }
        });
      });
      const res = await api("/api/talk", { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription!.sdp });
      if (!res.ok) throw new Error(`The backend answered ${res.status}.`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      setTalking(true);
    } catch (e) {
      closeTalk();
      if (e instanceof AuthError) cb.current.onAuthError();
      else setTalkError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was refused." : e instanceof Error ? e.message : "Could not start the microphone.");
    }
  };

  // The microphone never stays open: it closes after TALK_MAX_MS, and when the player goes away or reconnects.
  useEffect(() => {
    if (!talking) return;
    const t = setTimeout(stopTalking, TALK_MAX_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talking]);

  useEffect(() => {
    autoCount.current = 0;
  }, [mode, attempt, tick]);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const video = videoRef.current!;
    const img = imgRef.current!;

    const live = () => {
      if (cancelled) return;
      autoCount.current = 0;
      cb.current.onState({ status: "live" });
    };
    const fail = (message: string) => !cancelled && cb.current.onState({ status: "error", message });
    // The stream drops now and then (Wi-Fi, the camera's single session). Video modes reconnect by themselves
    // with growing pauses; after MAX_AUTO_RECONNECTS the error and the manual retry are shown.
    // Frames mode polls every second and recovers on its own.
    let retrying = false;
    const lost = (message: string) => {
      if (cancelled || retrying) return;
      if (mode === "frames" || autoCount.current >= MAX_AUTO_RECONNECTS) return fail(message);
      retrying = true;
      const wait = reconnectDelay(autoCount.current++);
      cb.current.onState({ status: "connecting", message: "The picture was lost. Reconnecting…" });
      const t = setTimeout(() => setTick((n) => n + 1), wait);
      cleanups.push(() => clearTimeout(t));
    };
    const handle = (e: unknown) => {
      if (cancelled) return;
      if (e instanceof AuthError) cb.current.onAuthError();
      else lost(e instanceof Error ? e.message : "Unknown error");
    };

    cb.current.onState({ status: "connecting" });
    video.onplaying = live;

    async function startWebRtc() {
      const pc = new RTCPeerConnection({ iceServers: [] }); // same network only
      cleanups.push(() => pc.close());
      pc.addTransceiver("video", { direction: "recvonly" });
      const audio = pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (ev) => {
        if (ev.streams[0]) video.srcObject = ev.streams[0];
      };
      let dropTimer: ReturnType<typeof setTimeout> | undefined;
      cleanups.push(() => clearTimeout(dropTimer));
      pc.onconnectionstatechange = () => {
        clearTimeout(dropTimer);
        if (pc.connectionState === "failed") lost("The WebRTC connection failed.");
        // "disconnected" often heals by itself; if it lasts, treat it as lost.
        else if (pc.connectionState === "disconnected") dropTimer = setTimeout(() => lost("The WebRTC connection dropped."), 3000);
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 1500);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(t);
            resolve();
          }
        });
      });
      const res = await api("/api/webrtc", {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: pc.localDescription!.sdp,
      });
      if (!res.ok) throw new Error(`go2rtc answered ${res.status}.`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      if (!cancelled) setHasAudio(audio.currentDirection === "recvonly" || audio.currentDirection === "sendrecv");
      video.play().catch(() => {});
    }

    async function startHls() {
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) throw new Error("This browser can't play HLS here.");
      const hls = new Hls({
        lowLatencyMode: true,
        xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${currentToken()}`),
      });
      cleanups.push(() => hls.destroy());
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) lost(`HLS stopped (${data.details}).`);
      });
      hls.loadSource("/api/stream.m3u8");
      hls.attachMedia(video);
      video.play().catch(() => {});
    }

    function startFrames() {
      let busy = false;
      let lastUrl: string | undefined;
      const tick = async () => {
        if (busy || document.hidden) return;
        busy = true;
        try {
          const url = URL.createObjectURL(await fetchFrame());
          if (cancelled) return URL.revokeObjectURL(url);
          img.src = url;
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = url;
          live();
        } catch (e) {
          handle(e);
        } finally {
          busy = false;
        }
      };
      void tick();
      const timer = setInterval(tick, 1000);
      cleanups.push(() => {
        clearInterval(timer);
        if (lastUrl) URL.revokeObjectURL(lastUrl);
      });
    }

    try {
      if (mode === "webrtc") void startWebRtc().catch(handle);
      else if (mode === "hls") void startHls().catch(handle);
      else startFrames();
    } catch (e) {
      handle(e);
    }

    return () => {
      cancelled = true;
      closeTalk();
      setHasAudio(false);
      setTalking(false);
      cleanups.forEach((fn) => fn());
      video.onplaying = null;
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
      img.removeAttribute("src");
    };
  }, [mode, attempt, tick]);

  return (
    <>
      {/* While you talk the camera's own sound is muted here, or its speaker would feed back through its microphone. */}
      <video ref={videoRef} hidden={mode === "frames"} autoPlay muted={!listening || talking} playsInline />
      <img ref={imgRef} hidden={mode !== "frames"} alt="Latest frame from the camera" />
      {mode === "webrtc" && hasAudio && (
        <div className="audio-bar">
          <button type="button" className="quiet" aria-pressed={listening} onClick={() => setListening((v) => !v)}>
            {listening ? "Sound on" : "Sound off"}
          </button>
          <button
            type="button"
            className={talking ? "talk on" : "talk"}
            aria-pressed={talking}
            disabled={blocked !== null}
            title={blocked ?? "Talk through the camera's speaker. Click again to stop."}
            onClick={() => (talking ? stopTalking() : void startTalking())}
          >
            {talking ? "Talking… tap to stop" : "Talk"}
          </button>
          {blocked && <span className="audio-hint">{blocked}</span>}
          {talkError && (
            <span className="audio-hint" role="alert">
              {talkError}
            </span>
          )}
        </div>
      )}
    </>
  );
}
