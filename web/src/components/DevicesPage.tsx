import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AuthError,
  addFoundDevice,
  addManualDevice,
  getDevices,
  removeDevice,
  scanDevices,
  updateDevice,
  type Device,
  type DeviceKind,
  type DeviceProtocol,
  type Found,
  type ScanResult,
} from "../api";
import { Shell } from "./Shell";

export const KIND_LABEL: Record<DeviceKind, string> = { camera: "Camera", vacuum: "Vacuum", light: "Light", tv: "TV", plug: "Plug", other: "Other" };

const PROTOCOL_LABEL: Record<DeviceProtocol, string> = { miio: "Xiaomi (miio)", cozylife: "CozyLife", androidtv: "Android TV", go2rtc: "Camera stream", other: "Other" };

/** The facts under a device's name, as one line: kind, room, address, model. */
export function deviceLine(d: { kind: DeviceKind; room?: string; host?: string; model?: string }): string {
  return [KIND_LABEL[d.kind], d.room, d.host, d.model].filter(Boolean).join(" · ");
}

/** What the search could not do, in words. Null when everything worked. */
export function cloudNote(r: ScanResult): string | null {
  if (r.cloud === "ok") return null;
  if (r.cloud === "not-signed-in") return "Not signed in to Xiaomi, so names, models and keys are missing. Sign in from Camera → Cameras, then search again.";
  return `The Xiaomi account did not answer${r.cloudMessage ? ` (${r.cloudMessage})` : ""}. Devices on the network are listed without names and models.`;
}

interface PageProps {
  onLogout: () => void;
}

/** Everything at home in one list, a search for new devices, and a way to add one by hand. Reached at /devices. */
export function DevicesPage({ onLogout }: PageProps) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState("");
  const timer = useRef<number>(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const prev = document.title;
    document.title = "Devices";
    return () => {
      document.title = prev;
    };
  }, []);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(""), 4000);
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onLogout();
      say(e instanceof Error ? e.message : "Something went wrong");
    },
    [onLogout, say],
  );

  const load = useCallback(() => getDevices().then(setDevices).catch(fail), [fail]);
  useEffect(() => {
    void load();
  }, [load]);

  const search = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      setResult(await scanDevices());
    } catch (e) {
      fail(e);
    } finally {
      setScanning(false);
    }
  };

  const fresh = result?.candidates.filter((c) => !c.known) ?? [];
  const alreadyThere = (result?.candidates.length ?? 0) - fresh.length;
  const note = result ? cloudNote(result) : null;

  return (
    <Shell current="devices" onLogout={onLogout}>
      <main className="vpage-main">
        <h1 className="page-title" ref={heading} tabIndex={-1}>
          Devices
        </h1>

        <section className="sheet" aria-labelledby="devices-home">
          <h2 id="devices-home">At home</h2>
          {!devices ? (
            <p className="hint">Loading…</p>
          ) : (
            <ul className="devices">
              {devices.map((d) => (
                <DeviceRow key={d.id} device={d} onChanged={load} onError={fail} onSaid={say} />
              ))}
            </ul>
          )}
        </section>

        <section className="sheet" aria-labelledby="devices-find">
          <div className="devices-head">
            <h2 id="devices-find">Find new devices</h2>
            <button type="button" className="primary" onClick={() => void search()} disabled={scanning}>
              {scanning ? "Searching…" : result ? "Search again" : "Find devices"}
            </button>
          </div>
          <p className="hint wide">Looks on your home network and in your Xiaomi account. Add a new device in its own app first, or let it join Wi‑Fi, then search here.</p>
          {note && (
            <p className="devices-note" role="status">
              {note}
            </p>
          )}
          {result &&
            (fresh.length === 0 ? (
              <p className="empty" role="status">
                Nothing new{alreadyThere > 0 ? ` (${alreadyThere} found ${alreadyThere === 1 ? "is" : "are"} already in the list)` : ""}.
              </p>
            ) : (
              <ul className="devices">
                {fresh.map((c) => (
                  <FoundRow
                    key={c.key}
                    found={c}
                    onAdded={() => {
                      say(`${c.name} added`);
                      setResult((r) => r && { ...r, candidates: r.candidates.map((x) => (x.key === c.key ? { ...x, known: true } : x)) });
                      void load();
                    }}
                    onError={fail}
                  />
                ))}
              </ul>
            ))}
        </section>

        <ManualForm
          onAdded={(name) => {
            say(`${name} added`);
            void load();
          }}
          onError={fail}
        />
      </main>
      <div className="toast" role="status" aria-live="polite">
        {toast}
      </div>
    </Shell>
  );
}

interface RowProps {
  device: Device;
  onChanged: () => void;
  onError: (e: unknown) => void;
  onSaid: (m: string) => void;
}

function DeviceRow({ device: d, onChanged, onError, onSaid }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(d.name);
  const [room, setRoom] = useState(d.room ?? "");
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updateDevice(d.id, { name, room });
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeDevice(d.id);
      onSaid(`${d.name} removed`);
      onChanged();
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="device">
        <form className="device-form" onSubmit={(e) => void save(e)} aria-label={`Edit ${d.name}`}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoFocus />
          </label>
          <label>
            Room
            <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} placeholder="Kitchen" />
          </label>
          <div className="device-actions">
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              Save
            </button>
            <button type="button" className="quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="device">
      <div className="device-main">
        <p className="device-name">{d.name}</p>
        <p className="device-line">{deviceLine(d)}</p>
        {!d.editable && <p className="device-line">Set in backend/.env: change or remove it there.</p>}
      </div>
      {d.editable && (
        <div className="device-actions">
          {confirm ? (
            <>
              <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
                Remove {d.name}?
              </button>
              <button type="button" className="quiet" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="quiet" onClick={() => setEditing(true)} aria-label={`Edit ${d.name}`}>
                Edit
              </button>
              <button type="button" className="quiet" onClick={() => setConfirm(true)} aria-label={`Remove ${d.name}`}>
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function FoundRow({ found: c, onAdded, onError }: { found: Found; onAdded: () => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState(c.name);
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addFoundDevice(c.key, name.trim(), room.trim());
      onAdded();
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  return (
    <li className="device">
      <form className="device-form" onSubmit={(e) => void add(e)} aria-label={`Add ${c.name}`}>
        <div className="device-main">
          <p className="device-line">
            {deviceLine(c)}
            {!c.seen && " · not answering on the network just now"}
          </p>
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </label>
        <label>
          Room
          <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} placeholder="Kitchen" />
        </label>
        <div className="device-actions">
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            Add
          </button>
        </div>
      </form>
    </li>
  );
}

function ManualForm({ onAdded, onError }: { onAdded: (name: string) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DeviceKind>("light");
  const [protocol, setProtocol] = useState<DeviceProtocol>("other");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addManualDevice({ kind, protocol, name: name.trim(), host: host.trim(), ...(room.trim() && { room: room.trim() }) });
      onAdded(name.trim());
      setName("");
      setHost("");
      setRoom("");
      setOpen(false);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sheet" aria-labelledby="devices-manual">
      <div className="devices-head">
        <h2 id="devices-manual">Add by hand</h2>
        <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open && (
        <form className="device-form" onSubmit={(e) => void submit(e)}>
          <p className="hint wide">For a device the search cannot see. Only addresses of your home network are accepted (10.x, 172.16–31.x, 192.168.x).</p>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </label>
          <label>
            Address
            <input value={host} onChange={(e) => setHost(e.target.value)} inputMode="decimal" placeholder="192.168.1.50" maxLength={15} required />
          </label>
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
              {(Object.keys(KIND_LABEL) as DeviceKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Talks over
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as DeviceProtocol)}>
              {(Object.keys(PROTOCOL_LABEL) as DeviceProtocol[]).map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room
            <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} placeholder="Kitchen" />
          </label>
          <div className="device-actions">
            <button type="submit" className="primary" disabled={busy || !name.trim() || !host.trim()}>
              Add
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
